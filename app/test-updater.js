'use strict';
// Adversarial tests ของ updater — ใช้ temp dir + synthetic key เท่านั้น ไม่แตะ app/data หรือ server จริง
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writeZip, parseZip, extractZipExact } = require('./lib/zip');
const { validateManifest, verifyAndParseManifest, signManifestBytes, checkManifestPolicy } = require('./lib/update-manifest');
const { buildUpdatePackage } = require('./tools/build-update-package');
const updateCore = require('./lib/update-core');
const { UpdateService, safeHttpsUrl, fetchHttpsBuffer } = require('./lib/update-service');
const { collectReleasePaths } = require('./tools/build-update-package');
const { DatabaseSync } = require('node:sqlite');

let passed = 0;
const asyncTests = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.stack || error}`); process.exitCode = 1; }
}
function testAsync(name, fn) { asyncTests.push({ name, fn }); }
function mustThrow(fn, code) {
  assert.throws(fn, error => !code || error.code === code, `ต้องปฏิเสธด้วย ${code || 'error'}`);
}
function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function replaceAllSameLength(buffer, from, to) {
  assert.strictEqual(Buffer.byteLength(from), Buffer.byteLength(to));
  const result = Buffer.from(buffer), a = Buffer.from(from), b = Buffer.from(to);
  let found = 0, at = 0;
  while ((at = result.indexOf(a, at)) >= 0) { b.copy(result, at); at += b.length; found++; }
  assert(found >= 2, `ไม่พบชื่อ ${from} ทั้ง local/central`);
  return result;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-updater-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
let builtRelease = null;
const baseManifest = {
  format: 1, product: 'clinic-offline', edition: 'standard', version: '1.1.0', variant: 'production', channel: 'pilot',
  min_from_version: '1.0.0', min_runtime: '22.5.0', expected_schema: 9, created_at: '2026-08-15T00:00:00.000Z',
  package: { url: 'https://example.invalid/releases/ClinicApp-1.1.0-production-pilot.zip',
    file: 'ClinicApp-1.1.0-production-pilot.zip', bytes: 123, sha256: 'a'.repeat(64) },
  files: [{ path: 'server.js', bytes: 3, sha256: hash(Buffer.from('abc')) }], obsolete: [],
};

console.log('Updater adversarial tests');
test('เซ็น exact manifest bytes แล้ว verify ก่อน parse ได้', () => {
  const bytes = Buffer.from(JSON.stringify(baseManifest) + '\n');
  const signature = signManifestBytes(bytes, privateKey);
  assert.deepStrictEqual(verifyAndParseManifest(bytes, signature, publicKey), baseManifest);
  const altered = Buffer.from(bytes); altered[20] ^= 1;
  mustThrow(() => verifyAndParseManifest(altered, signature, publicKey), 'MANIFEST_SIGNATURE');
});

test('wrong key และ signature format ผิดถูกปฏิเสธ', () => {
  const bytes = Buffer.from(JSON.stringify(baseManifest));
  const signature = signManifestBytes(bytes, privateKey);
  const other = crypto.generateKeyPairSync('ed25519').publicKey;
  mustThrow(() => verifyAndParseManifest(bytes, signature, other), 'MANIFEST_SIGNATURE');
  mustThrow(() => verifyAndParseManifest(bytes, 'not-base64', publicKey), 'MANIFEST_SIGNATURE');
});

test('manifest strict ปฏิเสธ unknown field ทุกระดับ', () => {
  mustThrow(() => validateManifest({ ...baseManifest, command: 'run-me' }), 'MANIFEST_UNKNOWN_FIELD');
  mustThrow(() => validateManifest({ ...baseManifest, package: { ...baseManifest.package, mirror: 'x' } }), 'MANIFEST_UNKNOWN_FIELD');
  mustThrow(() => validateManifest({ ...baseManifest, files: [{ ...baseManifest.files[0], mode: 7 }] }), 'MANIFEST_UNKNOWN_FIELD');
});

test('policy กัน downgrade, min-from, runtime, variant และ channel', () => {
  const policy = { currentVersion: '1.0.0', runtimeVersion: '22.5.0', variant: 'production', channel: 'pilot', edition: 'standard', expectedSchema: 9 };
  assert.deepStrictEqual(checkManifestPolicy(baseManifest, policy), { ok: true, version: '1.1.0' });
  mustThrow(() => checkManifestPolicy({ ...baseManifest, version: '1.0.0' }, policy), 'POLICY_DOWNGRADE');
  mustThrow(() => checkManifestPolicy({ ...baseManifest, min_from_version: '1.0.1' }, policy), 'POLICY_FULL_INSTALL_REQUIRED');
  mustThrow(() => checkManifestPolicy({ ...baseManifest, min_runtime: '99.0.0' }, policy), 'POLICY_RUNTIME');
  mustThrow(() => checkManifestPolicy(baseManifest, { ...policy, variant: 'trial' }), 'POLICY_VARIANT');
  mustThrow(() => checkManifestPolicy(baseManifest, { ...policy, channel: 'stable' }), 'POLICY_CHANNEL');
});

test('Node ZIP writer/reader แตกไทยและตรวจ exact inventory', () => {
  const zip = path.join(temp, 'good.zip'), out = path.join(temp, 'good-out');
  const content = Buffer.from('สวัสดี updater');
  writeZip(zip, [{ name: 'public/ทดสอบ.txt', data: content }, { name: 'server.js', data: Buffer.from('abc') }]);
  const inventory = [{ path: 'public/ทดสอบ.txt', bytes: content.length, sha256: hash(content) },
    { path: 'server.js', bytes: 3, sha256: hash(Buffer.from('abc')) }];
  const result = extractZipExact(zip, out, inventory);
  assert.strictEqual(result.files, 2);
  assert.deepStrictEqual(fs.readFileSync(path.join(out, 'public', 'ทดสอบ.txt')), content);
  mustThrow(() => extractZipExact(zip, path.join(temp, 'extra-out'), inventory.slice(0, 1)), 'ZIP_INVENTORY');
});

test('ZIP traversal และชื่อซ้ำแบบ Windows ถูกปฏิเสธก่อนเขียน', () => {
  const zip = path.join(temp, 'names.zip');
  writeZip(zip, [{ name: 'xx/evil.js', data: Buffer.from('x') }, { name: 'safe.js', data: Buffer.from('y') }]);
  mustThrow(() => parseZip(replaceAllSameLength(fs.readFileSync(zip), 'xx/evil.js', '../evil.js')), 'ZIP_UNSAFE_PATH');
  const duplicateZip = path.join(temp, 'dupe.zip');
  writeZip(duplicateZip, [{ name: 'a.js', data: Buffer.from('x') }, { name: 'b.js', data: Buffer.from('y') }]);
  mustThrow(() => parseZip(replaceAllSameLength(fs.readFileSync(duplicateZip), 'b.js', 'A.js')), 'ZIP_DUPLICATE_PATH');
  for (const name of ['CON.txt', 'public/file.js:stream', 'public/trailing.']) {
    mustThrow(() => writeZip(path.join(temp, `${crypto.randomUUID()}.zip`), [{ name, data: Buffer.from('x') }]), 'ZIP_UNSAFE_PATH');
  }
});

test('ZIP ที่แก้ payload หรือประกาศขนาดเกิน limit ถูกปฏิเสธ', () => {
  const zip = path.join(temp, 'tamper.zip');
  writeZip(zip, [{ name: 'server.js', data: Buffer.from('abc') }]);
  const parsed = parseZip(zip), changed = Buffer.from(parsed.buffer);
  changed[parsed.entries[0].dataStart] ^= 1;
  const changedFile = path.join(temp, 'changed.zip'); fs.writeFileSync(changedFile, changed);
  mustThrow(() => extractZipExact(changedFile, path.join(temp, 'changed-out'), [baseManifest.files[0]]));
  mustThrow(() => parseZip(zip, { maxUncompressedBytes: 2 }), 'ZIP_TOO_LARGE');
});

test('builder สร้าง app-only ZIP, manifest, signature และ audit ที่ตรวจย้อนกลับได้', () => {
  const keyFile = path.join(temp, 'synthetic-private.pem');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const out = path.join(temp, 'release');
  const result = buildUpdatePackage({ out, keyFile, minFrom: '0.9.0',
    baseUrl: 'https://example.invalid/releases/', variant: 'production', channel: 'pilot', createdAt: '2026-08-15T00:00:00Z' });
  const manifestBytes = fs.readFileSync(path.join(out, result.manifestFile));
  const manifest = verifyAndParseManifest(manifestBytes, fs.readFileSync(path.join(out, result.signatureFile)), publicKey);
  assert.strictEqual(hash(fs.readFileSync(path.join(out, result.packageFile))), manifest.package.sha256);
  assert(!manifest.files.some(item => /(^|\/)(data|runtime)(\/|$)|(^|\/)test-|recovery-key|\.db$/i.test(item.path)));
  const extracted = path.join(temp, 'release-out');
  extractZipExact(path.join(out, result.packageFile), extracted, manifest.files);
  assert(fs.existsSync(path.join(extracted, 'lib', 'update-manifest.js')));
  assert(fs.existsSync(path.join(out, result.auditFile)));
  assert(!fs.readdirSync(out).some(name => /private|\.key$|\.pem$/i.test(name)));
  builtRelease = { out, result, manifest, keyFile, publicKeyFile: path.join(temp, 'synthetic-public.pem') };
  fs.writeFileSync(builtRelease.publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }));
  mustThrow(() => buildUpdatePackage({ out: path.join(temp, 'wrong-version'), keyFile, minFrom: '0.9.0', version: '9.9.9',
    baseUrl: 'https://example.invalid/releases/', variant: 'production', channel: 'pilot' }));
});

test('snapshot receipt ใช้เป็น --expect เพื่อ rehearsal บนสำเนาโดยตรง', () => {
  assert(builtRelease);
  const installRoot = path.join(temp, 'rehearsal-install'), appRoot = path.join(installRoot, 'app');
  fs.mkdirSync(path.join(appRoot, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'tools', 'pre-upgrade-snapshot.js'), path.join(appRoot, 'tools', 'pre-upgrade-snapshot.js'));
  const dataDir = path.join(appRoot, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  const seed = spawnSync(process.execPath, ['--no-warnings', 'seed.js'], { cwd: __dirname,
    env: { ...process.env, CLINIC_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(seed.status, 0, seed.stderr);
  const snapshot = updateCore.createVerifiedSnapshot({ appRoot, databaseFile: path.join(dataDir, 'clinic.db'),
    updateId: 'rehearsal-test', executable: process.execPath });
  const stagedApp = path.join(temp, 'release-out');
  // workRoot ภาษาไทยคือสภาพจริงของเครื่องคลินิก และ Node/Windows เคยลบ tree ชื่อไทยไม่ออกโดยไม่ throw
  const workRoot = path.join(installRoot, 'update', 'งานซ้อม');
  const result = updateCore.runMigrationRehearsal({ executable: process.execPath, workRoot,
    stagedApp, snapshotFile: snapshot.snapshotFile, expectFile: snapshot.expectFile,
    expectedSchema: builtRelease.manifest.expected_schema });
  assert.deepStrictEqual(result, { ok: true, schema: builtRelease.manifest.expected_schema });
  assert.strictEqual(fs.existsSync(path.join(workRoot, 'rehearsal')), false,
    'สำเนาฐานข้อมูลคนไข้ที่ใช้ซ้อม migration ต้องถูกลบจริง แม้ path จะเป็นภาษาไทย');
  const receipt = JSON.parse(fs.readFileSync(snapshot.expectFile, 'utf8'));
  assert.strictEqual(receipt.integrity, 'ok');
  assert.strictEqual(Object.hasOwn(receipt, 'patients'), true);
});

test('file journal rollback คืนทั้งไฟล์เดิมและ DB snapshot', () => {
  const root = path.join(temp, 'transaction'), appRoot = path.join(root, 'app'), stagedApp = path.join(root, 'stage');
  fs.mkdirSync(appRoot, { recursive: true }); fs.mkdirSync(stagedApp, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'server.js'), 'old'); fs.writeFileSync(path.join(stagedApp, 'server.js'), 'new');
  const rollbackRoot = path.join(root, 'update', 'x', 'rollback-app');
  const journalFile = path.join(root, 'update', updateCore.JOURNAL_NAME);
  const journal = { format: 1, id: 'x', state: 'rehearsal-passed', snapshot_file: null, files: [], obsolete: [] };
  updateCore.atomicWriteJson(journalFile, journal);
  updateCore.applyFileTransaction({ appRoot, stagedApp, rollbackRoot,
    manifest: { files: [{ path: 'server.js' }], obsolete: [] }, journal, journalFile });
  assert.strictEqual(fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8'), 'new');
  updateCore.rollbackTransaction({ journal, journalFile, appRoot, rollbackRoot });
  assert.strictEqual(fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8'), 'old');
  assert.strictEqual(JSON.parse(fs.readFileSync(journalFile, 'utf8')).state, 'rolled-back');
});

test('launcher recovery ใช้ journal.previous ได้ถ้าไฟดับตรงช่องสลับชื่อ', () => {
  const root = path.join(temp, 'power-gap'), appRoot = path.join(root, 'app');
  const rollbackRoot = path.join(root, 'update', 'gap', 'rollback-app');
  fs.mkdirSync(appRoot, { recursive: true }); fs.mkdirSync(rollbackRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'server.js'), 'new'); fs.writeFileSync(path.join(rollbackRoot, 'server.js'), 'old');
  const journalFile = path.join(root, 'update', updateCore.JOURNAL_NAME);
  updateCore.atomicWriteJson(journalFile, { format: 1, id: 'gap', state: 'swapping-files', snapshot_file: null,
    files: [{ path: 'server.js', old_moved: true, new_published: true }], obsolete: [] });
  fs.renameSync(journalFile, `${journalFile}.previous`); // จำลองไฟดับหลัง active → previous ก่อน publish active ใหม่
  const result = updateCore.recoverUnfinished({ installRoot: root });
  assert.deepStrictEqual(result, { ok: true, recovered: true, state: 'rolled-back' });
  assert.strictEqual(fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8'), 'old');
  assert.strictEqual(JSON.parse(fs.readFileSync(journalFile, 'utf8')).state, 'rolled-back');
});

test('kill-point ทุก journal transition จบด้วย committed หรือกู้เป็น rolled-back', () => {
  const phases = ['validated', 'server-stopped', 'snapshot-created', 'rehearsal-passed', 'swapping-files',
    'files-swapped', 'starting-new', 'rolling-back'];
  for (const phase of phases) {
    const root = path.join(temp, `kill-${phase}`), updateRoot = path.join(root, 'update');
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    const journalFile = path.join(updateRoot, updateCore.JOURNAL_NAME);
    const script = `const c=require(process.argv[1]);const f=process.argv[2],p=process.argv[3];const j={format:1,id:'kill-test',state:'before',snapshot_file:null,files:[],obsolete:[]};c.atomicWriteJson(f,j);c.updateJournal(f,j,p);`;
    const child = spawnSync(process.execPath, ['-e', script, path.join(__dirname, 'lib', 'update-core.js'), journalFile, phase], {
      env: { ...process.env, CLINIC_UPDATE_TEST: '1', CLINIC_UPDATE_KILL_AT: phase }, encoding: 'utf8', timeout: 10000,
    });
    assert.strictEqual(child.status, 86, `${phase}: ${child.stderr}`);
    const recovered = updateCore.recoverUnfinished({ installRoot: root });
    assert.strictEqual(recovered.state, 'rolled-back', phase);
  }
});

test('health failure หลัง DB เปลี่ยน คืนทั้งโค้ดและ snapshot DB', () => {
  const root = path.join(temp, 'health-rollback'), appRoot = path.join(root, 'app');
  const rollbackRoot = path.join(root, 'update', 'health', 'rollback-app');
  fs.mkdirSync(appRoot, { recursive: true }); fs.mkdirSync(rollbackRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'server.js'), 'new'); fs.writeFileSync(path.join(rollbackRoot, 'server.js'), 'old');
  const data = path.join(appRoot, 'data'); fs.mkdirSync(data, { recursive: true });
  const dbFile = path.join(data, 'clinic.db'), snapshot = path.join(data, 'before.db');
  const db = new DatabaseSync(dbFile); db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY); INSERT INTO sample VALUES(1)');
  db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`); db.exec('INSERT INTO sample VALUES(2)'); db.close();
  const journalFile = path.join(root, 'update', updateCore.JOURNAL_NAME);
  const journal = { format: 1, id: 'health', state: 'starting-new', snapshot_file: snapshot,
    files: [{ path: 'server.js', old_moved: true, new_published: true }], obsolete: [] };
  updateCore.atomicWriteJson(journalFile, journal);
  updateCore.rollbackTransaction({ journal, journalFile, appRoot, rollbackRoot });
  assert.strictEqual(fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8'), 'old');
  const restored = new DatabaseSync(dbFile, { readOnly: true });
  assert.strictEqual(restored.prepare('SELECT COUNT(*) c FROM sample').get().c, 1); restored.close();
});

