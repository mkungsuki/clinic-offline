'use strict';
// Transaction core ของ updater — ไม่มี HTTP/UI และไม่เปิดฐาน production เมื่อ require
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { verifyAndParseManifest, checkManifestPolicy } = require('./update-manifest');
const { extractZipExact } = require('./zip');
const { SCHEMA_VERSION, SCHEMA_MARKERS, COUNT_TABLES } = require('./schema-version');

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const JOURNAL_NAME = 'active-journal.json';
const TRUSTED_STATE_NAME = 'trusted-state.json';
const APPLY_LOCK_NAME = 'apply.lock';
const REQUEST_FIELDS = ['format', 'id', 'manifest_file', 'signature_file', 'package_file', 'variant', 'channel',
  'edition', 'current_version', 'port'];
const PROFILE_FIELDS = ['format', 'product', 'edition', 'variant', 'channel', 'port'];
// https_port เพิ่มโดย security round 1 (A-refined) หลังจาก updater ออกแบบไว้ — เป็น optional: มีก็ได้ไม่มีก็ได้ แต่ถ้ามีต้องเป็นพอร์ตจริง
// (พบตอนซ้อมอัปเดตจริง 2026-08-19: assistant ปฏิเสธ profile ของชุดติดตั้งจริงว่า "ขาดหรือเกิน" แล้วหน้าจอค้าง)
const PROFILE_OPTIONAL_FIELDS = ['https_port'];

function updateError(code, message) { const error = new Error(message); error.code = code; return error; }

