'use strict';
// Backup ที่ตรวจสอบได้: snapshot SQLite ด้วย VACUUM INTO + attachments + SHA-256 manifest
// cloud destination คือโฟลเดอร์ sync ในเครื่อง จึงรายงานเพียง "คัดลอกเข้าโฟลเดอร์แล้ว"
// ไม่กล่าวอ้างว่า provider อัปโหลดสำเร็จจนกว่าจะมี remote verifier ในอนาคต
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, now, today, getSetting, setSetting, BACKUP_DIR, ATTACH_DIR, ASSET_DIR, DATA_DIR } = require('./db');
const KEY_FILE = path.join(DATA_DIR, 'cloud-backup.key');
const passwordRecovery = require('./password-recovery');
const audit = require('./audit');
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function sleepSync(ms) { Atomics.wait(WAIT_BUFFER, 0, 0, ms); }

// Google Drive/OneDrive แบบ virtual drive อาจคืนจาก copy/close ก่อน metadata และเนื้อไฟล์
// จะอ่านกลับได้ครบ จึงตรวจซ้ำแบบมีขอบเขตแทนการตัดสินว่าไฟล์เสียจากครั้งแรก
function verifyHashEventually(file, expectedHash) {
  const delays = [0, 100, 250, 500, 1000, 2000, 4000];
  let lastError = 'checksum ยังไม่ตรง';
  for (const delay of delays) {
    if (delay) sleepSync(delay);
    try {
      const actual = sha256(file);
      if (actual === expectedHash) return actual;
      lastError = 'checksum ยังไม่ตรง';
    } catch (e) { lastError = e.message; }
  }
  throw new Error(`ปลายทาง Cloud ยังอ่านไฟล์ ${path.basename(file)} กลับมาไม่ครบหลังรอ 7.9 วินาที: ${lastError}`);
}

function copyVerified(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const a = sha256(src), b = sha256(dst);
  if (a !== b) throw new Error(`checksum ไม่ตรง: ${path.basename(src)}`);
  return a;
}

function getOrCreateCloudKey() {
  if (!fs.existsSync(KEY_FILE)) {
    const prior = parseDetail(lastBackup()).some(t => ['external', 'cloud_sync'].includes(t.kind) && t.ok);
    if (prior || fs.existsSync(path.join(DATA_DIR, passwordRecovery.LOCAL_FILE)) || fs.existsSync(path.join(DATA_DIR, passwordRecovery.OWNER_FILE)) || getSetting('backup_cloud_key_exported', '0') === '1') {
      throw new Error('ไม่พบข้อมูลปลดล็อกเดิมของเครื่อง กรุณาใช้ตัวช่วยกู้ด้วยรหัสหรือ USB กู้ฉุกเฉิน ระบบจะไม่สร้างกุญแจใหม่ทับทางกู้เดิม');
    }
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const key = fs.readFileSync(KEY_FILE);
  if (key.length !== 32) throw new Error('cloud backup key ไม่ถูกต้อง');
  return key;
}

// format: CBK1 + nonce(12) + ciphertext + authTag(16)
function encryptFileVerified(src, dst, key) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const inFd = fs.openSync(src, 'r'), outFd = fs.openSync(dst, 'w');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    fs.writeSync(outFd, Buffer.from('CBK1')); fs.writeSync(outFd, nonce);
    let n; while ((n = fs.readSync(inFd, buf, 0, buf.length, null)) > 0) fs.writeSync(outFd, cipher.update(buf.subarray(0, n)));
    fs.writeSync(outFd, cipher.final()); fs.writeSync(outFd, cipher.getAuthTag());
  } finally { fs.closeSync(inFd); fs.closeSync(outFd); }
  if (decryptHash(dst, key) !== sha256(src)) throw new Error(`ตรวจไฟล์เข้ารหัสไม่ผ่าน: ${path.basename(src)}`);
}

function encryptToSyncFolderVerified(src, dst, key) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const stage = path.join(BACKUP_DIR, `.cloud-stage-${crypto.randomUUID()}.enc`);
  const partial = `${dst}.partial-${process.pid}`;
  try {
    // เข้ารหัสและพิสูจน์ว่าเปิดกลับได้บน local disk ก่อนแตะ virtual drive
    encryptFileVerified(src, stage, key);
    const encryptedHash = sha256(stage);
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    fs.copyFileSync(stage, partial);
    verifyHashEventually(partial, encryptedHash);

    // publish เฉพาะไฟล์ที่ตรวจครบแล้ว เพื่อไม่ให้ restore เห็นชื่อจริงระหว่างเขียน
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    fs.renameSync(partial, dst);
    verifyHashEventually(dst, encryptedHash);
  } finally {
    try { if (fs.existsSync(stage)) fs.unlinkSync(stage); } catch {}
    try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch {}
  }
}

