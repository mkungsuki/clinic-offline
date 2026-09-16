'use strict';
// Pure, standalone primitives. No database import; no API returns a raw key.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./recovery-core');
const FILE = 'clinic-recovery.wrapped.json';
const LOCAL_FILE = 'recovery-password.json';
const OWNER_FILE = 'backup-owner.json';
const KDF = Object.freeze({ name: 'scrypt', N: 131072, r: 8, p: 1 });
let deriving = false;
const fail = (code, message) => Object.assign(new Error(message), { code, status: code === 'BUSY' ? 409 : 400 });

function passwordText(value) {
  if (typeof value !== 'string') throw fail('PASSWORD_INVALID', 'กรุณาใส่รหัสสำรองข้อมูล');
  const text = value.normalize('NFC');
  if ([...text].length < 12 || [...text].length > 128 || Buffer.byteLength(text) > 512 || /[\x00-\x1f\x7f]/.test(text)) {
    throw fail('PASSWORD_INVALID', 'ใช้รหัสยาว 12–128 ตัวอักษร ใช้คำที่จำได้หลายคำหรือภาษาไทยได้');
  }
  return text;
}
function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw fail('ENVELOPE_INVALID', 'ไฟล์สำหรับใช้รหัสกู้ข้อมูลไม่สมบูรณ์ กรุณาดาวน์โหลดใหม่');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw fail('ENVELOPE_INVALID', 'อ่านไฟล์สำหรับใช้รหัสกู้ข้อมูลไม่ได้ กรุณาดาวน์โหลดใหม่'); }
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.partial-${crypto.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    // Never unlink the last good version before rename.
    fs.renameSync(temporary, file);
  } finally { if (fd != null) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
}
function metadata(e) {
  return { format: e.format, id: e.id, createdAt: e.createdAt, fingerprint: e.fingerprint,
    kdf: e.kdf, salt: e.salt, nonce: e.nonce };
}
function validate(e) {
  if (!e || e.format !== 1 || !/^[a-f0-9-]{36}$/.test(e.id || '') || !/^[a-f0-9]{16}$/.test(e.fingerprint || '') ||
      !Number.isFinite(Date.parse(e.createdAt)) || JSON.stringify(e.kdf) !== JSON.stringify(KDF) ||
      !/^[a-f0-9]{32}$/.test(e.salt || '') || !/^[a-f0-9]{24}$/.test(e.nonce || '') ||
      !/^[a-f0-9]{64}$/.test(e.ciphertext || '') || !/^[a-f0-9]{32}$/.test(e.tag || '')) {
    throw fail('ENVELOPE_INVALID', 'ไฟล์สำหรับใช้รหัสกู้ข้อมูลไม่สมบูรณ์หรือเป็นรุ่นที่ยังไม่รองรับ');
  }
  return e;
}
async function derive(password, salt) {
  if (deriving) throw fail('BUSY', 'กำลังตรวจรหัสอีกคำสั่ง กรุณารอสักครู่แล้วลองใหม่');
  const input = Buffer.from(passwordText(password), 'utf8'); deriving = true;
  try { return await new Promise((resolve, reject) => crypto.scrypt(input, Buffer.from(salt, 'hex'), 32,
    { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 192 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key))); }
  finally { input.fill(0); deriving = false; }
}
async function setPassword({ dataDir, keyFile, password, confirmation, opId, expectedId }) {
  if (!/^[a-f0-9-]{36}$/.test(opId || '')) throw fail('OP_REQUIRED', 'กรุณาเปิดหน้าตั้งรหัสใหม่');
  const file = path.join(dataDir, LOCAL_FILE);
  const previous = fs.existsSync(file) ? validate(readJson(file)) : null;
  if (previous?.id === opId) return { changed: false, id: previous.id, createdAt: previous.createdAt };
  if ((previous?.id || '') !== String(expectedId || '')) throw fail('PASSWORD_CHANGED', 'สถานะรหัสเปลี่ยนไปแล้ว กรุณาตรวจสถานะล่าสุดก่อนตั้งใหม่');
  const text = passwordText(password);
  if (text !== passwordText(confirmation)) throw fail('PASSWORD_MISMATCH', 'รหัสทั้งสองช่องไม่ตรงกัน กรุณาพิมพ์ใหม่');
  const e = { format: 1, id: opId, createdAt: new Date().toISOString(), kdf: KDF,
    salt: crypto.randomBytes(16).toString('hex'), nonce: crypto.randomBytes(12).toString('hex') };
  const wrapping = await derive(text, e.salt);
  let key;
  try {
    // Check again after async KDF so overlapping requests cannot replace a newer operation.
    const current = fs.existsSync(file) ? validate(readJson(file)) : null;
    if ((current?.id || '') !== (previous?.id || '')) throw fail('PASSWORD_CHANGED', 'สถานะรหัสเปลี่ยนไปแล้ว กรุณาตรวจอีกครั้ง');
    key = core.readRecoveryKeyFile(keyFile); e.fingerprint = core.keyFingerprint(key);
    const cipher = crypto.createCipheriv('aes-256-gcm', wrapping, Buffer.from(e.nonce, 'hex'));
    cipher.setAAD(Buffer.from(JSON.stringify(metadata(e))));
    e.ciphertext = Buffer.concat([cipher.update(key), cipher.final()]).toString('hex'); e.tag = cipher.getAuthTag().toString('hex');
    atomicJson(file, e);
    return { changed: true, id: e.id, createdAt: e.createdAt };
  } finally { wrapping.fill(0); if (key) key.fill(0); }
}
function localStatus(dataDir) {
  try { const e = validate(readJson(path.join(dataDir, LOCAL_FILE))); return { ready: true, id: e.id, createdAt: e.createdAt }; }
  catch (error) { return { ready: false, damaged: error.code !== 'ENOENT' }; }
}
function copyEnvelope(dataDir, destination, fingerprint) {
  const file = path.join(dataDir, LOCAL_FILE);
  if (!fs.existsSync(file)) return null;
  const e = validate(readJson(file));
  if (e.fingerprint !== fingerprint) throw fail('KEY_CHANGED', 'รหัสสำรองไม่ตรงกับข้อมูลในเครื่อง กรุณาตั้งรหัสใหม่ก่อนสำรอง');
  atomicJson(path.join(destination, FILE), e);
  if (JSON.stringify(readJson(path.join(destination, FILE))) !== JSON.stringify(e)) throw fail('ENVELOPE_COPY', 'ยังตรวจไฟล์สำหรับใช้รหัสที่ปลายทางไม่ได้ กรุณาสำรองอีกครั้ง');
  return { id: e.id, createdAt: e.createdAt };
}
async function withPassword(directory, password, action) {
  let e;
  try { e = validate(readJson(path.join(directory, FILE))); }
  catch (error) { if (error.code === 'ENOENT') throw fail('ENVELOPE_MISSING', 'โฟลเดอร์นี้ยังไม่มีไฟล์สำหรับใช้รหัส กรุณาดาวน์โหลดให้ครบ หรือใช้ USB กู้ฉุกเฉิน'); throw error; }
  const wrapping = await derive(password, e.salt);
  let key;
  try {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrapping, Buffer.from(e.nonce, 'hex'));
      decipher.setAAD(Buffer.from(JSON.stringify(metadata(e)))); decipher.setAuthTag(Buffer.from(e.tag, 'hex'));
      key = Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'hex')), decipher.final()]);
      if (core.keyFingerprint(key) !== e.fingerprint) throw new Error('fingerprint');
    } catch { throw fail('PASSWORD_WRONG', 'รหัสไม่ตรงกับข้อมูลสำรองชุดนี้ หรือไฟล์สำหรับใช้รหัสเสียหาย กรุณาลองใหม่หรือใช้ USB กู้ฉุกเฉิน'); }
    return await action(key, e);
  } finally { wrapping.fill(0); if (key) key.fill(0); }
}
function ownerData(owner) { return { format: 1, id: owner.id, generation: owner.generation, fingerprint: owner.fingerprint }; }
function signedOwner(owner, key) { const data = ownerData(owner); return { ...data, mac: crypto.createHmac('sha256', key).update(JSON.stringify(data)).digest('hex') }; }
function validOwner(owner, key) {
  if (!owner || owner.format !== 1 || !/^[a-f0-9-]{36}$/.test(owner.id || '') || !Number.isSafeInteger(owner.generation) || owner.generation < 0 || owner.fingerprint !== core.keyFingerprint(key)) return false;
  return /^[a-f0-9]{64}$/.test(owner.mac || '') && crypto.timingSafeEqual(Buffer.from(owner.mac, 'hex'), Buffer.from(signedOwner(owner, key).mac, 'hex'));
}
function ownersAt(destination, key) {
  if (!fs.existsSync(destination)) return [];
  const names = fs.readdirSync(destination).filter(n => /^clinic-owner-[a-f0-9-]{36}\.json$/.test(n));
  if (names.length > 1000) throw fail('OWNER_INVALID', 'พบข้อมูลการย้ายเครื่องมากผิดปกติ กรุณาเลือกโฟลเดอร์สำรองใหม่');
  return names.map(n => { const o = readJson(path.join(destination, n)); if (!validOwner(o, key)) throw fail('OWNER_INVALID', 'โฟลเดอร์นี้เป็นของคลินิกอื่นหรือข้อมูลการย้ายเครื่องเสียหาย ระบบยังไม่เขียนทับ'); return o; });
}
function ensureOwner(dataDir, key) {
  const file = path.join(dataDir, OWNER_FILE);
  if (fs.existsSync(file)) { const o = readJson(file); if (!validOwner(o, key)) throw fail('OWNER_INVALID', 'ข้อมูลประจำเครื่องสำหรับสำรองไม่ตรงกัน ระบบหยุดก่อนเขียนทับ'); return o; }
  const o = signedOwner({ id: crypto.randomUUID(), generation: 0, fingerprint: core.keyFingerprint(key) }, key); atomicJson(file, o); return o;
}
function claimDestination(dataDir, destination, key) {
  const own = ensureOwner(dataDir, key);
  const owners = ownersAt(destination, key);
  if (owners.some(o => o.id !== own.id && o.generation >= own.generation)) throw fail('OLDER_MACHINE', 'พบว่าโฟลเดอร์นี้ถูกใช้จากเครื่องที่กู้ข้อมูลแล้ว ระบบหยุดส่งจากเครื่องนี้เพื่อไม่ให้ทับข้อมูลใหม่ กรุณาใช้งานและสำรองจากเครื่องใหม่');
  if (!owners.length && fs.existsSync(destination) && fs.readdirSync(destination).some(n => /^clinic-.*\.enc$/.test(n)) &&
      !core.listRestorePoints(destination, key).some(p => p.complete && p.encrypted)) {
    throw fail('FOREIGN_BACKUP', 'โฟลเดอร์นี้มีข้อมูลสำรองเดิมที่เครื่องนี้ยังเปิดไม่ได้ กรุณาใช้ตัวช่วยกู้ก่อน หรือเลือกโฟลเดอร์ใหม่ ระบบยังไม่เขียนทับ');
  }
  const target = path.join(destination, `clinic-owner-${own.id}.json`);
  if (!fs.existsSync(target)) atomicJson(target, own);
  return own;
}
function prepareRecoveredSecrets(dataDir, sourceDir, key, envelope) {
  fs.writeFileSync(path.join(dataDir, 'cloud-backup.key'), key, { flag: 'wx', mode: 0o600 });
  if (envelope) atomicJson(path.join(dataDir, LOCAL_FILE), envelope);
  const generations = ownersAt(sourceDir, key).map(o => o.generation);
  const own = signedOwner({ id: crypto.randomUUID(), generation: Math.max(-1, ...generations) + 1, fingerprint: core.keyFingerprint(key) }, key);
  atomicJson(path.join(dataDir, OWNER_FILE), own);
}
function claimRecoveredDestination(dataDir, sourceDir) {
  let key;
  try {
    if (!sourceDir || !fs.statSync(sourceDir).isDirectory()) throw new Error('source unavailable');
    key = core.readRecoveryKeyFile(path.join(dataDir, 'cloud-backup.key'));
    claimDestination(dataDir, sourceDir, key);
    return null;
  } catch {
    // Restored, verified data is usable even if the downloaded source is read-only.
    return 'กู้ข้อมูลแล้ว แต่ยังบันทึกการย้ายเครื่องกลับไปยังโฟลเดอร์สำรองไม่ได้ กรุณาหยุดใช้เครื่องเก่า แล้วตั้งปลายทางสำรองและสำรองจากเครื่องใหม่นี้';
  } finally { if (key) key.fill(0); }
}
module.exports = { FILE, LOCAL_FILE, OWNER_FILE, passwordText, setPassword, localStatus, copyEnvelope,
  withPassword, atomicJson, claimDestination, prepareRecoveredSecrets, claimRecoveredDestination };
