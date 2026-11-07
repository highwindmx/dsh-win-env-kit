#!/usr/bin/env node
/**
 * dsh-teardown.mjs —— 开发过程卫生收尾（零依赖，Windows 优先走 taskkill）
 *
 * 配套规则：win-env-kit 技能规则 7。
 * 读 _scratch/<date>-<topic>/ledger.json，按台账：
 *   - 杀掉测试遗留进程（按 PID；进程不在 = 已被清理，INFO，绝不报错/重试）
 *   - （可选）删掉过程文档（文件不在 = 已清理，INFO）
 *   - （可选）删掉整个 _scratch/<date>-<topic>/ 目录
 *
 * 设计铁律（对应护栏 "gone ≠ error"）：任何「找不到」都当作已清理的正常态，
 * 不抛错、不重试、不在找不到的东西上做无界循环。
 *
 * 用法：
 *   node tools/dsh-teardown.mjs [--dir <ledger目录>] [--topic <t>] [--date <YYYY-MM-DD>]
 *                              [--check] [--kill] [--rm] [--rmdir] [--dry] [--json]
 *
 *   无 --kill/--rm 时默认两者都做（= 完整收尾）。
 *   --check  只核验一次（进程是否还活着、文件是否还在），不改动任何东西。
 *   --dry    打印将要做什么，不真正执行。
 *   --rmdir  额外递归删除整个 topic 目录（只在 _scratch/ 之下才允许）。
 *
 * 退出码：0 = 收尾完成（含「已清理」都算完成）；2 = 用法错。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, readdirSync, statSync, rmdirSync, statSync as _st } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';

function usage() {
  console.error('用法: node tools/dsh-teardown.mjs [--dir <dir>] [--topic <t>] [--date <YYYY-MM-DD>] [--check] [--kill] [--rm] [--rmdir] [--dry] [--json]');
  process.exit(2);
}

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 在 _scratch/ 下找 ledger.json：给定 date+topic 用确定路径，否则取最新的那个。 */
function resolveLedgerPath(opts) {
  if (opts.dir) return join(opts.dir, 'ledger.json');
  const root = join(process.cwd(), '_scratch');
  if (!existsSync(root)) return null;
  const candidates = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name, 'ledger.json');
    if (existsSync(full)) {
      let mtime = 0;
      try { mtime = statSync(full).mtimeMs; } catch {}
      candidates.push({ name, full, mtime });
    }
  }
  if (opts.date && opts.topic) {
    const exact = join(root, `${opts.date}-${opts.topic}`, 'ledger.json');
    return existsSync(exact) ? exact : null;
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length > 1) {
    console.error(`[INFO] 发现 ${candidates.length} 个 ledger，使用最新的：${candidates[0].name}`);
  }
  return candidates[0].full;
}

function readLedger(path) {
  if (!path || !existsSync(path)) return { processes: [], files: [], _missing: true };
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    return {
      processes: Array.isArray(obj.processes) ? obj.processes : [],
      files: Array.isArray(obj.files) ? obj.files : [],
      _path: path,
    };
  } catch (e) {
    console.error(`[WARN] ledger 解析失败（${path}）：${e.message} —— 跳过收尾`);
    return { processes: [], files: [], _missing: true };
  }
}

/** 核验进程是否还活着（一次性，不循环）。返回 'alive' | 'gone' | 'denied'。 */
function probeProcess(pid) {
  try {
    // signal 0 = 只检查存在，不发送信号；Windows 下可用
    process.kill(Number(pid), 0);
    return 'alive';
  } catch (e) {
    if (e.code === 'ESRCH') return 'gone';
    if (e.code === 'EPERM') return 'denied';
    return 'gone';
  }
}

/** 杀进程：taskkill /F /T，进程不在当已清理。返回 'killed' | 'gone' | 'denied' | 'error'。 */
function killProcess(pid) {
  try {
    // §10.4：捕获管道输出会触发沙箱 spawnSync EPERM；这里只需退出状态，
    // 用 'ignore' 绕开，不读 taskkill 的 stdout/stderr。
    execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], {
      windowsHide: true, stdio: 'ignore',
    });
    return 'killed';
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.toLowerCase();
    if (e.status === 0) return 'killed';
    if (/not found|no running|invalid|128|does not exist|could not be|terminate/.test(out)) return 'gone';
    if (/denied|access is denied|5 /.test(out) || e.code === 'EPERM') return 'denied';
    // stdio 被忽略时拿不到文本，非零状态即「PID 已不在」= 已清理（gone ≠ error）。
    return 'gone';
  }
}

function removeFile(path) {
  if (!existsSync(path)) return 'gone';
  try { unlinkSync(path); return 'removed'; }
  catch (e) {
    if (e.code === 'ENOENT') return 'gone';
    return 'error';
  }
}