// Node บางรุ่นบน Windows รายงานว่า rmSync({recursive:true}) สำเร็จ แต่ไม่ลบจริงเมื่อ path มีภาษาไทย
// (บทเรียนเดียวกับ build-installer.js) — updater ใช้ลบสำเนา staged/rehearsal ที่มีข้อมูลคนไข้ จึงห้ามพลาดเงียบ
function removeTreeSync(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) { fs.unlinkSync(target); return; }
  for (const name of fs.readdirSync(target)) removeTreeSync(path.join(target, name));
  fs.rmdirSync(target);
}
function sleepSync(ms) { Atomics.wait(WAIT_BUFFER, 0, 0, ms); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.partial-${process.pid}`;
  const previous = `${file}.previous`;
  // rename ที่ล้ม (AV ล็อกชั่วคราว) ทิ้ง .partial ของ pid นี้ไว้ ทำให้ write ครั้งถัดไป EEXIST ทั้งที่ยังกู้ได้
  try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  // Windows ไม่ยอม rename ทับไฟล์เดิม: เก็บ previous ไว้ตลอดหน้าต่างสลับชื่อ
  // ถ้าไฟดับ จะต้องเหลือ active หรือ previous อย่างน้อยหนึ่งไฟล์ให้ launcher กู้ได้
  if (fs.existsSync(previous)) fs.unlinkSync(previous);
  if (fs.existsSync(file)) fs.renameSync(file, previous);
  try { fs.renameSync(temporary, file); }
  catch (error) { if (!fs.existsSync(file) && fs.existsSync(previous)) fs.renameSync(previous, file); throw error; }
  try { if (fs.existsSync(previous)) fs.unlinkSync(previous); } catch {}
  try { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch {}
}

// ---- single-flight: ห้ามมี assistant สองตัวแตะไฟล์โปรแกรมพร้อมกัน ----
// เคสจริงที่ต้องกัน: (1) กดปุ่มอัปเดตสองครั้ง/สอง request → spawn สองตัว
// (2) ผู้ใช้ดับเบิลคลิกไอคอนเปิดคลินิกระหว่างอัปเดต → launcher เรียก --recover แล้ว rollback ทับตัวที่กำลังสลับไฟล์
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; } // มีอยู่แต่คนละสิทธิ์ = ยังถือว่ามีชีวิต
}

function readApplyLock(installRoot) {
  const lockFile = path.join(path.resolve(installRoot), 'update', APPLY_LOCK_NAME);
  if (!fs.existsSync(lockFile)) return null;
  let holder = null;
  try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return { lockFile, pid: null, alive: false }; }
  return { lockFile, pid: holder?.pid ?? null, started_at: holder?.started_at ?? null, alive: processAlive(holder?.pid) };
}

function acquireApplyLock(installRoot) {
  const updateRoot = path.join(path.resolve(installRoot), 'update');
  fs.mkdirSync(updateRoot, { recursive: true });
  const lockFile = path.join(updateRoot, APPLY_LOCK_NAME);
  const write = () => {
    const fd = fs.openSync(lockFile, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
  try { write(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = readApplyLock(installRoot);
    if (holder?.alive) throw updateError('UPDATE_IN_PROGRESS', 'มีการอัปเดตกำลังทำงานอยู่ กรุณารอให้รอบนี้จบก่อน (ประมาณ 1–2 นาที)');
    // เจ้าของ lock ตายไปแล้ว (ไฟดับ/ถูกฆ่า) — ยึดคืนได้ เพราะงานที่ค้างมี journal คุมและกู้ได้อยู่แล้ว
    try { fs.unlinkSync(lockFile); } catch {}
    try { write(); }
    catch (retryError) {
      if (retryError.code === 'EEXIST') throw updateError('UPDATE_IN_PROGRESS', 'มีการอัปเดตกำลังทำงานอยู่ กรุณารอให้รอบนี้จบก่อน (ประมาณ 1–2 นาที)');
      throw retryError;
    }
  }
  return () => { try { fs.unlinkSync(lockFile); } catch {} };
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw updateError('UPDATE_REQUEST', `${label} ไม่ถูกต้อง`);
  const keys = Object.keys(value).sort(), expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) throw updateError('UPDATE_REQUEST', `${label} มีข้อมูลขาดหรือเกิน`);
}

function containedFile(root, value, label) {
  if (typeof value !== 'string' || !value) throw updateError('UPDATE_REQUEST', `${label} หายไป`);
  const resolved = path.resolve(value);
  const base = path.resolve(root);
  if (!resolved.toLowerCase().startsWith(base.toLowerCase() + path.sep) || !fs.existsSync(resolved) || !fs.lstatSync(resolved).isFile()) {
    throw updateError('UPDATE_REQUEST', `${label} อยู่นอกพื้นที่อัปเดตหรือไม่พบไฟล์`);
  }
  return resolved;
}

function readUpdateRequest(requestFile, installRoot) {
  let request;
  try { request = JSON.parse(fs.readFileSync(requestFile, 'utf8')); } catch { throw updateError('UPDATE_REQUEST', 'อ่านคำขออัปเดตไม่ได้'); }
  exactObject(request, REQUEST_FIELDS, 'คำขออัปเดต');
  if (request.format !== 1 || !/^[a-f0-9-]{16,64}$/i.test(request.id) || !Number.isInteger(request.port) || request.port < 1 || request.port > 65535) {
    throw updateError('UPDATE_REQUEST', 'คำขออัปเดตมีรูปแบบไม่ถูกต้อง');
  }
  const updateRoot = path.join(path.resolve(installRoot), 'update');
  return { ...request,
    manifest_file: containedFile(updateRoot, request.manifest_file, 'manifest'),
    signature_file: containedFile(updateRoot, request.signature_file, 'signature'),
    package_file: containedFile(updateRoot, request.package_file, 'package'),
  };
}

function availableBytes(directory) {
  if (typeof fs.statfsSync !== 'function') return Number.MAX_SAFE_INTEGER;
  const stat = fs.statfsSync(directory, { bigint: true });
  return Number(stat.bavail * stat.bsize);
}

function ensureDiskSpace(installRoot, databaseFile, packageFile) {
  const dbBytes = fs.statSync(databaseFile).size, packageBytes = fs.statSync(packageFile).size;
  const required = 3 * dbBytes + packageBytes;
  const available = availableBytes(installRoot);
  if (available < required) throw updateError('UPDATE_DISK_SPACE', 'พื้นที่ว่างไม่พอสำหรับ snapshot และ rollback กรุณาเพิ่มพื้นที่ก่อนอัปเดต');
  return { required, available, databaseBytes: dbBytes, packageBytes };
}

function loadTrustedState(updateRoot) {
  const file = path.join(updateRoot, TRUSTED_STATE_NAME);
  const readable = fs.existsSync(file) ? file : `${file}.previous`;
  if (!fs.existsSync(readable)) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(readable, 'utf8')); } catch { throw updateError('UPDATE_STATE', 'ประวัติชุดอัปเดตเดิมอ่านไม่ได้'); }
  if (!value || value.format !== 1 || !Array.isArray(value.files) || typeof value.version !== 'string') throw updateError('UPDATE_STATE', 'ประวัติชุดอัปเดตเดิมไม่ถูกต้อง');
  return value;
}

function loadInstallPolicy(installRoot, request) {
  const profileFile = path.join(installRoot, 'update', 'install-profile.json');
  let profile;
  try { profile = JSON.parse(fs.readFileSync(profileFile, 'utf8')); } catch { throw updateError('UPDATE_PROFILE', 'ไม่พบข้อมูลชนิดชุดติดตั้ง กรุณาใช้ตัวติดตั้งเต็ม'); }
  const required = Object.fromEntries(Object.entries(profile).filter(([key]) => !PROFILE_OPTIONAL_FIELDS.includes(key)));
  exactObject(required, PROFILE_FIELDS, 'ข้อมูลชุดติดตั้ง');
  if (profile.https_port !== undefined && (!Number.isInteger(profile.https_port) || profile.https_port < 1 || profile.https_port > 65535)) throw updateError('UPDATE_PROFILE', 'ข้อมูลชนิดชุดติดตั้งไม่ถูกต้อง');
  if (profile.format !== 1 || profile.product !== 'clinic-offline'
    || !['production', 'trial'].includes(profile.variant) || !['pilot', 'stable'].includes(profile.channel)
    || !/^[a-z][a-z0-9-]{0,31}$/.test(profile.edition)
    || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw updateError('UPDATE_PROFILE', 'ข้อมูลชนิดชุดติดตั้งไม่ถูกต้อง');
  let packageJson;
  try { packageJson = JSON.parse(fs.readFileSync(path.join(installRoot, 'app', 'package.json'), 'utf8')); }
  catch { throw updateError('UPDATE_PROFILE', 'อ่าน version ปัจจุบันจากโปรแกรมไม่ได้'); }
  if (typeof packageJson.version !== 'string' || request.current_version !== packageJson.version
    || request.variant !== profile.variant || request.channel !== profile.channel || request.edition !== profile.edition
    || request.port !== profile.port) {
    throw updateError('UPDATE_PROFILE', 'คำขออัปเดตไม่ตรงกับชุดโปรแกรมที่ติดตั้งอยู่');
  }
  return { currentVersion: packageJson.version, variant: profile.variant, channel: profile.channel, edition: profile.edition };
}

function validateObsolete(manifest, trustedState) {
  if (!manifest.obsolete.length) return;
  if (!trustedState) throw updateError('UPDATE_OBSOLETE', 'ยังไม่มี inventory เดิมที่เชื่อถือได้ จึงลบไฟล์เก่าอัตโนมัติไม่ได้');
  const trusted = new Set(trustedState.files.map(item => String(item.path || '').toLocaleLowerCase('en-US')));
  for (const item of manifest.obsolete) if (!trusted.has(item.toLocaleLowerCase('en-US'))) {
    throw updateError('UPDATE_OBSOLETE', `ไม่อนุญาตให้ลบไฟล์ที่ไม่อยู่ใน inventory เดิม: ${item}`);
  }
}

function prepareRelease(options) {
  const { installRoot, request, publicKey } = options;
  const updateRoot = path.join(installRoot, 'update');
  const manifestBytes = fs.readFileSync(request.manifest_file);
  const manifest = verifyAndParseManifest(manifestBytes, fs.readFileSync(request.signature_file), publicKey);
  const installPolicy = loadInstallPolicy(installRoot, request);
  checkManifestPolicy(manifest, { ...installPolicy, expectedSchema: SCHEMA_VERSION, runtimeVersion: process.versions.node });
  if (manifest.package.bytes !== fs.statSync(request.package_file).size || manifest.package.sha256 !== sha256(request.package_file)) {
    throw updateError('UPDATE_PACKAGE_HASH', 'ไฟล์อัปเดตตรวจ SHA-256 ไม่ผ่าน');
  }
  const trustedState = loadTrustedState(updateRoot);
  validateObsolete(manifest, trustedState);
  const workRoot = path.join(updateRoot, request.id);
  if (fs.existsSync(workRoot)) throw updateError('UPDATE_WORK_EXISTS', 'พบพื้นที่ทำงานอัปเดตเดิม กรุณากู้รายการเดิมก่อน');
  const stagedApp = path.join(workRoot, 'staged-app');
  fs.mkdirSync(stagedApp, { recursive: true });
  try { extractZipExact(request.package_file, stagedApp, manifest.files); }
  catch (error) { try { removeTreeSync(workRoot); } catch {} throw error; }
  return { manifest, trustedState, workRoot, stagedApp, updateRoot };
}

function maybeKill(phase) {
  if (process.env.CLINIC_UPDATE_TEST === '1' && process.env.CLINIC_UPDATE_KILL_AT === phase) process.exit(86);
}

function updateJournal(file, journal, state) {
  journal.state = state;
  journal.updated_at = new Date().toISOString();
  atomicWriteJson(file, journal);
  maybeKill(state);
}

function runTool(executable, script, args, options = {}) {
  const result = spawnSync(executable, ['--no-warnings', script, ...args], { cwd: options.cwd,
    env: options.env || process.env, encoding: 'utf8', timeout: options.timeout || 120000, windowsHide: true,
    maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim().slice(0, 1000);
    throw updateError(options.code || 'UPDATE_TOOL_FAILED', `${options.message || 'เครื่องมือตรวจทำงานไม่สำเร็จ'}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function createVerifiedSnapshot(options) {
  const snapshotDir = path.join(options.appRoot, 'data', 'update', options.updateId);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const snapshotFile = path.join(snapshotDir, 'before.db');
  const expectFile = path.join(snapshotDir, 'expect.json');
  const output = runTool(options.executable, path.join(options.appRoot, 'tools', 'pre-upgrade-snapshot.js'),
    [options.databaseFile, snapshotFile], { cwd: options.appRoot, code: 'UPDATE_SNAPSHOT', message: 'สร้าง snapshot ก่อนอัปเดตไม่สำเร็จ' });
  let receipt;
  try { receipt = JSON.parse(output); } catch { throw updateError('UPDATE_SNAPSHOT', 'ผลตรวจ snapshot อ่านไม่ได้'); }
  if (receipt.integrity !== 'ok' || path.resolve(receipt.snapshot) !== path.resolve(snapshotFile)) throw updateError('UPDATE_SNAPSHOT', 'snapshot ตรวจสอบไม่ผ่าน');
  atomicWriteJson(expectFile, receipt);
  return { snapshotDir, snapshotFile, expectFile, receipt };
}

function runMigrationRehearsal(options) {
  const rehearsalRoot = path.join(options.workRoot, 'rehearsal');
  const rehearsalData = path.join(rehearsalRoot, 'data');
  fs.mkdirSync(rehearsalData, { recursive: true });
  fs.copyFileSync(options.snapshotFile, path.join(rehearsalData, 'clinic.db'), fs.constants.COPYFILE_EXCL);
  const output = runTool(options.executable, path.join(options.stagedApp, 'tools', 'migrate-and-verify.js'),
    ['--rehearsal', '--expect', options.expectFile], { cwd: options.stagedApp,
      env: { ...process.env, CLINIC_DATA_DIR: rehearsalData }, code: 'UPDATE_REHEARSAL', message: 'ซ้อม migration บนสำเนาไม่ผ่าน' });
  let result;
  try { result = JSON.parse(output); } catch { throw updateError('UPDATE_REHEARSAL', 'ผลซ้อม migration อ่านไม่ได้'); }
  if (!result.ok || !result.rehearsal || result.user_version !== options.expectedSchema) throw updateError('UPDATE_REHEARSAL', 'ผลซ้อม migration ไม่ตรงกับ manifest');
  // สำเนานี้คือฐานข้อมูลคนไข้ทั้งก้อน ถ้าลบไม่ออกต้องดังไม่ใช่เงียบ
  try { removeTreeSync(rehearsalRoot); } catch {}
  return { ok: true, schema: result.user_version };
}

function retryRenameSync(from, to) {
  const delays = [0, 50, 100, 250, 500, 1000, 2000];
  let last;
  for (const delay of delays) {
    if (delay) sleepSync(delay);
    try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); return; }
    catch (error) { last = error; if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) break; }
  }
  throw updateError('UPDATE_FILE_LOCKED', `ย้ายไฟล์ ${path.basename(from)} ไม่สำเร็จ: ${last?.message || ''}`);
}