test('ไฟดับซ้ำกลาง rollback ไม่ย้ายไฟล์เก่าที่คืนแล้วออก และคืน DB ซ้ำได้', () => {
  const root = path.join(temp, 'rollback-twice'), appRoot = path.join(root, 'app');
  const rollbackRoot = path.join(root, 'update', 'again', 'rollback-app');
  fs.mkdirSync(appRoot, { recursive: true }); fs.mkdirSync(rollbackRoot, { recursive: true });
  // จำลองไฟดับหลังไฟล์เก่าถูกย้ายกลับ target แล้ว: rollback copy หาย แต่ flags ยังไม่เปลี่ยน
  fs.writeFileSync(path.join(appRoot, 'server.js'), 'old-restored');
  const data = path.join(appRoot, 'data'); fs.mkdirSync(data, { recursive: true });
  const dbFile = path.join(data, 'clinic.db'), snapshot = path.join(data, 'before.db');
  const db = new DatabaseSync(dbFile); db.exec('CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(99)'); db.close();
  const snapDb = new DatabaseSync(snapshot); snapDb.exec('CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1)'); snapDb.close();
  const failedData = path.join(root, 'update', 'again', 'failed-new', 'data'); fs.mkdirSync(failedData, { recursive: true });
  fs.writeFileSync(path.join(failedData, 'clinic.db'), 'หลักฐานรอบก่อน');
  const journalFile = path.join(root, 'update', updateCore.JOURNAL_NAME);
  const journal = { format: 1, id: 'again', state: 'rolling-back', snapshot_file: snapshot,
    files: [{ path: 'server.js', old_moved: true, new_published: true }], obsolete: [] };
  updateCore.atomicWriteJson(journalFile, journal);
  updateCore.rollbackTransaction({ journal, journalFile, appRoot, rollbackRoot });
  assert.strictEqual(fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8'), 'old-restored');
  const restored = new DatabaseSync(dbFile, { readOnly: true });
  assert.strictEqual(restored.prepare('SELECT id FROM sample').get().id, 1); restored.close();
  assert(fs.existsSync(path.join(failedData, 'clinic.db.retry-1')));
});

test('apply lock กัน assistant สองตัวพร้อมกัน และยึดคืนได้เมื่อตัวเดิมตายไปแล้ว', () => {
  const root = path.join(temp, 'apply-lock');
  fs.mkdirSync(path.join(root, 'update'), { recursive: true });
  assert.strictEqual(updateCore.readApplyLock(root), null);
  const release = updateCore.acquireApplyLock(root);
  assert.strictEqual(updateCore.readApplyLock(root).alive, true);
  assert.strictEqual(updateCore.readApplyLock(root).pid, process.pid);
  mustThrow(() => updateCore.acquireApplyLock(root), 'UPDATE_IN_PROGRESS');
  release();
  assert.strictEqual(updateCore.readApplyLock(root), null);
  // ไฟดับกลางอัปเดตทิ้ง lock ไว้ — ต้องยึดคืนได้ ไม่งั้นเครื่องอัปเดตไม่ได้อีกเลย
  fs.writeFileSync(path.join(root, 'update', updateCore.APPLY_LOCK_NAME),
    JSON.stringify({ pid: 2147483646, started_at: '2026-08-15T00:00:00.000Z' }));
  assert.strictEqual(updateCore.readApplyLock(root).alive, false);
  const retaken = updateCore.acquireApplyLock(root);
  assert.strictEqual(updateCore.readApplyLock(root).pid, process.pid);
  retaken();
});

test('URL ที่มี query/credential/fragment ถูกปฏิเสธทั้ง manifest และ feed', () => {
  for (const url of ['https://example.invalid/releases/ClinicApp-1.1.0-production-pilot.zip?token=x',
    'https://u:p@example.invalid/releases/ClinicApp-1.1.0-production-pilot.zip',
    'https://example.invalid/releases/ClinicApp-1.1.0-production-pilot.zip#frag',
    'http://example.invalid/releases/ClinicApp-1.1.0-production-pilot.zip']) {
    mustThrow(() => validateManifest({ ...baseManifest, package: { ...baseManifest.package, url } }), 'MANIFEST_URL');
  }
  mustThrow(() => safeHttpsUrl('https://updates.example/latest.json?v=2', 'feed'), 'UPDATE_FEED_URL');
  mustThrow(() => safeHttpsUrl('http://updates.example/latest.json', 'feed'), 'UPDATE_FEED_URL');
});

// GitHub Releases: URL ที่ตั้งค่าสะอาด แต่ปลายทาง redirect เป็น signed URL มี ?X-Amz-... เสมอ — ต้องตามได้ (ก่อนแก้ 2026-08-19 ถูกปฏิเสธเป็น UPDATE_FEED_URL ทำให้ดาวน์โหลดจาก GitHub ไม่ได้เลย)
// และ redirect ออกนอก HTTPS หรือลึกเกิน 3 ชั้นต้องถูกปฏิเสธ · URL ตั้งต้นที่มี query ยังถูกปฏิเสธเหมือนเดิม
testAsync('ดาวน์โหลดตาม redirect แบบ GitHub (latest → tag → objects.githubusercontent.com?X-Amz-...) ได้ แต่ไม่ยอมหลุด HTTPS', async () => {
  const EventEmitter = require('node:events');
  const body = Buffer.from('{"hello":"feed"}');
  const fakeRequester = (chain) => (url, options, onResponse) => {
    const req = new EventEmitter(); req.end = () => {
      const step = chain.shift();
      const res = new EventEmitter(); res.statusCode = step.status; res.headers = step.headers || {}; res.resume = () => {};
      assert.equal(url.href, step.expect, 'ลำดับ URL ที่ถูกเรียกต้องตรง');
      onResponse(res);
      if (step.status === 200) { res.emit('data', body); res.emit('end'); }
    }; req.destroy = () => {}; return req;
  };
  const start = 'https://github.com/mkungsuki/mk-artifacts/releases/latest/download/latest-production-pilot.json';
  const got = await fetchHttpsBuffer(start, 1024, 3, fakeRequester([
    { expect: start, status: 302, headers: { location: 'https://github.com/mkungsuki/mk-artifacts/releases/download/v1.0.0/latest-production-pilot.json' } },
    { expect: 'https://github.com/mkungsuki/mk-artifacts/releases/download/v1.0.0/latest-production-pilot.json', status: 302,
      headers: { location: 'https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&response-content-disposition=attachment%3B%20filename%3Dlatest-production-pilot.json' } },
    { expect: 'https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&response-content-disposition=attachment%3B%20filename%3Dlatest-production-pilot.json', status: 200 },
  ]));
  assert.equal(got.toString(), body.toString());
  await assert.rejects(fetchHttpsBuffer(start, 1024, 3, fakeRequester([{ expect: start, status: 302, headers: { location: 'http://evil.example/x' } }])), e => e.code === 'UPDATE_REDIRECT');
  const loop = { expect: start, status: 302, headers: { location: start } };
  await assert.rejects(fetchHttpsBuffer(start, 1024, 3, fakeRequester([loop, loop, loop, loop, loop])), e => e.code === 'UPDATE_REDIRECT');
  await assert.rejects(async () => fetchHttpsBuffer(start + '?x=1', 1024, 3, fakeRequester([])), e => e.code === 'UPDATE_FEED_URL');
});

test('รายการไฟล์ release: trial มี seed-mock ที่อนุญาต, production ไม่มี, ไม่มี test-/data/runtime', () => {
  const prod = collectReleasePaths(__dirname, 'production'), trial = collectReleasePaths(__dirname, 'trial');
  assert.ok(!prod.some(p => /seed-mock/.test(p)), 'production ห้ามมี seed-mock');
  assert.ok(prod.includes('update-public-key.pem') && trial.includes('update-public-key.pem'), 'public key ตรวจลายเซ็นต้องติดไปทุกชุด');
  assert.ok(!prod.some(p => /private/i.test(p)), 'ห้ามมีไฟล์ private');
  assert.ok(trial.includes('seed-mock-day.js') && trial.includes('seed-mock-clinic.js'), 'trial ต้องมี seed จำลองทั้งสอง');
  for (const list of [prod, trial]) assert.ok(!list.some(p => /^test-|^codex-|^data\/|^runtime\/|\.(db|enc|key)$/.test(p)), 'ไฟล์ต้องห้ามหลุด');
});

test('assistant ล้มก่อนเริ่ม (request หาย) ต้องเขียนผล error กลับ ไม่ปล่อยหน้าจอค้าง "กำลังเริ่มอัปเดต"', () => {
  const root = path.join(temp, 'early-fail'), appRoot = path.join(root, 'app');
  fs.mkdirSync(path.join(appRoot, 'data', 'update'), { recursive: true });
  fs.mkdirSync(path.join(root, 'update'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'data', 'update', 'service-state.json'), JSON.stringify({ format: 1, state: 'starting', available_version: '9.9.9' }));
  const keyFile = path.join(temp, 'early-public.pem'); fs.writeFileSync(keyFile, publicKey.export({ type: 'spki', format: 'pem' }));
  const run = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, 'update-assistant.js'), '--request', path.join(root, 'update', 'missing.json'), '--install-root', root],
    { env: { ...process.env, CLINIC_UPDATE_TEST: '1', CLINIC_UPDATE_TEST_PUBLIC_KEY: keyFile }, encoding: 'utf8' });
  assert.notStrictEqual(run.status, 0, 'ต้องออกด้วย exit ≠ 0');
  const state = JSON.parse(fs.readFileSync(path.join(appRoot, 'data', 'update', 'service-state.json'), 'utf8'));
  assert.strictEqual(state.state, 'error');
  assert.match(state.message, /ยังไม่มีการเปลี่ยนแปลง/);
});

