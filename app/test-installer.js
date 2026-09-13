'use strict';
// ทดสอบชุดติดตั้ง Clinic Setup แบบ end-to-end บนโฟลเดอร์สะอาด (จำลองเครื่องคลินิกใหม่)
// isolated เต็มรูปแบบ: temp dir + พอร์ตสุ่ม — ไม่แตะ app/data และไม่ยิง 8080 เด็ดขาด
// รัน: node --no-warnings test-installer.js  (ไม่อยู่ใน npm test เพราะ build ใช้เวลา ~10-20 วิ — รันก่อนส่งมอบชุดติดตั้งทุกครั้ง)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { buildInstaller, PACKAGE_NAME, TRIAL_PACKAGE_NAME, DOCUMENT_FILES } = require('./tools/build-installer');
const { buildHotfix, TRIAL_HOTFIX_PACKAGE_NAME, APPLY_CMD: HOTFIX_APPLY_CMD } = require('./tools/build-hotfix');
const { sha256 } = require('./lib/recovery-core');
const { SCHEMA_VERSION } = require('./lib/schema-version');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-installer-test-'));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { console.error(`❌ ${name}: ${error.message}`); throw error; }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (error) { console.error(`❌ ${name}: ${error.message}`); throw error; }
}
// wrapper ต้องเป็น ASCII ล้วน: cmd.exe อ่านไฟล์ .cmd ด้วย codepage ของ console ที่ inherit มา
// ถ้าฝัง path ไทยลงไฟล์ตรง ๆ จะพังเมื่อ parent ไม่มี console จริง (Git Bash/CI) แม้ chcp จะเป็น 65001
// จึงส่ง path ผ่าน environment variable (Windows เก็บเป็น UTF-16 ไม่ผ่าน codepage) + chcp 65001 กันอีกชั้น
function wrapperBody(argCount) {
  const refs = Array.from({ length: argCount }, (_, i) => ` "%CLINIC_TEST_ARG${i + 1}%"`).join('');
  return `@echo off\r\nchcp 65001 >nul\r\ncall "%CLINIC_TEST_CMD%"${refs}\r\nexit /b %errorlevel%\r\n`;
}
function runCmd(cmdFile, args, env) {
  const wrapper = path.join(root, `run-cmd-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.cmd`);
  try {
    const passThrough = value => {
      const text = String(value);
      if (text.includes('"')) throw new Error('test path มี quote ซึ่งไม่อนุญาต');
      return text;
    };
    const argEnv = {};
    args.forEach((value, i) => { argEnv[`CLINIC_TEST_ARG${i + 1}`] = passThrough(value); });
    const body = wrapperBody(args.length);
    if (/[^\x00-\x7f]/.test(body)) throw new Error('wrapper ต้องเป็น ASCII ล้วน');
    fs.writeFileSync(wrapper, body, 'ascii');
    const output = execFileSync('cmd.exe', ['/d', '/c', wrapper], {
      env: { ...process.env, CLINIC_TEST_CMD: passThrough(cmdFile), ...argEnv, ...env },
      encoding: 'utf8', timeout: 120000,
    });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` };
  } finally { try { fs.unlinkSync(wrapper); } catch {} }
}

(async () => {
  // 1) build ชุดติดตั้งลง temp
  const distDir = path.join(root, 'dist');
  const result = buildInstaller({ out: distDir });
  const packageRoot = result.packageRoot;
  test('build สำเร็จ มี ZIP และไฟล์ครบ', () => {
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.zipFile), 'ต้องมีไฟล์ ZIP');
    for (const name of ['ติดตั้งระบบคลินิก.cmd', 'เปิดระบบคลินิก.cmd', 'รีสตาร์ทระบบคลินิก.cmd',
      'อ่านก่อนติดตั้ง.txt', 'setup-manifest.json', path.join('scripts', 'make-shortcuts.ps1'),
      path.join('runtime', 'node.exe'), path.join('app', 'server.js'), path.join('app', 'seed.js'),
      path.join('app', 'public', 'remed.js')]) {
      assert.ok(fs.existsSync(path.join(packageRoot, name)), `ขาดไฟล์ ${name}`);
    }
    for (const name of DOCUMENT_FILES) {
      assert.ok(fs.existsSync(path.join(packageRoot, 'เอกสาร', name)), `ขาดเอกสาร ${name}`);
    }
  });

  // 2) ชุดติดตั้งต้องสะอาด: ไม่มีข้อมูล/กุญแจ/test/demo — ตรวจอิสระจาก assertion ใน builder
  test('ไม่มี app/data, ไฟล์กุญแจ, test, seed-mock, --demo ใน package', () => {
    assert.ok(!fs.existsSync(path.join(packageRoot, 'app', 'data')), 'ห้ามมี app/data');
    const forbidden = /^(test-|codex-|seed-mock)|recovery-key|\.(db|db-wal|db-shm|enc|key)$/i;
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else assert.ok(!forbidden.test(entry.name), `ไฟล์ต้องห้าม: ${path.relative(packageRoot, full)}`);
      }
    })(packageRoot);
    const installer = fs.readFileSync(path.join(packageRoot, 'ติดตั้งระบบคลินิก.cmd'), 'utf8');
    assert.ok(!installer.includes('--demo'), 'ตัวติดตั้งห้าม seed แบบ demo');
  });

  // 3) ZIP แตกด้วย Expand-Archive (ตัวที่เข้มงวดสุดเรื่องชื่อไฟล์) แล้วชื่อไทย+เนื้อไฟล์ต้องรอดครบ
  const extracted = path.join(root, 'extracted');
  test('ZIP แตกแล้วชื่อไฟล์ไทยรอด + hash ตรง manifest ทุกไฟล์', () => {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${result.zipFile}' -DestinationPath '${extracted}' -Force`], { timeout: 120000 });
    const extractedRoot = path.join(extracted, PACKAGE_NAME);
    assert.ok(fs.existsSync(path.join(extractedRoot, 'ติดตั้งระบบคลินิก.cmd')), 'ชื่อไฟล์ไทยหายหลังแตก ZIP');
    const manifest = JSON.parse(fs.readFileSync(path.join(extractedRoot, 'setup-manifest.json'), 'utf8'));
    assert.ok(manifest.files.length >= 30);
    for (const file of manifest.files) {
      const full = path.join(extractedRoot, file.file);
      assert.ok(fs.existsSync(full), `ไฟล์หายหลังแตก ZIP: ${file.file}`);
      assert.equal(sha256(full), file.sha256, `hash ไม่ตรง: ${file.file}`);
    }
  });

  // 4) รันตัวติดตั้งจริงจากโฟลเดอร์ที่แตก ZIP → โฟลเดอร์ปลายทางสะอาด
  test('ไฟล์ ZIP เสียหลังแตก แม้ขนาดเท่าเดิม ต้องหยุดก่อนสร้างฐานข้อมูล', () => {
    const sourceRoot = path.join(extracted, PACKAGE_NAME);
    const file = path.join(sourceRoot, 'app', 'public', 'common.js');
    const before = fs.readFileSync(file), changed = Buffer.from(before); changed[0] ^= 1;
    const failedTarget = path.join(root, 'ตรวจ hash ภาษาไทย');
    try {
      fs.writeFileSync(file, changed);
      const run = runCmd(path.join(sourceRoot, 'ติดตั้งระบบคลินิก.cmd'), [failedTarget], { CLINIC_INSTALL_TEST: '1' });
      assert.equal(run.code, 1, run.output);
      assert(!fs.existsSync(path.join(failedTarget, 'app/data/clinic.db')));
      assert(!fs.existsSync(path.join(failedTarget, 'update/installed.marker')));
    } finally { fs.writeFileSync(file, before); }
  });

  const target = path.join(root, 'คลินิก ทดสอบติดตั้ง');
  const installerCmd = path.join(extracted, PACKAGE_NAME, 'ติดตั้งระบบคลินิก.cmd');
  test('ติดตั้งลงโฟลเดอร์สะอาดสำเร็จ (โหมดทดสอบ)', () => {
    const run = runCmd(installerCmd, [target], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(run.code, 0, `installer exit ${run.code}: ${run.output}`);
    assert.ok(fs.existsSync(path.join(target, 'app', 'data', 'clinic.db')), 'ต้องมีฐานข้อมูลใหม่');
    assert.ok(fs.existsSync(path.join(target, 'runtime', 'node.exe')), 'ต้องมี runtime');
    const license = fs.readFileSync(path.join(__dirname, '..', 'LICENSE'));
    for (const dir of [packageRoot, target]) {
      assert(fs.readFileSync(path.join(dir, 'LICENSE')).equals(license));
      assert(fs.readFileSync(path.join(dir, 'app', 'LICENSE')).equals(license));
    }
    assert.match(run.output, /AGPL-3.0/);
    const body = fs.readFileSync(installerCmd, 'utf8');
    assert(!/(?<!\r)\n/.test(body), 'installer ต้อง CRLF');
    assert(body.indexOf('goto :donetest') < body.indexOf('CLINIC_INSTALL_DONE'), 'headless ต้องข้ามกล่องข้อความ');
    for (const flag of ['/IS', '/IT', '/IM', '/R:2', '/W:2', '/LOG+']) assert(body.includes(flag));
    assert(!body.split('\n').some(line => line.startsWith('robocopy ') && line.includes('>nul')));
    assert.match(body, /type nul >>/);
    assert.match(body, /-WindowStyle Hidden/);
    assert(fs.existsSync(path.join(target, 'logs/install-copy.log')));
  });

  // 5) ฐานข้อมูลที่ได้ต้องว่างจริง: admin คนเดียว ไม่มี demo ไม่มีคนไข้/ยา และเข้าโหมดตั้งค่าครั้งแรก
  const dbFile = path.join(target, 'app', 'data', 'clinic.db');
  test('ฐานข้อมูลใหม่สะอาด: admin เดียว, ไม่มี demo, setup_required=1, schema ล่าสุด', () => {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const users = db.prepare('SELECT username, role FROM users ORDER BY username').all();
      assert.equal(users.length, 1, 'ต้องมีผู้ใช้เดียว');
      assert.equal(users[0].username, 'admin');
      assert.equal(users[0].role, 'admin');
      assert.equal(db.prepare('SELECT COUNT(*) c FROM patients').get().c, 0);
      assert.equal(db.prepare('SELECT COUNT(*) c FROM drugs').get().c, 0);
      const setting = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : undefined; };
      assert.equal(setting('setup_required'), '1');
      assert.equal(setting('demo_mode'), undefined, 'ห้ามมี demo_mode');
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'ฐานที่ติดตั้งใหม่ต้องเป็น schema ล่าสุด');
      assert.ok(db.prepare('SELECT COUNT(*) c FROM icd10').get().c >= 30, 'ICD-10 ต้องถูก seed');
      assert.equal(db.prepare('SELECT COUNT(*) c FROM services').get().c, 4, 'ค่าบริการพื้นฐาน 4 รายการ');
    } finally { db.close(); }
  });

  // 6) เปิด server จาก runtime พกพาบนพอร์ตสุ่ม แล้วต้องตอบ ready
  await testAsync('server ที่ติดตั้งเปิดได้จริงจาก runtime พกพา', async () => {
    const port = 20000 + Math.floor(Math.random() * 40000);
    const child = spawn(path.join(target, 'runtime', 'node.exe'), ['--no-warnings', 'server.js'], {
      cwd: path.join(target, 'app'), env: { ...process.env, CLINIC_PORT: String(port) }, stdio: 'pipe',
    });
    try {
      let ready = null;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !ready) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/recovery/ready`);
          if (response.ok) ready = await response.json();
        } catch { await new Promise((r) => setTimeout(r, 300)); }
      }
      assert.ok(ready, 'server ไม่ตอบ ready ภายใน 20 วินาที');
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200, 'หน้าแรกต้องเปิดได้');
    } finally {
      child.kill();
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
    }
  });

  // 7) รันตัวติดตั้งซ้ำใส่เครื่องที่มีข้อมูลแล้ว → ต้องปฏิเสธและไม่แตะฐานข้อมูลเดิม
  test('ติดตั้งซ้ำทับเครื่องที่มีข้อมูล → ปฏิเสธ ไม่เขียนทับ', () => {
    const before = sha256(dbFile);
    const run = runCmd(installerCmd, [target], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(run.code, 1, 'ต้อง exit 1 เมื่อปลายทางมีฐานข้อมูลแล้ว');
    assert.ok(run.output.includes('ไม่เขียนทับข้อมูลเดิม'), 'ต้องบอกเหตุผลชัด');
    assert.equal(sha256(dbFile), before, 'ฐานข้อมูลเดิมต้องไม่ถูกแตะ');
  });

  // 8) ดับเบิลคลิกจากในหน้าต่าง ZIP (ไม่มี runtime ข้างๆ) → ต้องเตือนให้แตกไฟล์ก่อน
  test('รันโดยไม่แตก ZIP → เตือนภาษาคนและหยุด', () => {
    const lonely = path.join(root, 'lonely');
    fs.mkdirSync(lonely);
    fs.copyFileSync(installerCmd, path.join(lonely, 'ติดตั้งระบบคลินิก.cmd'));
    const run = runCmd(path.join(lonely, 'ติดตั้งระบบคลินิก.cmd'), [path.join(root, 'nowhere')], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(run.code, 1);
    assert.ok(run.output.includes('Extract All'), 'ต้องแนะนำให้แตกไฟล์ก่อน');
  });

  // 9) build ชุดทดลองแยกจากตัวจริงอย่างชัดเจน
  const trialResult = buildInstaller({ out: distDir, trial: true });
  const trialPackageRoot = trialResult.packageRoot;
  test('build ชุดทดลองสำเร็จ ชื่อ ZIP/โฟลเดอร์/ทางเข้าแยกจากตัวจริง', () => {
    assert.equal(trialResult.ok, true);
    assert.equal(trialResult.trial, true);
    assert.equal(trialResult.packageName, TRIAL_PACKAGE_NAME);
    assert.equal(trialResult.installTarget, 'C:\\clinic-trial');
    assert.equal(trialResult.port, 8081);
    assert.ok(path.basename(trialResult.zipFile).startsWith('ClinicTrial-'));
    assert.ok(fs.existsSync(path.join(trialPackageRoot, 'app', 'seed-mock-clinic.js')));
    for (const name of DOCUMENT_FILES) {
      assert.ok(fs.existsSync(path.join(trialPackageRoot, 'เอกสาร', name)), `ชุดทดลองขาดเอกสาร ${name}`);
    }
    const launcher = fs.readFileSync(path.join(trialPackageRoot, 'เปิดระบบคลินิก.cmd'), 'utf8');
    assert.ok(launcher.includes('CLINIC_PORT=8081'));
    assert.ok(launcher.includes('app\\launch\\open.cmd'));
    const innerLauncher = path.join(trialPackageRoot, 'app', 'launch', 'open.cmd');
    assert.ok(fs.existsSync(innerLauncher), 'root stub ต้องมี launcher logic ใต้ app/ ให้เรียกจริง');
    assert.ok(fs.readFileSync(innerLauncher, 'utf8').includes('127.0.0.1:%CLINIC_PORT%'));
    const openRun = runCmd(path.join(trialPackageRoot, 'เปิดระบบคลินิก.cmd'), [], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(openRun.code, 1, openRun.output);
    assert.ok(openRun.output.includes('ยังไม่ได้ติดตั้ง'));
    const restartRun = runCmd(path.join(trialPackageRoot, 'รีสตาร์ทระบบคลินิก.cmd'), [], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(restartRun.code, 1, restartRun.output);
    assert.ok(restartRun.output.includes('ยังไม่ได้ติดตั้ง'));
    const profile = JSON.parse(fs.readFileSync(path.join(trialPackageRoot, 'update', 'install-profile.json'), 'utf8'));
    assert.deepStrictEqual(profile, { format: 1, product: 'clinic-offline', edition: 'standard', variant: 'trial', channel: 'pilot', port: 8081, https_port: 8444 });
    // Phase 6: ชุดติดตั้งต้องพกแหล่งอัปเดต (HTTPS ไม่มี query) ตรง variant — ไม่งั้นตัว updater ในเครื่องไม่รู้จะไปถามใคร
    assert.ok(fs.existsSync(path.join(trialPackageRoot, 'app', 'update-public-key.pem')), 'ชุดทดลองต้องมี public key ของ updater');
    assert.equal(fs.readFileSync(path.join(trialPackageRoot, 'update', 'feed-url.txt'), 'utf8').trim(),
      'https://github.com/mkungsuki/mk-artifacts/releases/latest/download/latest-trial-pilot.json');
    const installer = fs.readFileSync(path.join(trialPackageRoot, 'ติดตั้งระบบคลินิก.cmd'), 'utf8');
    assert.ok(installer.includes('C:\\clinic-trial'));
    assert.ok(installer.includes('seed.js --demo'));
    assert.ok(installer.includes('seed-mock-clinic.js'));
    for (const name of ['ตั้งค่าใช้สองเครื่อง (ทดลอง).cmd', 'ปิดการเชื่อมสองเครื่อง (ทดลอง).cmd',
      path.join('scripts', 'setup-lan.ps1'), path.join('scripts', 'remove-lan.ps1'), path.join('scripts', 'make-cert.ps1')]) {
      assert.ok(fs.existsSync(path.join(trialPackageRoot, name)), `ชุดทดลองขาดตัวช่วย ${name}`);
    }
  });

  // 9.5) เคยกด launcher ใน package จนเกิด app/data เปล่า: installer ต้องเตือน+ไม่ copy และต้อง seed trial ใหม่ครบ
  test('package มี app/data ขยะ → installer ไม่คัดลอก และ target trial มีผู้ใช้ครบ', () => {
    const dirtyData = path.join(trialPackageRoot, 'app', 'data');
    fs.mkdirSync(dirtyData, { recursive: true });
    const dirtyDb = new DatabaseSync(path.join(dirtyData, 'clinic.db'));
    try { dirtyDb.exec('CREATE TABLE users(id INTEGER);'); } finally { dirtyDb.close(); }
    const dirtyTarget = path.join(root, 'dirty-package-installed ภาษาไทย');
    try {
      const run = runCmd(path.join(trialPackageRoot, 'ติดตั้งระบบคลินิก.cmd'), [dirtyTarget], { CLINIC_INSTALL_TEST: '1' });
      assert.equal(run.code, 0, run.output);
      assert.ok(run.output.includes('พบฐานข้อมูลในโฟลเดอร์ชุดติดตั้ง'), 'ต้องเตือนว่าพบ data ขยะใน package');
      const installed = new DatabaseSync(path.join(dirtyTarget, 'app', 'data', 'clinic.db'), { readOnly: true });
      try { assert.ok(installed.prepare('SELECT COUNT(*) c FROM users').get().c >= 3, 'trial ที่ติดตั้งต้องมีบัญชีใช้งานครบ'); }
      finally { installed.close(); }
      assert.ok(fs.existsSync(path.join(dirtyTarget, 'update', 'installed.marker')));
    } finally { fs.rmSync(dirtyData, { recursive: true, force: true }); }
  });

  // 10) ชุดตัวจริงต้องยังคงสะอาดหลังเพิ่ม trial path
  test('เส้นทางตัวจริงไม่ปน trial: คนไข้ศูนย์ ไม่มี seed-mock และใช้ 8080 เท่านั้น', () => {
    assert.equal(fs.existsSync(path.join(packageRoot, 'app', 'seed-mock-clinic.js')), false);
    const launcher = fs.readFileSync(path.join(packageRoot, 'เปิดระบบคลินิก.cmd'), 'utf8');
    assert.ok(launcher.includes('CLINIC_PORT=8080'));
    assert.ok(launcher.includes('app\\launch\\open.cmd'));
    assert.ok(!launcher.includes('CLINIC_PORT=8081'));
    const profile = JSON.parse(fs.readFileSync(path.join(packageRoot, 'update', 'install-profile.json'), 'utf8'));
    assert.equal(profile.variant, 'production');
    assert.equal(profile.port, 8080);
    assert.ok(fs.existsSync(path.join(packageRoot, 'app', 'update-public-key.pem')), 'ชุดจริงต้องมี public key ของ updater');
    assert.equal(fs.readFileSync(path.join(packageRoot, 'update', 'feed-url.txt'), 'utf8').trim(),
      'https://github.com/mkungsuki/mk-artifacts/releases/latest/download/latest-production-pilot.json');
    assert.equal(profile.https_port, 8443);
    // security round 1 (A-refined): ชุดจริงมีตัวช่วยสองเครื่องแบบ HTTPS ของตัวเอง — ห้ามมีตัวช่วย HTTP ของชุดทดลอง
    for (const name of ['ตั้งค่าใช้สองเครื่อง.cmd', 'ปิดการเชื่อมสองเครื่อง.cmd',
      path.join('scripts', 'setup-lan.ps1'), path.join('scripts', 'remove-lan.ps1'), path.join('scripts', 'make-cert.ps1')]) {
      assert.ok(fs.existsSync(path.join(packageRoot, name)), `ชุดจริงขาดตัวช่วยสองเครื่อง (HTTPS): ${name}`);
    }
    for (const name of ['ตั้งค่าใช้สองเครื่อง (ทดลอง).cmd', path.join('scripts', 'setup-trial-lan.ps1')]) {
      assert.equal(fs.existsSync(path.join(packageRoot, name)), false, `ชุดจริงห้ามมีตัวช่วยของชุดทดลอง: ${name}`);
    }
    const prodLan = fs.readFileSync(path.join(packageRoot, 'scripts', 'setup-lan.ps1'), 'utf8');
    assert.ok(prodLan.includes('$httpsPort = 8443') && prodLan.includes('-LocalPort $httpsPort'), 'firewall ชุดจริงเปิดเฉพาะพอร์ต HTTPS 8443');
    assert.ok(!prodLan.includes('-LocalPort 8080') && !prodLan.includes('"http://${ip}'), 'ชุดจริงห้ามเปิดทาง HTTP บน LAN');
    const prodDb = new DatabaseSync(dbFile, { readOnly: true });
    try { assert.equal(prodDb.prepare('SELECT COUNT(*) c FROM patients').get().c, 0); }
    finally { prodDb.close(); }
  });

  // 11) แตก ZIP trial และตรวจชื่อไทย+manifest เหมือนตัวจริง
  const trialExtracted = path.join(root, 'extracted-trial');
  test('ZIP ชุดทดลองแตกแล้วชื่อไทยและ hash รอดครบ', () => {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${trialResult.zipFile}' -DestinationPath '${trialExtracted}' -Force`], { timeout: 120000 });
    const extractedRoot = path.join(trialExtracted, TRIAL_PACKAGE_NAME);
    assert.ok(fs.existsSync(path.join(extractedRoot, 'ติดตั้งระบบคลินิก.cmd')));
    const manifest = JSON.parse(fs.readFileSync(path.join(extractedRoot, 'setup-manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'clinic-trial');
    assert.equal(manifest.port, 8081);
    for (const file of manifest.files) {
      const full = path.join(extractedRoot, file.file);
      assert.ok(fs.existsSync(full), `ไฟล์ trial หายหลังแตก ZIP: ${file.file}`);
      assert.equal(sha256(full), file.sha256, `hash trial ไม่ตรง: ${file.file}`);
    }
  });

  // 11.5) สคริปต์เชื่อมสองเครื่องต้อง "รันได้จริง" จาก path ที่มีช่องว่าง+ภาษาไทย (regression ของบั๊กจริงที่คลินิก
  // 2026-08-12: .cmd ส่ง -Target "%~dp0" ที่ลงท้าย \ ทำให้ PowerShell ได้ path มี quote ปน → Test-Path ล้ม)
  // ต้องรันจากโฟลเดอร์ที่ "ติดตั้งแล้ว" (มี update\installed.marker) — ใช้ปลายทาง Thai+space ที่ข้อ 9.5 ติดตั้งไว้
  // (บั๊กหน้างาน 2026-08-16: helper รันจากโฟลเดอร์ที่แตก ZIP ได้ → ตอนนี้ต้องถูกปฏิเสธ ดูข้อ 11.6)
  test('ตั้งค่า/ปิดการเชื่อมสองเครื่อง (ทดลอง) รันผ่านจริงบน path มีช่องว่าง+ไทย', () => {
    const trialRoot = path.join(root, 'dirty-package-installed ภาษาไทย');
    assert.ok(fs.existsSync(path.join(trialRoot, 'update', 'installed.marker')), 'ต้องเป็นโฟลเดอร์ที่ติดตั้งแล้ว (จากข้อ 9.5)');
    const lanOut = path.join(root, 'lan-out');
    const setup = runCmd(path.join(trialRoot, 'ตั้งค่าใช้สองเครื่อง (ทดลอง).cmd'), [],
      { CLINIC_INSTALL_TEST: '1', CLINIC_LAN_TEST_OUT: lanOut });
    assert.equal(setup.code, 0, `setup-lan exit ${setup.code}: ${setup.output}`);
    const shortcut = fs.readFileSync(path.join(lanOut, 'เปิดระบบคลินิก (ห้องหมอ).url'), 'utf8');
    assert.ok(shortcut.includes('URL=https://192.168.50.10:8444/'), 'ทางลัดต้องชี้ https IP ทดสอบพอร์ต 8444');
    assert.ok(fs.existsSync(path.join(lanOut, 'อ่านก่อนเปิด.txt')), 'ต้องมีไฟล์คำอธิบายสำหรับเครื่องหมอ');
    // ใบรับรอง: สร้างจริงบน path ไทย, โฟลเดอร์ส่งออกมีเฉพาะ .cer + ตัวติดตั้งใบรับรอง — ห้ามมี pfx/รหัส
    for (const f of ['clinic.pfx', 'clinic.pfx.pass', 'clinic.cer', 'clinic-cert.json']) {
      assert.ok(fs.existsSync(path.join(trialRoot, 'cert', f)), `ต้องสร้าง cert/${f} ในโฟลเดอร์ติดตั้ง`);
    }
    assert.ok(fs.existsSync(path.join(lanOut, 'clinic.cer')), 'โฟลเดอร์ส่งเครื่องหมอต้องมี .cer');
    assert.ok(fs.existsSync(path.join(lanOut, 'ติดตั้งใบรับรอง (เครื่องห้องตรวจ).cmd')), 'ต้องมีตัวติดตั้งใบรับรองสำหรับเครื่องหมอ');
    for (const f of ['clinic.pfx', 'clinic.pfx.pass']) assert.equal(fs.existsSync(path.join(lanOut, f)), false, `ห้ามส่ง ${f} ไปเครื่องหมอ`);
    const certInfo = JSON.parse(fs.readFileSync(path.join(trialRoot, 'cert', 'clinic-cert.json'), 'utf8'));
    assert.ok(certInfo.san.includes('IPAddress=192.168.50.10') && certInfo.san.includes('DNS=localhost'), 'SAN ต้องมี IP ทดสอบและ localhost');
    const installCert = fs.readFileSync(path.join(lanOut, 'ติดตั้งใบรับรอง (เครื่องห้องตรวจ).cmd'), 'utf8');
    assert.ok(installCert.includes('Cert:\\CurrentUser\\Root') && installCert.includes('$env:CLINIC_CER'), 'ตัวติดตั้งใบรับรองส่ง path ผ่าน env (ไม่ฝัง path ไทยใน argument)');
    assert.ok(!/[^\r]\n/.test(installCert), 'ตัวติดตั้งใบรับรองต้องเป็น CRLF');
    // หน้า Admin (การ์ด "เครื่องห้องตรวจ") อ่านสถานะจาก cert/lan-setup.json ที่ตัวช่วยเขียนตอนสำเร็จ — ต้องมีและไม่มีความลับ
    const setupInfo = JSON.parse(fs.readFileSync(path.join(trialRoot, 'cert', 'lan-setup.json'), 'utf8'));
    assert.equal(setupInfo.url, 'https://192.168.50.10:8444/');
    assert.equal(setupInfo.output_dir, lanOut);
    assert.equal(setupInfo.rule_name, 'Clinic Trial - Doctor computer (HTTPS 8444)');
    assert.equal(setupInfo.thumbprint, certInfo.thumbprint);
    assert.ok(setupInfo.at && setupInfo.test_mode === true);
    assert.ok(!/pfx|pass/i.test(Object.keys(setupInfo).join(',')), 'lan-setup.json ห้ามมีอะไรเกี่ยวกับ pfx/รหัส');
    // รันซ้ำ: cert เดิมยังครอบ IP → ไม่สร้างใหม่ (thumbprint เดิม)
    const again = runCmd(path.join(trialRoot, 'ตั้งค่าใช้สองเครื่อง (ทดลอง).cmd'), [], { CLINIC_INSTALL_TEST: '1', CLINIC_LAN_TEST_OUT: lanOut });
    assert.equal(again.code, 0, again.output);
    assert.equal(JSON.parse(fs.readFileSync(path.join(trialRoot, 'cert', 'clinic-cert.json'), 'utf8')).thumbprint, certInfo.thumbprint, 'รันซ้ำต้องไม่เปลี่ยนใบรับรอง');
    const remove = runCmd(path.join(trialRoot, 'ปิดการเชื่อมสองเครื่อง (ทดลอง).cmd'), [], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(remove.code, 0, `remove-lan exit ${remove.code}: ${remove.output}`);
  });

  // 11.6) บั๊กหน้างานจริง 2026-08-16 (เจ้าของเจอเอง): ดับเบิลคลิก "ตั้งค่าใช้สองเครื่อง" จากโฟลเดอร์ที่แตก ZIP (ยังไม่ติดตั้ง)
  //       แล้ว helper วิ่งจนสุด → private key ผิดที่ + firewall ชี้ node.exe ผิดตัว + ส่งใบรับรองผิดใบไปเครื่องหมอ
  //       ตอนนี้ต้องปฏิเสธทั้งชั้น .cmd และชั้น .ps1 และห้ามแตะอะไรเลย (ไม่สร้าง cert/ ไม่สร้างโฟลเดอร์ส่งออก)
  test('ตัวช่วยสองเครื่องรันจากโฟลเดอร์ที่แตก ZIP (ยังไม่ติดตั้ง) ต้องปฏิเสธและไม่แตะอะไร', () => {
    const packageDir = path.join(trialExtracted, TRIAL_PACKAGE_NAME);
    assert.equal(fs.existsSync(path.join(packageDir, 'update', 'installed.marker')), false, 'โฟลเดอร์ที่แตก ZIP ต้องไม่มี installed.marker');
    const lanOut = path.join(root, 'lan-out-not-installed');
    const viaCmd = runCmd(path.join(packageDir, 'ตั้งค่าใช้สองเครื่อง (ทดลอง).cmd'), [], { CLINIC_INSTALL_TEST: '1', CLINIC_LAN_TEST_OUT: lanOut });
    assert.equal(viaCmd.code, 1, `ต้อง exit 1: ${viaCmd.output}`);
    assert.ok(viaCmd.output.includes('ยังไม่ได้ติดตั้ง'), `ต้องบอกว่ายังไม่ได้ติดตั้ง: ${viaCmd.output}`);
    assert.equal(fs.existsSync(path.join(packageDir, 'cert')), false, 'ห้ามสร้าง cert/ (private key) ในโฟลเดอร์ที่แตก ZIP');
    assert.equal(fs.existsSync(lanOut), false, 'ห้ามสร้างโฟลเดอร์ส่งไปเครื่องหมอ');
    // ชั้น .ps1 ต้องกันเองด้วย (เผื่อถูกเรียกตรงหรือ .cmd ถูกแก้)
    let psCode = 0; let psOutput = '';
    try {
      psOutput = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(packageDir, 'scripts', 'setup-lan.ps1'),
        '-Target', packageDir, '-TestMode', '-TestIp', '192.168.50.10', '-OutputDir', lanOut], { encoding: 'utf8', timeout: 30000 });
    } catch (error) { psCode = error.status ?? 1; psOutput = `${error.stdout || ''}${error.stderr || ''}`; }
    assert.equal(psCode, 1, `setup-lan.ps1 ต้อง exit 1 เมื่อ Target ยังไม่ติดตั้ง: ${psOutput}`);
    assert.ok(psOutput.includes('ยังไม่ได้ติดตั้ง'), psOutput);
    assert.equal(fs.existsSync(path.join(packageDir, 'cert')), false);
    assert.equal(fs.existsSync(lanOut), false);
    // ในโหมดใช้จริง .cmd ต้องมีทางเดินไปยังชุดที่ติดตั้งแล้ว (C:\clinic-trial) แทนการวิ่งต่อในโฟลเดอร์ ZIP
    const cmdText = fs.readFileSync(path.join(packageDir, 'ตั้งค่าใช้สองเครื่อง (ทดลอง).cmd'), 'utf8');
    assert.ok(cmdText.includes('installed.marker') && cmdText.includes('set "INSTALLED=C:\\clinic-trial"'), 'ต้องมี guard installed.marker และเส้นทางไปชุดที่ติดตั้งแล้ว');
    assert.ok(/set "PKG=%INSTALLED%"/.test(cmdText), 'ต้องเปลี่ยนไปใช้โฟลเดอร์ที่ติดตั้งแล้วเมื่อมี');
  });

  // 11.7) "ทำทีหลัง" ต้องมีทางเข้าที่ผู้ใช้เห็น (2026-08-16 เจ้าของ: "ทำไมมีแต่ตอนเริ่ม") — installer เลิกถามตอนติดตั้ง,
  //       ทางลัดบน Desktop ชี้ไปตัวช่วย, readme ชี้ไปการ์ดในหน้า Admin
  test('ตั้งค่าเครื่องห้องตรวจ "ทีหลัง": installer ไม่ถามตอนติดตั้ง + ทางลัด Desktop + readme ชี้ไปหน้า Admin', () => {
    for (const [pkgRoot, lanCmd] of [[trialPackageRoot, 'ตั้งค่าใช้สองเครื่อง (ทดลอง).cmd'], [packageRoot, 'ตั้งค่าใช้สองเครื่อง.cmd']]) {
      const installer = fs.readFileSync(path.join(pkgRoot, 'ติดตั้งระบบคลินิก.cmd'), 'utf8');
      assert.ok(!installer.includes('choice /c YN /m "ต้องการใช้กับคอมพิวเตอร์ห้องตรวจ'), 'ตัวติดตั้งต้องไม่ถามเรื่องเครื่องห้องตรวจตอนติดตั้ง');
      assert.ok(installer.includes('การ์ด "เครื่องห้องตรวจ"'), 'ตัวติดตั้งต้องบอกว่าทำทีหลังได้ที่หน้าตั้งค่า');
      const shortcuts = fs.readFileSync(path.join(pkgRoot, 'scripts', 'make-shortcuts.ps1'), 'utf8');
      assert.ok(shortcuts.includes(`'${lanCmd}'`) && shortcuts.includes('ตั้งค่าเครื่องห้องตรวจ'), 'make-shortcuts ต้องสร้างทางลัด Desktop ไปตัวช่วยสองเครื่อง');
      const readme = fs.readFileSync(path.join(pkgRoot, 'อ่านก่อนติดตั้ง.txt'), 'utf8');
      assert.ok(readme.includes('การ์ด "เครื่องห้องตรวจ"') && readme.includes('ทำทีหลังได้ทุกเมื่อ'), 'readme ต้องชี้ไปการ์ดในหน้าตั้งค่า');
    }
    // server ในชุดติดตั้งต้องมี lib/lan-status.js และหน้า admin มีการ์ด (ไฟล์ตาม allowlist)
    assert.ok(fs.existsSync(path.join(trialPackageRoot, 'app', 'lib', 'lan-status.js')));
    assert.ok(fs.readFileSync(path.join(trialPackageRoot, 'app', 'public', 'admin.html'), 'utf8').includes('id="lanCard"'));
  });

  // 12) ติดตั้ง trial จริงใน temp และตรวจ cohort สำคัญทั้งหมด
  const trialTarget = path.join(root, 'clinic-trial-installed');
  const trialInstaller = path.join(trialExtracted, TRIAL_PACKAGE_NAME, 'ติดตั้งระบบคลินิก.cmd');
  test('ติดตั้งชุดทดลองแล้วมี mock ≥100, demo mode, cohort/ยา/นัดครบ', () => {
    const run = runCmd(trialInstaller, [trialTarget], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(run.code, 0, `trial installer exit ${run.code}: ${run.output}`);
    const trialDbFile = path.join(trialTarget, 'app', 'data', 'clinic.db');
    const db = new DatabaseSync(trialDbFile, { readOnly: true });
    try {
      const setting = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
      assert.ok(db.prepare('SELECT COUNT(*) c FROM patients').get().c >= 100);
      assert.equal(setting('demo_mode'), '1');
      assert.ok(setting('clinic_name').endsWith('(ชุดทดลอง)'));
      assert.ok(db.prepare('SELECT COUNT(*) c FROM drugs WHERE active = 1').get().c >= 30);
      assert.ok(db.prepare("SELECT COUNT(*) c FROM appointments WHERE cancelled = 0 AND appt_date > date('now','localtime')").get().c >= 25);
      assert.ok(db.prepare("SELECT COUNT(DISTINCT hn) c FROM allergy_log WHERE action = 'add'").get().c >= 10);
      assert.ok(db.prepare("SELECT COUNT(*) c FROM visits WHERE visit_date = date('now','localtime') AND state IN ('WAITING','IN_EXAM','DISPENSING')").get().c >= 7);
      assert.ok(db.prepare("SELECT COUNT(*) c FROM receipts WHERE created_at < date('now','start of month')").get().c > 0);
    } finally { db.close(); }
    const openRun = runCmd(path.join(trialTarget, 'เปิดระบบคลินิก.cmd'), [], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(openRun.code, 0, openRun.output);
    assert.ok(openRun.output.includes('port 8081'));
  });

  // 12.5) จำลอง "เครื่องที่สอง" บนคอมเครื่องเดียว (เจ้าของมีเครื่องเดียว ทดสอบของจริงไม่ได้):
  // boot server ชุดทดลองแล้วยิงผ่าน IP วง LAN จริงของเครื่องนี้ (ไม่ใช่ 127.0.0.1) —
  // เส้นทางเดียวกับที่เครื่องห้องหมอจะใช้ พิสูจน์ว่า bind 0.0.0.0 + ไม่มี Host check ขวาง
  // (เหลือเสี่ยงจริงแค่ firewall ซึ่งต้องกด Yes ที่หน้างาน) + ด่าน loopback ของคำสั่งอันตรายยังทำงาน
  await testAsync('เครื่องที่สองเข้าผ่าน LAN IP ได้เฉพาะ HTTPS (HTTP ปิด) และคำสั่ง prepare-restore จาก LAN ถูกปฏิเสธ', async () => {
    const nets = os.networkInterfaces();
    const lanIp = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal)?.address;
    if (!lanIp) { console.log('   (เครื่องนี้ไม่มี LAN IP — ข้ามแบบระบุเหตุผล ไม่ใช่ผ่านเงียบ)'); return; }
    const port = 20000 + Math.floor(Math.random() * 40000);
    const httpsPort = port + 363;
    // ใบรับรองที่ตัวติดตั้ง (TestMode) สร้างไว้ใน <install>\cert — server ต้องหยิบเองโดยไม่ตั้งค่าเพิ่ม (path default)
    assert.ok(fs.existsSync(path.join(trialTarget, 'cert', 'clinic.pfx')), 'ตัวติดตั้งต้องสร้าง cert/clinic.pfx ไว้');
    const child = spawn(path.join(trialTarget, 'runtime', 'node.exe'), ['--no-warnings', 'server.js'], {
      cwd: path.join(trialTarget, 'app'), env: { ...process.env, CLINIC_PORT: String(port), CLINIC_HTTPS_PORT: String(httpsPort), NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: 'pipe',
    });
    const prevReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    // Keep startup diagnostics non-sensitive: exit/error codes only, never server payloads/keys.
    let startupCodes = [], readinessCode = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { startupCodes.push(...(String(chunk).match(/\b(?:EADDRINUSE|EACCES|ERR_[A-Z_]+)\b/g) || [])); });
    child.on('exit', (code, signal) => { startupCodes.push(`exit=${code},signal=${signal}`); });
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed ใน test เท่านั้น (เครื่องหมอจริงติดตั้ง .cer แทน)
    try {
      let ready = null;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline && !ready) {
        try {
          const response = await fetch(`https://${lanIp}:${httpsPort}/api/recovery/ready`, { signal: AbortSignal.timeout(1500) });
          if (response.ok) ready = await response.json();
          else readinessCode = `HTTP ${response.status}`;
        } catch (error) { readinessCode = error.cause?.code || error.name; await new Promise(r => setTimeout(r, 300)); }
      }
      assert.ok(ready, `server ไม่ตอบผ่าน HTTPS LAN IP ${lanIp}:${httpsPort} ภายใน 25 วิ (startup=${startupCodes.join(',') || 'running'}, request=${readinessCode})`);
      const page = await fetch(`https://${lanIp}:${httpsPort}/`);
      assert.equal(page.status, 200, 'หน้าแรกต้องเปิดผ่าน HTTPS LAN IP ได้');
      let httpLanRefused = false;
      try { await fetch(`http://${lanIp}:${port}/api/recovery/ready`, { signal: AbortSignal.timeout(3000) }); } catch { httpLanRefused = true; }
      assert.ok(httpLanRefused, 'HTTP บน LAN ต้องต่อไม่ได้ (server ผูก HTTP เฉพาะ 127.0.0.1)');
      const loop = await fetch(`http://127.0.0.1:${port}/api/recovery/ready`);
      assert.equal(loop.status, 200, 'HTTP loopback ยังใช้ได้ (tool/updater/หน้าร้าน)');
      // ด่านความปลอดภัย: คำสั่งหยุดระบบต้องถูกปฏิเสธเมื่อมาจาก IP ที่ไม่ใช่ loopback (แม้ผ่าน HTTPS)
      const stop = await fetch(`https://${lanIp}:${httpsPort}/api/system/prepare-restore`, { method: 'POST' });
      assert.equal(stop.status, 403, `prepare-restore จาก LAN ต้องโดน 403 (ได้ ${stop.status}: ${(await stop.clone().text()).slice(0, 200)})`);
      const body = await stop.json();
      assert.ok(String(body.error || '').includes('เครื่องคลินิกเท่านั้น'), 'ต้องโดนด่าน remote-address ไม่ใช่ด่าน token');
    } finally {
      if (prevReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevReject;
      child.kill();
      await new Promise(r => { child.once('exit', r); setTimeout(r, 3000); });
    }
  });

  // 12.6) ทางเข้าที่ "เริ่มโปรแกรม" ทุกตัวต้องกู้ journal ค้างก่อนเปิด — ไม่ใช่เฉพาะปุ่มเปิด
  //       และห้าม rollback ทับรอบอัปเดตที่ยังทำงานอยู่ (ผู้ใช้กดไอคอนระหว่างจอค้าง 1-2 นาทีเป็นเรื่องปกติ)
  test('launcher เปิด/รีสตาร์ท กู้ journal ค้างได้ และไม่ทับรอบอัปเดตที่กำลังทำงาน', () => {
    const updateDir = path.join(trialTarget, 'update');
    const journalFile = path.join(updateDir, 'active-journal.json');
    const lockFile = path.join(updateDir, 'apply.lock');
    const serverFile = path.join(trialTarget, 'app', 'server.js');
    const realServer = fs.readFileSync(serverFile);
    const rollbackRoot = path.join(updateDir, 'stuck', 'rollback-app');
    const writeStuckState = () => {
      fs.mkdirSync(rollbackRoot, { recursive: true });
      fs.writeFileSync(path.join(rollbackRoot, 'server.js'), 'OLD-SERVER');
      fs.writeFileSync(serverFile, 'NEW-SERVER');
      fs.writeFileSync(journalFile, JSON.stringify({ format: 1, id: 'stuck', state: 'swapping-files',
        snapshot_file: null, files: [{ path: 'server.js', old_moved: true, new_published: true }], obsolete: [] }));
    };
    try {
      // (ก) มีรอบอัปเดตทำงานจริง — lock ถือโดย process ที่ยังมีชีวิต (ตัวรัน test นี้เอง)
      writeStuckState();
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      for (const launcher of ['เปิดระบบคลินิก.cmd', 'รีสตาร์ทระบบคลินิก.cmd']) {
        const run = runCmd(path.join(trialTarget, launcher), [], { CLINIC_INSTALL_TEST: '1' });
        assert.equal(run.code, 0, `${launcher} exit ${run.code}: ${run.output}`);
        assert.ok(run.output.includes('กำลังอัปเดตอยู่'), `${launcher} ต้องบอกผู้ใช้ว่ากำลังอัปเดต: ${run.output}`);
        assert.equal(fs.readFileSync(serverFile, 'utf8'), 'NEW-SERVER', `${launcher} ห้าม rollback ทับรอบที่กำลังทำงาน`);
        assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).state, 'swapping-files',
          `${launcher} ห้ามเปลี่ยน journal ของรอบที่กำลังทำงาน`);
      }
      // (ข) ตัวที่ทำอยู่ตายไปแล้ว (ไฟดับ) — ปุ่มรีสตาร์ทต้องกู้รุ่นเดิมกลับให้ก่อนเปิด
      fs.rmSync(lockFile, { force: true });
      const restart = runCmd(path.join(trialTarget, 'รีสตาร์ทระบบคลินิก.cmd'), [], { CLINIC_INSTALL_TEST: '1' });
      assert.equal(restart.code, 0, `restart exit ${restart.code}: ${restart.output}`);
      assert.equal(fs.readFileSync(serverFile, 'utf8'), 'OLD-SERVER', 'ปุ่มรีสตาร์ทต้องกู้ไฟล์รุ่นเดิมกลับ');
      assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).state, 'rolled-back');
      assert.ok(restart.output.includes('restart launcher'), `ต้องเปิดต่อหลังกู้เสร็จ: ${restart.output}`);
    } finally {
      fs.writeFileSync(serverFile, realServer);
      for (const leftover of [journalFile, `${journalFile}.previous`, lockFile]) fs.rmSync(leftover, { force: true });
      fs.rmSync(path.join(updateDir, 'stuck'), { recursive: true, force: true });
    }
  });

  // 13) ตัวจริงและ trial อยู่ร่วมกันได้โดยคนละโฟลเดอร์/ฐาน/launcher
  test('ตัวจริงกับชุดทดลองอยู่ร่วมกันโดยข้อมูลไม่ปนและไม่ใช้ทางเข้าเดียวกัน', () => {
    assert.notEqual(path.resolve(target), path.resolve(trialTarget));
    const prodDb = path.join(target, 'app', 'data', 'clinic.db');
    const trialDb = path.join(trialTarget, 'app', 'data', 'clinic.db');
    assert.notEqual(sha256(prodDb), sha256(trialDb));
    const prod = new DatabaseSync(prodDb, { readOnly: true });
    const trial = new DatabaseSync(trialDb, { readOnly: true });
    try {
      assert.equal(prod.prepare('SELECT COUNT(*) c FROM patients').get().c, 0);
      assert.ok(trial.prepare('SELECT COUNT(*) c FROM patients').get().c >= 100);
    } finally { prod.close(); trial.close(); }
    const prodLauncher = fs.readFileSync(path.join(target, 'เปิดระบบคลินิก.cmd'), 'utf8');
    const trialLauncher = fs.readFileSync(path.join(trialTarget, 'เปิดระบบคลินิก.cmd'), 'utf8');
    assert.ok(prodLauncher.includes('CLINIC_PORT=8080'));
    assert.ok(trialLauncher.includes('CLINIC_PORT=8081'));
  });

  // 14) Windows + Node บางรุ่นเคยไม่ลบโฟลเดอร์ชื่อไทยด้วย rmSync recursive ทำให้ build trial รอบสองชน EEXIST
  test('build ชุดทดลองซ้ำลงปลายทางเดิมได้โดยไม่ชนไฟล์ชื่อไทย', () => {
    const rebuilt = buildInstaller({ out: distDir, trial: true, noZip: true });
    assert.equal(rebuilt.ok, true);
    assert.ok(fs.existsSync(path.join(rebuilt.packageRoot, 'runtime', 'node.exe')));
    assert.ok(fs.existsSync(path.join(rebuilt.packageRoot, 'app', 'public', 'remed.js')));
  });

  // 15) ตัวช่วยสองเครื่องต้องจำกัดวงและสร้างทางลัดได้โดย TestMode ไม่แตะ Firewall จริง
  test('ตัวช่วยสองเครื่องจำกัด Private/LocalSubnet/HTTPS 8444 และสร้างทางลัด https พร้อมใช้', () => {
    const script = path.join(trialPackageRoot, 'scripts', 'setup-lan.ps1');
    const source = fs.readFileSync(script, 'utf8');
    assert.ok(source.includes('$httpsPort = 8444') && source.includes('-LocalPort $httpsPort'));
    assert.ok(source.includes('-Profile Private'));
    assert.ok(source.includes('-RemoteAddress LocalSubnet'));
    assert.ok(!source.includes('-LocalPort 8080') && !source.includes('-LocalPort 8081'));
    assert.ok(!source.includes('-Profile Any'));
    assert.ok(!source.includes('-RemoteAddress Any'));

    // Target ต้องเป็นโฟลเดอร์ที่ติดตั้งแล้ว (guard installed.marker) — ใช้ปลายทางที่ข้อ 9.5 ติดตั้งไว้
    const installedTarget = path.join(root, 'dirty-package-installed ภาษาไทย');
    const doctorFolder = path.join(root, 'doctor-shortcut');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Target', installedTarget, '-TestMode', '-TestIp', '192.168.50.10', '-OutputDir', doctorFolder], {
      encoding: 'utf8', timeout: 30000,
    });
    const shortcut = fs.readFileSync(path.join(doctorFolder, 'เปิดระบบคลินิก (ห้องหมอ).url'), 'utf8');
    const instructions = fs.readFileSync(path.join(doctorFolder, 'อ่านก่อนเปิด.txt'), 'utf8');
    assert.ok(shortcut.includes('URL=https://192.168.50.10:8444/'));
    assert.ok(instructions.includes('ไม่ต้องติดตั้งโปรแกรม'));
    assert.ok(instructions.includes('ติดตั้งใบรับรอง'));
    assert.ok(instructions.includes('ห้ามกรอกข้อมูลคนไข้จริง'));

    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(trialPackageRoot, 'scripts', 'remove-lan.ps1'), '-Target', trialPackageRoot, '-TestMode'], {
      encoding: 'utf8', timeout: 30000,
    });
  });

  // 16) ทุก CMD ที่ส่งให้ผู้ใช้ต้องเป็น CRLF เพื่อให้ cmd.exe อ่านภาษาไทย/label ได้เสถียร
  test('ไฟล์ CMD ทั้งหมดในชุดทดลองใช้ CRLF', () => {
    const cmdFiles = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.toLowerCase().endsWith('.cmd')) cmdFiles.push(full);
      }
    })(trialPackageRoot);
    assert.ok(cmdFiles.length >= 7);
    for (const file of cmdFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const name = path.relative(trialPackageRoot, file);
      assert.equal(/(^|[^\r])\n/.test(content), false, `${name} มี LF ที่ไม่ใช่ CRLF`);
    }
  });

  // 16.5) ชุดอัปเดตทับ (hotfix) — ทางส่งรุ่นใหม่ให้เครื่องที่ติดตั้งแล้วโดยไม่ลบ/ลงใหม่ ระหว่างที่ updater Phase 6 ยังไม่ทำงาน
  //       รันสคริปต์จริงจากโฟลเดอร์ที่แตก ZIP ชื่อไทย+ช่องว่าง ลงปลายทางที่ติดตั้งจากข้อ 12 — ต้องแทนไฟล์โปรแกรม
  //       แต่ไม่แตะฐานข้อมูล/cert และเก็บสำเนาของเดิม + snapshot ไว้; guard ทุกทางต้อง "ไม่แตะอะไร"
  const hotfixExtracted = path.join(root, 'hotfix แตกไฟล์ ภาษาไทย');
  let hotfixResult = null;
  test('build ชุดอัปเดตทับ (trial) แล้ว ZIP แตกได้ ชื่อไทยรอด ไม่มี runtime/data/กุญแจ', () => {
    hotfixResult = buildHotfix({ out: distDir, trial: true, buildTag: 'hf' });
    assert.equal(hotfixResult.ok, true);
    assert.ok(fs.existsSync(hotfixResult.zipFile), 'ต้องมี ZIP hotfix');
    assert.ok(path.basename(hotfixResult.zipFile).startsWith('ClinicTrialHotfix-'), 'ชื่อ ZIP ต้องไม่ชนกับ ClinicTrial- ของ stage-delivery');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${hotfixResult.zipFile}' -DestinationPath '${hotfixExtracted}' -Force`], { timeout: 120000 });
    const pkg = path.join(hotfixExtracted, TRIAL_HOTFIX_PACKAGE_NAME);
    for (const name of [HOTFIX_APPLY_CMD, 'อ่านก่อนอัปเดต.txt', 'hotfix-manifest.json', path.join('scripts', 'verify-hotfix.js'),
      path.join('app', 'server.js'), path.join('app', 'public', 'app.css'), path.join('app', 'tools', 'pre-upgrade-snapshot.js'),
      path.join('app', 'seed-mock-clinic.js')]) {
      assert.ok(fs.existsSync(path.join(pkg, name)), `hotfix ขาด ${name}`);
    }
    for (const name of DOCUMENT_FILES) assert.ok(fs.existsSync(path.join(pkg, 'เอกสาร', name)), `hotfix ขาดเอกสาร ${name}`);
    assert.equal(fs.existsSync(path.join(pkg, 'runtime')), false, 'hotfix ห้ามมี runtime');
    assert.equal(fs.existsSync(path.join(pkg, 'app', 'data')), false, 'hotfix ห้ามมี app/data');
    assert.equal(fs.existsSync(path.join(pkg, 'update')), false, 'hotfix ห้ามมี update/ (installed.marker) — ไม่ใช่ชุดที่ติดตั้ง');
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'hotfix-manifest.json'), 'utf8'));
    assert.equal(manifest.variant, 'trial');
    assert.equal(manifest.schema_version, SCHEMA_VERSION);
    for (const file of manifest.files) assert.equal(sha256(path.join(pkg, file.file)), file.sha256, `hash ไม่ตรงหลังแตก ZIP: ${file.file}`);
    const cmd = fs.readFileSync(path.join(pkg, HOTFIX_APPLY_CMD), 'utf8');
    assert.equal(/(^|[^\r])\n/.test(cmd), false, 'hotfix .cmd ต้องเป็น CRLF');
    assert.ok(cmd.includes('installed.marker') && cmd.includes('MessageBox') && cmd.includes('CLINIC_INSTALL_TEST'), 'ต้องมี guard/กล่อง/โหมดทดสอบ');
    assert.ok(cmd.includes('if "%SRC:~-1%"=="\\" set "SRC=%SRC:~0,-1%"'), 'ต้องตัด \\ ท้าย %~dp0');
  });

  const hotfixCmd = () => path.join(hotfixExtracted, TRIAL_HOTFIX_PACKAGE_NAME, HOTFIX_APPLY_CMD);
  const appliedFile = path.join(trialTarget, 'update', 'hotfix-applied.txt');
  const appliedLines = () => (fs.existsSync(appliedFile) ? fs.readFileSync(appliedFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length : 0);
  test('อัปเดตทับลงชุดทดลองที่ติดตั้งแล้ว: แทนไฟล์โปรแกรม ไม่แตะฐาน/cert มีสำเนาเดิม+snapshot', () => {
    const cssFile = path.join(trialTarget, 'app', 'public', 'app.css');
    const dbFile = path.join(trialTarget, 'app', 'data', 'clinic.db');
    const certDir = path.join(trialTarget, 'cert');
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(path.join(certDir, 'keep-me.txt'), 'cert stays');
    fs.writeFileSync(cssFile, '/* OLD-CSS จำลองรุ่นเก่า */');
    // บั๊กจริงเครื่องเจ้าของ 2026-08-17: ไฟล์รุ่นเก่าที่ "ขนาดเท่ากัน + เวลาเท่ากัน" กับรุ่นใหม่ (ZIP ตั้งเวลาคงที่, billing.js
    // ต่างแค่ตัวเดียว) → robocopy ปกติข้าม → hash ปลายทางไม่ตรง — จำลอง: เนื้อหาต่าง 1 ตัว ขนาดเท่า mtime เท่าต้นทาง
    const srcBilling = path.join(hotfixExtracted, TRIAL_HOTFIX_PACKAGE_NAME, 'app', 'lib', 'billing.js');
    const dstBilling = path.join(trialTarget, 'app', 'lib', 'billing.js');
    const billingBytes = Buffer.from(fs.readFileSync(srcBilling));
    billingBytes[billingBytes.length - 2] = billingBytes[billingBytes.length - 2] === 0x20 ? 0x21 : 0x20;
    fs.writeFileSync(dstBilling, billingBytes);
    const srcStat = fs.statSync(srcBilling);
    fs.utimesSync(dstBilling, srcStat.atime, srcStat.mtime);
    assert.equal(fs.statSync(dstBilling).size, srcStat.size);
    assert.notEqual(sha256(dstBilling), sha256(srcBilling));
    const dbBefore = sha256(dbFile);
    const run = runCmd(hotfixCmd(), [trialTarget], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(run.code, 0, `hotfix exit ${run.code}: ${run.output}`);
    assert.ok(run.output.includes('ตรวจชุดอัปเดต') && run.output.includes('ตรวจไฟล์ปลายทางผ่าน'), run.output);
    const manifest = JSON.parse(fs.readFileSync(path.join(hotfixExtracted, TRIAL_HOTFIX_PACKAGE_NAME, 'hotfix-manifest.json'), 'utf8'));
    for (const file of manifest.files) assert.equal(sha256(path.join(trialTarget, file.file)), file.sha256, `ปลายทางไม่ตรงรุ่นใหม่: ${file.file}`);
    assert.equal(sha256(dbFile), dbBefore, 'ฐานข้อมูลต้องไม่ถูกแตะ');
    assert.equal(fs.readFileSync(path.join(certDir, 'keep-me.txt'), 'utf8'), 'cert stays', 'cert/ ต้องอยู่ครบ');
    assert.ok(fs.existsSync(path.join(trialTarget, 'update', 'installed.marker')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(trialTarget, 'update', 'install-profile.json'), 'utf8')).variant, 'trial');
    assert.equal(appliedLines(), 1, 'ต้องบันทึก hotfix-applied.txt 1 บรรทัด');
    const backupRoot = path.join(trialTarget, 'update', 'hotfix-backup', manifest.tag);
    assert.equal(fs.readFileSync(path.join(backupRoot, 'app', 'public', 'app.css'), 'utf8'), '/* OLD-CSS จำลองรุ่นเก่า */', 'สำเนาของเดิมต้องเป็นไฟล์เก่า');
    assert.equal(fs.existsSync(path.join(backupRoot, 'app', 'data')), false, 'สำเนาต้องไม่ก๊อป app/data');
    const snap = new DatabaseSync(path.join(backupRoot, 'clinic-before.db'), { readOnly: true });
    try {
      assert.equal(snap.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.ok(snap.prepare('SELECT COUNT(*) c FROM patients').get().c >= 100);
    } finally { snap.close(); }
    // รันซ้ำได้ (idempotent) และสำเนารอบสองไม่ทับรอบแรก
    const again = runCmd(hotfixCmd(), [trialTarget], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(again.code, 0, again.output);
    assert.equal(appliedLines(), 2);
    assert.equal(fs.readFileSync(path.join(backupRoot, 'app', 'public', 'app.css'), 'utf8'), '/* OLD-CSS จำลองรุ่นเก่า */', 'สำเนารอบแรกต้องไม่ถูกทับ');
    // บั๊กหน้างานเครื่องหมอ 2026-08-17 (log จริง): แตก ZIP "ทับลงใน C:\clinic-trial โดยตรง" → SRC = TARGET → robocopy ก๊อปทับตัวเอง ERROR 32 ทุกไฟล์
    // จำลอง: ก๊อปเนื้อหาชุด hotfix ลงปลายทาง (เหมือน Explorer แทนที่) แล้วรัน .cmd จากปลายทาง → ต้องข้ามคัดลอก ตรวจ SHA ผ่าน จบเขียว ไม่ค้าง
    const pkg = path.join(hotfixExtracted, TRIAL_HOTFIX_PACKAGE_NAME);
    try { execFileSync('robocopy', [pkg, trialTarget, '/E', '/IS', '/IT', '/IM', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS'], { stdio: 'ignore' }); } catch (e) { if ((e.status || 16) >= 8) throw e; } // robocopy exit 1-7 = สำเร็จ
    assert.ok(fs.existsSync(path.join(trialTarget, HOTFIX_APPLY_CMD)) && fs.existsSync(path.join(trialTarget, 'hotfix-manifest.json')), 'จำลองการแตกทับไม่สำเร็จ');
    const started = Date.now();
    const same = runCmd(path.join(trialTarget, HOTFIX_APPLY_CMD), [trialTarget], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(same.code, 0, `แตกทับลงโฟลเดอร์ติดตั้งต้องยังจบได้: ${same.output}`);
    assert.ok(same.output.includes('ไฟล์รุ่นใหม่อยู่ในที่แล้ว'), same.output);
    assert.ok(Date.now() - started < 60000, 'ต้องไม่ค้าง');
    assert.equal(appliedLines(), 3);
    const sameLog = fs.readdirSync(path.join(trialTarget, 'logs')).filter(n => n.startsWith('hotfix-')).map(n => fs.readFileSync(path.join(trialTarget, 'logs', n), 'utf8')).join('\n');
    assert.ok(sameLog.includes('[same-folder]'), 'log ต้องบันทึกว่าข้ามคัดลอกเพราะโฟลเดอร์เดียวกัน');
  });

  test('guard ของชุดอัปเดตทับ: ไม่มี marker / ชุดจริง / journal ค้าง / schema ไม่ตรง / ZIP เสีย → หยุดโดยไม่แตะอะไร', () => {
    const before = appliedLines();
    // (ก) ปลายทางไม่มีอะไร (ยังไม่เคยติดตั้ง) → ต้องไม่สร้างโฟลเดอร์
    const nowhere = path.join(root, 'ยังไม่ติดตั้ง ที่นี่');
    const a = runCmd(hotfixCmd(), [nowhere], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(a.code, 1, `ต้องปฏิเสธเมื่อไม่มี installed.marker: ${a.output}`);
    assert.ok(a.output.includes('ไม่พบ'), a.output);
    assert.equal(fs.existsSync(nowhere), false, 'ห้ามสร้างปลายทางเอง');
    // (ข) ชุดจริงที่ติดตั้งแล้ว (ข้อ 4) — hotfix ของ trial ต้องไม่ลง
    const prodServer = path.join(target, 'app', 'server.js');
    const prodBefore = sha256(prodServer);
    const b = runCmd(hotfixCmd(), [target], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(b.code, 1, `ต้องปฏิเสธชุดจริง: ${b.output}`);
    assert.ok(b.output.includes('ไม่ใช่ระบบคลินิก (ทดลอง)'), b.output);
    assert.equal(sha256(prodServer), prodBefore);
    assert.equal(fs.existsSync(path.join(target, 'update', 'hotfix-applied.txt')), false);
    assert.equal(fs.existsSync(path.join(target, 'update', 'hotfix-backup')), false, 'ห้ามสำรองก่อนตรวจผ่าน');
    // (ค) มีการอัปเดตค้าง
    const journal = path.join(trialTarget, 'update', 'active-journal.json');
    fs.writeFileSync(journal, JSON.stringify({ format: 1, id: 'x', state: 'swapping-files', files: [], obsolete: [] }));
    try {
      const c = runCmd(hotfixCmd(), [trialTarget], { CLINIC_INSTALL_TEST: '1' });
      assert.equal(c.code, 1, c.output);
      assert.ok(c.output.includes('อัปเดตค้าง'), c.output);
    } finally { fs.rmSync(journal, { force: true }); }
    // (ง) schema บนเครื่องไม่เท่ากับชุดอัปเดต (= รุ่นที่มี migration) → ต้องใช้ตัวติดตั้งเต็ม
    const dbFile = path.join(trialTarget, 'app', 'data', 'clinic.db');
    const bump = version => { const db = new DatabaseSync(dbFile); try { db.exec(`PRAGMA user_version = ${version}`); } finally { db.close(); } };
    bump(SCHEMA_VERSION + 1);
    try {
      const d = runCmd(hotfixCmd(), [trialTarget], { CLINIC_INSTALL_TEST: '1' });
      assert.equal(d.code, 1, d.output);
      assert.ok(d.output.includes('คนละแบบ'), d.output);
    } finally { bump(SCHEMA_VERSION); }
    // (จ) ไฟล์ในชุดอัปเดตไม่ตรง manifest (ZIP โหลดไม่ครบ/ถูกแก้)
    const tampered = path.join(hotfixExtracted, TRIAL_HOTFIX_PACKAGE_NAME, 'app', 'lib', 'print.js');
    const original = fs.readFileSync(tampered);
    fs.writeFileSync(tampered, 'tampered');
    try {
      const e = runCmd(hotfixCmd(), [trialTarget], { CLINIC_INSTALL_TEST: '1' });
      assert.equal(e.code, 1, e.output);
      assert.ok(e.output.includes('ไม่ครบหรือไม่ตรง'), e.output);
      assert.notEqual(fs.readFileSync(path.join(trialTarget, 'app', 'lib', 'print.js'), 'utf8'), 'tampered', 'ไฟล์เสียห้ามหลุดไปปลายทาง');
    } finally { fs.writeFileSync(tampered, original); }
    // (ฉ) บั๊กหน้างานเครื่องหมอ 2026-08-17: ชุดติดตั้งแบบ Run as administrator → ผู้ใช้ธรรมดาเขียนทับไฟล์ไม่ได้ → robocopy รอ retry เงียบ = "ค้าง"
    //     ตอนนี้ต้องเช็คสิทธิ์เขียนก่อน แล้ว (นอกโหมดทดสอบ) ยกสิทธิ์เอง; ในโหมดทดสอบต้องหยุดทันทีไม่แตะอะไร ไม่ค้าง
    const pkgJson = path.join(trialTarget, 'app', 'package.json');
    const me = process.env.USERNAME || os.userInfo().username;
    execFileSync('icacls', [pkgJson, '/deny', `${me}:(W)`], { stdio: 'ignore' });
    try {
      const started = Date.now();
      const f = runCmd(hotfixCmd(), [trialTarget], { CLINIC_INSTALL_TEST: '1' });
      assert.equal(f.code, 1, f.output);
      assert.ok(f.output.includes('ไม่มีสิทธิ์เขียน'), f.output);
      assert.ok(Date.now() - started < 60000, 'ต้องไม่ค้างรอ retry ของ robocopy');
      assert.equal(fs.existsSync(path.join(trialTarget, 'update', 'hotfix-backup')) && fs.readdirSync(path.join(trialTarget, 'update', 'hotfix-backup')).length, 2, 'ไม่สำรองเพิ่มเมื่อยังไม่มีสิทธิ์เขียน (มีแค่ 2 รอบก่อนหน้า — รอบแตกทับไม่สำรองเพราะไม่มีของเดิมให้สำรอง)');
    } finally { execFileSync('icacls', [pkgJson, '/remove:d', me], { stdio: 'ignore' }); }
    // หลังคืนสิทธิ์ ต้องรันผ่านตามปกติ และ log robocopy อยู่ใน logs\ (ไม่ซ่อนลง nul อีก)
    const okAgain = runCmd(hotfixCmd(), [trialTarget], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(okAgain.code, 0, okAgain.output);
    const logs = fs.readdirSync(path.join(trialTarget, 'logs')).filter(n => n.startsWith('hotfix-'));
    assert.ok(logs.length >= 1 && fs.readFileSync(path.join(trialTarget, 'logs', logs[0]), 'utf8').includes('Files :'), 'robocopy ต้องเขียนสรุปลง logs\\hotfix-<tag>.log');
    assert.equal(appliedLines(), before + 1, 'guard ทุกทางต้องไม่บันทึกว่าอัปเดต (มีแค่รอบที่ผ่านหลังคืนสิทธิ์)');
  });

  // 17) harness ต้องรันได้จากทุก shell: wrapper ห้ามฝัง path ที่ไม่ใช่ ASCII
  //     (บั๊กจริง 2026-08-15: รันจาก Git Bash แล้ว cmd.exe อ่าน path ไทยในไฟล์ wrapper เพี้ยน = แดงปลอม)
  test('wrapper รัน .cmd ไทยได้โดยไม่ฝัง path ลงไฟล์ (ต้องผ่านทั้ง PowerShell และ Git Bash)', () => {
    for (const count of [0, 1, 2]) {
      const body = wrapperBody(count);
      assert.equal(/[^\x00-\x7f]/.test(body), false, `wrapper ที่มี ${count} argument ต้องเป็น ASCII ล้วน`);
      assert.ok(body.startsWith('@echo off\r\nchcp 65001 >nul\r\n'), 'wrapper ต้องตั้ง codepage เองก่อนเรียก');
    }
    const echoRoot = path.join(root, 'wrapper ไทย');
    fs.mkdirSync(echoRoot, { recursive: true });
    const echoCmd = path.join(echoRoot, 'สะท้อนพารามิเตอร์.cmd');
    fs.writeFileSync(echoCmd, '@echo off\r\nchcp 65001 >nul\r\necho ARG1=%~1\r\nexit /b 0\r\n');
    const run = runCmd(echoCmd, [path.join(echoRoot, 'ปลายทางทดสอบ')], { CLINIC_INSTALL_TEST: '1' });
    assert.equal(run.code, 0, run.output);
    assert.ok(run.output.includes('ARG1=' + path.join(echoRoot, 'ปลายทางทดสอบ')), run.output);
  });

  console.log(`\nผ่านทั้งหมด ${passed} ข้อ`);
  fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => {
  console.error(error.message || error);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
