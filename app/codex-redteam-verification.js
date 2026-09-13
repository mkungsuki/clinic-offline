'use strict';
// Passing adversarial checks for reviewed claims. All databases and document
// payloads are synthetic and live under OS temporary directories.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const appRoot = __dirname;
let passed = 0;
function test(name, fn) {
  fn(); passed++;
  console.log(`PASS: ${name}`);
}
function loadDbInChild(dataDir) {
  return spawnSync(process.execPath, ['--no-warnings', '-e', "require('./lib/db').db.close()"], {
    cwd: appRoot, env: { ...process.env, CLINIC_DATA_DIR: dataDir }, encoding: 'utf8', windowsHide: true,
  });
}

const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-redteam-migration-'));
try {
  test('v9 migration failure rolls back prior DDL and reruns cleanly', () => {
    const initial = loadDbInChild(migrationDir);
    assert.equal(initial.status, 0, initial.stderr);
    const file = path.join(migrationDir, 'clinic.db');
    const setup = new DatabaseSync(file);
    setup.exec(`
      DROP TABLE med_cert_events;
      DROP TABLE receipt_document_snapshots;
      ALTER TABLE users DROP COLUMN display_name_en;
      ALTER TABLE receipt_lines DROP COLUMN item_code;
      ALTER TABLE med_certs DROP COLUMN template_key;
      ALTER TABLE med_certs DROP COLUMN template_version;
      ALTER TABLE med_certs DROP COLUMN language;
      PRAGMA user_version=8;
      CREATE TABLE receipt_document_snapshots (conflict INTEGER);
    `);
    setup.close();

    const failed = loadDbInChild(migrationDir);
    assert.notEqual(failed.status, 0, 'the injected mid-v9 name conflict must fail migration');
    const afterFailure = new DatabaseSync(file);
    assert.equal(afterFailure.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(afterFailure.prepare("SELECT COUNT(*) count FROM pragma_table_info('users') WHERE name='display_name_en'").get().count, 0,
      'ALTER TABLE before the injected failure must be rolled back');
    afterFailure.exec('DROP TABLE receipt_document_snapshots');
    afterFailure.close();

    const rerun = loadDbInChild(migrationDir);
    assert.equal(rerun.status, 0, rerun.stderr);
    const recovered = new DatabaseSync(file, { readOnly: true });
    assert.equal(recovered.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(recovered.prepare("SELECT COUNT(*) count FROM pragma_table_info('users') WHERE name='display_name_en'").get().count, 1);
    recovered.close();
  });
} finally { fs.rmSync(migrationDir, { recursive: true, force: true }); }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-redteam-verification-'));
process.env.CLINIC_DATA_DIR = dataDir;
const { db, now, setSetting } = require('./lib/db');
const print = require('./lib/print');
const { bahtText } = require('./lib/document-utils');
const { createRecoveryKit } = require('./lib/recovery-kit');
try {
  test('all required append-only tables reject direct UPDATE and DELETE', () => {
    const ts = now();
    db.exec('PRAGMA foreign_keys=ON');
    db.prepare("INSERT INTO users(id,username,display_name,role,pass_hash,created_at) VALUES(1,'doc','Synthetic Doctor','doctor','x',?)").run(ts);
    db.prepare("INSERT INTO users(id,username,display_name,role,pass_hash,created_at) VALUES(2,'front','Synthetic Front','front','x',?)").run(ts);
    db.prepare("INSERT INTO patients(hn,first_name,sex,created_at,created_by) VALUES('99-9001','Synthetic','F',?,2)").run(ts);
    db.prepare("INSERT INTO visits(id,hn,visit_date,queue_no,state,doctor_id,created_by,created_at) VALUES(1,'99-9001','2026-08-10',1,'COMPLETED',1,2,?)").run(ts);
    db.prepare("INSERT INTO note_versions(id,visit_id,version,created_by,created_at) VALUES(1,1,1,1,?)").run(ts);
    db.prepare("INSERT INTO order_versions(id,visit_id,version,lines_json,created_by,created_at) VALUES(1,1,1,'[]',1,?)").run(ts);
    db.prepare("INSERT INTO drugs(id,name,price) VALUES(1,'Synthetic Drug',1)").run();
    db.prepare("INSERT INTO stock_movements(id,drug_id,type,qty,created_by,created_at) VALUES(1,1,'receive',1,2,?)").run(ts);
    db.prepare("INSERT INTO allergy_log(id,hn,action,substance,created_by,created_at) VALUES(1,'99-9001','add','Synthetic',2,?)").run(ts);
    db.prepare("INSERT INTO receipts(receipt_no,visit_id,hn,patient_name,order_version_id,subtotal,discount,total,pay_method,status,created_by,created_at) VALUES('RC-SYNTH',1,'99-9001','Synthetic',1,1,0,1,'cash','ISSUED',2,?)").run(ts);
    db.prepare("INSERT INTO receipt_lines(id,receipt_no,line_type,name,qty,price_each,amount) VALUES(1,'RC-SYNTH','service','Synthetic',1,1,1)").run();
    db.prepare("INSERT INTO receipt_document_snapshots(receipt_no,template_key,template_version,issuer_json,payer_json,payment_json,cashier_json,source,created_by,created_at) VALUES('RC-SYNTH','receipt_a5',2,'{}','{}','{}','{}','new_issue',2,?)").run(ts);
    db.prepare("INSERT INTO med_certs(cert_no,visit_id,hn,patient_name,doctor_id,doctor_name,content_json,created_by,created_at) VALUES('MC-SYNTH',1,'99-9001','Synthetic',1,'Synthetic Doctor','{}',1,?)").run(ts);
    db.prepare("INSERT INTO med_cert_events(cert_no,action,reason,created_by,created_at) VALUES('MC-SYNTH','void','Synthetic reason',1,?)").run(ts);

    for (const table of ['note_versions', 'order_versions', 'stock_movements', 'allergy_log', 'med_certs',
      'receipt_lines', 'receipt_document_snapshots', 'med_cert_events']) {
      assert.throws(() => db.exec(`UPDATE ${table} SET rowid=rowid`), /append-only/);
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /append-only/);
    }
    assert.throws(() => db.exec('UPDATE receipts SET total=0'), /only ISSUED->VOID/);
    assert.throws(() => db.exec('DELETE FROM receipts'), /append-only/);
    db.exec("BEGIN; UPDATE receipts SET status='VOID',void_reason='Synthetic',voided_by=2,voided_at='2026-08-10 12:00:00'; ROLLBACK;");
  });

  test('new document fields escape active HTML in certificate and appointment renderers', () => {
    const payload = '</style><script data-redteam>alert(1)</script><img src=x onerror=alert(2)>';
    setSetting('clinic_name', payload);
    setSetting('clinic_address', payload);
    setSetting('clinic_phone', payload);
    setSetting('appt_slip_footer', payload);
    const appointment = print.appointmentSlipHTML({ prefix: payload, first_name: payload, last_name: payload, hn: payload,
      appt_date: '2026-08-11', days: payload, note: payload, doctor_name: payload, created_at: '2026-08-10 10:00:00' });
    const certificate = print.medCertHTML({ cert_no: 'MC-SYNTH', patient_name: payload, hn: payload,
      doctor_name: payload, created_at: '2026-08-10 10:00:00', content: { template_type: 'tmc_health_en', language: 'en',
        patient_name_en: payload, patient_address_en: payload, general_normal: false, abnormal_detail: payload,
        other_conditions: payload, physician_opinion: payload, recommendation: payload,
        declaration: { chronic: { has: true, detail: payload }, accident_surgery: { has: false, detail: '' },
          admitted: { has: false, detail: '' }, other: { has: true, detail: payload } },
        snapshot: { clinic: { name: payload, address: payload, name_en: payload, address_en: payload },
          doctor: { name: payload, name_en: payload, medical_license: payload }, patient: { citizen_id: payload, address: payload },
          vitals: { weight_kg: payload, height_cm: payload, bp_sys: payload, bp_dia: payload, pulse: payload } } } });
    for (const html of [appointment, certificate]) {
      assert.equal(html.includes('<script data-redteam>'), false);
      assert.equal(html.includes('<img src=x onerror='), false);
      assert.ok(html.includes('&lt;'), 'payload must be represented as escaped text');
    }
  });

  test('baht text handles large groups, rounding, and bounds', () => {
    assert.equal(bahtText(999999999), 'เก้าร้อยเก้าสิบเก้าล้านเก้าแสนเก้าหมื่นเก้าพันเก้าร้อยเก้าสิบเก้าบาทถ้วน');
    assert.equal(bahtText(1000000000001), 'หนึ่งล้านล้านเอ็ดบาทถ้วน');
    assert.equal(bahtText(1.999), 'สองบาทถ้วน');
    assert.throws(() => bahtText(-1), /จำนวนเงินไม่ถูกต้อง/);
    assert.throws(() => bahtText(Number.MAX_SAFE_INTEGER), /มากเกิน/);
  });

  test('a synthetic raw 32-byte local key creates a usable Recovery Kit without entering inventory', () => {
    const kitTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-redteam-raw-kit-'));
    const target = path.join(kitTestRoot, 'target');
    const keyFile = path.join(kitTestRoot, 'synthetic-local.key');
    const runtime = path.join(kitTestRoot, 'node.exe');
    const syntheticKey = crypto.randomBytes(32);
    try {
      fs.mkdirSync(target);
      fs.writeFileSync(keyFile, syntheticKey);
      fs.writeFileSync(runtime, 'synthetic runtime');
      const result = createRecoveryKit({ targetRoot: target, keyFile, appRoot, runtimePath: runtime,
        allowFixedForTest: true, appVersion: 'red-team' });
      assert.equal(fs.statSync(path.join(result.kitRoot, 'Recovery Key.txt')).size, 32);
      const inventory = fs.readFileSync(path.join(result.kitRoot, 'kit-files.json'), 'utf8');
      assert.equal(inventory.includes('Recovery Key'), false);
      assert.equal(fs.existsSync(path.join(result.kitRoot, 'ClinicApp', 'data')), false);
    } finally {
      syntheticKey.fill(0);
      fs.rmSync(kitTestRoot, { recursive: true, force: true });
    }
  });

  console.log(`${passed} red-team verification checks passed`);
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
