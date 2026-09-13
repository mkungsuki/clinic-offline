'use strict';
// Standalone updater: ถูก spawn หลังดาวน์โหลดเสร็จ และถือ request-file path เท่านั้น
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const core = require('./lib/update-core');

const EXIT_IN_PROGRESS = 3; // launcher ใช้แยกว่า "กำลังอัปเดตอยู่" ออกจาก "กู้ไม่สำเร็จ"

function argument(name) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null; }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: options.headers || {}, timeout: options.timeout || 3000 }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end();
  });
}
async function ready(port) { try { return (await request(port, '/api/recovery/ready')).status === 200; } catch { return false; } }
async function stopClinic(appRoot, port) {
  if (!(await ready(port))) return { wasRunning: false };
  const tokenFile = path.join(appRoot, 'data', 'recovery-control.token');
  if (!fs.existsSync(tokenFile)) throw core.updateError('UPDATE_STOP', 'หยุดระบบเดิมอย่างปลอดภัยไม่ได้ จึงยังไม่เริ่มอัปเดต');
  const token = fs.readFileSync(tokenFile);
  try {
    const result = await request(port, '/api/system/prepare-restore', { method: 'POST', timeout: 5000,
      headers: { 'X-Recovery-Control': token.toString('utf8').trim(), 'Content-Length': '0' } });
    if (result.status !== 200) throw core.updateError('UPDATE_STOP', 'หยุดระบบเดิมอย่างปลอดภัยไม่ได้ จึงยังไม่เริ่มอัปเดต');
  } finally { token.fill(0); }
  for (let i = 0; i < 60; i++) { await wait(250); if (!(await ready(port))) return { wasRunning: true }; }
  throw core.updateError('UPDATE_STOP', 'ระบบเดิมยังปิดไม่สนิท จึงยังไม่แตะไฟล์โปรแกรม');
}
// `ready()` แยกไม่ออกระหว่าง "server ปิดแล้ว" กับ "server ยังอยู่แต่ตอบไม่ทันใน 3 วินาที"
// (เช่นกำลัง VACUUM ตอน backup) — ถ้าเชื่อผิดจะไปสลับไฟล์ทับใต้ server ที่ยังรันอยู่
// จึงต้องพิสูจน์ด้วยการ bind พอร์ตจริงก่อนแตะไฟล์ใด ๆ
function portFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
}
async function ensurePortFree(port) {
  const limit = process.env.CLINIC_UPDATE_TEST === '1' && process.env.CLINIC_UPDATE_PORT_ATTEMPTS
    ? Math.max(1, Number(process.env.CLINIC_UPDATE_PORT_ATTEMPTS)) : 20;
  for (let attempt = 0; attempt < limit; attempt++) {
    if (await portFree(port)) return true;
    await wait(500);
  }
  throw core.updateError('UPDATE_STOP', 'ยังมีโปรแกรมถือพอร์ตของระบบคลินิกอยู่ จึงยังไม่แตะไฟล์โปรแกรม กรุณาปิดระบบคลินิกให้สนิทแล้วลองใหม่');
}

function startClinic(installRoot, port) {
  const appRoot = path.join(installRoot, 'app');
  // เปิดกลับผ่าน supervisor ถ้ารุ่นใหม่มี (เฝ้าเปิดกลับ+log — incident 2026-08-24); ชุดทดสอบ/รุ่นเก่าที่ไม่มีไฟล์นี้ยังเปิด server ตรงได้
  const supervisor = path.join(appRoot, 'launch', 'supervisor.js');
  const entry = fs.existsSync(supervisor) ? path.join('launch', 'supervisor.js') : 'server.js';
  const child = spawn(process.execPath, ['--no-warnings', entry], { cwd: appRoot, detached: true, stdio: 'ignore',
    windowsHide: true, env: { ...process.env, CLINIC_PORT: String(port) } });
  child.unref();
}
async function waitHealthy(installRoot, port, expect, schema) {
  for (let i = 0; i < 60; i++) {
    await wait(500);
    try {
      const readyResult = await request(port, '/api/recovery/ready');
      const loginResult = await request(port, '/login.html');
      if (readyResult.status !== 200 || loginResult.status !== 200) continue;
      const payload = JSON.parse(readyResult.body);
      if (payload.schema !== schema) continue;
      return core.verifyDatabaseHealth(path.join(installRoot, 'app', 'data', 'clinic.db'), expect, schema);
    } catch {}
  }
  throw core.updateError('UPDATE_HEALTH', 'ระบบรุ่นใหม่เปิดหรือตรวจสุขภาพไม่ผ่าน');
}
async function run(requestFile, installRoot, publicKey) {
  const release = core.acquireApplyLock(installRoot);
  try { return await runLocked(requestFile, installRoot, publicKey); }
  finally { release(); }
}