test('status บนเครื่องที่ไม่มี install-profile (dev/ลงมือ) ต้องไม่ล้ม: ยังบอกรุ่นปัจจุบัน + configured=false + เหตุผล', () => {
  // หน้า admin (และตัวเฝ้าหลังอัปเดต) อ่าน /api/update/status เสมอ — ถ้าล้มทั้ง route หน้าจะแสดงผลอะไรไม่ได้เลย
  const root = path.join(temp, 'no-profile'), appRoot = path.join(root, 'app');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }));
  const st = new UpdateService({ installRoot: root, appRoot, dataDir: path.join(root, 'data'), feedUrl: 'https://example.invalid/latest.json' }).publicStatus({ host: true });
  assert.strictEqual(st.current_version, '1.2.3');
  assert.strictEqual(st.configured, false);
  assert.strictEqual(st.state, 'idle');
  assert.match(st.message, /ไม่พบข้อมูลชนิดชุดติดตั้ง/);
});

test('cleanup หลัง commit ลบสำเนาโค้ด/ZIP แต่ไม่แตะ snapshot ฐานข้อมูล', () => {
  const root = path.join(temp, 'commit-cleanup'), updateRoot = path.join(root, 'update');
  const id = 'cleanup-id';
  for (const dir of [path.join(updateRoot, id, 'staged-app'), path.join(updateRoot, 'downloads', id),
    path.join(updateRoot, 'requests'), path.join(root, 'app', 'data', 'update', id)]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(updateRoot, id, 'staged-app', 'server.js'), 'x');
  fs.writeFileSync(path.join(updateRoot, 'downloads', id, 'app.zip'), 'x');
  const requestFile = path.join(updateRoot, 'requests', `${id}.json`);
  fs.writeFileSync(requestFile, '{}');
  const snapshot = path.join(root, 'app', 'data', 'update', id, 'before.db');
  fs.writeFileSync(snapshot, 'snapshot');
  const outside = path.join(root, 'app', 'data', 'clinic.db'); fs.writeFileSync(outside, 'live');
  updateCore.cleanupAfterCommit(root, id, requestFile);
  assert.strictEqual(fs.existsSync(path.join(updateRoot, id)), false);
  assert.strictEqual(fs.existsSync(path.join(updateRoot, 'downloads', id)), false);
  assert.strictEqual(fs.existsSync(requestFile), false);
  assert.strictEqual(fs.existsSync(snapshot), true, 'snapshot ฐานข้อมูลเป็นหลักฐาน ห้ามลบอัตโนมัติ');
  assert.strictEqual(fs.existsSync(outside), true);
  // request ที่อยู่นอก update/requests ห้ามถูกลบ
  const stray = path.join(root, 'stray.json'); fs.writeFileSync(stray, '{}');
  updateCore.cleanupAfterCommit(root, 'no-such-id', stray);
  assert.strictEqual(fs.existsSync(stray), true);
});

