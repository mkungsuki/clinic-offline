'use strict';
// ฐานข้อมูลกลางของระบบ — SQLite ไฟล์เดียว เปิดผ่าน node:sqlite (synchronous)
// ทุก write ทั้งระบบวิ่งผ่าน process เดียว จึง serialized โดยธรรมชาติ
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.CLINIC_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'clinic.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const ASSET_DIR = path.join(DATA_DIR, 'assets');

for (const d of [DATA_DIR, BACKUP_DIR, ATTACH_DIR, ASSET_DIR]) fs.mkdirSync(d, { recursive: true });

const { SCHEMA_VERSION } = require('./schema-version');

const db = new DatabaseSync(DB_PATH);
// ด่านแรกก่อนเขียนอะไรลงฐาน: โปรแกรมรุ่นเก่าห้ามเปิดฐานที่รุ่นใหม่กว่า migrate ไปแล้ว
// (เช่น หลัง rollback โปรแกรมโดยไม่ได้คืนฐาน) — เดิมโค้ดเก่าจะเปิดเงียบๆ แล้วพังทีหลังแบบมองไม่เห็น
{
  const found = db.prepare('PRAGMA user_version').get().user_version;
  if (found > SCHEMA_VERSION) {
    try { db.close(); } catch {}
    const error = new Error(
      `เปิดฐานข้อมูลไม่ได้: ฐานข้อมูลนี้ถูกปรับโดยโปรแกรมรุ่นใหม่กว่า (ฐานข้อมูลรุ่น ${found} แต่โปรแกรมนี้รองรับถึงรุ่น ${SCHEMA_VERSION}) ` +
      'ระบบหยุดเพื่อไม่ให้ข้อมูลคนไข้เสียหาย — กรุณาติดตั้งโปรแกรมรุ่นล่าสุด หรือให้ผู้ดูแลกู้ฐานข้อมูลรุ่นเดิมจากสำเนาก่อนอัปเดต',
    );
    error.code = 'SCHEMA_TOO_NEW';
    error.found = found;
    error.supported = SCHEMA_VERSION;
    throw error;
  }
}
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// ---- เวลา: ใช้เวลาท้องถิ่นเครื่อง host เป็น authority (plan A9) ----
function pad(n) { return String(n).padStart(2, '0'); }
function now() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function today() { return now().slice(0, 10); }
function buddhistYear2() { return String((new Date().getFullYear() + 543) % 100).padStart(2, '0'); }
function buddhistYear4() { return String(new Date().getFullYear() + 543); }

// ---- transaction helper (node:sqlite ไม่มี .transaction()) ----
let txnDepth = 0;
function txn(fn) {
  if (txnDepth > 0) return fn(); // nested → join outer txn
  db.exec('BEGIN IMMEDIATE');
  txnDepth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { txnDepth--; }
}

// ---- schema ---- (ตัวเลขอยู่ใน lib/schema-version.js — แก้ที่นั่นคู่กับ migrateSteps เสมอ)

function migrate() {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v === SCHEMA_VERSION) return;
  if (v > SCHEMA_VERSION) throw new Error(`schema ${v} ใหม่กว่าที่รองรับ (${SCHEMA_VERSION})`); // ด่านบนกันไว้แล้ว — กันซ้ำเผื่อเรียก migrate() ตรง
  // ทั้ง migration ต้องเป็น all-or-nothing: ถ้าไฟดับ/แครชกลางคัน ต้องไม่เหลือ schema
  // ค้างครึ่งๆ ที่ทำให้เปิดโปรแกรมไม่ได้ (SQLite DDL อยู่ใน transaction ได้)
  txn(() => migrateSteps(v));
}

