'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR, getSetting, setSetting, now } = require('./db');
const backup = require('./backup');
const core = require('./recovery-core');
const discovery = require('./recovery-discovery');
const { createRecoveryKit } = require('./recovery-kit');

const APP_ROOT = path.join(__dirname, '..');
const DRILLS_DIR = path.join(DATA_DIR, 'recovery-drills');

function idFor(value) {
  return crypto.createHash('sha256').update(path.resolve(value).toLowerCase()).digest('hex').slice(0, 16);
}

function hoursSince(value) {
  if (!value) return Infinity;
  const time = new Date(String(value).replace(' ', 'T')).getTime();
  return Number.isFinite(time) ? (Date.now() - time) / 3600000 : Infinity;
}

function health() {
  const current = backup.status();
  const kitFingerprint = getSetting('recovery_kit_fingerprint', '');
  const kitCreatedAt = getSetting('recovery_kit_created_at', '');
  const lastDrillAt = getSetting('recovery_last_drill_at', '');
  const drillFresh = hoursSince(lastDrillAt) <= 24 * 180;
  let state = 'safe';
  let headline = 'ข้อมูลปลอดภัยแล้ว';
  let action = null;
  if (!current.lastGood || !current.ok) {
    state = 'action'; headline = 'ข้อมูลสำรองยังไม่ใหม่พอ'; action = { code: 'RUN_BACKUP', label: 'สำรองข้อมูลตอนนี้' };
  } else if (!current.off_device_ok) {
    state = 'action'; headline = 'ข้อมูลยังอยู่ในเครื่องนี้อย่างเดียว'; action = { code: 'SETUP_BACKUP', label: 'ตั้งค่าการสำรองข้อมูล' };
  } else if (!kitFingerprint) {
    state = 'action'; headline = 'ยังไม่มี USB สำหรับกู้ฉุกเฉิน'; action = { code: 'CREATE_KIT', label: 'สร้าง Recovery Kit' };
  } else if (!lastDrillAt || !drillFresh) {
    state = 'action'; headline = 'ควรซ้อมกู้ข้อมูลเพื่อให้แน่ใจว่าเปิดได้'; action = { code: 'RUN_DRILL', label: 'ซ้อมกู้ข้อมูล' };
  }
  return {
    state, headline, action,
    lastBackupAt: current.lastGood && current.lastGood.finished_at || null,
    offDeviceOk: current.off_device_ok,
    kitReady: !!kitFingerprint,
    kitCreatedAt: kitCreatedAt || null,
    lastDrillAt: lastDrillAt || null,
    drillFresh,
  };
}

function setupOptions() {
  const found = discovery.discover({ knownPaths: [
    getSetting('backup_dest_1', ''), getSetting('backup_dest_2', ''), getSetting('backup_cloud_dest', ''),
  ].filter(Boolean) });
  const external = found.volumes.filter(volume => volume.driveType === 2 || volume.busType.toUpperCase() === 'USB')
    .map(volume => ({ id: idFor(volume.root), label: volume.volumeName || 'USB / External drive',
      size: volume.size, freeSpace: volume.freeSpace, technicianPath: volume.root }));
  const cloud = [];
  const configuredCloud = getSetting('backup_cloud_dest', '');
  if (configuredCloud) cloud.push({ id: idFor(configuredCloud), label: 'Google Drive / OneDrive ที่ตั้งไว้',
    ready: fs.existsSync(configuredCloud), technicianPath: configuredCloud });
  for (const folder of discovery.oneDriveFolders()) {
    const destination = path.join(folder, 'Clinic Backup');
    if (!cloud.some(item => item.id === idFor(destination))) cloud.push({ id: idFor(destination), label: 'OneDrive', ready: true, technicianPath: destination });
  }
  for (const volume of found.volumes.filter(item => item.volumeName.toLowerCase().includes('google drive'))) {
    const base = fs.existsSync(path.join(volume.root, 'My Drive')) ? path.join(volume.root, 'My Drive') : volume.root;
    const destination = path.join(base, 'Clinic Backup');
    if (!cloud.some(item => item.id === idFor(destination))) cloud.push({ id: idFor(destination), label: 'Google Drive', ready: true, technicianPath: destination });
  }
  return { external, cloud, current: {
    cloudConfigured: !!configuredCloud,
    externalConfigured: !!getSetting('backup_dest_1', ''),
    kitReady: !!getSetting('recovery_kit_fingerprint', ''),
  } };
}

function resolveExternal(targetId) {
  const options = setupOptions();
  return options.external.find(item => item.id === targetId) || null;
}

function resolveCloud(targetId) {
  const options = setupOptions();
  return options.cloud.find(item => item.id === targetId) || null;
}

function driveRootOf(target) {
  return path.parse(path.resolve(target)).root.toLowerCase();
}

function hasRecoveryKit(driveRoot) {
  try { return fs.existsSync(path.join(driveRoot, 'Clinic Recovery Kit')); }
  catch { return false; }
}