async function runLocked(requestFile, installRoot, publicKey) {
  const appRoot = path.join(installRoot, 'app'), databaseFile = path.join(appRoot, 'data', 'clinic.db');
  const requestData = core.readUpdateRequest(requestFile, installRoot);
  core.ensureDiskSpace(installRoot, databaseFile, requestData.package_file);
  const prepared = core.prepareRelease({ installRoot, request: requestData, publicKey });
  const journalFile = path.join(prepared.updateRoot, core.JOURNAL_NAME);
  const journal = { format: 1, id: requestData.id, state: 'validated', previous_version: requestData.current_version,
    new_version: prepared.manifest.version, expected_schema: prepared.manifest.expected_schema,
    started_at: new Date().toISOString(), updated_at: new Date().toISOString(), snapshot_file: null, files: [], obsolete: [] };
  core.atomicWriteJson(journalFile, journal);
  if (process.env.CLINIC_UPDATE_TEST === '1' && process.env.CLINIC_UPDATE_KILL_AT === 'validated') process.exit(86);
  let stopped = null;
  const rollbackRoot = path.join(prepared.workRoot, 'rollback-app');
  try {
    stopped = await stopClinic(appRoot, requestData.port);
    await ensurePortFree(requestData.port);
    // ลบ session ที่ persist ไว้ — คง invariant ของ health check (ห้ามมีใครถือ session เขียนข้อมูลระหว่างตรวจนับหลังสลับรุ่น)
    // รอบอัปเดตรุ่นจึงเป็นกรณีเดียวที่ผู้ใช้ต้อง login ใหม่ (login.html มีข้อความอธิบายอยู่แล้ว)
    // ใช้ unlink ไม่ใช่ rmSync — rmSync บน path ไทย no-op เงียบ (บทเรียน AGENTS/stage-delivery, เจอซ้ำใน test e2e 2026-08-24)
    const sessionsFile = path.join(appRoot, 'data', 'sessions.json');
    try { if (fs.existsSync(sessionsFile)) fs.unlinkSync(sessionsFile); } catch {}
    if (fs.existsSync(sessionsFile)) throw core.updateError('UPDATE_STOP', 'ลบ session เดิมไม่สำเร็จ จึงยังไม่เริ่มสลับรุ่น');
    core.updateJournal(journalFile, journal, 'server-stopped');
    const snapshot = core.createVerifiedSnapshot({ appRoot, databaseFile, updateId: requestData.id, executable: process.execPath });
    journal.snapshot_file = snapshot.snapshotFile; journal.expect_file = snapshot.expectFile;
    journal.previous_schema = snapshot.receipt.user_version;
    core.updateJournal(journalFile, journal, 'snapshot-created');
    core.runMigrationRehearsal({ executable: process.execPath, workRoot: prepared.workRoot, stagedApp: prepared.stagedApp,
      snapshotFile: snapshot.snapshotFile, expectFile: snapshot.expectFile, expectedSchema: prepared.manifest.expected_schema });
    core.updateJournal(journalFile, journal, 'rehearsal-passed');
    core.applyFileTransaction({ appRoot, stagedApp: prepared.stagedApp, rollbackRoot, manifest: prepared.manifest, journal, journalFile });
    core.updateJournal(journalFile, journal, 'starting-new');
    startClinic(installRoot, requestData.port);
    const health = await waitHealthy(installRoot, requestData.port, snapshot.receipt, prepared.manifest.expected_schema);
    journal.health = health; journal.finished_at = new Date().toISOString();
    core.updateJournal(journalFile, journal, 'committed');
    // เขียน trusted inventory หลัง journal commit เท่านั้น — ถ้าไฟดับคาบเกี่ยว ต้องเหลือ inventory เก่า
    // (รอบหน้าจะปฏิเสธการลบไฟล์แบบเห็นชัด) ดีกว่าเหลือ inventory ใหม่บนโค้ดที่ถูก rollback ไปแล้ว
    core.commitTrustedState(prepared.updateRoot, prepared.manifest);
    core.writeServiceOutcome(appRoot, { state: 'up_to_date', available_version: prepared.manifest.version,
      message: `อัปเดตเป็นรุ่น ${prepared.manifest.version} เรียบร้อยแล้ว` });
    core.cleanupAfterCommit(installRoot, requestData.id, requestFile);
    return { ok: true, version: prepared.manifest.version, state: journal.state };
  } catch (error) {
    let rolledBack = false;
    if (journal.files.some(item => item.old_moved || item.new_published) || ['files-swapped', 'starting-new'].includes(journal.state)) {
      try { await stopClinic(appRoot, requestData.port); } catch {}
      core.rollbackTransaction({ journal, journalFile, appRoot, rollbackRoot });
      rolledBack = true;
      startClinic(installRoot, requestData.port);
      try { await waitHealthy(installRoot, requestData.port, journal.expect_file ? JSON.parse(fs.readFileSync(journal.expect_file, 'utf8')) : {}, Number(journal.previous_schema)); } catch {}
    } else if (stopped?.wasRunning) startClinic(installRoot, requestData.port);
    // ข้อความคงที่เท่านั้น — error.message มี stderr/path ของเครื่องมือปนได้ ห้ามส่งขึ้นหน้าจอผู้ใช้
    core.writeServiceOutcome(appRoot, { state: 'error',
      message: rolledBack
        ? 'อัปเดตไม่สำเร็จ ระบบคืนกลับรุ่นเดิมให้แล้วและใช้งานได้ตามปกติ กรุณาแจ้งผู้ดูแล'
        : 'อัปเดตไม่สำเร็จ ยังไม่มีการเปลี่ยนแปลงกับโปรแกรม ใช้งานได้ตามปกติ กรุณาแจ้งผู้ดูแล' });
    throw error;
  }
}

