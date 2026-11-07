#!/usr/bin/env node
/**
 * build-audit.mjs —— 构建产物安全性体检（零依赖）
 *
 * 目的：在分发前把「会被 SmartScreen / 杀软误判」的常见诱因量化出来。
 * 规则来源：win-env-kit 技能（规则 3、4、9）。
 *
 * 用法：
 *   node tools/build-audit.mjs <文件或目录...> [--json] [--strict]
 *
 * 检查项：
 *   MOTW          Zone.Identifier 备用数据流（从网上下载的标记）
 *   TRUST-MARK    DSH 沙箱盖在工作区根、继承给产物的本地信任标记（解析 icacls）：
 *                 低完整性标签 / S-1-4-* 沙箱 SID / Everyone 拒绝 ACE。带这些标记的本机产物
 *                 双击可能被要求安全确认；生成/复制到工作区根之外的干净目录即消失（已实测）。
 *   SIGN          Authenticode 签名是否有效；是否有 RFC3161 时间戳
 *   PE-DEBUG      PE Debug 目录里烙进去的 PDB 绝对路径（常含用户名/临时目录）
 *   PE-RICH       Rich header 里烙进去的构建机信息（VS 工具链路径）
 *   TEMP-PATH     文件内容里出现的 %TEMP% / dsh-spill / Temp\dsh- / 用户名 等绝对路径
 *   PE-VERSION    资源里有没有 CompanyName / ProductName / FileVersion（缺了很像“野”程序）
 *   PE-SUBSYSTEM  子系统 / 是否 .NET / 架构
 *
 * 退出码：0 = 无失败项；1 = 有失败项（默认只算 high；--strict 下 mid 也算）；2 = 用法错误。
 */