function migrateSteps(v) {
  if (v < 1) migrateV1();
  if (v < 2) {
    // v2: ผู้ติดต่อฉุกเฉิน (คำขอเจ้าของคลินิกระหว่าง UAT 2026-08-10)
    db.exec('ALTER TABLE patients ADD COLUMN emergency_name TEXT');
    db.exec('ALTER TABLE patients ADD COLUMN emergency_phone TEXT');
  }
  if (v < 3) {
    // v3: น้ำตาลปลายนิ้ว DTX (mg/dL) — เคสหลักคลินิกคือ HT/DM ต้องตามค่าได้
    db.exec('ALTER TABLE visits ADD COLUMN glucose REAL');
  }
  if (v < 4) {
    // v4: preset ข้อความ (PE ฯลฯ) — หมอกดแปะแทนพิมพ์ซ้ำ เพิ่ม/ปิดเองได้
    db.exec(`CREATE TABLE IF NOT EXISTS text_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by INTEGER,
      active INTEGER NOT NULL DEFAULT 1
    )`);
    if (db.prepare('SELECT COUNT(*) c FROM text_presets').get().c === 0) {
      const ins = db.prepare('INSERT INTO text_presets (field, name, content) VALUES (?, ?, ?)');
      ins.run('pe', 'ปกติทั่วไป',
        'GA: good consciousness, not pale, no jaundice\nHEENT: WNL\nHeart: regular rhythm, no murmur\nLungs: clear both lungs\nAbdomen: soft, not tender, no mass');
      ins.run('pe', 'Neuro screen ปกติ',
        'E4V5M6, orientation intact\nPupils 3 mm RTL both, CN II–XII intact\nMotor power gr. V all extremities, no pronator drift\nSensory intact all modalities\nDTR 2+ all, Babinski negative\nCerebellar: FTN/HKS normal, no nystagmus\nGait steady, tandem gait normal');
      ins.run('pe', 'เวียนศีรษะ/Vertigo',
        'No spontaneous/gaze-evoked nystagmus\nHead impulse test negative\nNo focal neurological deficit\nCerebellar signs negative, tandem gait normal\nTM intact both ears');
      ins.run('pe', 'URI/ไข้หวัด',
        'Pharynx injected, tonsils not enlarged, no exudate\nTM intact both\nLungs: clear\nNo cervical lymphadenopathy');
    }
  }
  if (v < 5) {
    // v5: ระบบนัด follow-up (คำขอเจ้าของ 2026-08-10) — นัดผูกกับคนไข้+visit, ดูรวมเป็นปฏิทิน
    db.exec(`CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hn TEXT NOT NULL REFERENCES patients(hn),
      visit_id INTEGER REFERENCES visits(id),
      appt_date TEXT NOT NULL,
      days INTEGER,
      note TEXT,
      cancelled INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER, created_at TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS ix_appt_date ON appointments(appt_date)');
  }
  if (v < 6) {
    // v6: ราคาทุนยา (คำขอเจ้าของ) — ทุน snapshot เข้า receipt_lines ตอนขาย เพื่อคิดกำไรขั้นต้นย้อนหลังได้แม่น
    db.exec('ALTER TABLE drugs ADD COLUMN cost REAL');
    db.exec('ALTER TABLE receipt_lines ADD COLUMN cost_each REAL');
  }
  if (v < 7) {
    // v7: โปรไฟล์แพทย์สำหรับเอกสาร — แยกจากชื่อ login และ snapshot ตอนออกเอกสาร
    db.exec('ALTER TABLE users ADD COLUMN medical_license TEXT');
    db.exec('ALTER TABLE users ADD COLUMN specialty TEXT');
  }
  if (v < 8) {
    // v8: เลือก editor เริ่มต้นต่อยา — ยาทั่วไปไม่ต้องเห็นช่องเวลา, neuro เลือกเวลาเฉพาะได้
    db.exec("ALTER TABLE drugs ADD COLUMN dose_mode TEXT NOT NULL DEFAULT 'standard'");
  }
  if (v < 9) {
    // v9: เอกสาร versioned + snapshot หัวใบเสร็จ ณ วันออก + lifecycle ยกเลิกใบรับรอง
    db.exec(`
ALTER TABLE users ADD COLUMN display_name_en TEXT;
ALTER TABLE receipt_lines ADD COLUMN item_code TEXT;
ALTER TABLE med_certs ADD COLUMN template_key TEXT;
ALTER TABLE med_certs ADD COLUMN template_version INTEGER;
ALTER TABLE med_certs ADD COLUMN language TEXT;

CREATE TABLE receipt_document_snapshots (
  receipt_no TEXT PRIMARY KEY REFERENCES receipts(receipt_no),
  template_key TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  issuer_json TEXT NOT NULL,
  payer_json TEXT NOT NULL,
  payment_json TEXT NOT NULL,
  cashier_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('new_issue','legacy_confirmed')),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER receipt_document_snapshots_no_update BEFORE UPDATE ON receipt_document_snapshots
BEGIN SELECT RAISE(ABORT, 'append-only: receipt_document_snapshots cannot be updated'); END;
CREATE TRIGGER receipt_document_snapshots_no_delete BEFORE DELETE ON receipt_document_snapshots
BEGIN SELECT RAISE(ABORT, 'append-only: receipt_document_snapshots cannot be deleted'); END;

CREATE TABLE med_cert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cert_no TEXT NOT NULL UNIQUE REFERENCES med_certs(cert_no),
  action TEXT NOT NULL CHECK(action IN ('void','replace')),
  reason TEXT NOT NULL,
  replacement_cert_no TEXT REFERENCES med_certs(cert_no),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER med_cert_events_no_update BEFORE UPDATE ON med_cert_events
BEGIN SELECT RAISE(ABORT, 'append-only: med_cert_events cannot be updated'); END;
CREATE TRIGGER med_cert_events_no_delete BEFORE DELETE ON med_cert_events
BEGIN SELECT RAISE(ABORT, 'append-only: med_cert_events cannot be deleted'); END;
`);
  }
  if (v < 10) {
    // v10: คลินิกมีเครื่องพิมพ์ตัวเดียวที่หน้าร้าน — หมอออกใบรับรองที่ห้องตรวจแล้วหน้าร้านเป็นคนพิมพ์
    // ต้องรู้ข้ามเครื่องว่าใบไหน "รอพิมพ์" vs "พิมพ์แล้ว" และเป็น audit ของเอกสารกฎหมายไปในตัว
    // station: host = เครื่องที่ต่อเครื่องพิมพ์ (loopback) · lan = เครื่องห้องตรวจ (เปิดดูได้แต่พิมพ์ไม่ได้จริง)
    db.exec(`
CREATE TABLE document_print_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('medcert','receipt','appointment')),
  doc_ref TEXT NOT NULL,
  visit_id INTEGER REFERENCES visits(id),
  printed_by INTEGER NOT NULL,
  printed_role TEXT NOT NULL,
  station TEXT NOT NULL CHECK(station IN ('host','lan')),
  created_at TEXT NOT NULL
);
CREATE INDEX ix_print_events_doc ON document_print_events(doc_type, doc_ref);
CREATE INDEX ix_print_events_visit ON document_print_events(visit_id);
CREATE TRIGGER document_print_events_no_update BEFORE UPDATE ON document_print_events
BEGIN SELECT RAISE(ABORT, 'append-only: document_print_events cannot be updated'); END;
CREATE TRIGGER document_print_events_no_delete BEFORE DELETE ON document_print_events
BEGIN SELECT RAISE(ABORT, 'append-only: document_print_events cannot be deleted'); END;
`);
  }
  if (v < 11) {
    // v11 (security round 1): บันทึกการเข้าใช้ — ใคร login/ปลดล็อกสำเร็จ/ล้มเหลว จากเครื่องไหน (auth_events)
    // และใครเปิดดู/ส่งออก/พิมพ์ข้อมูลคนไข้คนไหน (access_log) — ทั้งคู่ append-only, ห้ามเก็บรหัส/PIN ที่พิมพ์ผิด
    // ไม่ backfill ย้อนหลัง: เริ่มบันทึกจากวันที่ migrate
    db.exec(`
CREATE TABLE auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL CHECK(event IN ('login_ok','login_fail','unlock_ok','unlock_fail','logout','locked_out','clock_override')),
  username TEXT,
  user_id INTEGER,
  station TEXT NOT NULL CHECK(station IN ('host','lan')),
  remote TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_auth_events_time ON auth_events(created_at);
CREATE INDEX ix_auth_events_remote ON auth_events(remote, created_at);
CREATE TRIGGER auth_events_no_update BEFORE UPDATE ON auth_events
BEGIN SELECT RAISE(ABORT, 'append-only: auth_events cannot be updated'); END;
CREATE TRIGGER auth_events_no_delete BEFORE DELETE ON auth_events
BEGIN SELECT RAISE(ABORT, 'append-only: auth_events cannot be deleted'); END;

CREATE TABLE access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  station TEXT NOT NULL CHECK(station IN ('host','lan')),
  action TEXT NOT NULL CHECK(action IN ('view_patient','view_history','view_documents','export','print')),
  ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_access_log_ref ON access_log(ref, created_at);
CREATE INDEX ix_access_log_user ON access_log(user_id, created_at);
CREATE TRIGGER access_log_no_update BEFORE UPDATE ON access_log
BEGIN SELECT RAISE(ABORT, 'append-only: access_log cannot be updated'); END;
CREATE TRIGGER access_log_no_delete BEFORE DELETE ON access_log
BEGIN SELECT RAISE(ABORT, 'append-only: access_log cannot be deleted'); END;
`);
  }
  if (v < 12) {
    // v12: exactly-once registration (incident 2026-08-24 — codex NO-GO ข้อ 1): browser ส่ง op_id มากับการลงทะเบียน
    // ถ้า connection ขาดหลัง commit ก่อนคำตอบถึงจอ ผู้ใช้กดซ้ำ → server คืนผลเดิมแทนการสร้างคนไข้/คิวซ้ำ
    // ตารางนี้เป็น operational cache (prune 7 วัน) ไม่ใช่เวชระเบียน — ไม่ต้อง append-only trigger
    db.exec(`CREATE TABLE client_ops (
      op_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }
  if (v < 13) {
    // v13: แจ้งเตือนยาหมดอายุแบบรายลอต (หมอขอ 2026-08-31 สองรอบ): หมอกรอกวันหมดอายุทุก lot ตอนรับเข้า
    // ระบบเลือก lot ที่ใกล้หมดสุดมาเตือนเอง — lot หมด/เก็บออกแล้วปิดด้วย cleared_at (ห้าม DELETE — ประวัติต้องย้อนได้)
    // ไม่ทำ FEFO ตัดสต็อกรายลอต: ยอดรวมยังเป็น stock_movements เดิม (lot เป็นชั้นข้อมูลวันหมดอายุเท่านั้น)
    // expiry_warn_days = เกณฑ์เตือนรายยา (supplier แต่ละยาต่างกัน) — NULL = ใช้ค่ากลาง stock_expiry_warn_days
    db.exec(`CREATE TABLE drug_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drug_id INTEGER NOT NULL REFERENCES drugs(id),
      expiry_date TEXT NOT NULL,
      lot_label TEXT,
      qty_received REAL,
      received_at TEXT NOT NULL,
      received_by INTEGER,
      cleared_at TEXT,
      cleared_by INTEGER,
      cleared_reason TEXT
    )`);
    db.exec('CREATE INDEX ix_drug_lots_active ON drug_lots(drug_id, cleared_at)');
    db.exec('ALTER TABLE drugs ADD COLUMN expiry_warn_days INTEGER');
  }
  // v14: append-only appointment/contact history; old attendance remains unknown.
  if (v < 14) db.exec(`
CREATE TABLE appointment_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 appointment_id INTEGER NOT NULL REFERENCES appointments(id),
 kind TEXT NOT NULL CHECK(kind IN ('created','attendance','contact','reschedule','cancel')),
 outcome TEXT,note TEXT,previous_date TEXT,appointment_date TEXT,
 created_by INTEGER REFERENCES users(id),created_at TEXT NOT NULL
);
CREATE INDEX ix_appointment_events ON appointment_events(appointment_id,id);
CREATE TRIGGER appointment_events_no_update BEFORE UPDATE ON appointment_events BEGIN SELECT RAISE(ABORT,'append-only: appointment_events cannot be updated'); END;
CREATE TRIGGER appointment_events_no_delete BEFORE DELETE ON appointment_events BEGIN SELECT RAISE(ABORT,'append-only: appointment_events cannot be deleted'); END;
`);
  // v15: old rows stay NULL; never infer a requested doctor from the examiner.
  if (v < 15) db.exec(`
ALTER TABLE appointments ADD COLUMN doctor_id INTEGER REFERENCES users(id);
ALTER TABLE visits ADD COLUMN preferred_doctor_id INTEGER REFERENCES users(id);
`);
  // v16: unknown service costs remain NULL, including every historical receipt.
  if (v < 16) db.exec('ALTER TABLE services ADD COLUMN cost REAL CHECK(cost IS NULL OR cost >= 0)');
  // Keep all legacy instructions unchanged; never infer a numeric dose from prose.
  if (v < 17) db.exec('ALTER TABLE drugs ADD COLUMN default_dose_json TEXT');
  // v18 is additive: historical rows, tables and their immutable triggers stay untouched.
  if (v < 18) {
    db.exec(`CREATE TABLE audit_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      actor_id INTEGER REFERENCES users(id), actor_name TEXT, actor_role TEXT,
      station TEXT NOT NULL CHECK(station IN ('host','lan','system')),
      category TEXT NOT NULL CHECK(category IN ('patient','vitals','drug','service','lot','user','settings','stock')),
      action TEXT NOT NULL CHECK(action IN ('create','update','merge','suspend','reactivate','secret_changed','permission','import')),
      entity_id TEXT NOT NULL, ref TEXT NOT NULL,
      changes_json TEXT NOT NULL CHECK(json_valid(changes_json)), reason TEXT,
      source TEXT NOT NULL, important INTEGER NOT NULL CHECK(important IN (0,1))
    );
    CREATE INDEX audit_changes_category_time ON audit_changes(category,created_at,id);
    CREATE INDEX audit_changes_ref ON audit_changes(ref,created_at,id);
    CREATE INDEX audit_changes_entity ON audit_changes(category,entity_id,created_at,id);
    CREATE INDEX audit_changes_actor ON audit_changes(actor_id,created_at,id);
    CREATE TRIGGER audit_changes_no_update BEFORE UPDATE ON audit_changes BEGIN SELECT RAISE(ABORT,'audit_changes is append-only'); END;
    CREATE TRIGGER audit_changes_no_delete BEFORE DELETE ON audit_changes BEGIN SELECT RAISE(ABORT,'audit_changes is append-only'); END;`);
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('audit_changes_since',now());
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function migrateV1() {
  db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('doctor','front','admin')),
  pass_hash TEXT NOT NULL,
  pin_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patients (
  hn TEXT PRIMARY KEY,
  prefix TEXT DEFAULT '',
  first_name TEXT NOT NULL,
  last_name TEXT DEFAULT '',
  sex TEXT NOT NULL,
  birth_date TEXT,
  citizen_id TEXT,
  phone TEXT,
  phone_norm TEXT,
  address TEXT,
  chronic TEXT DEFAULT '',
  duplicate_of_hn TEXT REFERENCES patients(hn),
  created_at TEXT NOT NULL, created_by INTEGER,
  updated_at TEXT, updated_by INTEGER
);
CREATE INDEX IF NOT EXISTS ix_patients_name ON patients(first_name, last_name);
CREATE INDEX IF NOT EXISTS ix_patients_phone ON patients(phone_norm);
CREATE INDEX IF NOT EXISTS ix_patients_cid ON patients(citizen_id);

-- แพ้ยา: append-only, สถานะปัจจุบัน = add ที่ยังไม่ถูก remove อ้างถึง
CREATE TABLE IF NOT EXISTS allergy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hn TEXT NOT NULL REFERENCES patients(hn),
  action TEXT NOT NULL CHECK(action IN ('add','remove')),
  ref_id INTEGER,
  substance TEXT NOT NULL,
  reaction TEXT,
  reason TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_allergy_hn ON allergy_log(hn);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT NOT NULL, period TEXT NOT NULL, value INTEGER NOT NULL,
  PRIMARY KEY (name, period)
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hn TEXT NOT NULL REFERENCES patients(hn),
  visit_date TEXT NOT NULL,
  queue_no INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('WAITING','IN_EXAM','DISPENSING','COMPLETED','CANCELLED')),
  doctor_id INTEGER REFERENCES users(id),
  requeued_at TEXT,
  weight_kg REAL, height_cm REAL, temp_c REAL, bp_sys INTEGER, bp_dia INTEGER, pulse INTEGER,
  vitals_updated_by INTEGER, vitals_updated_at TEXT,
  cancel_reason TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (visit_date, queue_no)
);
CREATE INDEX IF NOT EXISTS ix_visits_date ON visits(visit_date);
CREATE INDEX IF NOT EXISTS ix_visits_hn ON visits(hn);
CREATE INDEX IF NOT EXISTS ix_visits_state ON visits(state);