test('rename ที่ Defender ล็อกชั่วคราว retry แล้วสำเร็จ', () => {
  const root = path.join(temp, 'rename-retry'), from = path.join(root, 'from.txt'), to = path.join(root, 'to.txt');
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(from, 'ok');
  const original = fs.renameSync; let attempts = 0;
  fs.renameSync = function(a, b) {
    attempts++;
    if (attempts < 3) { const error = new Error('synthetic lock'); error.code = 'EPERM'; throw error; }
    return original.call(fs, a, b);
  };
  try { updateCore.retryRenameSync(from, to); }
  finally { fs.renameSync = original; }
  assert.strictEqual(attempts, 3); assert.strictEqual(fs.readFileSync(to, 'utf8'), 'ok');
});

testAsync('Phase 3 check → stage → apply ใช้ HTTPS URL คงที่และไม่ส่งข้อมูลคลินิก', async () => {
  assert(builtRelease);
  const root = path.join(temp, 'phase3 service ไทย'), appRoot = path.join(root, 'app'), updateRoot = path.join(root, 'update');
  fs.mkdirSync(appRoot, { recursive: true }); fs.mkdirSync(updateRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ version: '0.9.0' }));
  fs.writeFileSync(path.join(updateRoot, 'install-profile.json'), JSON.stringify({ format: 1, product: 'clinic-offline',
    edition: 'standard', variant: 'production', channel: 'pilot', port: 28081, https_port: 28444 }));
  const publicFile = path.join(appRoot, 'update-public-key.pem');
  fs.copyFileSync(builtRelease.publicKeyFile, publicFile);
  const manifestBytes = fs.readFileSync(path.join(builtRelease.out, builtRelease.result.manifestFile));
  const signatureBytes = fs.readFileSync(path.join(builtRelease.out, builtRelease.result.signatureFile));
  const packageBytes = fs.readFileSync(path.join(builtRelease.out, builtRelease.result.packageFile));
  const feedUrl = 'https://updates.example/latest-production.json';
  const requested = [];
  const fetchBuffer = async url => {
    const href = String(url.href || url); requested.push(href);
    if (href === feedUrl) return manifestBytes;
    if (href === `${feedUrl}.sig`) return signatureBytes;
    if (href === builtRelease.manifest.package.url) return packageBytes;
    throw new Error(`unexpected URL ${href}`);
  };
  let spawned = null;
  const service = new UpdateService({ installRoot: root, appRoot, dataDir: path.join(root, 'isolated-data'),
    publicKeyFile: publicFile, feedUrl, fetchBuffer, spawnApply: file => { spawned = file; } });
  const checked = await service.check(); assert.strictEqual(checked.state, 'available');
  const staged = await service.stage(); assert.strictEqual(staged.state, 'ready_to_apply');
  const applied = await service.apply(); assert.strictEqual(applied.state, 'starting');
  assert(spawned && fs.existsSync(spawned));
  assert.deepStrictEqual(requested, [feedUrl, `${feedUrl}.sig`, builtRelease.manifest.package.url]);
  for (const href of requested) {
    const url = safeHttpsUrl(href, 'test');
    assert.strictEqual(url.search, ''); assert.strictEqual(url.username, ''); assert.strictEqual(url.password, '');
  }
  const request = updateCore.readUpdateRequest(spawned, root);
  assert.strictEqual(request.current_version, '0.9.0');

  // scheduler ยิง check ทุกวัน/ตอนบูต — ห้ามล้างสถานะ ready_to_apply ที่ยังใช้ได้ ไม่งั้นโหลดซ้ำทั้งก้อน
  fs.writeFileSync(path.join(root, 'isolated-data', 'update', 'service-state.json'),
    JSON.stringify({ format: 1, state: 'ready_to_apply', available_version: builtRelease.manifest.version,
      checked_at: '2026-08-15T00:00:00.000Z', message: 'พร้อมอัปเดต', manifest_file: null, signature_file: null,
      request_file: spawned }));
  const rechecked = await service.check();
  assert.strictEqual(rechecked.state, 'ready_to_apply', 'check ซ้ำต้องไม่ทับสถานะที่โหลดเสร็จแล้ว');
  assert.strictEqual(rechecked.request_file, spawned);

  // กดปุ่มอัปเดตซ้ำ/สอง request ต้องไม่ spawn assistant ตัวที่สองมาสลับไฟล์ทับตัวแรก
  const lockFile = path.join(root, 'update', updateCore.APPLY_LOCK_NAME);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  await assert.rejects(() => service.apply(), error => error.code === 'UPDATE_IN_PROGRESS');
  fs.rmSync(lockFile, { force: true });
  fs.writeFileSync(path.join(root, 'update', 'active-journal.json'),
    JSON.stringify({ format: 1, id: 'x', state: 'swapping-files', files: [], obsolete: [] }));
  await assert.rejects(() => service.apply(), error => error.code === 'UPDATE_IN_PROGRESS');
  fs.rmSync(path.join(root, 'update', 'active-journal.json'), { force: true });
});