function decryptHash(file, key, outputFile = null) {
  const stat = fs.statSync(file);
  if (stat.size < 32) throw new Error('ไฟล์ cloud backup ไม่สมบูรณ์');
  const fd = fs.openSync(file, 'r'), head = Buffer.alloc(16), tag = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0); fs.readSync(fd, tag, 0, 16, stat.size - 16);
  if (head.subarray(0, 4).toString() !== 'CBK1') { fs.closeSync(fd); throw new Error('รูปแบบไฟล์ cloud backup ไม่ถูกต้อง'); }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(4)); decipher.setAuthTag(tag);
  const h = crypto.createHash('sha256'), buf = Buffer.allocUnsafe(1024 * 1024);
  const outFd = outputFile ? fs.openSync(outputFile, 'wx') : null;
  let pos = 16, left = stat.size - 32;
  try {
    while (left > 0) {
      const want = Math.min(buf.length, left), n = fs.readSync(fd, buf, 0, want, pos);
      if (!n) throw new Error('ไฟล์ cloud backup ขาดช่วง');
      const plain = decipher.update(buf.subarray(0, n)); h.update(plain); if (outFd != null) fs.writeSync(outFd, plain);
      pos += n; left -= n;
    }
    const tail = decipher.final(); h.update(tail); if (outFd != null) fs.writeSync(outFd, tail);
    return h.digest('hex');
  } finally { fs.closeSync(fd); if (outFd != null) fs.closeSync(outFd); }
}

function syncFiles(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  let copied = 0, checked = 0;
  const files = [];
  if (!fs.existsSync(srcDir)) return { copied, checked, files };
  for (const f of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, f);
    if (!fs.statSync(src).isFile()) continue;
    const dst = path.join(dstDir, f);
    const srcHash = sha256(src);
    if (!fs.existsSync(dst) || sha256(dst) !== srcHash) { copyVerified(src, dst); copied++; }
    else checked++;
    files.push({ name: f, bytes: fs.statSync(src).size, sha256: srcHash });
  }
  return { copied, checked, files };
}

function syncEncryptedFiles(srcDir, dstDir, key) {
  fs.mkdirSync(dstDir, { recursive: true });
  let copied = 0, checked = 0;
  if (!fs.existsSync(srcDir)) return { copied, checked };
  for (const f of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, f); if (!fs.statSync(src).isFile()) continue;
    const dst = path.join(dstDir, `${f}.enc`), hash = sha256(src);
    let same = false;
    if (fs.existsSync(dst)) { try { same = decryptHash(dst, key) === hash; } catch { same = false; } }
    if (!same) { encryptToSyncFolderVerified(src, dst, key); copied++; } else checked++;
  }
  return { copied, checked };
}

function prune() {
  const cutoff = new Date(Date.now() - 30 * 86400000);
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const m = f.match(/^clinic-(\d{4})(\d{2})(\d{2})-(\d{6})(?:-\d{3})?\.(db|manifest\.json)$/);
    if (!m) continue;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
    if (d < cutoff && m[3] !== '01') fs.unlinkSync(path.join(BACKUP_DIR, f));
  }
}