function applyFileTransaction(options) {
  const { appRoot, stagedApp, rollbackRoot, manifest, journal, journalFile } = options;
  fs.mkdirSync(rollbackRoot, { recursive: true });
  updateJournal(journalFile, journal, 'swapping-files');
  for (const item of manifest.files) {
    const source = path.join(stagedApp, ...item.path.split('/'));
    const target = path.join(appRoot, ...item.path.split('/'));
    const rollback = path.join(rollbackRoot, ...item.path.split('/'));
    // Leave byte-identical files in place, including the runtime used by a maintenance helper.
    if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink() && fs.statSync(target).size === item.bytes && sha256(target) === item.sha256) continue;
    const record = { path: item.path, old_moved: false, new_published: false };
    journal.files.push(record); atomicWriteJson(journalFile, journal);
    if (fs.existsSync(target)) { retryRenameSync(target, rollback); record.old_moved = true; atomicWriteJson(journalFile, journal); }
    retryRenameSync(source, target); record.new_published = true; atomicWriteJson(journalFile, journal);
    maybeKill(`file:${item.path}`);
  }
  for (const item of manifest.obsolete) {
    const target = path.join(appRoot, ...item.split('/'));
    const rollback = path.join(rollbackRoot, ...item.split('/'));
    const record = { path: item, old_moved: false };
    journal.obsolete.push(record); atomicWriteJson(journalFile, journal);
    if (fs.existsSync(target)) { retryRenameSync(target, rollback); record.old_moved = true; atomicWriteJson(journalFile, journal); }
  }
  updateJournal(journalFile, journal, 'files-swapped');
}

