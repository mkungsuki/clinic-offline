'use strict';
// Adversarial recovery tests use only synthetic data in a temporary directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const core = require('./lib/recovery-core');
const { createRecoveryKit } = require('./lib/recovery-kit');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-recovery-test-'));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { console.error(`❌ ${name}: ${error.message}`); throw error; }
}

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function makeDb(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE clinic_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare('INSERT INTO clinic_test (value) VALUES (?)').run(value);
  db.exec('PRAGMA user_version=8');
  db.close();
}
function dbValue(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT value FROM clinic_test').get().value; }
  finally { db.close(); }
}
function encrypt(src, dst, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const plain = fs.readFileSync(src);
  const encrypted = Buffer.concat([Buffer.from('CBK1'), nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, encrypted);
}
function fixture(name, options = {}) {
  const source = path.join(root, name);
  const plain = path.join(root, `${name}-plain`);
  fs.mkdirSync(source);
  fs.mkdirSync(plain);
  const stamp = 'clinic-20260810-210000';
  const dbFile = path.join(plain, `${stamp}.db`);
  const attachment = path.join(plain, 'lab-safe.txt');
  makeDb(dbFile, options.value || 'new');
  fs.writeFileSync(attachment, 'synthetic lab data');
  const itemName = options.itemName || 'lab-safe.txt';
  const manifest = {
    format: 1, created_at: '2026-08-10 21:00:00',
    database: { file: `${stamp}.db`, bytes: fs.statSync(dbFile).size, sha256: hash(dbFile), integrity: 'ok' },
    attachments: [{ name: itemName, bytes: fs.statSync(attachment).size, sha256: hash(attachment) }], assets: [],
  };
  const manifestFile = path.join(plain, `${stamp}.manifest.json`);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const key = crypto.randomBytes(32);
  encrypt(dbFile, path.join(source, `${stamp}.db.enc`), key);
  encrypt(manifestFile, path.join(source, `${stamp}.manifest.json.enc`), key);
  if (!options.missingAttachment) encrypt(attachment, path.join(source, 'attachments', 'lab-safe.txt.enc'), key);
  const keyFile = path.join(root, `${name}-key.txt`);
  fs.writeFileSync(keyFile, `CLINIC-BACKUP-KEY-1:${key.toString('base64')}`);
  return { source, key, keyFile, manifestFile: `${stamp}.manifest.json.enc` };
}

try {
  test('encrypted restore ตรวจ hash, DB และไฟล์แนบก่อนยืนยัน', () => {
    const f = fixture('good');
    const output = path.join(root, 'good-output');
    const result = core.restoreToNewDirectory({ sourceDir: f.source, keyFile: f.keyFile, outputDir: output });
    assert.equal(result.database.integrity, 'ok');
    assert.equal(dbValue(path.join(output, 'data', 'clinic.db')), 'new');
    assert.equal(fs.readFileSync(path.join(output, 'data', 'attachments', 'lab-safe.txt'), 'utf8'), 'synthetic lab data');
  });

  test('wrong key หยุดและไม่เหลือ decrypted output', () => {
    const f = fixture('wrong-key');
    const wrong = path.join(root, 'wrong-key-file.txt');
    fs.writeFileSync(wrong, `CLINIC-BACKUP-KEY-1:${crypto.randomBytes(32).toString('base64')}`);
    const output = path.join(root, 'wrong-output');
    assert.throws(() => core.restoreToNewDirectory({ sourceDir: f.source, keyFile: wrong, outputDir: output }), /เปิดข้อมูลสำรองไม่ได้/);
    assert.equal(fs.existsSync(output), false);
  });

  test('backup ไม่ครบหยุดก่อน publish และล้าง output', () => {
    const f = fixture('incomplete', { missingAttachment: true });
    const output = path.join(root, 'incomplete-output');
    assert.throws(() => core.restoreToNewDirectory({ sourceDir: f.source, keyFile: f.keyFile, outputDir: output }), /ข้อมูลสำรองไม่ครบ/);
    assert.equal(fs.existsSync(output), false);
  });

  test('manifest path traversal ถูกปฏิเสธ', () => {
    const f = fixture('traversal', { itemName: '../escape.txt' });
    const output = path.join(root, 'traversal-output');
    assert.throws(() => core.restoreToNewDirectory({ sourceDir: f.source, keyFile: f.keyFile, outputDir: output }), /ชื่อไฟล์ที่ไม่ปลอดภัย/);
    assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
  });

  test('manifest ชื่ออุปกรณ์สงวนของ Windows (CON) ถูกปฏิเสธ', () => {
    const f = fixture('reserved', { itemName: 'CON' });
    const output = path.join(root, 'reserved-output');
    assert.throws(() => core.restoreToNewDirectory({ sourceDir: f.source, keyFile: f.keyFile, outputDir: output }), /ชื่อไฟล์ที่ไม่ปลอดภัย/);
    assert.equal(fs.existsSync(output), false);
  });

  test('safe publish เก็บฐานเดิมและ rollback กลับได้', () => {
    const live = path.join(root, 'publish', 'data');
    const prepared = path.join(root, 'publish', 'prepared');
    makeDb(path.join(live, 'clinic.db'), 'old');
    makeDb(path.join(prepared, 'clinic.db'), 'new');
    fs.mkdirSync(path.join(live, 'attachments')); fs.writeFileSync(path.join(live, 'attachments', 'old.txt'), 'old');
    fs.mkdirSync(path.join(prepared, 'attachments')); fs.writeFileSync(path.join(prepared, 'attachments', 'new.txt'), 'new');
    const result = core.publishPreparedData({ preparedDataDir: prepared, liveDataDir: live });
    assert.equal(dbValue(path.join(live, 'clinic.db')), 'new');
    assert.equal(fs.existsSync(path.join(result.rollbackDir, 'data', 'clinic.db')), true);
    core.rollbackPublishedData({ liveDataDir: live, rollbackDir: result.rollbackDir });
    assert.equal(dbValue(path.join(live, 'clinic.db')), 'old');
    assert.equal(fs.existsSync(path.join(live, 'attachments', 'old.txt')), true);
  });

  test('publish failure ย้อนข้อมูลเดิมกลับอัตโนมัติ', () => {
    const live = path.join(root, 'publish-fail', 'data');
    const prepared = path.join(root, 'publish-fail', 'prepared');
    makeDb(path.join(live, 'clinic.db'), 'old-safe');
    makeDb(path.join(prepared, 'clinic.db'), 'new-fails');
    const originalRename = fs.renameSync;
    let injected = false;
    fs.renameSync = function injectFailure(from, to) {
      if (!injected && path.resolve(from) === path.resolve(path.join(prepared, 'clinic.db'))) {
        injected = true; throw new Error('simulated publish interruption');
      }
      return originalRename.call(fs, from, to);
    };
    try { assert.throws(() => core.publishPreparedData({ preparedDataDir: prepared, liveDataDir: live }), /simulated publish interruption/); }
    finally { fs.renameSync = originalRename; }
    assert.equal(injected, true);
    assert.equal(dbValue(path.join(live, 'clinic.db')), 'old-safe');
  });

  test('Recovery Kit ไม่มี app/data และ inventory ไม่บันทึก key', () => {
    const f = fixture('kit');
    const target = path.join(root, 'kit-target'); fs.mkdirSync(target);
    const fakeRuntime = path.join(root, 'node.exe'); fs.writeFileSync(fakeRuntime, 'synthetic runtime');
    const result = createRecoveryKit({ targetRoot: target, keyFile: f.keyFile, appRoot: __dirname,
      runtimePath: fakeRuntime, allowFixedForTest: true, appVersion: 'test' });
    assert.equal(fs.existsSync(path.join(result.kitRoot, 'ClinicApp', 'data')), false);
    const inventory = fs.readFileSync(path.join(result.kitRoot, 'kit-files.json'), 'utf8');
    assert.equal(inventory.includes('Recovery Key'), false);
    assert.equal(inventory.includes('CLINIC-BACKUP-KEY-1:'), false);
  });

  console.log(`\n${passed} recovery adversarial tests ผ่านทั้งหมด`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
