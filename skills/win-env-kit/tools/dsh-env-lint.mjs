#!/usr/bin/env node
/**
 * dsh-env-lint.mjs —— 本机编码与换行规则检查器
 *
 * 规则来源：win-env-kit 技能（规则 1、2）。
 *
 * 用法：
 *   node tools/dsh-env-lint.mjs <路径...>            # 只检查
 *   node tools/dsh-env-lint.mjs <路径...> --fix      # 自动修换行与 BOM
 *   node tools/dsh-env-lint.mjs <路径...> --json     # 机器可读输出
 *
 * 检查项：
 *   BOM       UTF-8 BOM（EF BB BF）出现在不该出现的位置
 *   EOL       换行不符合分轨规则（.ps1/.bat/.cmd/.reg → CRLF，其余文本 → LF）
 *   U+FFFD    文件里已有解码失败的替换字符（真正的乱码落盘）
 *   GBKHEUR   非 UTF-8 可解码的字节序列（大概率是 GBK/936 残留）
 *   MOJIBAKE  典型 mojibake 特征字节（如 烫烫烫 / 锟斤拷 / ô 类拉丁乱码）
 *   SCRATCH   冒烟测试 / 截屏 / 中间过程脚本散落在项目里，按 §7 应进 _scratch/
 *
 * 退出码：0 = 无问题；1 = 有问题（--fix 后仍修不好的也算 1）。
 */
import { readFileSync, writeFileSync, statSync, readdirSync, lstatSync } from 'node:fs';
import { extname, basename, join, resolve, relative } from 'node:path';

// ---------- 规则表 ----------

/** 这些扩展名必须是 CRLF。 */
const CRLF_EXTS = new Set(['.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.reg']);

/** 这些扩展名是二进制，跳过不检查。 */
const BINARY_EXTS = new Set([
  '.exe', '.dll', '.pdb', '.lib', '.obj', '.msi', '.msix', '.cab', '.zip',
  '.7z', '.gz', '.tar', '.rar', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.webp', '.bmp', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.sqlite', '.db', '.so', '.dylib',
  '.node', '.class', '.jar', '.pyc', '.wasm',
]);

/** 目录直接跳过。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'bin', 'obj', '.next',
  '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.turbo',
  '.pnpm-store', 'vendor', '.gradle', '.idea', '.vscode-test',
  // §7：临时产物隔离区，永不参与编码/换行检查，也永不提交
  '_scratch',
]);

/**
 * §7 临时产物规范：冒烟测试、截屏、探针脚本、日志等必须落在
 * _scratch/<date>-<topic>/{smoke,shots,probes,logs}/ 里。
 * 散落在源码树里的这类文件很可能是「会不小心被提交/被读进对话」的中间产物。
 */
const SCRATCH_PATTERNS = [
  { re: /(^|[\\/])screens?shot[\w.-]*\.(png|jpe?g|gif|bmp)$/i, label: '截图文件' },
  { re: /(^|[\\/])(screen|shot|capture|snap)[\w.-]*\.(png|jpe?g|gif|bmp)$/i, label: '截图文件' },
  { re: /(^|[\\/])smoke[_-]?test[\w.-]*\.(ps1|cmd|bat|py|js|mjs|ts)$/i, label: '冒烟测试脚本' },
  { re: /(^|[\\/])(probe|scratch|spike|tmp|temp)[\w.-]*\.(ps1|py|js|mjs|ts|json|txt|log)$/i, label: '中间过程脚本' },
  { re: /(^|[\\/])[\w.-]*(smoke|screenshot|screengrab)[\w.-]*\.(log|txt|json)$/i, label: '测试日志' },
  // §8 过程文档：开发期临时笔记/草稿，散落在源码树里必须进 _scratch/
  { re: /(^|[\\/])(notes?|draft|草稿|笔记|临时|todo|scratch)[\w.-]*\.(md|txt|json)$/i, label: '过程文档' },
  { re: /(^|[\\/])(PROCESS|process)[\w.-]*\.(md|txt|log|json)$/i, label: '过程文档' },
  { re: /(^|[\\/])(debug|dbg)[\w.-]*\.(log|txt|dump)$/i, label: '调试过程文件' },
];

/** p 位于 _scratch/ 隔离区内？ */
function inScratch(p) {
  return resolve(p).toLowerCase().split(/[\\/]+/).includes('_scratch');
}

/** 对单个文件路径做 §7 检查（在 main 里对每个被检查文件调用）。 */
function checkScratchPlacement(p) {
  if (inScratch(p)) return null;
  const name = basename(p);
  for (const { re, label } of SCRATCH_PATTERNS) {
    if (re.test(name)) {
      return {
        code: 'SCRATCH',
        msg: `${label} "${name}" 散落在项目里，按 §7 应移进 _scratch/<date>-<topic>/{smoke,shots,probes,logs}/`,
      };
    }
  }
  return null;
}

/**
 * 常见 mojibake 指纹（在按 UTF-8 解码后的文本里找）。
 * 注意排除「讲解乱码」的场景：文档里引号/反引号包起来的示例不算。
 */