function removeDir(dir) {
  // 只在 _scratch/ 之下才允许删除，避免误伤仓库
  const norm = resolve(dir).toLowerCase().replace(/\\/g, '/');
  if (!norm.includes('/_scratch/') && !norm.endsWith('/_scratch')) {
    console.error(`[WARN] 拒绝删除 _scratch/ 之外的目录：${dir}`);
    return 'refused';
  }
  try {
    rmdirSync(dir, { recursive: true, maxRetries: 3 });
    return 'removed';
  } catch (e) { return 'error'; }
}

function main(argv) {
  const args = argv.slice(2);
  const opts = { kill: false, rm: false, rmdir: false, check: false, dry: false, json: false };
  let dir = null, topic = null, date = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') opts.check = true;
    else if (a === '--kill') opts.kill = true;
    else if (a === '--rm') opts.rm = true;
    else if (a === '--rmdir') opts.rmdir = true;
    else if (a === '--dry') opts.dry = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--dir') dir = args[++i];
    else if (a === '--topic') topic = args[++i];
    else if (a === '--date') date = args[++i];
    else if (a.startsWith('--')) usage();
    else usage();
  }
  // 默认完整收尾
  if (!opts.kill && !opts.rm && !opts.rmdir && !opts.check) { opts.kill = true; opts.rm = true; }

  const ledgerPath = resolveLedgerPath({ dir, topic, date });
  const ledger = readLedger(ledgerPath);
  const report = { ledger: ledgerPath || null, processes: [], files: [], dir: null };

  if (ledger._missing) {
    const msg = opts.check ? 'CHECK 没有发现需要核验的台账（_scratch 下无 ledger.json）。' : '没有需要收尾的台账（_scratch 下无 ledger.json）。';
    if (opts.json) { console.log(JSON.stringify({ ...report, note: 'nothing-to-do' }, null, 2)); }
    else { console.log(msg); }
    process.exit(0);
  }

  if (opts.check) {
    for (const pr of ledger.processes) {
      const st = probeProcess(pr.pid);
      const line = { pid: pr.pid, purpose: pr.purpose || '', status: st };
      report.processes.push(line);
      const tag = st === 'alive' ? 'ALIVE ' : st === 'denied' ? 'DENIED' : 'GONE  ';
      console.log(`  [${tag}] PID ${pr.pid}${pr.purpose ? '  (' + pr.purpose + ')' : ''}`);
    }
    for (const f of ledger.files) {
      const st = existsSync(f.path) ? 'present' : 'gone';
      report.files.push({ path: f.path, purpose: f.purpose || '', status: st });
      console.log(`  [${st === 'present' ? 'HAVE  ' : 'GONE  '}] ${f.path}${f.purpose ? '  (' + f.purpose + ')' : ''}`);
    }
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  // 收尾：kill
  if (opts.kill) {
    for (const pr of ledger.processes) {
      const status = opts.dry ? 'dry-kill' : killProcess(pr.pid);
      report.processes.push({ pid: pr.pid, purpose: pr.purpose || '', status });
      if (status === 'killed') console.log(`  [KILLED ] PID ${pr.pid}${pr.purpose ? '  (' + pr.purpose + ')' : ''}`);
      else if (status === 'gone') console.log(`  [GONE   ] PID ${pr.pid} 已不在（用户已清理或早已退出）`);
      else if (status === 'denied') console.log(`  [DENIED ] PID ${pr.pid} 无权限结束（记录一下，需用户手动处理）`);
      else if (status === 'dry-kill') console.log(`  [DRY    ] 将结束 PID ${pr.pid}`);
      else console.log(`  [ERROR  ] PID ${pr.pid} 结束失败：${status}`);
    }
  }

  // 收尾：rm
  if (opts.rm) {
    for (const f of ledger.files) {
      const status = opts.dry ? 'dry-rm' : removeFile(f.path);
      report.files.push({ path: f.path, purpose: f.purpose || '', status });
      if (status === 'removed') console.log(`  [REMOVED] ${f.path}`);
      else if (status === 'gone') console.log(`  [GONE   ] ${f.path} 已不在（用户已清理）`);
      else if (status === 'dry-rm') console.log(`  [DRY    ] 将删除 ${f.path}`);
      else console.log(`  [ERROR  ] ${f.path} 删除失败：${status}`);
    }
  }

  // 收尾：rmdir（整个 topic）
  if (opts.rmdir && ledger._path) {
    const topicDir = dirname(ledger._path);
    const status = opts.dry ? 'dry-rmdir' : removeDir(topicDir);
    report.dir = { path: topicDir, status };
    if (status === 'removed') console.log(`  [RMDIR  ] 已删除 ${topicDir}`);
    else if (status === 'dry-rmdir') console.log(`  [DRY    ] 将删除 ${topicDir}`);
    else console.log(`  [NOTE   ] 目录未删除：${status}（${topicDir}）`);
  }

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  console.log('收尾完成（缺失=已清理，不计入失败）。');
  process.exit(0);
}

main(process.argv);
