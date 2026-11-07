#!/usr/bin/env node
/**
 * dsh-privacy-gate.mjs —— 截图隐私门禁（零依赖，纯本地，不上传任何像素）
 *
 * 规则来源：win-env-kit 技能规则 6。
 *
 * 为什么需要它：在这套环境里，一张图片被 read_image / present / 贴进对话
 * 就等于「上传」——像素会经过模型服务端。所以任何测试截图在进对话之前，
 * 必须先跑本门禁；本脚本只读文件的字节与尺寸，输出纯文本结论，绝不读像素。
 *
 * 用法：
 *   node tools/dsh-privacy-gate.mjs <图片或目录...> [选项]
 *
 * 选项：
 *   --json              机器可读输出
 *   --strict            mid 级发现也 BLOCK（默认只 high 级 BLOCK）
 *   --root <dir>        允许的图片根目录，默认 ./_scratch
 *   --screen WxH        主屏尺寸，默认取 DSH_SCREEN 或 sidecar 或 1280x800
 *   --allow <CODE>      把某检查码降级为信息（人工确认过的例外，可重复）
 *
 * 检查码：
 *   LOCATION    图片不在 _scratch / --root 之下（来源不可信）
 *   PATH-PII    路径里含用户名 / 机器名 / %TEMP% / 用户目录特征
 *   TEXT-PII    文件字节里嵌了上述 PII 字符串（PNG tEXt / JPEG COM 等元数据）
 *   FULLSCREEN  尺寸接近主屏且没有「窗口限定」sidecar 佐证（疑似整屏抓取）
 *   MAXIMIZED   尺寸接近主屏但 sidecar 证明是窗口/区域抓取（提示人工复核）
 *   SCOPE       sidecar 声明的 scope 不是 window/region（含 screen）
 *   NO-SIDECAR  没有 dsh-screenshot.ps1 写的佐证文件，无法证明来源
 *   DIM-UNKNOWN 无法解析图片尺寸（隐私默认 fail-closed）
 *   SIDECAR-OK  sidecar 佐证通过（信息）
 *
 * 退出码：0 = ALLOW（可进对话）；1 = BLOCK（不要读进对话）；2 = 用法错。
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { extname, basename, dirname, join, resolve, relative, sep } from 'node:path';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp']);
// DPI trap: on a high-DPI display the physical screen size and the
// virtualized size seen by a DPI-unaware process differ (e.g. 1.5x scaling).
// A full-screen grab can therefore match EITHER size depending on who
// captured it. Keep the smaller virtualized size (DEFAULT_SCREEN below) as
// the conservative floor so FULLSCREEN trips regardless of DPI context.
const DEFAULT_SCREEN = { w: 1280, h: 800 };
const FULLSCREEN_FLOOR = DEFAULT_SCREEN;

function parseScreen(s) {
  const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(String(s || '').trim());
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

function piiMarkers() {
  const user = String(process.env.USERNAME || '').trim();
  const comp = String(process.env.COMPUTERNAME || '').trim();
  const named = [['USERNAME', user], ['COMPUTERNAME', comp]]
    .filter(([, v]) => v && v.length >= 4);
  const patterns = [
    ['TEMP-DSH', /[\\/]Temp[\\/]dsh-[A-Za-z0-9_-]+/i],
    ['DSH-SPILL', /dsh-spill-[A-Za-z0-9_-]+/i],
    ['APPDATA-TEMP', /AppData[\\/]Local[\\/]Temp/i],
    ['SHORTNAME', /[\\/][A-Za-z0-9]{1,6}~\d[\\/]/],
    ['SOURCE-REPOS', /source[\\/]repos/i],
    ['USER-HOME', /[\\/]Users[\\/][^\\/:*?"<>|]+[\\/](Desktop|Documents|Downloads|OneDrive|Pictures)/i],
  ];
  return { named, patterns };
}

function scanPii(text, pii) {
  const low = text.toLowerCase();
  const hits = [];
  for (const [label, v] of pii.named) if (low.includes(v.toLowerCase())) hits.push(label);
  for (const [label, re] of pii.patterns) if (re.test(text)) hits.push(label);
  return [...new Set(hits)];
}

/** 只解析尺寸，不解码像素。支持 PNG / GIF / BMP / JPEG；其余返回 null。 */
function imageSize(buf) {
  try {
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 &&
        buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d &&
        buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a &&
        buf.subarray(12, 16).toString('latin1') === 'IHDR') {
      return { format: 'PNG', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10) {
      const sig = buf.subarray(0, 6).toString('latin1');
      if (sig === 'GIF87a' || sig === 'GIF89a')
        return { format: 'GIF', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d)
      return { format: 'BMP', w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)) };
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 <= buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        let m = buf[i + 1];
        while (m === 0xff && i + 2 < buf.length) { i++; m = buf[i + 1]; }
        if (m === 0xd8 || m === 0xd9 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (i + 4 > buf.length) break;
        const len = buf.readUInt16BE(i + 2);
        const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
        if (sof) return { format: 'JPEG', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } catch { /* 落到 DIM-UNKNOWN */ }
  return null;
}

function loadSidecar(file) {
  const p = join(dirname(file), basename(file, extname(file)) + '.json');
  try {
    const txt = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    const obj = JSON.parse(txt);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

function* walkImages(dir) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkImages(p);
    else if (e.isFile() && IMAGE_EXTS.has(extname(e.name).toLowerCase())) yield p;
  }
}

function checkImage(file, ctx) {
  const findings = [];
  const add = (sev, code, msg) => findings.push({ sev, code, msg });
  const abs = resolve(file);
  const rel = relative(process.cwd(), abs) || file;

  let buf;
  try { buf = readFileSync(abs); }
  catch (e) { add('high', 'READ', `读取失败: ${e.message}`); return { file: rel, findings }; }

  // LOCATION —— 只信任 _scratch/ 或显式 --root 之下的图片
  const parts = abs.toLowerCase().split(/[\\/]+/);
  const inScratch = parts.includes('_scratch');
  const rootAbs = resolve(ctx.root).replace(/[\\/]+$/, '').toLowerCase();
  const a = abs.toLowerCase();
  const underRoot = a === rootAbs || a.startsWith(rootAbs + sep) || a.startsWith(rootAbs + '/');
  if (!inScratch && !underRoot)
    add('high', 'LOCATION', `图片不在 _scratch/ 或 --root(${rootAbs}) 之下，来源不可信：${rel}`);

  // PATH-PII —— 路径本身泄露身份
  const pathHits = scanPii(abs, ctx.pii);
  if (pathHits.length) add('high', 'PATH-PII', `路径里含身份特征：${pathHits.join(', ')}`);

  // TEXT-PII —— 图片元数据（PNG tEXt / JPEG COM / EXIF）里嵌了身份
  const raw = buf.toString('latin1') + '\n' + buf.toString('utf16le');
  const textHits = scanPii(raw, ctx.pii);
  if (textHits.length) add('high', 'TEXT-PII', `文件字节里含身份特征：${textHits.join(', ')}`);

  // SIZE
  const size = imageSize(buf);
  if (!size) add('high', 'DIM-UNKNOWN', '无法解析图片尺寸（支持 PNG/JPEG/GIF/BMP）——隐私默认 fail-closed');

  // SIDECAR —— dsh-screenshot.ps1 写的来源佐证
  const side = loadSidecar(abs);
  const attested = !!(side && (side.scope === 'window' || side.scope === 'region'));
  if (!side) add('mid', 'NO-SIDECAR', '没有 dsh-screenshot.ps1 写的佐证 .json，无法证明是窗口/区域截取');
  else if (side.scope === 'screen') add('high', 'SCOPE', '佐证声明为整屏抓取（scope=screen）');
  else if (!attested) add('high', 'SCOPE', `佐证里的 scope 不是 window/region：${String(side.scope)}`);
  else add('info', 'SIDECAR-OK', `佐证通过：scope=${side.scope} rect=${JSON.stringify(side.rect || [])}`);

  // 本图采用的主屏尺寸：--screen > DSH_SCREEN > sidecar > 默认
  let scr = ctx.explicit;
  if (!scr && side && Number(side.screenW) > 0 && Number(side.screenH) > 0)
    scr = { w: Number(side.screenW), h: Number(side.screenH) };
  if (!scr) scr = DEFAULT_SCREEN;

  // FULLSCREEN / MAXIMIZED
  // Ratio test uses `scr` when it is >= the DPI-virtualized floor (usually
  // sidecar screenW/H, or an explicit --screen). Absolute test always uses
  // the floor: an image at the DEFAULT_SCREEN size must NEVER pass as a
  // window capture, even when the attested screen was reported larger.
  if (size) {
    const base = (scr.w >= FULLSCREEN_FLOOR.w && scr.h >= FULLSCREEN_FLOOR.h) ? scr : FULLSCREEN_FLOOR;
    const nearFull = (size.w >= scr.w * 0.9 && size.h >= scr.h * 0.85) ||
                     (size.w >= FULLSCREEN_FLOOR.w && size.h >= FULLSCREEN_FLOOR.h);
    if (nearFull) {
      if (attested)
        add('mid', 'MAXIMIZED', `尺寸 ${size.w}x${size.h} 接近主屏（基准 ${base.w}x${base.h}）；佐证说是窗口截取，请人工确认截的是被测应用`);
      else
        add('high', 'FULLSCREEN', `尺寸 ${size.w}x${size.h} 接近/等于主屏（基准 ${base.w}x${base.h}），且没有窗口佐证——疑似整屏抓取`);
    }
  }

  return {
    file: rel, format: size ? size.format : '?',
    w: size ? size.w : null, h: size ? size.h : null,
    screen: scr, findings,
  };
}

function usage() {
  console.error(`用法: node tools/dsh-privacy-gate.mjs <图片或目录...> [选项]
选项:
  --json             机器可读输出
  --strict           mid 级发现也 BLOCK
  --root <dir>       允许的图片根目录（默认 ./_scratch）
  --screen WxH       主屏尺寸（默认取 DSH_SCREEN / 佐证 / ${DEFAULT_SCREEN.w}x${DEFAULT_SCREEN.h}）
  --allow <CODE>     把某检查码降级为信息（人工确认过的例外，可重复）
退出码: 0=ALLOW 1=BLOCK 2=用法错`);
  process.exit(2);
}

function printText(results, ctx, missing) {
  const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', off: '\x1b[0m' };
  console.log(`== dsh-privacy-gate ==  screen ${ctx.explicit ? `${ctx.explicit.w}x${ctx.explicit.h}` : 'auto'}  root ${resolve(ctx.root)}  strict=${ctx.strict ? 'on' : 'off'}`);
  for (const m of missing) {
    console.log(`\n${C.yellow}${m}${C.off}`);
    console.log(`  [${C.red}HIGH${C.off}] MISSING: 路径不存在`);
  }
  for (const r of results) {
    console.log(`\n${C.yellow}${r.file}${C.off}`);
    console.log(`  ${C.dim}${r.format} ${r.w}x${r.h}  (screen ${r.screen.w}x${r.screen.h})${C.off}`);
    for (const f of r.findings) {
      const tag = f.sev === 'high' ? `${C.red}HIGH${C.off}`
        : f.sev === 'mid' ? `${C.yellow}MID ${C.off}` : `${C.dim}INFO${C.off}`;
      console.log(`  [${tag}${f.allowed ? ' (--allow)' : ''}] ${f.code}: ${f.msg}`);
    }
    console.log(`  VERDICT: ${r.verdict === 'ALLOW' ? `${C.green}ALLOW${C.off}` : `${C.red}BLOCK${C.off}`}`);
  }
  const allow = results.filter((r) => r.verdict === 'ALLOW').length;
  const block = results.length - allow + missing.length;
  console.log(`\n${allow} ALLOW, ${block} BLOCK`);
  if (block) console.log(`${C.red}BLOCK 的图片不要调用 read_image / present / 贴进对话。${C.off}`);
  else console.log('只有 ALLOW 的图片才可以读进对话。');
}

function main(argv) {
  const args = argv.slice(2);
  const ctx = { json: false, strict: false, root: '_scratch', explicit: null, allow: new Set(), pii: piiMarkers() };
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') ctx.json = true;
    else if (a === '--strict') ctx.strict = true;
    else if (a === '--root') { ctx.root = args[++i]; if (!ctx.root) usage(); }
    else if (a === '--screen') { ctx.explicit = parseScreen(args[++i]); if (!ctx.explicit) usage(); }
    else if (a === '--allow') { const v = args[++i]; if (!v) usage(); ctx.allow.add(v.toUpperCase()); }
    else if (a.startsWith('--')) usage();
    else targets.push(a);
  }
  if (!targets.length) usage();
  ctx.explicit = ctx.explicit || parseScreen(process.env.DSH_SCREEN) || null;

  const files = [], missing = [];
  for (const t of targets) {
    let st;
    try { st = statSync(resolve(t)); } catch { missing.push(t); continue; }
    if (st.isDirectory()) files.push(...walkImages(resolve(t)));
    else files.push(resolve(t));
  }

  const results = files.map((f) => checkImage(f, ctx));
  for (const r of results) {
    for (const f of r.findings) {
      if (f.sev !== 'info' && ctx.allow.has(f.code.toUpperCase())) { f.sev = 'info'; f.allowed = true; }
    }
    r.verdict = r.findings.some((f) => f.sev === 'high' || (ctx.strict && f.sev === 'mid')) ? 'BLOCK' : 'ALLOW';
  }

  if (ctx.json) {
    console.log(JSON.stringify({
      screenDefault: DEFAULT_SCREEN, strict: ctx.strict, results, missing,
      allow: results.filter((r) => r.verdict === 'ALLOW').map((r) => r.file),
      block: [...results.filter((r) => r.verdict === 'BLOCK').map((r) => r.file), ...missing],
    }, null, 2));
  } else {
    printText(results, ctx, missing);
  }

  const block = results.filter((r) => r.verdict === 'BLOCK').length + missing.length;
  process.exit(block > 0 ? 1 : 0);
}

main(process.argv);