function restoreDatabase(snapshotFile, databaseFile, failedRoot) {
  fs.mkdirSync(failedRoot, { recursive: true });
  const moveAside = source => {
    const base = path.join(failedRoot, path.basename(source));
    let target = base, n = 1;
    while (fs.existsSync(target)) target = `${base}.retry-${n++}`;
    retryRenameSync(source, target);
  };
  for (const suffix of ['', '-wal', '-shm']) {
    const live = databaseFile + suffix;
    if (fs.existsSync(live)) moveAside(live);
  }
  const restoreTemp = `${databaseFile}.update-restore-${process.pid}`;
  fs.copyFileSync(snapshotFile, restoreTemp, fs.constants.COPYFILE_EXCL);
  retryRenameSync(restoreTemp, databaseFile);
}

function rollbackTransaction(options) {
  const { journal, journalFile, appRoot, rollbackRoot } = options;
  updateJournal(journalFile, journal, 'rolling-back');
  const failedRoot = path.join(path.dirname(rollbackRoot), 'failed-new');
  const moveFailedAside = (target, relative) => {
    const base = path.join(failedRoot, ...relative.split('/'));
    let destination = base, n = 1;
    while (fs.existsSync(destination)) destination = `${base}.retry-${n++}`;
    retryRenameSync(target, destination);
  };
  for (const record of [...journal.files].reverse()) {
    const target = path.join(appRoot, ...record.path.split('/'));
    const rollback = path.join(rollbackRoot, ...record.path.split('/'));
    // rollback copy ยังอยู่ = ไฟล์เก่ายังไม่ถูกคืน; ถ้าหายแล้วถือว่ารอบก่อนคืนสำเร็จ
    // จึงห้ามย้าย target ซ้ำ เพราะ target นั้นอาจเป็นไฟล์เก่าที่กู้กลับมาแล้ว
    if (record.old_moved && fs.existsSync(rollback)) {
      if (fs.existsSync(target)) moveFailedAside(target, record.path);
      retryRenameSync(rollback, target);
    } else if (!record.old_moved && record.new_published && fs.existsSync(target)) {
      moveFailedAside(target, record.path);
    }
  }
  for (const record of [...journal.obsolete].reverse()) {
    const target = path.join(appRoot, ...record.path.split('/'));
    const rollback = path.join(rollbackRoot, ...record.path.split('/'));
    if (record.old_moved && fs.existsSync(rollback)) retryRenameSync(rollback, target);
  }
  if (journal.snapshot_file && fs.existsSync(journal.snapshot_file)) {
    restoreDatabase(journal.snapshot_file, path.join(appRoot, 'data', 'clinic.db'), path.join(failedRoot, 'data'));
  }
  updateJournal(journalFile, journal, 'rolled-back');
}