// ชื่อเดิมละเอียดถึงวินาที ทำให้ผู้ใช้กด backup ซ้ำเร็วหรือสอง request ต่อกัน
// ชนไฟล์ VACUUM INTO เดิมได้ ใช้ลำดับ 000-999 ภายในวินาทีเดียวเพื่อให้ชื่อ unique
// และเรียงตามชื่อได้ถูกต้อง โดย recovery parser ยังรองรับไฟล์รุ่นเก่าที่ไม่มีลำดับ
function allocateBackupPaths(startedAt) {
  const base = `${startedAt.slice(0, 10).replace(/-/g, '')}-${startedAt.slice(11, 19).replace(/:/g, '')}`;
  for (let sequence = 0; sequence < 1000; sequence++) {
    const stamp = `${base}-${String(sequence).padStart(3, '0')}`;
    const localFile = path.join(BACKUP_DIR, `clinic-${stamp}.db`);
    const manifestFile = path.join(BACKUP_DIR, `clinic-${stamp}.manifest.json`);
    const destinations = ['backup_dest_1', 'backup_dest_2', 'backup_cloud_dest'].map(k => getSetting(k, '')).filter(Boolean);
    const existsElsewhere = destinations.some(d => fs.existsSync(path.join(d, `${path.basename(localFile)}.enc`)) || fs.existsSync(path.join(d, `${path.basename(manifestFile)}.enc`)));
    if (!fs.existsSync(localFile) && !fs.existsSync(manifestFile) && !existsElsewhere) return { localFile, manifestFile };
  }
  throw new Error('มีการสำรองข้อมูลถี่เกินไปในวินาทีเดียว กรุณารอสักครู่แล้วลองใหม่');
}

// ข้อมูลคนไข้ที่ออกนอกเครื่องคลินิก (USB/external และ Cloud) เข้ารหัส AES-256-GCM เสมอ
// USB หายหรือถูกขโมย = เปิดอ่านไม่ได้ถ้าไม่มี Recovery Key (ซึ่งอยู่บน Recovery Kit แยกต่างหาก)
// เฉพาะ backup ในเครื่อง (BACKUP_DIR) เท่านั้นที่เก็บแบบไม่เข้ารหัส เพราะอยู่บนเครื่องเดียวกับข้อมูลจริงอยู่แล้ว
function copySnapshot(target, localFile, manifestFile) {
  const dest = path.resolve(target.path);
  if (dest === path.resolve(BACKUP_DIR)) throw new Error('ปลายทางซ้ำกับโฟลเดอร์ backup ในเครื่อง');
  fs.mkdirSync(dest, { recursive: true });
  const key = getOrCreateCloudKey();
  try {
    passwordRecovery.claimDestination(DATA_DIR, dest, key);
    const passwordCopy = passwordRecovery.copyEnvelope(DATA_DIR, dest, require('./recovery-core').keyFingerprint(key));
    encryptToSyncFolderVerified(localFile, path.join(dest, `${path.basename(localFile)}.enc`), key);
    const attachments = syncEncryptedFiles(ATTACH_DIR, path.join(dest, 'attachments'), key);
    const assets = syncEncryptedFiles(ASSET_DIR, path.join(dest, 'assets'), key);
    // Publish the restore point last, after its password file and payloads exist.
    encryptToSyncFolderVerified(manifestFile, path.join(dest, `${path.basename(manifestFile)}.enc`), key);
    return { key: target.key, kind: target.kind, path: target.path, ok: true,
      state: 'encrypted_to_sync_folder', encryption: 'AES-256-GCM', attachments, assets, passwordCopy };
  } finally { key.fill(0); }
}

function syncAttachments(dstDir) { return syncFiles(ATTACH_DIR, dstDir); }