testAsync('พอร์ตยังถูกถือแต่ไม่ตอบ /ready → assistant ต้องหยุดก่อนแตะไฟล์โปรแกรม', async () => {
  assert(builtRelease);
  const installRoot = path.join(temp, 'port-held install');
  const appRoot = path.join(installRoot, 'app'), updateRoot = path.join(installRoot, 'update');
  fs.mkdirSync(path.join(appRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(updateRoot, 'downloads'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ version: '0.9.0' }));
  fs.writeFileSync(path.join(appRoot, 'server.js'), 'SENTINEL-OLD-SERVER');
  fs.writeFileSync(path.join(appRoot, 'data', 'clinic.db'), Buffer.alloc(4096));
  // TCP listener ที่รับ connection แต่ไม่ตอบอะไรเลย = อาการ server ยังอยู่แต่ตอบไม่ทัน (เช่นกำลัง VACUUM)
  const held = net.createServer(socket => socket.resume());
  const port = await new Promise(resolve => held.listen(0, '0.0.0.0', () => resolve(held.address().port)));
  try {
    fs.writeFileSync(path.join(updateRoot, 'install-profile.json'), JSON.stringify({ format: 1, product: 'clinic-offline',
      edition: 'standard', variant: 'production', channel: 'pilot', port, https_port: port <= 65172 ? port + 363 : port - 363 }));
    const id = crypto.randomUUID();
    const downloadDir = path.join(updateRoot, 'downloads', id); fs.mkdirSync(downloadDir, { recursive: true });
    const manifestFile = path.join(downloadDir, 'manifest.json'), signatureFile = `${manifestFile}.sig`;
    const packageFile = path.join(downloadDir, builtRelease.result.packageFile);
    fs.copyFileSync(path.join(builtRelease.out, builtRelease.result.manifestFile), manifestFile);
    fs.copyFileSync(path.join(builtRelease.out, builtRelease.result.signatureFile), signatureFile);
    fs.copyFileSync(path.join(builtRelease.out, builtRelease.result.packageFile), packageFile);
    const requestDir = path.join(updateRoot, 'requests'); fs.mkdirSync(requestDir, { recursive: true });
    const requestFile = path.join(requestDir, `${id}.json`);
    fs.writeFileSync(requestFile, JSON.stringify({ format: 1, id, manifest_file: manifestFile, signature_file: signatureFile,
      package_file: packageFile, variant: 'production', channel: 'pilot', edition: 'standard',
      current_version: '0.9.0', port }));
    const run = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, 'update-assistant.js'),
      '--request', requestFile, '--install-root', installRoot], { cwd: __dirname, encoding: 'utf8', timeout: 90000,
      env: { ...process.env, CLINIC_UPDATE_TEST: '1', CLINIC_UPDATE_TEST_PUBLIC_KEY: builtRelease.publicKeyFile,
        CLINIC_UPDATE_PORT_ATTEMPTS: '2' } });
    assert.notStrictEqual(run.status, 0, 'ต้องล้มเหลว ไม่ใช่เดินหน้าสลับไฟล์');
    assert.match(`${run.stdout}${run.stderr}`, /ถือพอร์ต/);
    assert.strictEqual(fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8'), 'SENTINEL-OLD-SERVER',
      'ห้ามแตะไฟล์โปรแกรมเมื่อยังพิสูจน์ไม่ได้ว่า server เดิมปิดสนิท');
    const outcome = JSON.parse(fs.readFileSync(path.join(appRoot, 'data', 'update', 'service-state.json'), 'utf8'));
    assert.strictEqual(outcome.state, 'error');
    assert.match(outcome.message, /ยังไม่มีการเปลี่ยนแปลง/);
  } finally { await new Promise(resolve => held.close(resolve)); }
});