function verifyDatabaseHealth(databaseFile, expect, expectedSchema) {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const foreign = db.prepare('PRAGMA foreign_key_check').all().length;
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const hasColumn = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
    if (integrity !== 'ok' || foreign || schema !== expectedSchema || !SCHEMA_MARKERS.tables.every(hasTable)
      || !SCHEMA_MARKERS.columns.every(([table, column]) => hasColumn(table, column))) throw updateError('UPDATE_HEALTH', 'ฐานข้อมูลหลังอัปเดตตรวจโครงสร้างไม่ผ่าน');
    const counts = {};
    for (const table of [...COUNT_TABLES.exact, ...COUNT_TABLES.atLeast]) counts[table] = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    for (const table of COUNT_TABLES.exact) if (counts[table] !== expect[table]) throw updateError('UPDATE_HEALTH', `${table} มีจำนวนเปลี่ยนไปหลังอัปเดต`);
    for (const table of COUNT_TABLES.atLeast) if (counts[table] < expect[table]) throw updateError('UPDATE_HEALTH', `${table} มีข้อมูลลดลงหลังอัปเดต`);
    return { integrity, schema, counts };
  } finally { db.close(); }
}

function commitTrustedState(updateRoot, manifest) {
  atomicWriteJson(path.join(updateRoot, TRUSTED_STATE_NAME), { format: 1, version: manifest.version,
    variant: manifest.variant, channel: manifest.channel, files: manifest.files, committed_at: new Date().toISOString() });
}

