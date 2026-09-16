'use strict';
// Synthetic keys/passwords only, never read an installed clinic or print secrets.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const passwords = require('./lib/password-recovery'), core = require('./lib/recovery-core');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic password ไทย -'));
const data = path.join(root, 'old'), source = path.join(root, 'cloud'); fs.mkdirSync(data); fs.mkdirSync(source);
const keyFile = path.join(data, 'cloud-backup.key'); fs.writeFileSync(keyFile, crypto.randomBytes(32));
const password = 'สังเคราะห์สำหรับทดสอบ-123', replacement = 'replacement test only 456';
let count = 0;
async function test(name, work) { await work(); console.log('PASSWORD PASS: ' + name); count++; }
function encrypt(src, dst) {
  const key = core.readRecoveryKeyFile(keyFile), nonce = crypto.randomBytes(12);
  try { const c = crypto.createCipheriv('aes-256-gcm', key, nonce); fs.writeFileSync(dst, Buffer.concat([Buffer.from('CBK1'), nonce, c.update(fs.readFileSync(src)), c.final(), c.getAuthTag()])); }
  finally { key.fill(0); }
}
async function main() {
  const id = crypto.randomUUID();
  await test('setting a password wraps existing key; status and envelope contain no password', async () => {
    await passwords.setPassword({ dataDir: data, keyFile, password, confirmation: password, opId: id });
    assert.equal(passwords.localStatus(data).id, id);
    assert(!fs.readFileSync(path.join(data, passwords.LOCAL_FILE), 'utf8').includes(password));
    const key = core.readRecoveryKeyFile(keyFile);
    try { passwords.copyEnvelope(data, source, core.keyFingerprint(key)); passwords.claimDestination(data, source, key); }
    finally { key.fill(0); }
  });
  await test('clean-machine password opens legacy encrypted backup with original fingerprint', async () => {
    const dbFile = path.join(root, 'legacy.db'), db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES (\'legacy fixture\')'); db.close();
    const name = 'clinic-20260810-210000.db'; encrypt(dbFile, path.join(source, name + '.enc'));
    const manifestFile = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify({ format: 1, created_at: '2026-08-10 21:00:00', database: { file: name, sha256: core.sha256(dbFile), bytes: fs.statSync(dbFile).size }, attachments: [], assets: [] }));
    encrypt(manifestFile, path.join(source, 'clinic-20260810-210000.manifest.json.enc'));
    await passwords.withPassword(source, password, async (key, envelope) => {
      assert.equal(core.keyFingerprint(key), envelope.fingerprint);
      const target = path.join(root, 'clean');
      const result = core.restoreToNewDirectory({ sourceDir: source, outputDir: target, key });
      assert.equal(result.ok, true);
      passwords.prepareRecoveredSecrets(path.join(target, 'data'), source, key, envelope);
      const savedKey = core.readRecoveryKeyFile(path.join(target, 'data/cloud-backup.key'));
      try { assert.equal(core.keyFingerprint(savedKey), envelope.fingerprint); } finally { savedKey.fill(0); }
      assert.equal(passwords.localStatus(path.join(target, 'data')).ready, true);
    });
  });
  await test('wrong password never calls restore and authenticates envelope metadata', async () => {
    let called = false;
    await assert.rejects(passwords.withPassword(source, 'wrong synthetic password', () => { called = true; }), { code: 'PASSWORD_WRONG' }); assert(!called);
    const file = path.join(source, passwords.FILE), original = fs.readFileSync(file); const tampered = JSON.parse(original); tampered.createdAt = '2026-01-01T00:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(tampered));
    await assert.rejects(passwords.withPassword(source, password, () => { called = true; }), { code: 'PASSWORD_WRONG' }); assert(!called); fs.writeFileSync(file, original);
  });
  await test('hostile KDF/oversized file rejected before derivation', async () => {
    const file = path.join(source, passwords.FILE), original = fs.readFileSync(file), e = JSON.parse(original); e.kdf.N = 1073741824; fs.writeFileSync(file, JSON.stringify(e));
    await assert.rejects(passwords.withPassword(source, password, () => {}), { code: 'ENVELOPE_INVALID' });
    fs.writeFileSync(file, 'x'.repeat(17000)); await assert.rejects(passwords.withPassword(source, password, () => {}), { code: 'ENVELOPE_INVALID' }); fs.writeFileSync(file, original);
  });
  await test('NFC preserves equivalent password; spaces significant and no composition requirement', async () => {
    assert.equal(passwords.passwordText('e\u0301'.repeat(12)), passwords.passwordText('é'.repeat(12)));
    assert.notEqual(passwords.passwordText('a long plain phrase '), passwords.passwordText('a long plain phrase'));
    assert.throws(() => passwords.passwordText('too short'), { code: 'PASSWORD_INVALID' });
  });
  await test('retry after durable commit leaves envelope unchanged; stale operation cannot reset newer password', async () => {
    const file = path.join(data, passwords.LOCAL_FILE), original = core.sha256(file);
    await passwords.setPassword({ dataDir: data, keyFile, password: replacement, confirmation: replacement, opId: id }); assert.equal(core.sha256(file), original);
    const nextId = crypto.randomUUID(); await passwords.setPassword({ dataDir: data, keyFile, password: replacement, confirmation: replacement, opId: nextId, expectedId: id });
    await assert.rejects(passwords.setPassword({ dataDir: data, keyFile, password, confirmation: password, opId: id }), { code: 'PASSWORD_CHANGED' });
    assert.equal(passwords.localStatus(data).id, nextId);
  });
  await test('failed rename preserves previously usable envelope', async () => {
    const file = path.join(source, passwords.FILE), hash = core.sha256(file), rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === file) throw new Error('synthetic disk fault'); return rename(from, to); };
    const key = core.readRecoveryKeyFile(keyFile);
    try { assert.throws(() => passwords.copyEnvelope(data, source, core.keyFingerprint(key)), /synthetic disk fault/); }
    finally { fs.renameSync = rename; key.fill(0); }
    assert.equal(core.sha256(file), hash);
    await passwords.withPassword(source, password, async () => {});
  });
  await test('old machine stops after new restored machine claims same destination', async () => {
    await passwords.withPassword(source, password, async key => {
      passwords.claimDestination(path.join(root, 'clean/data'), source, key);
      assert.throws(() => passwords.claimDestination(data, source, key), { code: 'OLDER_MACHINE' });
    });
  });
  await test('metadata tampering cannot silently replace destination owner', async () => {
    const file = fs.readdirSync(source).find(n => n.startsWith('clinic-owner-'));
    const full = path.join(source, file), e = JSON.parse(fs.readFileSync(full)); e.generation += 10; fs.writeFileSync(full, JSON.stringify(e));
    await passwords.withPassword(source, password, async key => { assert.throws(() => passwords.claimDestination(data, source, key), { code: 'OWNER_INVALID' }); });
  });
  await test('unwritable or missing source warns without invalidating restored data', async () => {
    const restored = path.join(root, 'clean/data'), obstruction = path.join(root, 'not-a-directory');
    fs.writeFileSync(obstruction, 'synthetic obstacle');
    const hash = core.sha256(path.join(restored, 'clinic.db'));
    for (const target of [obstruction, path.join(root, 'missing-source')]) {
      assert.match(passwords.claimRecoveredDestination(restored, target), /กู้ข้อมูลแล้ว.*หยุดใช้เครื่องเก่า/);
      assert.equal(core.sha256(path.join(restored, 'clinic.db')), hash);
    }
    assert(!fs.existsSync(path.join(root, 'missing-source')));
  });
  await test('legacy Kit key replacement retires stale password and rollback restores it', async () => {
    const home = path.join(root, 'legacy-kit-replace'), live = path.join(home, 'data'), prepared = path.join(home, 'stage');
    fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(prepared);
    for (const folder of [live, prepared]) {
      const db = new DatabaseSync(path.join(folder, 'clinic.db')); db.exec('CREATE TABLE synthetic(value TEXT)'); db.close();
      fs.writeFileSync(path.join(folder, 'cloud-backup.key'), crypto.randomBytes(32));
    }
    fs.writeFileSync(path.join(live, passwords.LOCAL_FILE), 'synthetic old envelope');
    const oldEnvelopeHash = core.sha256(path.join(live, passwords.LOCAL_FILE));
    const published = core.publishPreparedData({ preparedDataDir: prepared, liveDataDir: live });
    assert(!fs.existsSync(path.join(live, passwords.LOCAL_FILE)));
    assert.equal(passwords.localStatus(live).ready, false);
    core.rollbackPublishedData({ liveDataDir: live, rollbackDir: published.rollbackDir });
    assert.equal(core.sha256(path.join(live, passwords.LOCAL_FILE)), oldEnvelopeHash);
  });
  await test('publish interruption preserves original database on next boot', async () => {
    const home = path.join(root, 'interruption'), live = path.join(home, 'data'), prepared = path.join(home, 'stage'); fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(prepared);
    for (const [folder, value] of [[live, 'old'], [prepared, 'new']]) { const db = new DatabaseSync(path.join(folder, 'clinic.db')); db.exec('CREATE TABLE synthetic(value TEXT)'); db.prepare('INSERT INTO synthetic VALUES (?)').run(value); db.close(); }
    const child = `const fs=require('node:fs'),core=require(${JSON.stringify(path.join(__dirname, 'lib/recovery-core'))});const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(a===${JSON.stringify(path.join(live, 'clinic.db'))})process.exit(88)};core.publishPreparedData({preparedDataDir:${JSON.stringify(prepared)},liveDataDir:${JSON.stringify(live)}});`;
    assert.equal(spawnSync(process.execPath, ['--no-warnings', '-e', child], { stdio: 'ignore' }).status, 88);
    core.recoverInterruptedPublications(live); core.recoverInterruptedPublications(live);
    const db = new DatabaseSync(path.join(live, 'clinic.db'), { readOnly: true }); assert.equal(db.prepare('SELECT value FROM synthetic').get().value, 'old'); db.close();
  });
  await test('interrupted rollback recovers original database and password together on next boot', async () => {
    const home = path.join(root, 'rollback-interruption'), live = path.join(home, 'data'), prepared = path.join(home, 'stage');
    fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(prepared);
    for (const [folder, value] of [[live, 'original'], [prepared, 'restore']]) {
      const db = new DatabaseSync(path.join(folder, 'clinic.db')); db.exec('CREATE TABLE synthetic(value TEXT)'); db.prepare('INSERT INTO synthetic VALUES (?)').run(value); db.close();
      fs.writeFileSync(path.join(folder, 'cloud-backup.key'), crypto.randomBytes(32));
      fs.writeFileSync(path.join(folder, passwords.LOCAL_FILE), `synthetic ${value} envelope`);
    }
    const originalEnvelope = core.sha256(path.join(live, passwords.LOCAL_FILE));
    const originalKey = core.readRecoveryKeyFile(path.join(live, 'cloud-backup.key')), fingerprint = core.keyFingerprint(originalKey); originalKey.fill(0);
    const published = core.publishPreparedData({ preparedDataDir: prepared, liveDataDir: live });
    const child = `const fs=require('node:fs'),core=require(${JSON.stringify(path.join(__dirname, 'lib/recovery-core'))});const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(a===${JSON.stringify(path.join(live, 'clinic.db'))})process.exit(88)};core.rollbackPublishedData({liveDataDir:${JSON.stringify(live)},rollbackDir:${JSON.stringify(published.rollbackDir)}});`;
    assert.equal(spawnSync(process.execPath, ['--no-warnings', '-e', child], { stdio: 'ignore' }).status, 88);
    core.recoverInterruptedPublications(live); core.recoverInterruptedPublications(live);
    const db = new DatabaseSync(path.join(live, 'clinic.db'), { readOnly: true }); assert.equal(db.prepare('SELECT value FROM synthetic').get().value, 'original'); db.close();
    assert.equal(core.sha256(path.join(live, passwords.LOCAL_FILE)), originalEnvelope);
    const restoredKey = core.readRecoveryKeyFile(path.join(live, 'cloud-backup.key')); try { assert.equal(core.keyFingerprint(restoredKey), fingerprint); } finally { restoredKey.fill(0); }
  });
  await test('failed publication and transient undo failure remain recoverable instead of terminal success', async () => {
    const home = path.join(root, 'undo-fault'), live = path.join(home, 'data'), prepared = path.join(home, 'stage');
    fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(prepared);
    for (const [folder, value] of [[live, 'original'], [prepared, 'restore']]) {
      const db = new DatabaseSync(path.join(folder, 'clinic.db')); db.exec('CREATE TABLE synthetic(value TEXT)'); db.prepare('INSERT INTO synthetic VALUES (?)').run(value); db.close();
    }
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === path.join(live, 'clinic.db')) throw new Error('synthetic temporary rename fault'); return rename(from, to); };
    try { assert.throws(() => core.publishPreparedData({ preparedDataDir: prepared, liveDataDir: live }), { code: 'ROLLBACK_INCOMPLETE' }); }
    finally { fs.renameSync = rename; }
    const rollbackRoot = path.join(home, 'recovery-rollbacks'), journal = path.join(rollbackRoot, fs.readdirSync(rollbackRoot)[0], 'restore-journal.json');
    assert.equal(JSON.parse(fs.readFileSync(journal, 'utf8')).state, 'rolling-back');
    core.recoverInterruptedPublications(live); core.recoverInterruptedPublications(live);
    const db = new DatabaseSync(path.join(live, 'clinic.db'), { readOnly: true }); assert.equal(db.prepare('SELECT value FROM synthetic').get().value, 'original'); db.close();
  });
  console.log('PASSWORD TOTAL: ' + count);
}
main().catch(error => { console.error('PASSWORD FAIL: ' + error.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