test('standalone assistant ทำ snapshot → rehearsal → swap → health → commit บนคลินิกสังเคราะห์', () => {
  assert(builtRelease);
  const installRoot = path.join(temp, 'e2e install ภาษาไทย');
  const appRoot = path.join(installRoot, 'app'), updateRoot = path.join(installRoot, 'update');
  const port = 21000 + crypto.randomInt(20000);
  extractZipExact(path.join(builtRelease.out, builtRelease.result.packageFile), appRoot, builtRelease.manifest.files);
  const oldPackage = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  oldPackage.version = '0.9.0';
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify(oldPackage, null, 2) + '\n');
  fs.mkdirSync(updateRoot, { recursive: true });
  fs.writeFileSync(path.join(updateRoot, 'install-profile.json'), JSON.stringify({ format: 1, product: 'clinic-offline',
    edition: 'standard', variant: 'production', channel: 'pilot', port, https_port: port <= 65172 ? port + 363 : port - 363 }));
  fs.mkdirSync(path.join(appRoot, 'data'), { recursive: true });
  const seed = spawnSync(process.execPath, ['--no-warnings', 'seed.js'], { cwd: appRoot,
    env: { ...process.env, CLINIC_DATA_DIR: path.join(appRoot, 'data') }, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(seed.status, 0, seed.stderr);
  const releaseDir = path.join(updateRoot, 'downloads'); fs.mkdirSync(releaseDir, { recursive: true });
  const manifestFile = path.join(releaseDir, builtRelease.result.manifestFile);
  const signatureFile = path.join(releaseDir, builtRelease.result.signatureFile);
  const packageFile = path.join(releaseDir, builtRelease.result.packageFile);
  fs.copyFileSync(path.join(builtRelease.out, builtRelease.result.manifestFile), manifestFile);
  fs.copyFileSync(path.join(builtRelease.out, builtRelease.result.signatureFile), signatureFile);
  fs.copyFileSync(path.join(builtRelease.out, builtRelease.result.packageFile), packageFile);
  const requestDir = path.join(updateRoot, 'requests'); fs.mkdirSync(requestDir, { recursive: true });
  const requestFile = path.join(requestDir, 'request.json');
  fs.writeFileSync(requestFile, JSON.stringify({ format: 1, id: crypto.randomUUID(), manifest_file: manifestFile,
    signature_file: signatureFile, package_file: packageFile, variant: 'production', channel: 'pilot',
    edition: 'standard', current_version: '0.9.0', port }, null, 2));
  const parsedRequest = updateCore.readUpdateRequest(requestFile, installRoot);
  mustThrow(() => updateCore.prepareRelease({ installRoot, request: { ...parsedRequest, variant: 'trial' }, publicKey }), 'UPDATE_PROFILE');
  mustThrow(() => updateCore.prepareRelease({ installRoot, request: { ...parsedRequest, port: port + 1 }, publicKey }), 'UPDATE_PROFILE');
  // session ที่ persist ไว้ (2026-08-24) ต้องถูกลบตอนอัปเดตรุ่น — invariant health check: ห้ามมีใครถือ session เก่าเขียนข้อมูลระหว่างตรวจนับ
  fs.writeFileSync(path.join(appRoot, 'data', 'sessions.json'), JSON.stringify({ format: 1, saved_at: Date.now(), sessions: {} }));
  const run = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, 'update-assistant.js'), '--request', requestFile,
    '--install-root', installRoot], { cwd: __dirname, env: { ...process.env, CLINIC_UPDATE_TEST: '1',
      CLINIC_UPDATE_TEST_PUBLIC_KEY: builtRelease.publicKeyFile }, encoding: 'utf8', timeout: 90000 });
  assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const journal = JSON.parse(fs.readFileSync(path.join(updateRoot, updateCore.JOURNAL_NAME), 'utf8'));
  assert.strictEqual(journal.state, 'committed');
  assert(fs.existsSync(path.join(appRoot, 'data', 'update', journal.id, 'before.db')));
  assert(fs.existsSync(path.join(updateRoot, updateCore.TRUSTED_STATE_NAME)));
  // assistant เป็น process แยก ถ้าไม่เขียนผลกลับ หน้า admin จะค้าง "กำลังเริ่มอัปเดต…" ตลอดไป
  const finished = new UpdateService({ installRoot, appRoot }).publicStatus({ host: true });
  assert.strictEqual(finished.state, 'up_to_date', `หน้า admin ต้องไม่ค้างสถานะกำลังอัปเดต (ได้ ${finished.state})`);
  assert(finished.message.includes(builtRelease.manifest.version), finished.message);
  assert.strictEqual(fs.existsSync(path.join(updateRoot, journal.id)), false, 'สำเนา staged/rollback ต้องถูกเก็บกวาดหลัง commit');
  assert.strictEqual(fs.existsSync(requestFile), false, 'request ที่ใช้แล้วต้องถูกเก็บกวาด');
  assert.strictEqual(fs.existsSync(path.join(updateRoot, updateCore.APPLY_LOCK_NAME)), false, 'lock ต้องถูกปล่อยเมื่อจบ');
  assert.strictEqual(fs.existsSync(path.join(appRoot, 'data', 'sessions.json')), false,
    'sessions.json ต้องถูกลบระหว่างอัปเดตรุ่น (รอบอัปเดต = login ใหม่เสมอ — health check ต้องไม่ถูกแทรกด้วย session เก่า)');
  const stopper = `const fs=require('node:fs'),http=require('node:http');const t=fs.readFileSync(process.argv[2],'utf8').trim();const r=http.request({hostname:'127.0.0.1',port:Number(process.argv[1]),path:'/api/system/prepare-restore',method:'POST',headers:{'X-Recovery-Control':t,'Content-Length':'0'}},x=>{x.resume();x.on('end',()=>process.exit(x.statusCode===200?0:2));});r.on('error',()=>process.exit(3));r.end();`;
  const stopped = spawnSync(process.execPath, ['-e', stopper, String(port), path.join(appRoot, 'data', 'recovery-control.token')],
    { encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(stopped.status, 0, stopped.stderr);
});