const MOJIBAKE_MARKERS = [
  '锟斤拷', '烫烫烫', '屯屯屯', 'Ã©', 'Ã¨', 'Ã¤', 'Ã¶', 'â€™', 'â€œ',
  'â€', 'ï¼', 'ã€', 'Â·', 'Ã¼', 'Ã±',
];

/**
 * 把「被引号或行内代码包起来的示例文本」抹掉，避免文档讲解被误报。
 * 同时抹掉本检查器自身的标记表定义行（里面必然含这些字符串）。
 */
function stripQuotedExamples(text) {
  return text
    .replace(/`[^`\n]*`/g, '')          // 行内代码
    .replace(/"[^"\n]{0,40}"/g, '')     // 双引号示例
    .replace(/“[^”\n]{0,40}”/g, '')     // 中文引号示例
    .replace(/‘[^’\n]{0,40}’/g, '')
    // 注释里列举乱码示例是「讲解」，不是故障
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    // 本脚本自身的数据表：从 MOJIBAKE_MARKERS 定义到其结束的 '];'
    .replace(/MOJIBAKE_MARKERS\s*=\s*\[[\s\S]*?\];/g, '');
}

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const REPLACEMENT_RUN = /\uFFFD{2,}/; // 连续两个以上 U+FFFD 才算硬伤

// ---------- 分类 ----------

function isCrlfExt(p) {
  return CRLF_EXTS.has(extname(p).toLowerCase());
}

function isBinaryExt(p) {
  return BINARY_EXTS.has(extname(p).toLowerCase());
}

/** 判断一段内容是否“看起来像文本”（允许 UTF-8 解码失败，那种情况单独报）。 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  if (n === 0) return false;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    // 允许 \t \n \r \f，其余 C0 控制字符计为可疑
    if (b < 0x09 || (b > 0x0d && b < 0x20)) ctrl++;
  }
  return ctrl / n > 0.03;
}

// ---------- 单文件检查 ----------

/**
 * @param {string} path
 * @param {{fix:boolean}} opts
 * @returns {{path:string, findings:Array<{code:string,msg:string,line?:number}>, fixed:boolean}}
 */
function checkFile(path, opts) {
  const findings = [];
  let fixed = false;

  let buf;
  try {
    buf = readFileSync(path);
  } catch (e) {
    return { path, findings: [{ code: 'READ', msg: `读取失败: ${e.message}` }], fixed };
  }

  // 空文件 / 二进制直接跳过
  if (buf.length === 0) return { path, findings, fixed };
  if (isBinaryExt(path) || looksBinary(buf)) return { path, findings, fixed };

  // --- BOM ---
  const hasBom = buf.length >= 3 && buf.subarray(0, 3).equals(BOM_UTF8);
  const crlf = isCrlfExt(path);
  // .ps1 含非 ASCII 时 BOM 是“推荐”的；其余一律不该有 BOM
  const body = hasBom ? buf.subarray(3) : buf;

  // --- 编码 ---
  let text;
  let utf8Ok = true;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    utf8Ok = false;
    // 用宽松模式继续跑，以便报告换行等其他问题
    text = new TextDecoder('utf-8', { fatal: false }).decode(body);
    let firstBad = -1;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b >= 0x80) {
        const slice = buf.subarray(i, Math.min(i + 4, buf.length));
        const dec = new TextDecoder('utf-8', { fatal: false }).decode(slice);
        if (dec.includes('\uFFFD')) { firstBad = i; break; }
        i += Math.max(0, slice.length - 1);
      }
    }
    const snip = firstBad >= 0
      ? buf.subarray(firstBad, firstBad + 12).toString('hex').match(/../g).join(' ')
      : '(?)';
    findings.push({
      code: 'GBKHEUR',
      msg: `不是合法 UTF-8（首个可疑字节偏移 ${firstBad}，内容 ${snip}）——大概率是 GBK/936 残留，需转码`,
    });
  }

  // --- BOM 规则 ---
  const nonAscii = /[^\x00-\x7F]/.test(text);
  if (hasBom && !crlf) {
    findings.push({ code: 'BOM', msg: 'UTF-8 BOM 出现在非 Windows 脚本文件里（应为无 BOM）' });
    if (opts.fix) {
      const out = Buffer.from(text, 'utf8');
      writeFileSync(path, out);
      fixed = true;
      findings.pop();
      findings.push({ code: 'BOM', msg: '已移除 UTF-8 BOM', fixedHere: true });
    }
  }
  if (!hasBom && crlf && nonAscii) {
    // .ps1 含中文且无 BOM：5.1 会按 GBK 误读。只提示，不自动加（需要人确认）
    findings.push({
      code: 'BOM',
      msg: '含非 ASCII 的 Windows 脚本没有 BOM：PowerShell 5.1 会按系统代码页(936)误读中文，建议存成 UTF-8 with BOM 或改成纯 ASCII',
      soft: true,
    });
  }

  // --- U+FFFD（已落盘的解码失败）---
  if (utf8Ok && REPLACEMENT_RUN.test(text)) {
    const idx = text.search(REPLACEMENT_RUN);
    const line = text.slice(0, idx).split('\n').length;
    findings.push({ code: 'U+FFFD', msg: `发现连续 U+FFFD 替换字符（第 ${line} 行）——内容已损坏`, line });
  }

  // --- mojibake 指纹（先抹掉引号里的示例，避免文档讲解被误报）---
  if (utf8Ok) {
    const masked = stripQuotedExamples(text);
    for (const marker of MOJIBAKE_MARKERS) {
      const idx = masked.indexOf(marker);
      if (idx >= 0) {
        const line = text.slice(0, idx).split('\n').length;
        findings.push({ code: 'MOJIBAKE', msg: `疑似乱码标记 "${marker}"（第 ${line} 行）`, line });
        break; // 每文件只报第一处，避免刷屏
      }
    }
  }

  // --- 换行分轨 ---
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const loneLf = (text.match(/(^|[^\r])\n/g) || []).length;
  const loneCr = (text.match(/\r(?!\n)/g) || []).length;

  const expected = crlf ? 'CRLF' : 'LF';
  const violating = crlf ? loneLf : crlfCount;

  if (violating > 0 || loneCr > 0) {
    const detail = crlf
      ? `${loneLf} 处 LF（应为 CRLF）`
      : `${crlfCount} 处 CRLF（应为 LF）`;
    findings.push({ code: 'EOL', msg: `换行不符合规则：${detail}${loneCr ? `，另有 ${loneCr} 处孤立 CR` : ''}` });

    if (opts.fix) {
      // 只做换行归一，不改编码、不改 BOM 状态
      const normalized = text.replace(/\r\n|\r/g, '\n');
      const outText = crlf ? normalized.replace(/\n/g, '\r\n') : normalized;
      const prefix = hasBom ? BOM_UTF8 : Buffer.alloc(0);
      writeFileSync(path, Buffer.concat([prefix, Buffer.from(outText, utf8Ok ? 'utf8' : 'latin1')]));
      fixed = true;
      findings.pop();
      findings.push({ code: 'EOL', msg: `已把换行归一为 ${expected}`, fixedHere: true });
    }
  } else if (!crlf && crlfCount > 0) {
    // 纯 CRLF 文件但没有违反规则（crlf 扩展名之外）—— 上面已覆盖
  }

  return { path, findings, fixed };
}

// ---------- 遍历 ----------

function* walk(p) {
  let st;
  try { st = lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(basename(p))) return;
    let entries;
    try { entries = readdirSync(p); } catch { return; }
    for (const e of entries) yield* walk(join(p, e));
  } else if (st.isFile()) {
    yield p;
  }
}

// ---------- main ----------

function main(argv) {
  const args = argv.slice(2);
  const fix = args.includes('--fix');
  const json = args.includes('--json');
  const targets = args.filter((a) => !a.startsWith('--'));

  if (targets.length === 0) {
    console.error('用法: node tools/dsh-env-lint.mjs <路径...> [--fix] [--json]');
    process.exit(2);
  }

  const results = [];
  for (const t of targets) {
    const abs = resolve(t);
    let st;
    try { st = statSync(abs); } catch {
      results.push({ path: t, findings: [{ code: 'MISSING', msg: '路径不存在' }], fixed: false });
      continue;
    }
    const files = st.isDirectory() ? [...walk(abs)] : [abs];
    for (const f of files) {
      const r = checkFile(f, { fix });
      // §7：目录遍历时 _scratch 已被 SKIP_DIRS 跳过，但显式传入的文件仍要查摆放位置
      const placement = checkScratchPlacement(f);
      if (placement) r.findings.push(placement);
      results.push(r);
    }
  }

  const bad = results.filter((r) => r.findings.length > 0);
  const fixable = results.filter((r) => r.fixed);

  if (json) {
    console.log(JSON.stringify({ checked: results.length, problems: bad, fixed: fixable.map((r) => r.path) }, null, 2));
  } else {
    const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', off: '\x1b[0m' };
    for (const r of bad) {
      const rel = relative(process.cwd(), r.path) || r.path;
      console.log(`\n${C.yellow}${rel}${C.off}`);
      for (const f of r.findings) {
        const tag = f.fixedHere ? `${C.green}FIXED${C.off}` : f.soft ? `${C.dim}INFO${C.off}` : `${C.red}${f.code}${C.off}`;
        console.log(`  [${tag}] ${f.msg}`);
      }
    }
    const hard = results.flatMap((r) => r.findings.filter((f) => !f.soft && !f.fixedHere));
    console.log(
      `\n检查 ${results.length} 个文件，` +
      `${results.filter((r) => r.findings.some((f) => !f.soft)).length} 个有问题，` +
      `${fixable.length} 个已自动修复，剩余硬问题 ${hard.length} 条。` +
      (hard.length ? `\n${C.red}仍有 ${hard.length} 条需人工处理。${C.off}` : ''),
    );
  }

  const remainingHard = results.flatMap((r) => r.findings).filter((f) => !f.soft && !f.fixedHere);
  process.exit(remainingHard.length > 0 ? 1 : 0);
}

main(process.argv);