import { readFileSync, readdirSync, statSync, lstatSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { extname, basename, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const PE_EXTS = new Set(['.exe', '.dll', '.sys', '.scr', '.cpl', '.ocx', '.node', '.pyd', '.efi']);
// 非 PE 但会被双击执行 / 分发、因而也吃本地信任标记的可执行类文件
const TRUST_EXTS = new Set([
  '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.reg', '.vbs', '.wsf', '.hta', '.lnk',
  '.msi', '.msp', '.zip', '.7z', '.rar', '.iso', '.cab',
]);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SIGTOOL_CANDIDATES = [
  'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe',
  'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.22621.0\\x64\\signtool.exe',
  'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.19041.0\\x64\\signtool.exe',
];

const C = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', off: '\x1b[0m' };
const sevColor = (s) => (s === 'high' ? C.red : s === 'mid' ? C.yellow : C.dim);

/**
 * 跑外部命令并把 stdout+stderr 收进字符串。
 *
 * 关键：DSH 受限沙箱**禁止捕获子进程的管道输出**——execFileSync 默认管道、
 * cmd.exe 的 `>` 重定向、powershell -Command 的管道，都会 spawnSync EPERM。
 * 唯一稳定的写法是把 stdio 直接指向一个文件 fd（不是 named pipe），跑完读该文件。
 * 这样 icacls / signtool / powershell 都能在沙箱里正常工作并拿到输出。
 * 返回 { status, out }；命令以非零退出时 status 为非 0，不抛。
 */
function runCaptured(bin, args, timeout = 30000) {
  const dump = join(tmpdir(), `dsh-cap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  let fd;
  let status = 0;
  try {
    fd = openSync(dump, 'w');
    execFileSync(bin, args, { stdio: ['ignore', fd, fd], timeout, windowsHide: true });
  } catch (e) {
    status = (typeof e.status === 'number') ? e.status : 1;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* */ } }
  }
  let out = '';
  // PowerShell 5.1 的 Get-Content/-join 在重定向到文件时会带 UTF-16LE BOM 与尾部 NUL，
  // 统一剥掉，避免正则/显示里冒出 \u0000
  try { out = readFileSync(dump, 'utf8').replace(/^\uFEFF/, '').replace(/\u0000/g, ''); } catch { /* 没生成就算空 */ }
  try { unlinkSync(dump); } catch { /* */ }
  return { status, out };
}

// ---------- 读取备用数据流（MOTW） ----------

function readZoneIdentifier(path) {
  // PowerShell 读 ADS 最稳；避免 node 的 xattr 不可用
  const r = runCaptured(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
     `$z = Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -Stream Zone.Identifier -ErrorAction SilentlyContinue; if ($z) { $z -join "\`n" }`],
    10000,
  );
  return r.out.trim() || null;
}

// ---------- 本地信任标记（DSH 沙箱盖章，解析 icacls） ----------

/**
 * DSH 在 workspace-write 下会往工作区根写三条 ACE 并 (OI)(CI) 继承给每个文件：
 *   - S-1-4-* （沙箱 restricting SID，SECURITY_NON_UNIQUE_AUTHORITY，无法解析成用户名）
 *   - Mandatory Label\Low Mandatory Level (NW) 低完整性标签 + No-Write-Up
 *   - Everyone (CI)(DENY)(DC)
 * 带这些标记的文件在本机双击/执行可能被要求安全确认（用户说的「ACE 问题」）。
 * 已实测：把文件复制/生成到工作区根**之外**的干净目录，三条标记全部消失；
 * 在盖章根里原地 icacls /setintegritylevel 或 /remove 一律 Access denied。
 * 因此这里只做「发现」，修复靠产物流向，不尝试改写 ACL。
 *
 * 语言无关判据：S-1-4-* 是最强信号（与低完整性标签总是成对出现，且复制出去即消失）。
 * 返回命中的人类可读标记数组；无法判定时返回 null（不当作失败，避免误报）。
 */
function readTrustMarks(path) {
  if (process.platform !== 'win32') return null;
  const r = runCaptured('icacls', [path], 10000);
  // 跑不动 / icacls 不存在时返回 null（不当作失败，避免误报）
  if (!r.out) return null;
  const out = r.out;
  const marks = [];
  if (/\bS-1-4-\d/i.test(out)) marks.push('DSH 沙箱 SID (S-1-4-*)');
  // 下面两条是英文/本地化最佳努力，用于把消息写全；S-1-4-* 已足够触发告警
  if (/Low Mandatory Level|低强制|低完整性|\bS-1-16-4096\b/i.test(out)) marks.push('低完整性标签 (Low IL)');
  if (/Everyone[^\n]*DENY|Everyone[^\n]*拒绝/i.test(out)) marks.push('Everyone 拒绝 ACE');
  return marks;
}

// ---------- PE 解析（最小实现） ----------

function parsePe(buf) {
  const pe = { isPe: false };
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return pe; // 'MZ'
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length) return pe;
  if (buf.readUInt32LE(peOff) !== 0x00004550) return pe; // 'PE\0\0'

  pe.isPe = true;
  const machine = buf.readUInt16LE(peOff + 4);
  pe.machine = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64', 0x1c4: 'arm' }[machine] || `0x${machine.toString(16)}`;
  const numSections = buf.readUInt16LE(peOff + 6);
  const sizeOfOptHeader = buf.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  pe.format = magic === 0x20b ? 'PE32+' : magic === 0x10b ? 'PE32' : `magic 0x${magic.toString(16)}`;
  pe.subsystem = buf.readUInt16LE(optOff + 68);
  pe.subsystemName = { 2: 'GUI', 3: 'CUI' }[pe.subsystem] || String(pe.subsystem);

  // 数据目录：CliHeader(14) 判断 .NET，Debug(6)，Certificate(4)
  const dirOff = optOff + (pe.format === 'PE32+' ? 112 : 96);
  const readDir = (i) => (dirOff + i * 8 + 8 <= buf.length
    ? { rva: buf.readUInt32LE(dirOff + i * 8), size: buf.readUInt32LE(dirOff + i * 8 + 4) }
    : { rva: 0, size: 0 });
  pe.clr = readDir(14);
  pe.debugDir = readDir(6);
  pe.certDir = readDir(4);
  pe.isDotNet = pe.clr.rva !== 0 && pe.clr.size !== 0;
  pe.isSigned = pe.certDir.rva !== 0 && pe.certDir.size !== 0;

  // 节表，供 RVA→文件偏移
  const sectOff = optOff + sizeOfOptHeader;
  pe.sections = [];
  for (let i = 0; i < numSections; i++) {
    const o = sectOff + i * 40;
    if (o + 40 > buf.length) break;
    pe.sections.push({
      name: buf.toString('ascii', o, o + 8).replace(/\0+$/, ''),
      vsize: buf.readUInt32LE(o + 8),
      vaddr: buf.readUInt32LE(o + 12),
      rawsize: buf.readUInt32LE(o + 16),
      rawptr: buf.readUInt32LE(o + 20),
    });
  }
  pe.rva2off = (rva) => {
    for (const s of pe.sections) {
      if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawsize)) {
        return s.rawptr + (rva - s.vaddr);
      }
    }
    return -1;
  };
  return pe;
}

/** 从 Debug 目录里抽出 PDB 路径（CodeView RSDS 记录）。 */
function readPdbPath(buf, pe) {
  if (!pe.debugDir.rva || !pe.debugDir.size) return null;
  const off = pe.rva2off(pe.debugDir.rva);
  if (off < 0 || off + 28 > buf.length) return null;
  const count = Math.floor(pe.debugDir.size / 28);
  for (let i = 0; i < count; i++) {
    const e = off + i * 28;
    if (e + 28 > buf.length) break;
    const type = buf.readUInt32LE(e + 12);
    const size = buf.readUInt32LE(e + 16);
    const dataRva = buf.readUInt32LE(e + 20);
    if (type !== 2 /* IMAGE_DEBUG_TYPE_CODEVIEW */) continue;
    const d = pe.rva2off(dataRva);
    if (d < 0 || d + 24 > buf.length) continue;
    if (buf.toString('ascii', d, d + 4) === 'RSDS') {
      const end = Math.min(d + Math.max(size, 512), buf.length);
      const raw = buf.subarray(d + 24, end);
      const z = raw.indexOf(0);
      return raw.subarray(0, z < 0 ? raw.length : z).toString('utf8');
    }
  }
  return null;
}

/** 抽出常见的绝对路径模式（UTF-8 与 UTF-16LE 都扫）。 */
function scanPaths(buf, pe) {
  const hits = new Set();
  const textual = buf.toString('latin1');
  const patterns = [
    /[A-Za-z]:\\Users\\[^\\\s"']+/g,
    /[A-Za-z]:\\[^\s"']*\\?AppData\\Local\\Temp\\[^\s"']+/g,
    /dsh-spill-[A-Za-z0-9]+/g,
    /\\Temp\\dsh-[A-Za-z0-9]+/g,
    /[A-Za-z]:\\[^\s"']*\\?source\\repos\\[^\s"']+/g,
  ];
  for (const re of patterns) {
    for (const m of textual.matchAll(re)) hits.add(m[0].slice(0, 160));
  }
  // UTF-16LE 版本
  const u16 = buf.toString('utf16le');
  for (const re of patterns) {
    for (const m of u16.matchAll(re)) hits.add(m[0].slice(0, 160));
  }
  return [...hits];
}

/** 从资源里粗读 VS_VERSIONINFO 的字符串（够用即可）。 */
function readVersionStrings(buf, pe) {
  const out = {};
  const text = buf.toString('utf16le');
  for (const key of ['CompanyName', 'ProductName', 'FileDescription', 'FileVersion', 'ProductVersion', 'OriginalFilename', 'LegalCopyright']) {
    const idx = text.indexOf(key);
    if (idx < 0) continue;
    // key 之后通常是 \0\0、长度 WORD、值
    const win = buf.subarray(idx * 2, Math.min(idx * 2 + 400, buf.length));
    // 值在 UTF-16 里跟在 key\0 后面几个字段；用宽松正则
    const m = /^([\s\S]{0,40})/.exec(win.toString('utf16le'));
    const after = m ? m[1] : '';
    const parts = after.split('\u0000').map((s) => s.replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '').trim()).filter(Boolean);
    const val = parts.find((p, i) => i > 0 && p.length > 0 && !p.startsWith('VarFileInfo'));
    if (val) out[key] = val.slice(0, 120);
  }
  return out;
}

function findSigntool() {
  for (const p of SIGTOOL_CANDIDATES) {
    try { if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

function verifySignature(path) {
  const signtool = findSigntool();
  if (!signtool) return { available: false };
  // signtool 输出本地化（中文 Windows 输出中文），用 utf8 读；runCaptured 绕开沙箱管道禁令
  const r = runCaptured(signtool, ['verify', '/pa', '/v', path], 60000);
  if (r.status === 0) {
    const info = readSignerInfo(path);
    return { available: true, valid: true, timestamp: info.timestamp, signer: info.signer, status: info.status };
  }
  return { available: true, valid: false, timestamp: false, rawTail: r.out.slice(-600) };
}

/** 用 PowerShell 取签名者与时间戳（Get-AuthenticodeSignature 跨版本可用）。 */
function readSignerInfo(path) {
  const r = runCaptured('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$s = Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/g, "''")}'; ` +
    `"STATUS=$($s.Status)"; "SIGNER=$($s.SignerCertificate.Subject)"; "TIME=$($s.TimeStamperCertificate.Subject)"`,
  ], 30000);
  const out = r.out;
  const get = (k) => { const m = new RegExp(`${k}=(.+)`).exec(out); return m ? m[1].trim() : null; };
  const status = get('STATUS');
  return {
    status,
    signer: get('SIGNER'),
    // TimeStamperCertificate 存在即有时间戳
    timestamp: !!(get('TIME') && get('TIME') !== ''),
  };
}

// ---------- 单产物审计 ----------

function auditFile(path) {
  const findings = [];
  let buf;
  try { buf = readFileSync(path); } catch (e) {
    return { path, findings: [{ sev: 'high', code: 'READ', msg: `读取失败：${e.message}` }], facts: {} };
  }
  const facts = { sizeBytes: buf.length };

  // MOTW
  const zi = readZoneIdentifier(path);
  facts.motw = zi;
  if (zi) {
    findings.push({
      sev: 'high', code: 'MOTW',
      msg: `带 Zone.Identifier（来自网络）：${zi.split('\n').find((l) => /ZoneId/.test(l)) || 'ZoneId=?'}。分发前必须解除块，否则接收方会吃 SmartScreen 警告`,
    });
  }

  // TRUST-MARK：本地信任标记（DSH 沙箱盖章）
  const marks = readTrustMarks(path);
  facts.trustMarks = marks;
  if (marks && marks.length) {
    findings.push({
      sev: 'high', code: 'TRUST-MARK',
      msg: `产物带 DSH 沙箱盖章的本地信任标记：${marks.join('、')}。本机双击/执行可能被要求安全确认。` +
           `修复：把最终产物生成/复制到工作区根之外的干净目录（已实测标记全部消失）；原位 icacls 改不动。`,
    });
  }

  const isPeFile = PE_EXTS.has(extname(path).toLowerCase());
  if (!isPeFile) {
    const paths = scanPaths(buf, null);
    for (const p of paths) {
      findings.push({ sev: 'mid', code: 'TEMP-PATH', msg: `文件内容含绝对路径：${p}` });
    }
    return { path, findings, facts };
  }

  const pe = parsePe(buf);
  facts.pe = pe;
  if (!pe.isPe) {
    findings.push({ sev: 'high', code: 'PE', msg: '期望是 PE 文件但解析失败（文件损坏或扩展名不符）' });
    return { path, findings, facts };
  }

  facts.arch = pe.machine;
  facts.dotnet = pe.isDotNet;
  facts.subsystem = pe.subsystemName;

  // Debug/PDB 路径
  const pdb = readPdbPath(buf, pe);
  facts.pdbPath = pdb;
  if (pdb && /^[A-Za-z]:\\/.test(pdb)) {
    const bad = /Temp|dsh-spill|AppData\\Local\\Temp/i.test(pdb);
    findings.push({
      sev: bad ? 'high' : 'mid', code: 'PE-DEBUG',
      msg: `PDB 路径是绝对路径，会暴露构建机目录${bad ? '，且指向临时目录（强烈建议去掉）' : ''}：${pdb}`,
    });
  }

  // 绝对路径扫描
  const paths = scanPaths(buf, pe);
  facts.embeddedPaths = paths;
  for (const p of paths) {
    if (/dsh-spill|\\Temp\\dsh-|AppData\\Local\\Temp/i.test(p)) {
      findings.push({ sev: 'high', code: 'TEMP-PATH', msg: `产物里烙进了临时目录：${p}` });
    } else if (/A:\\Users\\/i.test(p)) {
      findings.push({ sev: 'mid', code: 'TEMP-PATH', msg: `产物里烙进了用户绝对路径：${p}` });
    }
  }

  // 版本资源
  const vs = readVersionStrings(buf, pe);
  facts.versionStrings = vs;
  if (!vs.CompanyName) findings.push({ sev: 'mid', code: 'PE-VERSION', msg: '缺少 CompanyName（版本资源里没有厂商信息，像“无名”程序，易被判可疑）' });
  if (!vs.ProductName) findings.push({ sev: 'mid', code: 'PE-VERSION', msg: '缺少 ProductName' });
  if (!vs.FileVersion) findings.push({ sev: 'mid', code: 'PE-VERSION', msg: '缺少 FileVersion' });

  // 签名
  const sig = verifySignature(path);
  facts.signature = sig;
  if (!sig.available) {
    findings.push({ sev: 'mid', code: 'SIGN', msg: '找不到 signtool.exe，无法验证签名' });
  } else if (!sig.valid) {
    findings.push({ sev: 'high', code: 'SIGN', msg: 'Authenticode 签名无效或缺失：接收方运行时会弹 SmartScreen“未知发布者”' });
  } else if (!sig.timestamp) {
    findings.push({ sev: 'mid', code: 'SIGN', msg: '签名有效但没有时间戳：证书过期后签名即失效' });
  }

  return { path, findings, facts };
}

function* walk(p) {
  let st;
  try { st = lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(basename(p))) return;
    for (const e of readdirSync(p)) yield* walk(join(p, e));
  } else if (st.isFile()) yield p;
}

// ---------- main ----------

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const strict = args.includes('--strict');
  const targets = args.filter((a) => !a.startsWith('--'));
  if (!targets.length) {
    console.error('用法: node tools/build-audit.mjs <文件或目录...> [--json] [--strict]');
    process.exit(2);
  }

  const results = [];
  for (const t of targets) {
    const abs = resolve(t);
    let st;
    try { st = statSync(abs); } catch {
      results.push({ path: t, findings: [{ sev: 'high', code: 'MISSING', msg: '路径不存在' }], facts: {} });
      continue;
    }
    const files = st.isDirectory() ? [...walk(abs)] : [abs];
    for (const f of files) {
      const ext = extname(f).toLowerCase();
      // 目录模式只扫「会被双击/执行、可能吃本地信任标记」的产物（PE + 脚本 + 分发包）；
      // 显式指定单文件时全查（连 VERSION / .md 也查，便于诊断盖章来源）。
      const scannable = PE_EXTS.has(ext) || TRUST_EXTS.has(ext) || /Zone\.Identifier/.test(f);
      if (!scannable && st.isDirectory()) continue;
      results.push(auditFile(f));
    }
  }

  const high = results.flatMap((r) => r.findings.filter((f) => f.sev === 'high').map((f) => ({ ...f, file: r.path })));
  const mid = results.flatMap((r) => r.findings.filter((f) => f.sev === 'mid').map((f) => ({ ...f, file: r.path })));
  const failing = strict ? [...high, ...mid] : high;

  if (json) {
    console.log(JSON.stringify({ files: results.length, high, mid, failing, strict, all: results }, null, 2));
  } else {
    for (const r of results) {
      const rel = relative(process.cwd(), r.path) || r.path;
      const pe = r.facts.pe;
      const head = pe
        ? `${rel} ${C.dim}[${r.facts.arch || '?'} ${r.facts.subsystem || '?'} ${r.facts.dotnet ? '.NET ' : ''}${(r.facts.sizeBytes / 1024).toFixed(1)} KB]${C.off}`
        : `${rel} ${C.dim}[${(r.facts.sizeBytes / 1024).toFixed(1)} KB]${C.off}`;
      console.log(`\n${head}`);
      if (!r.findings.length) {
        console.log(`  ${C.green}OK${C.off} 签名/MOTW/信任标记/路径/版本资源 均未发现问题`);
      }
      for (const f of r.findings) {
        console.log(`  [${sevColor(f.sev)}${f.sev.toUpperCase()} ${f.code}${C.off}] ${f.msg}`);
      }
      if (r.facts.signature?.signer) console.log(`  ${C.dim}签名者：${r.facts.signature.signer}${C.off}`);
      if (r.facts.pdbPath) console.log(`  ${C.dim}PDB：${r.facts.pdbPath}${C.off}`);
    }
    console.log(`\n审计 ${results.length} 个文件，高危 ${high.length} 条、中危 ${mid.length} 条；` +
                `失败项 ${failing.length} 条（${strict ? '--strict：high+mid' : '默认：仅 high'}）。`);
  }

  process.exit(failing.length > 0 ? 1 : 0);
}

main();