// ---- launch/supervisor.js (incident 2026-08-24: server ตายกลางงานแล้วไม่มีทั้งคนเปิดกลับและหลักฐาน) ----
// ใช้ supervisor+applog ตัวจริง copy ลงโครง temp คู่กับ server.js ปลอมที่สั่งพฤติกรรมผ่าน env
function supervisorHarness(mode) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-supervisor-'));
  const root = path.join(base,'app');
  fs.mkdirSync(path.join(root, 'launch'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'launch', 'supervisor.js'), path.join(root, 'launch', 'supervisor.js'));
  fs.copyFileSync(path.join(__dirname, 'lib', 'applog.js'), path.join(root, 'lib', 'applog.js'));
  fs.copyFileSync(path.join(__dirname,'lib','trial-start-guard.js'),path.join(root,'lib','trial-start-guard.js'));
  if(mode==='trial-pending'){fs.mkdirSync(path.join(base,'update'));fs.writeFileSync(path.join(base,'update/trial-maintenance-pending.json'),'{}');}
  fs.writeFileSync(path.join(root, 'server.js'), `'use strict';
const fs = require('node:fs');
const file = process.env.FAKE_STARTS_FILE;
const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;
fs.writeFileSync(file, String(n));
const mode = process.env.FAKE_MODE;
if (mode === 'clean') process.exit(0);
if (mode === 'busy') process.exit(10);
if (mode === 'crash') process.exit(1);
if (mode === 'crash-once') { if (n === 1) process.exit(1); setTimeout(() => process.exit(0), 2500); }
`);
  const startsFile = path.join(root, 'starts.txt');
  const logDir = path.join(root, 'logs');
  const env = { ...process.env, CLINIC_SUPERVISOR_TEST: '1', CLINIC_SUPERVISOR_RETRY_MS: '100',
    CLINIC_LOG_DIR: logDir, FAKE_STARTS_FILE: startsFile, FAKE_MODE: mode, CLINIC_DATA_DIR: path.join(root, 'data') };
  const run = () => new Promise(resolve => {
    const child = require('node:child_process').spawn(process.execPath,
      ['--no-warnings', path.join(root, 'launch', 'supervisor.js')], { env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: 'timeout' }); }, 20000);
    child.on('exit', code => { clearTimeout(timer); resolve({ code }); });
  });
  const starts = () => (fs.existsSync(startsFile) ? Number(fs.readFileSync(startsFile, 'utf8')) : 0);
  const logText = () => {
    try { return fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n'); }
    catch { return ''; }
  };
  return { run, starts, logText, cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} } };
}

