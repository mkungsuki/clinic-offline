'use strict';
// Pure recovery primitives. This module must never import ./db because the
// standalone assistant has to work when the live ClinicApp database cannot open.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const KEY_PREFIX = 'CLINIC-BACKUP-KEY-1:';
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
// รุ่นใหม่เติมลำดับ 000-999 เพื่อไม่ให้ backup ภายในวินาทีเดียวชนกัน;
// optional เพื่ออ่าน backup รุ่นเก่าที่ไม่มีลำดับได้เสมอ
const MANIFEST_RE = /^clinic-(\d{8})-(\d{6})(?:-\d{3})?\.manifest\.json(\.enc)?$/;
const DB_RE = /^clinic-\d{8}-\d{6}(?:-\d{3})?\.db$/;
const SAFE_FILE_RE = /^(?!\.)[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
// ชื่ออุปกรณ์สงวนของ Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9) เปิด/เขียนเป็นไฟล์ไม่ได้ตามปกติ
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

function recoveryError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function parseRecoveryKeyText(text) {
  const match = String(text || '').match(/CLINIC-BACKUP-KEY-1:([A-Za-z0-9+/=]+)/);
  if (!match) throw recoveryError('WRONG_KEY', 'ไฟล์กู้ข้อมูลนี้ไม่ถูกต้อง กรุณาใช้ไฟล์จาก Recovery Kit ของคลินิกนี้');
  let key;
  try { key = Buffer.from(match[1], 'base64'); }
  catch { throw recoveryError('WRONG_KEY', 'ไฟล์กู้ข้อมูลนี้ไม่ถูกต้อง กรุณาใช้ไฟล์จาก Recovery Kit ของคลินิกนี้'); }
  if (key.length !== 32) throw recoveryError('WRONG_KEY', 'ไฟล์กู้ข้อมูลนี้ไม่ถูกต้อง กรุณาใช้ไฟล์จาก Recovery Kit ของคลินิกนี้');
  return key;
}

// อ่านกุญแจได้ 2 รูปแบบที่ระบบสร้างขึ้นเอง:
//   - ไฟล์ในเครื่อง cloud-backup.key = raw 32 bytes (backup.js เขียนไว้)
//   - Recovery Key.txt บน Kit = ข้อความ "CLINIC-BACKUP-KEY-1:<base64>"
// แยกด้วยขนาด: ไฟล์ข้อความยาวกว่า 32 เสมอ (prefix อย่างเดียว 20 ตัว) จึงไม่กำกวม
function readRecoveryKeyFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw recoveryError('WRONG_KEY', 'ไฟล์กู้ข้อมูลนี้ไม่ถูกต้อง');
  const raw = fs.readFileSync(file);
  if (raw.length === 32) return Buffer.from(raw);
  return parseRecoveryKeyText(raw.toString('utf8'));
}

function assertRegularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { throw recoveryError('BACKUP_INCOMPLETE', `ข้อมูลสำรองไม่ครบ: ไม่พบ${label}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw recoveryError('BACKUP_INCOMPLETE', `ข้อมูลสำรองไม่ปลอดภัย: ${label}`);
  return stat;
}

function decryptChunks(src, key, onPlain) {
  const stat = assertRegularFile(src, 'ไฟล์เข้ารหัส');
  if (stat.size < 32) throw recoveryError('BACKUP_INCOMPLETE', 'ข้อมูลสำรองไม่ครบ');
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(16);
  const tag = Buffer.alloc(16);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    fs.readSync(fd, head, 0, 16, 0);
    fs.readSync(fd, tag, 0, 16, stat.size - 16);
    if (head.subarray(0, 4).toString() !== 'CBK1') throw recoveryError('BACKUP_FORMAT', 'รูปแบบข้อมูลสำรองไม่ถูกต้อง');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(4));
    decipher.setAuthTag(tag);
    let position = 16;
    let left = stat.size - 32;
    while (left > 0) {
      const wanted = Math.min(buffer.length, left);
      const read = fs.readSync(fd, buffer, 0, wanted, position);
      if (!read) throw recoveryError('BACKUP_INCOMPLETE', 'ข้อมูลสำรองขาดช่วง');
      const plain = decipher.update(buffer.subarray(0, read));
      hash.update(plain);
      onPlain(plain);
      position += read;
      left -= read;
    }
    const tail = decipher.final();
    hash.update(tail);
    onPlain(tail);
    return hash.digest('hex');
  } catch (error) {
    if (error.code) throw error;
    throw recoveryError('WRONG_KEY_OR_DAMAGED', 'เปิดข้อมูลสำรองไม่ได้ อาจใช้ Recovery Kit คนละชุดหรือไฟล์ยังมาไม่ครบ');
  } finally { fs.closeSync(fd); }
}

function decryptToBuffer(src, key, maxBytes = MAX_MANIFEST_BYTES) {
  const chunks = [];
  let size = 0;
  decryptChunks(src, key, chunk => {
    size += chunk.length;
    if (size > maxBytes) throw recoveryError('BACKUP_FORMAT', 'รายละเอียดข้อมูลสำรองมีขนาดผิดปกติ');
    chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks);
}

function decryptToNewFile(src, dst, key) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const fd = fs.openSync(dst, 'wx');
  try { return decryptChunks(src, key, chunk => fs.writeSync(fd, chunk)); }
  catch (error) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(dst); } catch {}
    throw error;
  } finally { try { fs.closeSync(fd); } catch {} }
}

function copyToNewFile(src, dst) {
  assertRegularFile(src, 'ไฟล์ข้อมูล');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const input = fs.openSync(src, 'r');
  const output = fs.openSync(dst, 'wx');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
      const chunk = buffer.subarray(0, read);
      fs.writeSync(output, chunk);
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch (error) {
    try { fs.unlinkSync(dst); } catch {}
    throw error;
  } finally { fs.closeSync(input); fs.closeSync(output); }
}

function safeItemName(name) {
  const value = String(name || '');
  if (!SAFE_FILE_RE.test(value) || path.basename(value) !== value || value.includes('..') || WINDOWS_RESERVED_RE.test(value)) {
    throw recoveryError('BACKUP_FORMAT', 'ข้อมูลสำรองมีชื่อไฟล์ที่ไม่ปลอดภัย');
  }
  return value;
}

function validateManifest(manifest) {
  if (!manifest || manifest.format !== 1 || !manifest.database) throw recoveryError('BACKUP_FORMAT', 'รายละเอียดข้อมูลสำรองไม่ถูกต้อง');
  const dbFile = safeItemName(manifest.database.file);
  if (!DB_RE.test(dbFile)) throw recoveryError('BACKUP_FORMAT', 'ชื่อฐานข้อมูลในข้อมูลสำรองไม่ถูกต้อง');
  if (!/^[a-f0-9]{64}$/.test(String(manifest.database.sha256 || ''))) throw recoveryError('BACKUP_FORMAT', 'ข้อมูลตรวจสอบฐานข้อมูลไม่ถูกต้อง');
  const seen = new Set();
  const validateItems = (items, kind) => (Array.isArray(items) ? items : []).map(item => {
    const name = safeItemName(item.name);
    const unique = `${kind}:${name.toLowerCase()}`;
    if (seen.has(unique)) throw recoveryError('BACKUP_FORMAT', 'ข้อมูลสำรองมีชื่อไฟล์ซ้ำ');
    seen.add(unique);
    if (!/^[a-f0-9]{64}$/.test(String(item.sha256 || ''))) throw recoveryError('BACKUP_FORMAT', 'ข้อมูลตรวจสอบไฟล์ไม่ถูกต้อง');
    return { name, sha256: item.sha256, bytes: Number(item.bytes) || null };
  });
  return {
    format: 1,
    created_at: String(manifest.created_at || ''),
    database: { file: dbFile, sha256: manifest.database.sha256, bytes: Number(manifest.database.bytes) || null },
    attachments: validateItems(manifest.attachments, 'attachments'),
    assets: validateItems(manifest.assets, 'assets'),
  };
}

function readManifest(sourceDir, manifestFile, key = null) {
  const name = path.basename(manifestFile);
  const match = name.match(MANIFEST_RE);
  if (!match) throw recoveryError('BACKUP_FORMAT', 'ไม่รู้จักจุดกู้ข้อมูลนี้');
  const full = path.join(sourceDir, name);
  assertRegularFile(full, 'รายละเอียดข้อมูลสำรอง');
  let text;
  if (match[3]) {
    if (!key) throw recoveryError('KEY_REQUIRED', 'กรุณาเสียบ Recovery Kit');
    text = decryptToBuffer(full, key).toString('utf8');
  } else {
    const stat = fs.statSync(full);
    if (stat.size > MAX_MANIFEST_BYTES) throw recoveryError('BACKUP_FORMAT', 'รายละเอียดข้อมูลสำรองมีขนาดผิดปกติ');
    text = fs.readFileSync(full, 'utf8');
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw recoveryError('BACKUP_FORMAT', 'อ่านรายละเอียดข้อมูลสำรองไม่ได้'); }
  return { manifest: validateManifest(parsed), encrypted: !!match[3], manifestFile: name };
}

function listRestorePoints(sourceDir, key = null) {
  const root = path.resolve(sourceDir);
  let names;
  try { names = fs.readdirSync(root); }
  catch { throw recoveryError('SOURCE_MISSING', 'ยังไม่พบที่เก็บข้อมูลสำรอง กรุณาเสียบไดรฟ์หรือเปิด Google Drive'); }
  const points = [];
  for (const name of names.filter(value => MANIFEST_RE.test(value)).sort().reverse()) {
    try {
      const read = readManifest(root, name, key);
      const expectedDb = path.join(root, `${read.manifest.database.file}${read.encrypted ? '.enc' : ''}`);
      assertRegularFile(expectedDb, 'ฐานข้อมูล');
      points.push({
        id: name,
        createdAt: read.manifest.created_at,
        encrypted: read.encrypted,
        attachments: read.manifest.attachments.length,
        assets: read.manifest.assets.length,
        databaseBytes: read.manifest.database.bytes,
        complete: true,
      });
    } catch (error) {
      points.push({ id: name, complete: false, errorCode: error.code || 'INVALID_BACKUP' });
    }
  }
  return points;
}

function verifyDatabase(dbFile) {
  const database = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const integrityRows = database.prepare('PRAGMA integrity_check').all();
    const integrity = integrityRows.map(row => Object.values(row)[0]);
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw recoveryError('DB_DAMAGED', 'ฐานข้อมูลสำรองตรวจไม่ผ่าน');
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw recoveryError('DB_RELATION_ERROR', 'ข้อมูลสำรองมีความเชื่อมโยงไม่ครบ');
    const userVersion = database.prepare('PRAGMA user_version').get().user_version;
    const tables = database.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().count;
    if (!tables) throw recoveryError('DB_FORMAT', 'ไฟล์นี้ไม่ใช่ฐานข้อมูล ClinicApp');
    return { integrity: 'ok', foreignKeys: 'ok', userVersion, tables };
  } finally { database.close(); }
}

function restoreToNewDirectory(options) {
  const sourceDir = path.resolve(options.sourceDir);
  const outputDir = path.resolve(options.outputDir);
  if (fs.existsSync(outputDir)) throw recoveryError('OUTPUT_EXISTS', 'พื้นที่ซ้อมกู้นี้มีข้อมูลอยู่แล้ว ระบบจึงไม่เขียนทับ');
  const key = options.key || (options.keyFile ? readRecoveryKeyFile(options.keyFile) : null);
  let created = false;
  try {
    const candidates = fs.readdirSync(sourceDir).filter(name => MANIFEST_RE.test(name)).sort();
    if (!candidates.length) throw recoveryError('NO_BACKUP', 'ไม่พบข้อมูลสำรองที่ใช้กู้ได้');
    const selected = options.manifestFile || candidates[candidates.length - 1];
    const read = readManifest(sourceDir, selected, key);
    const expectedBytes = (read.manifest.database.bytes || 0) +
      read.manifest.attachments.reduce((sum, item) => sum + (item.bytes || 0), 0) +
      read.manifest.assets.reduce((sum, item) => sum + (item.bytes || 0), 0);
    try {
      const space = fs.statfsSync(path.dirname(outputDir));
      const available = Number(space.bavail) * Number(space.bsize);
      const required = Math.ceil(expectedBytes * 1.2) + 64 * 1024 * 1024;
      if (available < required) throw recoveryError('SPACE_LOW', 'พื้นที่ในเครื่องไม่พอสำหรับซ้อมกู้ กรุณาเพิ่มพื้นที่แล้วลองใหม่');
    } catch (error) {
      if (error.code === 'SPACE_LOW') throw error;
      // Some virtual filesystems do not expose statfs; exclusive writes and
      // cleanup still keep the operation fail-safe in that environment.
    }
    fs.mkdirSync(outputDir, { recursive: false });
    created = true;
    const dataDir = path.join(outputDir, 'data');
    fs.mkdirSync(dataDir);
    const transfer = (relativeDir, item, destination) => {
      const suffix = read.encrypted ? '.enc' : '';
      const src = path.join(sourceDir, relativeDir, `${item.name}${suffix}`);
      const actual = read.encrypted ? decryptToNewFile(src, destination, key) : copyToNewFile(src, destination);
      if (actual !== item.sha256) throw recoveryError('CHECKSUM_MISMATCH', 'ข้อมูลสำรองตรวจไม่ผ่าน กรุณาเลือกจุดกู้อื่น');
    };
    const dbSource = path.join(sourceDir, `${read.manifest.database.file}${read.encrypted ? '.enc' : ''}`);
    const dbOut = path.join(dataDir, 'clinic.db');
    const dbHash = read.encrypted ? decryptToNewFile(dbSource, dbOut, key) : copyToNewFile(dbSource, dbOut);
    if (dbHash !== read.manifest.database.sha256) throw recoveryError('CHECKSUM_MISMATCH', 'ฐานข้อมูลสำรองตรวจไม่ผ่าน');
    for (const item of read.manifest.attachments) transfer('attachments', item, path.join(dataDir, 'attachments', item.name));
    for (const item of read.manifest.assets) transfer('assets', item, path.join(dataDir, 'assets', item.name));
    const database = verifyDatabase(dbOut);
    const result = {
      ok: true,
      backupCreatedAt: read.manifest.created_at,
      manifestFile: read.manifestFile,
      encrypted: read.encrypted,
      database,
      attachments: read.manifest.attachments.length,
      assets: read.manifest.assets.length,
      keyFingerprint: key ? keyFingerprint(key) : null,
    };
    fs.writeFileSync(path.join(outputDir, 'RESTORE-VERIFIED.json'), JSON.stringify(result, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(outputDir, 'RESTORE-VERIFIED.txt'),
      `ตรวจสอบข้อมูลสำรองสำเร็จ\nข้อมูลถึงเวลา: ${read.manifest.created_at}\n`, { encoding: 'utf8', flag: 'wx' });
    return result;
  } catch (error) {
    if (created) { try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {} }
    throw error;
  } finally { if (key && options.keyFile) key.fill(0); }
}

function directoryBytes(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw recoveryError('UNSAFE_PATH', 'พบทางลัดไฟล์ที่ไม่ปลอดภัยในข้อมูลที่จะกู้');
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function writeJournal(file, journal) {
  const temporary = `${file}.partial`;
  fs.writeFileSync(temporary, JSON.stringify(journal, null, 2), { encoding: 'utf8', flush: true });
  fs.renameSync(temporary, file);
}

function publishPreparedData(options) {
  const preparedDataDir = path.resolve(options.preparedDataDir);
  const liveDataDir = path.resolve(options.liveDataDir);
  if (path.parse(liveDataDir).root === liveDataDir || path.parse(preparedDataDir).root === preparedDataDir) {
    throw recoveryError('UNSAFE_PATH', 'ตำแหน่งข้อมูลไม่ปลอดภัย ระบบจึงหยุดก่อน');
  }
  if (path.parse(preparedDataDir).root.toLowerCase() !== path.parse(liveDataDir).root.toLowerCase()) {
    throw recoveryError('DIFFERENT_VOLUME', 'ต้องเตรียมข้อมูลบนไดรฟ์เดียวกับ ClinicApp ก่อนกู้จริง');
  }
  const preparedDb = path.join(preparedDataDir, 'clinic.db');
  verifyDatabase(preparedDb);
  const parent = path.dirname(liveDataDir);
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(liveDataDir, { recursive: true });
  const rollbackRoot = path.join(parent, 'recovery-rollbacks');
  fs.mkdirSync(rollbackRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rollbackDir = path.join(rollbackRoot, `before-${stamp}-${crypto.randomUUID()}`);
  fs.mkdirSync(rollbackDir, { recursive: false });
  const journalFile = path.join(rollbackDir, 'restore-journal.json');
  const journal = { format: 1, state: 'prepared', operationId: options.operationId || null, startedAt: new Date().toISOString(), movedOld: [], published: [] };
  writeJournal(journalFile, journal);
  // Replacing the key also retires any previous envelope/owner. A legacy Kit
  // without an envelope must never leave a different clinic's password active.
  const secretFiles = ['cloud-backup.key', 'recovery-password.json', 'backup-owner.json'];
  const extra = fs.existsSync(path.join(preparedDataDir, 'cloud-backup.key')) ? secretFiles : [];
  const payloads = ['clinic.db', 'clinic.db-wal', 'clinic.db-shm', 'attachments', 'assets', ...extra];
  journal.payloads = payloads;
  const moveIfExists = (from, to, record) => {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    record.push(path.basename(from));
    if (record === journal.movedOld || record === journal.published) writeJournal(journalFile, journal);
    fs.renameSync(from, to);
  };
  try {
    journal.state = 'moving-old';
    for (const name of payloads) {
      moveIfExists(path.join(liveDataDir, name), path.join(rollbackDir, 'data', name), journal.movedOld);
      writeJournal(journalFile, { ...journal, state: 'moving-old' });
    }
    journal.state = 'old-preserved';
    writeJournal(journalFile, journal);
    journal.state = 'publishing-new';
    for (const name of ['clinic.db', 'attachments', 'assets', ...extra]) {
      moveIfExists(path.join(preparedDataDir, name), path.join(liveDataDir, name), journal.published);
      writeJournal(journalFile, { ...journal, state: 'publishing-new' });
    }
    const verified = verifyDatabase(path.join(liveDataDir, 'clinic.db'));
    journal.state = 'committed';
    journal.finishedAt = new Date().toISOString();
    journal.database = verified;
    writeJournal(journalFile, journal);
    return { ok: true, rollbackDir, journalFile, database: verified };
  } catch (error) {
    journal.state = 'rolling-back';
    journal.errorCode = error.code || 'PUBLISH_FAILED';
    writeJournal(journalFile, journal);
    const failedDir = path.join(rollbackDir, 'failed-new');
    fs.mkdirSync(failedDir, { recursive: true });
    try {
      for (const name of journal.published) moveIfExists(path.join(liveDataDir, name), path.join(failedDir, name), []);
      for (const name of journal.movedOld) moveIfExists(path.join(rollbackDir, 'data', name), path.join(liveDataDir, name), []);
    } catch {
      // Keep the write-ahead rolling-back state. Startup must retry the undo,
      // not initialize an empty database after a falsely terminal receipt.
      throw recoveryError('ROLLBACK_INCOMPLETE', 'ยังคืนข้อมูลเดิมไม่ครบ ระบบเก็บข้อมูลเดิมไว้แล้ว กรุณาปิดและเปิดโปรแกรมใหม่เพื่อให้ระบบทำต่อ');
    }
    journal.state = 'rolled-back';
    journal.finishedAt = new Date().toISOString();
    writeJournal(journalFile, journal);
    throw error;
  }
}

function rollbackPublishedData(options) {
  const liveDataDir = path.resolve(options.liveDataDir);
  const rollbackDir = path.resolve(options.rollbackDir);
  const journalFile = path.join(rollbackDir, 'restore-journal.json');
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  if (journal.state !== 'committed') throw recoveryError('ROLLBACK_STATE', 'ไม่สามารถย้อนกลับจากสถานะนี้ได้โดยอัตโนมัติ');
  journal.state = 'rolling-back-after-start-failure';
  writeJournal(journalFile, journal);
  const failedDir = path.join(rollbackDir, 'failed-after-start');
  fs.mkdirSync(failedDir, { recursive: true });
  const moveIfExists = (from, to) => {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  };
  for (const name of journal.payloads || ['clinic.db', 'clinic.db-wal', 'clinic.db-shm', 'attachments', 'assets']) {
    moveIfExists(path.join(liveDataDir, name), path.join(failedDir, name));
  }
  for (const name of journal.movedOld || []) {
    moveIfExists(path.join(rollbackDir, 'data', name), path.join(liveDataDir, name));
  }
  journal.state = 'rolled-back-after-start-failure';
  journal.rolledBackAt = new Date().toISOString();
  writeJournal(journalFile, journal);
  return { ok: true, journalFile };
}

function recoverInterruptedPublications(liveDataDir) {
  const root = path.join(path.dirname(path.resolve(liveDataDir)), 'recovery-rollbacks');
  if (!fs.existsSync(root)) return;
  const allowed = new Set(['clinic.db', 'clinic.db-wal', 'clinic.db-shm', 'attachments', 'assets', 'cloud-backup.key', 'recovery-password.json', 'backup-owner.json']);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('before-')) continue;
    const rollbackDir = path.join(root, entry.name), file = path.join(rollbackDir, 'restore-journal.json');
    if (!fs.existsSync(file)) continue;
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (['committed', 'rolled-back', 'rolled-back-after-start-failure', 'rolled-back-after-interruption'].includes(journal.state)) continue;
    const names = [...new Set([...(journal.movedOld || []), ...(journal.published || [])])];
    if (names.some(n => !allowed.has(n))) throw recoveryError('JOURNAL_INVALID', 'บันทึกการกู้ค้างไม่ถูกต้อง ระบบหยุดเพื่อรักษาข้อมูลเดิม');
    const failed = path.join(rollbackDir, 'interrupted-new'); fs.mkdirSync(failed, { recursive: true });
    for (const name of names) {
      const old = path.join(rollbackDir, 'data', name), live = path.join(liveDataDir, name);
      if (fs.existsSync(old)) {
        if (fs.existsSync(live)) fs.renameSync(live, path.join(failed, `${name}-${crypto.randomUUID()}`));
        fs.renameSync(old, live);
      } else if (!(journal.movedOld || []).includes(name) && (journal.published || []).includes(name) && fs.existsSync(live)) {
        fs.renameSync(live, path.join(failed, `${name}-${crypto.randomUUID()}`));
      }
    }
    writeJournal(file, { ...journal, state: 'rolled-back-after-interruption' });
  }
}

module.exports = {
  KEY_PREFIX,
  parseRecoveryKeyText,
  readRecoveryKeyFile,
  keyFingerprint,
  listRestorePoints,
  restoreToNewDirectory,
  verifyDatabase,
  publishPreparedData,
  rollbackPublishedData,
  recoverInterruptedPublications,
  directoryBytes,
  sha256,
};