function runBackup({ source, actorId } = {}) {
  const requested = ['manual','scheduled','system'].includes(source) ? source : null;
  const who = audit.actor(actorId,requested);
  const origin = requested || (who.actor_id ? 'manual' : 'system');
  const startedAt = now();
  const { localFile, manifestFile } = allocateBackupPaths(startedAt);
  const targets = [];
  let localOk = false;
  try {
    db.exec(`VACUUM INTO '${localFile.replace(/'/g, "''")}'`);
    const integrity = (() => {
      const { DatabaseSync } = require('node:sqlite');
      const checkDb = new DatabaseSync(localFile, { readOnly: true });
      try { return checkDb.prepare('PRAGMA integrity_check').get().integrity_check; }
      finally { checkDb.close(); }
    })();
    if (integrity !== 'ok') throw new Error(`SQLite integrity_check: ${integrity}`);
    const localAttachments = syncAttachments(path.join(BACKUP_DIR, 'attachments'));
    const localAssets = syncFiles(ASSET_DIR, path.join(BACKUP_DIR, 'assets'));
    if (fs.existsSync(path.join(DATA_DIR, passwordRecovery.LOCAL_FILE))) {
      const key = getOrCreateCloudKey();
      try { passwordRecovery.copyEnvelope(DATA_DIR, BACKUP_DIR, require('./recovery-core').keyFingerprint(key)); }
      finally { key.fill(0); }
    }
    const manifest = {
      format: 1, created_at: startedAt, database: { file: path.basename(localFile),
        bytes: fs.statSync(localFile).size, sha256: sha256(localFile), integrity },
      attachments: localAttachments.files,
      assets: localAssets.files,
    };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
    targets.push({ key: 'local', kind: 'local', path: BACKUP_DIR, ok: true, state: 'verified_copy',
      attachments: { copied: localAttachments.copied, checked: localAttachments.checked } });
    localOk = true;
  } catch (e) {
    targets.push({ key: 'local', kind: 'local', path: BACKUP_DIR, ok: false, state: 'failed', error: e.message });
  }

  const configured = [
    { key: 'backup_dest_1', kind: 'external', path: getSetting('backup_dest_1', '') },
    { key: 'backup_dest_2', kind: 'external', path: getSetting('backup_dest_2', '') },
    { key: 'backup_cloud_dest', kind: 'cloud_sync', path: getSetting('backup_cloud_dest', '') },
  ].filter(t => t.path);
  if (localOk) {
    for (const target of configured) {
      try { targets.push(copySnapshot(target, localFile, manifestFile)); }
      catch (e) { targets.push({ ...target, ok: false, state: 'failed', error: e.message }); }
    }
    try { prune(); } catch (e) { targets.push({ key: 'retention', kind: 'maintenance', ok: false, state: 'failed', error: e.message }); }
  }
  const required = targets.filter(t => t.kind !== 'maintenance');
  const ok = localOk && required.every(t => t.ok);
  const detail = JSON.stringify({ format: 3, targets, source:origin, ...who });
  db.prepare('INSERT INTO backup_log (started_at, finished_at, ok, detail) VALUES (?, ?, ?, ?)')
    .run(startedAt, now(), ok ? 1 : 0, detail);
  return { ok: ok ? 1 : 0, detail, targets };
}

function parseDetail(row) {
  if (!row || !row.detail) return [];
  try { const d = JSON.parse(row.detail); return Array.isArray(d.targets) ? d.targets : []; }
  catch { return []; } // log รุ่นเก่าเป็นข้อความธรรมดา
}
function lastBackup() { return db.prepare('SELECT * FROM backup_log ORDER BY id DESC LIMIT 1').get() || null; }
function lastGoodBackup() { return db.prepare('SELECT * FROM backup_log WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() || null; }

function status() {
  const good = lastGoodBackup(), last = lastBackup();
  const ageH = good ? (Date.now() - new Date(good.finished_at.replace(' ', 'T'))) / 3600000 : Infinity;
  const targets = parseDetail(last);
  const externalOk = targets.some(t => t.kind === 'external' && t.ok);
  const cloud = targets.find(t => t.kind === 'cloud_sync') || null;
  const password = passwordRecovery.localStatus(DATA_DIR);
  return {
    last, lastGood: good, ok: ageH < 25, age_hours: ageH === Infinity ? null : Math.round(ageH * 10) / 10,
    targets, off_device_ok: externalOk || !!(cloud && cloud.ok),
    coverage: externalOk || (cloud && cloud.ok) ? 'multi_copy' : 'local_only',
    cloud, cloud_key_exported: getSetting('backup_cloud_key_exported', '0') === '1',
    password_ready: password.ready,
    password_cloud_ready: !!(password.ready && cloud?.ok && cloud.passwordCopy?.id === password.id),
  };
}

function ensureRecoveryKeyFile() {
  const key = getOrCreateCloudKey();
  const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  key.fill(0);
  return { file: KEY_FILE, fingerprint };
}
function markRecoveryKeyExported() { setSetting('backup_cloud_key_exported', '1'); }

function schedule() {
  setInterval(() => {
    try {
      const at = getSetting('backup_time', '21:00');
      if (now().slice(11, 16) >= at) {
        const doneToday = db.prepare('SELECT 1 FROM backup_log WHERE ok = 1 AND started_at >= ?').get(`${today()} 00:00:00`);
        if (!doneToday) runBackup({source:'scheduled'});
      }
    } catch (e) { console.error('backup schedule error:', e.message); }
  }, 10 * 60 * 1000).unref();
}

module.exports = { runBackup, status, schedule, ensureRecoveryKeyFile, markRecoveryKeyExported, decryptHash, parseDetail };
