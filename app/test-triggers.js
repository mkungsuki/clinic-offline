'use strict';
// No production connection: seed synthetic data in a new temp directory before opening SQLite.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-trigger-test-'));
let db, passed = 0;
try {
  const env = { ...process.env, CLINIC_DATA_DIR: temp };
  for (const args of [['seed.js', '--demo'], ['seed-mock-clinic.js']]) {
    const r = spawnSync(process.execPath, ['--no-warnings', ...args], { cwd: __dirname, env, stdio: 'pipe', windowsHide: true });
    assert.equal(r.status, 0, 'synthetic fixture seed failed');
  }
  db = new DatabaseSync(path.join(temp, 'clinic.db'));
  const visit = db.prepare('SELECT id, hn FROM visits LIMIT 1').get();
  db.prepare("INSERT INTO med_certs (cert_no,visit_id,hn,patient_name,doctor_id,doctor_name,content_json,created_by,created_at) VALUES ('TEST-CERT',?,?,'ทดสอบ',1,'ทดสอบ','{}',1,'2026-01-01')").run(visit.id, visit.hn);
  const tests = [
    ['note_versions', "UPDATE note_versions SET dx_text='test'", /append-only/],
    ['stock_movements', 'DELETE FROM stock_movements', /append-only/],
    ['receipts', 'UPDATE receipts SET total=0', /only ISSUED->VOID/],
    ['receipts', 'DELETE FROM receipts', /append-only/],
    ['order_versions', "UPDATE order_versions SET lines_json='[]'", /append-only/],
    ['allergy_log', 'DELETE FROM allergy_log', /append-only/],
    ['med_certs', "UPDATE med_certs SET patient_name='test'", /append-only/],
  ];
  for (const [table, sql, expected] of tests) {
    assert(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n > 0, 'fixture must populate ' + table);
    assert.throws(() => db.exec(sql), expected);
    passed++; console.log('✅ isolated trigger: ' + table);
  }
  const receipt = db.prepare("SELECT receipt_no FROM receipts WHERE status='ISSUED' LIMIT 1").get();
  assert(receipt);
  db.exec('BEGIN');
  const changed = db.prepare("UPDATE receipts SET status='VOID', void_reason='synthetic test', voided_by=1, voided_at='2026-01-01' WHERE receipt_no=?").run(receipt.receipt_no);
  assert.equal(changed.changes, 1);
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT status FROM receipts WHERE receipt_no=?').get(receipt.receipt_no).status, 'ISSUED');
  passed++; console.log('TRIGGER PASS: ' + passed + '/8 (synthetic temp DB only)');
} finally { if (db) db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
