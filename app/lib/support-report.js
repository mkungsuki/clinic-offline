'use strict';
// "รายงานปัญหา" ไฟล์เดียวสำหรับตรวจในคลินิกก่อนเปิด GitHub Issue:
// ต้องการหลักฐานจากเครื่องคลินิกโดยผู้ใช้ทำแค่ "กดปุ่มเดียวแล้วส่งไฟล์ที่ได้"
// กติกาเหล็ก: ห้ามมีข้อมูลคนไข้แม้แต่ field เดียว (ไฟล์นี้ออกนอกเครื่องแบบไม่เข้ารหัส)
// → อ่านเฉพาะ: ข้อมูลรุ่น/สถานะระบบ, auth_events/backup_log (ไม่มีชื่อคนไข้โดย schema),
//   log ของ server/supervisor/updater/ติดตั้ง และ crash record จาก Windows Event Log
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { db, now, getSetting, SCHEMA_VERSION, DATA_DIR } = require('./db');
const applog = require('./applog');

const APP_ROOT = path.join(__dirname, '..');
const INSTALL_ROOT = path.join(APP_ROOT, '..');
const TAIL_BYTES = 150 * 1024;   // ต่อไฟล์ log
const MAX_FILES_PER_GROUP = 7;

function section(title, body) {
  return `\n${'='.repeat(60)}\n== ${title}\n${'='.repeat(60)}\n${body || '(ไม่มีข้อมูล)'}\n`;
}

function tailFile(file, bytes = TAIL_BYTES) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return (start > 0 ? `... (ตัดหัวไฟล์ ${start} bytes)\n` : '') + buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (error) { return `(อ่านไม่ได้: ${error.message})`; }
}

function logGroup(dir, prefix) {
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter(n => (prefix ? n.startsWith(prefix) : true) && n.endsWith('.log'))
      .sort().slice(-MAX_FILES_PER_GROUP);
  } catch { return '(ไม่มีโฟลเดอร์นี้)'; }
  if (!names.length) return '(ไม่มีไฟล์ log)';
  return names.map(n => `--- ${n} ---\n${tailFile(path.join(dir, n))}`).join('\n');
}

function readJsonSafe(file) {
  try { return JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return '(ไม่มี/อ่านไม่ได้)'; }
}

function rows(sql, params = []) {
  try {
    const items = db.prepare(sql).all(...params);
    if (!items.length) return '(ว่าง)';
    const keys = Object.keys(items[0]);
    return [keys.join(' | '), ...items.map(r => keys.map(k => r[k] ?? '').join(' | '))].join('\n');
  } catch (error) { return `(query ไม่ได้: ${error.message})`; }
}

// crash record ของ Windows (Application Error / WER) — server รันบนเครื่องหลักซึ่งคือเครื่องที่ crash พอดี
function windowsCrashEvents() {
  const query = provider => new Promise(resolve => {
    execFile('wevtutil', ['qe', 'Application', `/q:*[System[Provider[@Name='${provider}']]]`,
      '/c:15', '/rd:true', '/f:text'], { timeout: 7000, windowsHide: true },
    (error, stdout) => resolve(error ? `(อ่านไม่ได้: ${error.message})` : (stdout.trim() || '(ไม่มีรายการ)')));
  });
  return Promise.all([query('Application Error'), query('Windows Error Reporting')])
    .then(([appError, wer]) => `--- Application Error (15 รายการล่าสุด) ---\n${appError}\n\n--- Windows Error Reporting (15 รายการล่าสุด) ---\n${wer}`);
}

async function buildReport({ uptimeSeconds, port, httpsPort, httpsListening, clockError } = {}) {
  let version = '?';
  try { version = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version; } catch {}
  let schema = '?';
  try { schema = db.prepare('PRAGMA user_version').get().user_version; } catch {}
  const info = [
    `สร้างเมื่อ: ${now()}`,
    `รุ่นโปรแกรม: ${version} (schema ${schema}, รองรับถึง ${SCHEMA_VERSION})`,
    `Node: ${process.version} · pid: ${process.pid} · uptime ของ server: ${Math.round(uptimeSeconds || process.uptime())} วินาที`,
    `พอร์ต: HTTP ${port ?? '?'} · HTTPS ${httpsListening ? httpsPort : 'ปิด'}`,
    `นาฬิกา: ${clockError ? `มีปัญหา — ${clockError}` : 'ปกติ'}`,
    `demo_mode: ${getSetting('demo_mode', '0')}`,
    `install-profile: ${readJsonSafe(path.join(INSTALL_ROOT, 'update', 'install-profile.json'))}`,
    `update service-state: ${readJsonSafe(path.join(DATA_DIR, 'update', 'service-state.json'))}`,
    `active-journal ค้าง: ${fs.existsSync(path.join(INSTALL_ROOT, 'update', 'active-journal.json')) ? 'มี (อัปเดตค้าง!)' : 'ไม่มี'}`,
  ].join('\n');

  const appLogDir = applog.resolveLogDir();
  const parts = [
    '📋 รายงานปัญหาระบบคลินิก (สร้างอัตโนมัติจากปุ่ม "🆘 แจ้งปัญหา")',
    'ไฟล์นี้ไม่มีข้อมูลคนไข้ — มีเฉพาะข้อมูลทางเทคนิคของตัวโปรแกรม ส่งให้ผู้ดูแลระบบได้เลย',
    section('ข้อมูลระบบ', info),
    section('การเข้าใช้ระบบ 14 วันล่าสุด (auth_events)', rows(
      "SELECT created_at, event, username, station, remote FROM auth_events WHERE created_at >= datetime('now', 'localtime', '-14 days') ORDER BY id DESC LIMIT 300")),
    section('ผลสำรองข้อมูล 14 วันล่าสุด (backup_log)', rows(
      "SELECT started_at, finished_at, ok FROM backup_log WHERE started_at >= datetime('now', 'localtime', '-14 days') ORDER BY id DESC LIMIT 60")),
    section('log ของ server', logGroup(appLogDir, 'server-')),
    section('log ของ supervisor (ตัวเฝ้าเปิดกลับ)', logGroup(appLogDir, 'supervisor-')),
    section('log ตัวช่วยอัปเดต', tailFile(path.join(INSTALL_ROOT, 'update', 'logs', 'latest.log'), 100 * 1024)),
    section('log ติดตั้ง/ตั้งค่า (โฟลเดอร์ logs ของชุดติดตั้ง)', logGroup(path.join(INSTALL_ROOT, 'logs'))),
    section('บันทึก crash ของ Windows (Event Log)', await windowsCrashEvents()),
    '\n(จบรายงาน — ไม่มีข้อมูลคนไข้ในไฟล์นี้)\n',
  ];
  return parts.join('\n');
}

function reportFilename() {
  return `รายงานปัญหา-${now().replace(/[-:]/g, '').replace(' ', '-').slice(0, 13)}.txt`;
}

module.exports = { buildReport, reportFilename };