async function main() {
  const testMode = process.env.CLINIC_UPDATE_TEST === '1';
  const installRoot = testMode && argument('--install-root') ? path.resolve(argument('--install-root')) : path.resolve(__dirname, '..');
  if (process.argv.includes('--recover')) {
    // ผู้ใช้ดับเบิลคลิกไอคอนระหว่างอัปเดตได้เสมอ (หน้าจอค้างไป 1–2 นาที) — ห้าม rollback ทับตัวที่ทำงานอยู่
    let release;
    try { release = core.acquireApplyLock(installRoot); }
    catch (error) {
      if (error.code !== 'UPDATE_IN_PROGRESS') throw error;
      console.log('ระบบกำลังอัปเดตอยู่ กรุณารอประมาณ 1–2 นาที แล้วเปิดใหม่อีกครั้ง');
      process.exitCode = EXIT_IN_PROGRESS;
      return;
    }
    try {
      const result = core.recoverUnfinished({ installRoot });
      console.log(result.recovered ? 'กู้รายการอัปเดตที่ค้างเรียบร้อยแล้ว' : 'ไม่มีรายการอัปเดตค้าง');
    } finally { release(); }
    return;
  }
  const requestFile = argument('--request');
  if (!requestFile) throw core.updateError('UPDATE_REQUEST', 'ไม่พบคำขออัปเดต');
  const publicKeyFile = testMode && process.env.CLINIC_UPDATE_TEST_PUBLIC_KEY
    ? path.resolve(process.env.CLINIC_UPDATE_TEST_PUBLIC_KEY) : path.join(__dirname, 'update-public-key.pem');
  if (!fs.existsSync(publicKeyFile)) throw core.updateError('UPDATE_KEY_MISSING', 'เครื่องนี้ยังไม่มี public key สำหรับตรวจชุดอัปเดต กรุณาใช้ตัวติดตั้งเต็ม');
  const result = await run(path.resolve(requestFile), installRoot, fs.readFileSync(publicKeyFile));
  console.log(`อัปเดตเป็นรุ่น ${result.version} สำเร็จ`);
}

// ล้มก่อนเข้า runLocked (อ่าน request/profile/ดิสก์/ตรวจลายเซ็น) → ยังไม่มีใครเขียนผลกลับ หน้า admin จะค้าง "กำลังเริ่มอัปเดต" ตลอดไป
// (พบ 2026-08-19) → ถ้า service-state ยัง 'starting' ให้เขียน error ที่ระบุว่าไม่มีอะไรเปลี่ยน
function reportEarlyFailure(error) {
  try {
    const testMode = process.env.CLINIC_UPDATE_TEST === '1';
    const installRoot = testMode && argument('--install-root') ? path.resolve(argument('--install-root')) : path.resolve(__dirname, '..');
    const appRoot = path.join(installRoot, 'app');
    let state = null;
    try { state = JSON.parse(fs.readFileSync(path.join(appRoot, 'data', 'update', 'service-state.json'), 'utf8')).state; } catch {}
    if (state === 'starting') core.writeServiceOutcome(appRoot, { state: 'error',
      message: 'อัปเดตไม่สำเร็จ ยังไม่มีการเปลี่ยนแปลงกับโปรแกรม ใช้งานได้ตามปกติ กรุณาแจ้งผู้ดูแล (' + (error.code || 'UPDATE_ERROR') + ')' });
  } catch {}
}
if (require.main === module) main().catch(error => { console.error(error.message || 'อัปเดตไม่สำเร็จ'); reportEarlyFailure(error); process.exitCode = 1; });
module.exports = { run, stopClinic, startClinic, waitHealthy, ensurePortFree, EXIT_IN_PROGRESS };