function configureDestinations(body) {
  if (body.cloudId) {
    const selected = resolveCloud(String(body.cloudId));
    if (!selected) throw new Error('ไม่พบ Google Drive/OneDrive ที่เลือก กรุณาค้นหาใหม่');
    fs.mkdirSync(selected.technicianPath, { recursive: true });
    setSetting('backup_cloud_dest', selected.technicianPath);
  }
  if (body.externalId) {
    const selected = resolveExternal(String(body.externalId));
    if (!selected) throw new Error('ไม่พบ external drive ที่เลือก กรุณาเสียบใหม่แล้วค้นหาอีกครั้ง');
    // ห้ามใช้ USB ที่เป็น Recovery Kit อยู่แล้วมาเก็บ backup ด้วย — ถ้าหายจะเสียทั้งข้อมูลและกุญแจพร้อมกัน
    if (hasRecoveryKit(path.parse(selected.technicianPath).root)) {
      throw new Error('USB นี้เป็น Recovery Kit สำหรับกู้ข้อมูลอยู่แล้ว กรุณาใช้ USB คนละอันสำหรับเก็บข้อมูลสำรอง เพื่อไม่ให้ข้อมูลและกุญแจหายไปพร้อมกัน');
    }
    const destination = path.join(selected.technicianPath, 'Clinic Backup');
    fs.mkdirSync(destination, { recursive: true });
    setSetting('backup_dest_1', destination);
  }
  return { ok: true, options: setupOptions() };
}

function createKit(targetId) {
  const selected = resolveExternal(String(targetId || ''));
  if (!selected) throw new Error('ยังไม่พบ USB กรุณาเสียบ USB แล้วกดค้นหาใหม่');
  // ห้ามสร้าง Recovery Kit ลง USB ที่ตั้งเป็นที่เก็บ backup อยู่แล้ว — กุญแจกับข้อมูลต้องแยกกันคนละอัน
  const kitRoot = driveRootOf(path.parse(selected.technicianPath).root);
  for (const dest of [getSetting('backup_dest_1', ''), getSetting('backup_dest_2', '')].filter(Boolean)) {
    if (driveRootOf(dest) === kitRoot) {
      throw new Error('USB นี้ถูกใช้เก็บข้อมูลสำรองอยู่แล้ว กรุณาใช้ USB คนละอันทำ Recovery Kit เพื่อให้กุญแจกับข้อมูลไม่หายไปพร้อมกัน');
    }
  }
  const keyInfo = backup.ensureRecoveryKeyFile();
  const packageJson = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
  const result = createRecoveryKit({
    targetRoot: selected.technicianPath,
    keyFile: keyInfo.file,
    appRoot: APP_ROOT,
    runtimePath: process.execPath,
    appVersion: packageJson.version,
    nodeVersion: process.version,
    cloudFolderName: path.basename(getSetting('backup_cloud_dest', '') || 'Clinic Backup'),
    installation: { appRoot: APP_ROOT, liveDataDir: DATA_DIR,
      port: Number(getSetting('port', '8080')), executable: process.execPath, args: ['--no-warnings', 'server.js'] },
  });
  setSetting('recovery_kit_fingerprint', result.fingerprint);
  setSetting('recovery_kit_created_at', result.createdAt);
  backup.markRecoveryKeyExported();
  return { ok: true, createdAt: result.createdAt, files: result.files, label: selected.label };
}

function candidateSources() {
  return [
    { kind: 'cloud', directory: getSetting('backup_cloud_dest', '') },
    { kind: 'external', directory: getSetting('backup_dest_1', '') },
    { kind: 'external', directory: getSetting('backup_dest_2', '') },
    { kind: 'local', directory: path.join(DATA_DIR, 'backups') },
  ].filter(item => item.directory && fs.existsSync(item.directory));
}

function runDrill() {
  const keyInfo = backup.ensureRecoveryKeyFile();
  const key = core.readRecoveryKeyFile(keyInfo.file);
  let selected = null;
  try {
    for (const source of candidateSources()) {
      // ส่ง key ให้ทุกแหล่ง: external/cloud เข้ารหัสแล้ว, local ไม่เข้ารหัสก็ไม่เป็นไร (core มองข้าม key ถ้าไม่ใช่ไฟล์ .enc)
      const points = core.listRestorePoints(source.directory, key)
        .filter(point => point.complete)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      if (points.length && (!selected || String(points[0].createdAt) > String(selected.point.createdAt))) selected = { source, point: points[0] };
    }
  } finally { key.fill(0); }
  if (!selected) throw new Error('ยังไม่พบข้อมูลสำรองที่ซ้อมกู้ได้ กรุณาสำรองข้อมูลก่อน');
  fs.mkdirSync(DRILLS_DIR, { recursive: true });
  const outputDir = path.join(DRILLS_DIR, `drill-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  const result = core.restoreToNewDirectory({ sourceDir: selected.source.directory, outputDir,
    manifestFile: selected.point.id, keyFile: selected.point.encrypted ? keyInfo.file : null });
  fs.rmSync(path.join(outputDir, 'data'), { recursive: true, force: true });
  setSetting('recovery_last_drill_at', now());
  setSetting('recovery_last_drill_backup_at', result.backupCreatedAt);
  return { ok: true, backupCreatedAt: result.backupCreatedAt, checkedAt: getSetting('recovery_last_drill_at', '') };
}

module.exports = { health, setupOptions, configureDestinations, createKit, runDrill };