// หลัง commit แล้วสำเนาโค้ด/ZIP ไม่มีประโยชน์อีก ปล่อยไว้จะพอกทุกครั้งที่อัปเดต
// **ไม่ลบ** snapshot ฐานข้อมูลใต้ app/data/update/ — เป็นหลักฐานก่อนอัปเดต ให้เจ้าของตัดสินใจนโยบายเก็บเอง
function cleanupAfterCommit(installRoot, updateId, requestFile) {
  const updateRoot = path.join(path.resolve(installRoot), 'update');
  const targets = [path.join(updateRoot, updateId), path.join(updateRoot, 'downloads', updateId),
    path.join(updateRoot, 'stage-check', updateId)];
  for (const target of targets) { try { removeTreeSync(target); } catch {} }
  if (requestFile) {
    const resolved = path.resolve(requestFile);
    if (resolved.toLowerCase().startsWith(path.join(updateRoot, 'requests').toLowerCase() + path.sep)) {
      try { removeTreeSync(resolved); } catch {}
    }
  }
}

// assistant รันเป็น process แยกและ detached — ถ้าไม่เขียนผลกลับ หน้า admin จะค้างข้อความ
// "กำลังเริ่มอัปเดต ระบบจะกลับมาเองใน 1–2 นาที" ตลอดไป ทั้งที่อัปเดตจบไปแล้ว
// ข้อความต้องเป็นข้อความคงที่ ห้ามใส่ error.message ดิบ (มี path/stderr ของเครื่องมือปนได้)
function writeServiceOutcome(appRoot, value) {
  try {
    atomicWriteJson(path.join(path.resolve(appRoot), 'data', 'update', 'service-state.json'), {
      format: 1, state: value.state, available_version: value.available_version || null,
      checked_at: new Date().toISOString(), message: value.message || null,
      manifest_file: null, signature_file: null, request_file: null,
    });
  } catch {}
}

function recoverUnfinished(options) {
  const activeFile = path.join(options.installRoot, 'update', JOURNAL_NAME);
  const previousFile = `${activeFile}.previous`;
  if (!fs.existsSync(activeFile) && fs.existsSync(previousFile)) fs.renameSync(previousFile, activeFile);
  const journalFile = activeFile;
  if (!fs.existsSync(journalFile)) return { ok: true, recovered: false };
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  if (journal.state === 'committed' || journal.state === 'rolled-back') return { ok: true, recovered: false, state: journal.state };
  const appRoot = path.join(options.installRoot, 'app');
  const rollbackRoot = path.join(options.installRoot, 'update', journal.id, 'rollback-app');
  if (journal.files?.some(item => item.old_moved || item.new_published) || journal.state === 'files-swapped' || journal.state === 'starting-new') {
    rollbackTransaction({ journal, journalFile, appRoot, rollbackRoot });
  } else {
    updateJournal(journalFile, journal, 'rolled-back');
  }
  // ปิดวงให้หน้า admin ด้วย ไม่งั้นจะค้างข้อความ "กำลังเริ่มอัปเดต…" ที่ service เขียนไว้ตอนกดปุ่ม
  writeServiceOutcome(appRoot, { state: 'error',
    message: 'อัปเดตรอบก่อนไม่สำเร็จ ระบบคืนกลับรุ่นเดิมให้แล้วและใช้งานได้ตามปกติ กรุณาแจ้งผู้ดูแล' });
  return { ok: true, recovered: true, state: 'rolled-back' };
}

module.exports = { JOURNAL_NAME, TRUSTED_STATE_NAME, APPLY_LOCK_NAME, atomicWriteJson, readUpdateRequest, ensureDiskSpace,
  prepareRelease, createVerifiedSnapshot, runMigrationRehearsal, applyFileTransaction, rollbackTransaction,
  verifyDatabaseHealth, commitTrustedState, recoverUnfinished, updateJournal, retryRenameSync, updateError, removeTreeSync,
  acquireApplyLock, readApplyLock, cleanupAfterCommit, writeServiceOutcome };