-- draft = กันไฟดับเท่านั้น ถูก promote เป็น note_versions ใน txn จบตรวจเสมอ
CREATE TABLE IF NOT EXISTS note_drafts (
  visit_id INTEGER PRIMARY KEY REFERENCES visits(id),
  payload_json TEXT NOT NULL,
  updated_by INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS note_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  version INTEGER NOT NULL,
  cc TEXT, hpi TEXT, pe TEXT, dx_text TEXT, icd10 TEXT, note TEXT,
  vitals_json TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (visit_id, version)
);
CREATE TABLE IF NOT EXISTS order_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  version INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  edit_reason TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (visit_id, version)
);
-- ack แยกตารางเพื่อให้ order_versions เป็น append-only แท้
CREATE TABLE IF NOT EXISTS order_acks (
  order_version_id INTEGER PRIMARY KEY REFERENCES order_versions(id),
  acked_by INTEGER NOT NULL, acked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drugs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  name TEXT NOT NULL,
  generic_name TEXT,
  unit TEXT DEFAULT 'เม็ด',
  price REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  qty_on_hand REAL NOT NULL DEFAULT 0,
  default_instructions TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
-- ledger คือ source of truth ของ stock; drugs.qty_on_hand เป็น cache ที่อัปเดตใน txn เดียวกัน
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drug_id INTEGER NOT NULL REFERENCES drugs(id),
  type TEXT NOT NULL CHECK(type IN ('receive','dispense','adjust','void_return')),
  qty REAL NOT NULL,
  ref TEXT, reason TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stock_drug ON stock_movements(drug_id);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_no TEXT PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  hn TEXT NOT NULL,
  patient_name TEXT NOT NULL,
  order_version_id INTEGER NOT NULL REFERENCES order_versions(id),
  subtotal REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  discount_reason TEXT,
  total REAL NOT NULL,
  pay_method TEXT NOT NULL CHECK(pay_method IN ('cash','transfer')),
  status TEXT NOT NULL DEFAULT 'ISSUED' CHECK(status IN ('ISSUED','VOID')),
  void_reason TEXT, voided_by INTEGER, voided_at TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL
);
-- invariant: 1 ใบ ISSUED ต่อ visit
CREATE UNIQUE INDEX IF NOT EXISTS ux_receipt_issued ON receipts(visit_id) WHERE status = 'ISSUED';
CREATE INDEX IF NOT EXISTS ix_receipts_date ON receipts(created_at);

