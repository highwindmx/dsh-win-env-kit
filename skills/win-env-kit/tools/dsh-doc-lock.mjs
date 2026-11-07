#!/usr/bin/env node
/**
 * dsh-doc-lock.mjs —— 共享文档的编辑锁（零依赖，Windows 友好）
 *
 * 目的：多 agent / 多会话并发改同一个文档（README、AGENTS.md、CHANGELOG、版本文件…）时，
 *       防止「后写覆盖先写」「内容交错」「编码被翻坏」。DSH 没有跨 agent 文件锁，
 *       这里用一个同级 lockfile 约定来模拟「单一写入者」纪律。
 *
 * 锁文件：<同目录>/.<目标文件名>.lock.json
 *   例：README.md  →  .README.md.lock.json
 *   锁内容：{ agent, pid, since, expires, topic, host }
 *
 * 三条子命令：
 *   claim   --file <f> --agent <id> [--pid <pid>] [--topic <t>] [--ttl-min <N=30>] [--force] [--json]
 *           抢锁。锁不存在/已过期 → 直接拿到（写锁文件，exit 0）。
 *           锁是别人的且新鲜 → 默认拒绝（exit 1，打印持锁者）；加 --force 可强行接管。
 *           锁是自己 → 续期（刷新 since/expires，exit 0）。
 *   check   --file <f> --agent <id> [--json]
 *           只查询，不改文件。
 *           free=无人持锁；mine=自己持锁；expired=别人持锁但已过期（可 --force 接管）；blocked=别人持锁且新鲜。
 *           退出码：free/mine/expired=0；blocked=1。
 *   release --file <f> [--agent <id>] [--force] [--json]
 *           释放锁（删锁文件）。默认只能释放自己；--force 可释放任意。
 *
 * 设计铁律（对应 §8 护栏 gone ≠ error）：锁文件不存在 = 没人在改 = 自由进入，不当失败。
 *   锁过期 = 上一个 agent 多半已失联/被中断 = 可安全接管，不报错。
 *
 * 退出码：0 = 成功/可继续；1 = 被阻塞/拒绝；2 = 用法错。
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';

const TTL_DEFAULT_MIN = 30;
const USAGE = '用法: node tools/dsh-doc-lock.mjs <claim|check|release> --file <目标文件> --agent <id> [--pid <pid>] [--topic <t>] [--ttl-min <N>] [--force] [--json]';

function failUsage() { console.error(USAGE); process.exit(2); }

function lockPathFor(target) {
  const abs = resolve(target);
  return join(dirname(abs), '.' + basename(abs) + '.lock.json');
}

function nowISO() { return new Date().toISOString(); }

function readLock(p) {
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    if (typeof o.expires !== 'number') return null; // 损坏的锁视为无锁
    return o;
  } catch { return null; }
}

function writeLock(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8' });
}

function parseArgs(argv) {
  const a = { _cmd: argv[2], json: false, force: false };
  for (let i = 3; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--force') a.force = true;
    else if (x === '--file') a.file = argv[++i];
    else if (x === '--agent') a.agent = argv[++i];
    else if (x === '--pid') a.pid = argv[++i];
    else if (x === '--topic') a.topic = argv[++i];
    else if (x === '--ttl-min') a.ttl = Number(argv[++i]);
    else failUsage();
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  if (!a._cmd || !['claim', 'check', 'release'].includes(a._cmd)) failUsage();
  if (!a.file) failUsage();
  if ((a._cmd === 'claim') && !a.agent) failUsage();
  if ((a._cmd === 'check') && !a.agent) failUsage();

  const lp = lockPathFor(a.file);
  const lock = readLock(lp);
  const now = Date.now();
  const fresh = lock && now < lock.expires;
  const mine = lock && a.agent && lock.agent === a.agent;

  const out = (obj) => { if (a.json) console.log(JSON.stringify(obj, null, 2)); };

  if (a._cmd === 'check') {
    if (!lock) { console.log('free   无人持锁，可安全编辑'); out({ status: 'free' }); process.exit(0); }
    if (mine) { console.log(`mine   自己已持锁（agent=${lock.agent}，${lock.topic || ''}），可继续`); out({ status: 'mine', lock }); process.exit(0); }
    if (!fresh) { console.log(`expired 别人(${lock.agent})的锁已过期（since=${lock.since}），可用 --force 接管`); out({ status: 'expired', lock }); process.exit(0); }
    console.log(`blocked 被 ${lock.agent} 持锁至 ${new Date(lock.expires).toISOString()}（topic=${lock.topic || ''}），请等待或 --force 接管`);
    out({ status: 'blocked', lock });
    process.exit(1);
  }

  if (a._cmd === 'claim') {
    if (lock && fresh && !mine && !a.force) {
      console.log(`blocked 被 ${lock.agent} 持锁至 ${new Date(lock.expires).toISOString()}，未加 --force 拒绝接管`);
      out({ status: 'blocked', lock });
      process.exit(1);
    }
    if (lock && fresh && !mine && a.force) {
      console.log(`takeover 强行接管 ${lock.agent} 的锁（topic=${lock.topic || ''}）`);
    }
    const ttl = Number.isFinite(a.ttl) ? a.ttl : TTL_DEFAULT_MIN;
    const obj = {
      agent: a.agent,
      pid: a.pid || String(process.pid),
      since: nowISO(),
      expires: now + ttl * 60000,
      topic: a.topic || '',
      host: process.env.COMPUTERNAME || '',
    };
    writeLock(lp, obj);
    console.log(`claimed 已对 ${a.file} 取得编辑锁（agent=${a.agent}，ttl=${ttl}min，锁文件 ${lp}）`);
    out({ status: 'claimed', lock: obj, lockFile: lp });
    process.exit(0);
  }

  if (a._cmd === 'release') {
    if (!lock) { console.log('gone   锁文件已不存在（视为已释放），无需操作'); out({ status: 'gone' }); process.exit(0); }
    if (!mine && !a.force) {
      console.log(`refused 锁属于 ${lock.agent}，非本人且无 --force，拒绝释放`);
      out({ status: 'refused', lock });
      process.exit(1);
    }
    try { unlinkSync(lp); } catch (e) { if (e.code !== 'ENOENT') { console.error('删除锁失败：' + e.message); process.exit(1); } }
    console.log(`released 已释放 ${a.file} 的编辑锁${a.force && !mine ? '（强行）' : ''}`);
    out({ status: 'released', lockFile: lp });
    process.exit(0);
  }
}

main();