testAsync('supervisor: incomplete trial reset must never start a new empty database',async()=>{
  const h=supervisorHarness('trial-pending');try{assert.strictEqual((await h.run()).code,0);assert.strictEqual(h.starts(),0);assert(h.logText().includes('ทำต่อ.cmd'));}finally{h.cleanup();}
});

testAsync('supervisor: server ปิดเอง (exit 0 = recovery/update สั่ง) ต้องไม่ถูกเปิดกลับ', async () => {
  const h = supervisorHarness('clean');
  const result = await h.run();
  assert.strictEqual(result.code, 0);
  assert.strictEqual(h.starts(), 1, 'ห้ามเปิดกลับ — จะชนกับ update-assistant ที่กำลังสลับไฟล์');
  h.cleanup();
});

testAsync('supervisor: พอร์ตถูกใช้ (exit 10) = มีระบบเปิดอยู่แล้ว ต้องหยุดเงียบ ไม่วนเปิดซ้อน', async () => {
  const h = supervisorHarness('busy');
  const result = await h.run();
  assert.strictEqual(result.code, 0);
  assert.strictEqual(h.starts(), 1);
  assert(h.logText().includes('เปิดอยู่แล้ว'), 'log ต้องบอกเหตุผล');
  h.cleanup();
});

testAsync('supervisor: crash ครั้งเดียวแล้วรุ่นถัดไปอยู่ได้ → เปิดกลับอัตโนมัติ (หมอไม่ต้องปิดเปิดโปรแกรมเอง)', async () => {
  const h = supervisorHarness('crash-once');
  const result = await h.run();
  assert.strictEqual(result.code, 0, 'จบด้วย server ปิดตัวปกติ');
  assert.strictEqual(h.starts(), 2, 'ต้องถูกเปิดกลับ 1 ครั้งหลัง crash');
  assert(h.logText().includes('เปิดกลับใน'), 'log ต้องบันทึกการเปิดกลับพร้อม exit code');
  h.cleanup();
});

testAsync('supervisor: ตายเร็วติดกัน 3 ครั้ง = ปัญหาถาวร → หยุด + ข้อความบอกผู้ใช้ (ไม่วนไม่รู้จบ)', async () => {
  const h = supervisorHarness('crash');
  const result = await h.run();
  assert.strictEqual(result.code, 1);
  assert.strictEqual(h.starts(), 3, 'ลอง 3 ครั้งแล้วต้องหยุด');
  assert(h.logText().includes('3 ครั้งติดกัน'), 'ต้องมีข้อความสำหรับกล่องแจ้งผู้ใช้ใน log');
  h.cleanup();
});

testAsync('unchanged signed runtime is not moved while its executable is running', async () => {
  const root=path.join(temp,'held-runtime'),appRoot=path.join(root,'app'),stagedApp=path.join(root,'stage');
  fs.mkdirSync(appRoot,{recursive:true});fs.mkdirSync(stagedApp,{recursive:true});
  const target=path.join(appRoot,'node.exe');fs.copyFileSync(process.execPath,target);fs.copyFileSync(target,path.join(stagedApp,'node.exe'));
  const child=require('node:child_process').spawn(target,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore'],windowsHide:true});
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
    const journal={format:1,id:'held',state:'rehearsal-passed',snapshot_file:null,files:[],obsolete:[]};
    const journalFile=path.join(root,'update',updateCore.JOURNAL_NAME);
    updateCore.applyFileTransaction({appRoot,stagedApp,rollbackRoot:path.join(root,'rollback'),journal,journalFile,manifest:{files:[{path:'node.exe',bytes:fs.statSync(target).size,sha256:hash(fs.readFileSync(target))}],obsolete:[]}});
    assert.equal(journal.files.length,0);assert.equal(child.exitCode,null);assert(fs.existsSync(target));
  } finally {const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}
});

(async () => {
  for (const item of asyncTests) {
    try { await item.fn(); passed++; console.log(`  ✓ ${item.name}`); }
    catch (error) { console.error(`  ✗ ${item.name}\n    ${error.stack || error}`); process.exitCode = 1; }
  }
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  if (process.exitCode) process.exit(process.exitCode);
  console.log(`\nUpdater: ${passed} tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