CREATE TABLE IF NOT EXISTS receipt_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no TEXT NOT NULL REFERENCES receipts(receipt_no),
  line_type TEXT NOT NULL CHECK(line_type IN ('drug','service')),
  ref_id INTEGER,
  name TEXT NOT NULL,
  qty REAL NOT NULL,
  unit TEXT,
  price_each REAL NOT NULL,
  amount REAL NOT NULL,
  instructions TEXT
);
CREATE INDEX IF NOT EXISTS ix_rlines_no ON receipt_lines(receipt_no);

CREATE TABLE IF NOT EXISTS med_certs (
  cert_no TEXT PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  hn TEXT NOT NULL,
  patient_name TEXT NOT NULL,
  doctor_id INTEGER NOT NULL,
  doctor_name TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fav_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cc TEXT, dx_text TEXT, icd10 TEXT, note_json TEXT,
  lines_json TEXT NOT NULL,
  created_by INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS icd10 (
  code TEXT PRIMARY KEY, term_en TEXT, term_th TEXT
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hn TEXT NOT NULL REFERENCES patients(hn),
  visit_id INTEGER REFERENCES visits(id),
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT, size INTEGER,
  uploaded_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);

-- ================= append-only guards =================
-- เวชระเบียน/ledger/เอกสารการเงิน แก้ย้อนหลังไม่ได้ในระดับ DB (plan §4 structural)
`);
  for (const t of ['note_versions', 'order_versions', 'order_acks', 'stock_movements', 'allergy_log', 'med_certs', 'receipt_lines', 'backup_log']) {
    db.exec(`
CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t}
BEGIN SELECT RAISE(ABORT, 'append-only: ${t} cannot be updated'); END;
CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t}
BEGIN SELECT RAISE(ABORT, 'append-only: ${t} cannot be deleted'); END;`);
  }
  // ใบเสร็จ: อนุญาต UPDATE เดียวคือ ISSUED → VOID โดยตัวเลขเงิน/ตัวตนใบห้ามเปลี่ยน
  db.exec(`
