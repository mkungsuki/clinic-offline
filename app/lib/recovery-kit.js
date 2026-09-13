'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readRecoveryKeyFile, keyFingerprint, sha256 } = require('./recovery-core');

const APP_FILES = ['package.json', 'server.js'];
const APP_DIRECTORIES = ['lib', 'public'];
const TOOL_FILES = ['tools/run-backup.js', 'tools/restore-cloud-backup.js', 'tools/migrate-and-verify.js'];

function assertSafeTarget(targetRoot, appRoot, allowFixedForTest) {
  const target = path.resolve(targetRoot);
  const app = path.resolve(appRoot);
  if (target.toLowerCase().startsWith(app.toLowerCase() + path.sep)) throw new Error('Recovery Kit ต้องอยู่นอกโฟลเดอร์ ClinicApp');
  if (!allowFixedForTest && path.parse(target).root.toLowerCase() === path.parse(app).root.toLowerCase()) {
    throw new Error('กรุณาเลือก USB หรือ external drive เพื่อให้ Kit ไม่หายพร้อมเครื่องนี้');
  }
  return target;
}

function copyFileVerified(src, dst, inventory, label) {
  const stat = fs.lstatSync(src);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`ไฟล์โปรแกรมไม่ปลอดภัย: ${label}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
  const sourceHash = sha256(src);
  const targetHash = sha256(dst);
  if (sourceHash !== targetHash) throw new Error(`ตรวจไฟล์ใน Recovery Kit ไม่ผ่าน: ${label}`);
  inventory.push({ file: label.replace(/\\/g, '/'), bytes: stat.size, sha256: sourceHash });
}

function copyDirectoryAllowlist(srcRoot, relativeDir, dstRoot, inventory) {
  const source = path.join(srcRoot, relativeDir);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) copyDirectoryAllowlist(srcRoot, relative, dstRoot, inventory);
    else if (entry.isFile() && /\.(?:js|html|css|json|png|jpe?g|svg|ico|webp)$/i.test(entry.name)) {
      copyFileVerified(path.join(srcRoot, relative), path.join(dstRoot, relative), inventory, path.join('ClinicApp', relative));
    }
  }
}

function createRecoveryKit(options) {
  const appRoot = path.resolve(options.appRoot);
  const targetBase = assertSafeTarget(options.targetRoot, appRoot, !!options.allowFixedForTest);
  const kitRoot = path.join(targetBase, 'Clinic Recovery Kit');
  if (fs.existsSync(kitRoot)) throw new Error('USB นี้มี Recovery Kit อยู่แล้ว กรุณากดอัปเดต Kit แทนการสร้างซ้ำ');
  const key = readRecoveryKeyFile(options.keyFile);
  const fingerprint = keyFingerprint(key);
  key.fill(0);
  const runtimePath = path.resolve(options.runtimePath || process.execPath);
  const inventory = [];
  let created = false;
  try {
    fs.mkdirSync(kitRoot, { recursive: false });
    created = true;
    const runtimeDir = path.join(kitRoot, 'runtime');
    const appDir = path.join(kitRoot, 'ClinicApp');
    fs.mkdirSync(runtimeDir);
    fs.mkdirSync(appDir);

    copyFileVerified(runtimePath, path.join(runtimeDir, 'node.exe'), inventory, 'runtime/node.exe');
    for (const file of APP_FILES) copyFileVerified(path.join(appRoot, file), path.join(appDir, file), inventory, path.join('ClinicApp', file));
    for (const directory of APP_DIRECTORIES) copyDirectoryAllowlist(appRoot, directory, appDir, inventory);
    for (const file of TOOL_FILES) {
      if (fs.existsSync(path.join(appRoot, file))) copyFileVerified(path.join(appRoot, file), path.join(appDir, file), inventory, path.join('ClinicApp', file));
    }
    copyFileVerified(path.join(appRoot, 'recovery-assistant.js'), path.join(kitRoot, 'recovery-assistant.js'), inventory, 'recovery-assistant.js');

    // Key is copied directly from disk and deliberately excluded from inventory/log output.
    const keyDestination = path.join(kitRoot, 'Recovery Key.txt');
    fs.copyFileSync(options.keyFile, keyDestination, fs.constants.COPYFILE_EXCL);
    const copiedKey = readRecoveryKeyFile(keyDestination);
    const copiedFingerprint = keyFingerprint(copiedKey);
    copiedKey.fill(0);
    if (copiedFingerprint !== fingerprint) throw new Error('ตรวจ Recovery Key บน USB ไม่ผ่าน');

    const descriptor = {
      format: 1,
      kind: 'clinic-recovery-kit',
      createdAt: new Date().toISOString(),
      keyFingerprint: fingerprint,
      appVersion: String(options.appVersion || '1.0.0'),
      nodeVersion: String(options.nodeVersion || process.version),
      cloudFolderName: String(options.cloudFolderName || ''),
      installation: {
        appRoot: String(options.installation && options.installation.appRoot || appRoot),
        liveDataDir: String(options.installation && options.installation.liveDataDir || path.join(appRoot, 'data')),
        port: Number(options.installation && options.installation.port || 8080),
        executable: String(options.installation && options.installation.executable || runtimePath),
        args: Array.isArray(options.installation && options.installation.args) ? options.installation.args : ['--no-warnings', 'server.js'],
      },
    };
    fs.writeFileSync(path.join(kitRoot, 'clinic-recovery-kit.json'), JSON.stringify(descriptor, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(kitRoot, 'kit-files.json'), JSON.stringify({ format: 1, files: inventory }, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(kitRoot, 'เปิดตัวช่วยกู้ข้อมูล.cmd'),
      '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" --no-warnings "%~dp0recovery-assistant.js" --kit-root "%~dp0"\r\n',
      { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(appDir, 'เปิดระบบคลินิก.cmd'),
      '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0..\\runtime\\node.exe" --no-warnings server.js\r\n',
      { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(kitRoot, 'อ่านก่อนใช้.txt'),
      'Recovery Kit สำหรับกู้ข้อมูลคลินิก\r\n\r\n1. เก็บ USB นี้แยกจากคอมคลินิก\r\n2. เมื่อระบบมีปัญหา เสียบ USB แล้วดับเบิลคลิก “เปิดตัวช่วยกู้ข้อมูล”\r\n3. ห้ามส่งไฟล์ใน USB นี้ผ่านแชตหรืออีเมล\r\n',
      { encoding: 'utf8', flag: 'wx' });
    return { ok: true, kitRoot, fingerprint, files: inventory.length, createdAt: descriptor.createdAt };
  } catch (error) {
    if (created) { try { fs.rmSync(kitRoot, { recursive: true, force: true }); } catch {} }
    throw error;
  }
}

module.exports = { createRecoveryKit };
