'use strict';
// log ถาวรของ server/supervisor — เกิดจาก incident 2026-08-24: server หายกลางงานหมอ
// แล้วระบบไม่เหลือหลักฐานอะไรเลย (launcher เปิดด้วย start /min ไม่ redirect, ไม่มี crash handler)
// กติกา: ห้าม require lib/db (ต้องใช้ได้แม้ DB เปิดไม่ได้ — นั่นแหละ crash ที่ต้องบันทึก)
// และห้ามเขียนข้อมูลคนไข้ลง log (ไฟล์นี้ถูกส่งออกนอกเครื่องผ่าน "รายงานปัญหา")
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const KEEP_DAYS = 30;

// ตำแหน่ง log: เครื่องที่ติดตั้งจริง = <install>\logs (คนดูแลหาเจอที่เดียวกับ log ติดตั้ง/hotfix)
// dev/test = <DATA_DIR>\logs — ผูกกับ data dir เพื่อให้ harness ที่ใช้ temp DB แยกขาดเองอัตโนมัติ
function resolveLogDir() {
  if (process.env.CLINIC_LOG_DIR) return process.env.CLINIC_LOG_DIR;
  const installRoot = path.join(APP_ROOT, '..');
  if (fs.existsSync(path.join(installRoot, 'update', 'installed.marker'))) return path.join(installRoot, 'logs');
  const dataDir = process.env.CLINIC_DATA_DIR || path.join(APP_ROOT, 'data');
  return path.join(dataDir, 'logs');
}

function pad(n) { return String(n).padStart(2, '0'); }
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function dayKey() { return stamp().slice(0, 10).replace(/-/g, ''); }

function pruneOld(dir, name) {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const file of fs.readdirSync(dir)) {
    if (!file.startsWith(`${name}-`) || !file.endsWith('.log')) continue;
    try { if (fs.statSync(path.join(dir, file)).mtimeMs < cutoff) fs.unlinkSync(path.join(dir, file)); } catch {}
  }
}

// logger เขียนแบบ append รายวัน (server-YYYYMMDD.log) — เขียนไม่ได้ต้องไม่ล้มโปรแกรม (log คือของแถม)
function makeLogger(name) {
  const dir = resolveLogDir();
  try { fs.mkdirSync(dir, { recursive: true }); pruneOld(dir, name); } catch {}
  const write = (level, text) => {
    const line = `${stamp()} [${level}] ${String(text).replace(/\r?\n/g, '\n    ')}\n`;
    try { fs.appendFileSync(path.join(dir, `${name}-${dayKey()}.log`), line); } catch {}
  };
  return { dir, name, info: t => write('info', t), error: t => write('error', t), write };
}

// ต่อ console เข้า log file (console เดิมยังทำงาน) + จับ crash ให้เหลือหลักฐานก่อนตาย
// exit code ตกลงกับ launch/supervisor.js: 1 = crash (เปิดกลับได้), 10 = พอร์ตถูกใช้ (ห้ามเปิดกลับ),
// 11 = ฐานข้อมูลรุ่นใหม่กว่าโปรแกรม (ห้ามเปิดกลับ — เปิดกี่รอบก็เหมือนเดิม ต้องคนแก้)
function install(logger) {
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  console.log = (...args) => { logger.info(args.map(String).join(' ')); origLog(...args); };
  console.error = (...args) => { logger.error(args.map(String).join(' ')); origError(...args); };
  const fatal = (kind, error) => {
    const detail = error && error.stack ? error.stack : String(error);
    logger.write('fatal', `${kind}: ${detail}`);
    origError(`${kind}:`, detail);
    process.exit(error && error.code === 'SCHEMA_TOO_NEW' ? 11 : 1);
  };
  process.on('uncaughtException', error => fatal('uncaughtException', error));
  process.on('unhandledRejection', error => fatal('unhandledRejection', error));
}

module.exports = { resolveLogDir, makeLogger, install, stamp };