CREATE TRIGGER IF NOT EXISTS receipts_guard_update BEFORE UPDATE ON receipts
WHEN NOT (
  OLD.status = 'ISSUED' AND NEW.status = 'VOID'
  AND NEW.receipt_no = OLD.receipt_no AND NEW.visit_id = OLD.visit_id
  AND NEW.hn = OLD.hn AND NEW.patient_name = OLD.patient_name
  AND NEW.order_version_id = OLD.order_version_id
  AND NEW.subtotal = OLD.subtotal AND NEW.discount = OLD.discount AND NEW.total = OLD.total
  AND NEW.pay_method = OLD.pay_method
  AND NEW.created_by = OLD.created_by AND NEW.created_at = OLD.created_at
  AND NEW.void_reason IS NOT NULL AND NEW.voided_by IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'receipts: only ISSUED->VOID with reason is allowed'); END;
CREATE TRIGGER IF NOT EXISTS receipts_no_delete BEFORE DELETE ON receipts
BEGIN SELECT RAISE(ABORT, 'append-only: receipts cannot be deleted'); END;
`);
}

migrate();

// ---- settings helpers ----
function getSetting(key, dflt) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : dflt;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---- counters: เลขรันทุกชนิดออกจากที่นี่ ภายใน txn ของผู้เรียกเสมอ ----
function nextCounter(name, period) {
  db.prepare(`INSERT INTO counters (name, period, value) VALUES (?, ?, 0)
              ON CONFLICT(name, period) DO NOTHING`).run(name, period);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ? AND period = ?').run(name, period);
  return db.prepare('SELECT value FROM counters WHERE name = ? AND period = ?').get(name, period).value;
}
function nextHN() {
  const yy = buddhistYear2();
  return `${yy}-${String(nextCounter('hn', yy)).padStart(4, '0')}`;
}
function nextQueueNo() { return nextCounter('queue', today()); }
function nextReceiptNo() {
  const y = buddhistYear4();
  return `RC${y}-${String(nextCounter('receipt', y)).padStart(5, '0')}`;
}
function nextCertNo() {
  const y = buddhistYear4();
  return `MC${y}-${String(nextCounter('medcert', y)).padStart(4, '0')}`;
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  db, txn, now, today, migrate,
  getSetting, setSetting,
  nextCounter, nextHN, nextQueueNo, nextReceiptNo, nextCertNo,
  round2, SCHEMA_VERSION,
  DATA_DIR, DB_PATH, BACKUP_DIR, ATTACH_DIR, ASSET_DIR,
};
