'use strict';
// Regression tests ใช้ฐานข้อมูลชั่วคราวเสมอ ไม่แตะ app/data/clinic.db
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-regression-'));
process.env.CLINIC_DATA_DIR = tempDir;

const { db, now, ATTACH_DIR, ASSET_DIR, setSetting } = require('./lib/db');
const appts = require('./lib/appointments');
const auth = require('./lib/auth');
const visits = require('./lib/visits');
const notes = require('./lib/notes');
const stock = require('./lib/stock');
const billing = require('./lib/billing');
const backup = require('./lib/backup');
const print = require('./lib/print');
const { bahtText } = require('./lib/document-utils');
const { mergeRemedLines } = require('./public/remed');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); throw e; }
}

function addUser(username, role) {
  const r = auth.createUser({ username, displayName: username, role, password: 'Test-pass-123', pin: '1234' });
  return Number(r.lastInsertRowid);
}
function addPatient(hn) {
  db.prepare(`INSERT INTO patients (hn, first_name, sex, created_at, created_by) VALUES (?, 'ทดสอบ', 'F', ?, ?)`)
    .run(hn, now(), frontId);
}
function completedVisit(hn, qty) {
  const v = visits.create(hn, frontId);
  visits.transition(v.id, 'call', doctorId);
  const done = visits.finishExam(v.id, {
    note: { cc: 'ทดสอบ', dx_text: 'test' },
    lines: [{ type: 'drug', ref_id: drugId, qty }], baseVersionId: null,
  }, doctorId);
  const paid = billing.pay(v.id, { orderVersionId: done.order.id, payMethod: 'cash', userId: frontId });
  return { visitId: v.id, receiptNo: paid.receiptNo };
}

const frontId = addUser('front-test', 'front');
const doctorId = addUser('doctor-test', 'doctor');
const doctor2Id = addUser('doctor2-test', 'doctor');
const drugId = stock.upsertDrug({ name: 'Test Drug', unit: 'เม็ด', price: 2 });
stock.move(drugId, 'receive', 100, { reason: 'test', userId: frontId });
addPatient('99-0001');
addPatient('99-0002');

try {
  test('จบตรวจบันทึก note + order + state ใน transaction เดียว', () => {
    const v = visits.create('99-0001', frontId);
    visits.transition(v.id, 'call', doctorId);
    const r = visits.finishExam(v.id, {
      note: { cc: 'เวียนศีรษะ', dx_text: 'Vertigo' },
      lines: [{ type: 'drug', ref_id: drugId, qty: 10 }], baseVersionId: null,
    }, doctorId);
    assert.equal(r.visit.state, 'DISPENSING');
    assert.equal(notes.noteVersions(v.id).length, 1);
    assert.equal(r.order.lines[0].qty, 10);
    billing.pay(v.id, { orderVersionId: r.order.id, payMethod: 'cash', userId: frontId });
  });

  test('void/reissue แบบยาไม่คืน ไม่ตัด stock ซ้ำ', () => {
    const { receiptNo } = completedVisit('99-0002', 10);
    const before = db.prepare('SELECT qty_on_hand FROM drugs WHERE id = ?').get(drugId).qty_on_hand;
    billing.voidAndReissue(receiptNo, {
      newLines: [{ type: 'drug', ref_id: drugId, qty: 5 }], returnedStock: false,
      voidReason: 'แก้เอกสาร', payMethod: 'cash', userId: frontId,
    });
    const after = db.prepare('SELECT qty_on_hand FROM drugs WHERE id = ?').get(drugId).qty_on_hand;
    assert.equal(after, before);
  });

  test('void/reissue แบบยาคืนจริง คืนของเดิมแล้วตัดของใหม่', () => {
    const { receiptNo } = completedVisit('99-0002', 10);
    const before = db.prepare('SELECT qty_on_hand FROM drugs WHERE id = ?').get(drugId).qty_on_hand;
    billing.voidAndReissue(receiptNo, {
      newLines: [{ type: 'drug', ref_id: drugId, qty: 4 }], returnedStock: true,
      voidReason: 'รับยาคืนและจ่ายใหม่', payMethod: 'cash', userId: frontId,
    });
    const after = db.prepare('SELECT qty_on_hand FROM drugs WHERE id = ?').get(drugId).qty_on_hand;
    assert.equal(after, before + 6);
  });

  test('แพทย์คนอื่นออกใบรับรองในชื่อเจ้าของ visit ไม่ได้', () => {
    const v = db.prepare('SELECT id FROM visits WHERE doctor_id = ? ORDER BY id LIMIT 1').get(doctorId);
    assert.throws(() => billing.issueMedCert(v.id, {}, doctor2Id), /เฉพาะแพทย์เจ้าของ visit/);
  });

  test('หน้าคลินิกเพิ่มจำนวนหรือแก้วิธีใช้ยาไม่ได้', () => {
    const previous = notes.buildLines([{ type: 'drug', ref_id: drugId, qty: 10, instructions: 'หลังอาหาร' }]);
    assert.throws(() => notes.validateFrontOrderEdit(previous,
      [{ type: 'drug', ref_id: drugId, qty: 11, instructions: 'หลังอาหาร' }]), /เพิ่มจำนวน/);
    assert.throws(() => notes.validateFrontOrderEdit(previous,
      [{ type: 'drug', ref_id: drugId, qty: 10, instructions: 'ก่อนนอน' }]), /แก้วิธีใช้/);
    assert.equal(notes.validateFrontOrderEdit(previous,
      [{ type: 'drug', ref_id: drugId, qty: 5, instructions: 'หลังอาหาร' }])[0].qty, 5);
  });

  test('เวลาเฉพาะคำนวณจำนวนได้ และ manual override ไม่ถูกทับ', () => {
    const exact = { mode: 'exact_times', times: [
      { time: '06:00', amount: 1 }, { time: '10:00', amount: 0.5 }, { time: '14:00', amount: 1 },
    ], timing: 'ก่อนอาหาร', days: 7 };
    const calculated = notes.buildLines([{ type: 'drug', ref_id: drugId, qty: 1, dose: exact }])[0];
    assert.equal(calculated.qty, 18);
    assert.match(calculated.instructions, /06:00 1 เม็ด/);
    const manual = notes.buildLines([{ type: 'drug', ref_id: drugId, qty: 12,
      dose: { ...exact, qty_source: 'manual' } }])[0];
    assert.equal(manual.calculated_qty, 18);
    assert.equal(manual.qty, 12);
    assert.equal(notes.validateFrontOrderEdit([calculated], [{ ...calculated, qty: 12,
      dose: { ...calculated.dose, qty_source: 'manual' } }])[0].qty, 12);
  });

  test('ยา PRN ไม่เดาจำนวนให้อัตโนมัติ', () => {
    const line = notes.buildLines([{ type: 'drug', ref_id: drugId, qty: 10, dose: {
      mode: 'prn', prn_amount: 1, prn_indication: 'ปวดศีรษะ', prn_interval_hours: 6, prn_max_per_day: 4,
    } }])[0];
    assert.equal(line.qty, 10);
    assert.equal(line.calculated_qty, null);
    assert.match(line.instructions, /ปวดศีรษะ/);
  });

  test('ใบรับรอง snapshot ข้อมูลคลินิกและแพทย์ ไม่เปลี่ยนตาม setting ใหม่', () => {
    db.prepare('UPDATE users SET medical_license = ?, specialty = ? WHERE id = ?').run('ว12345', 'ประสาทวิทยา', doctorId);
    setSetting('clinic_name', 'คลินิกเดิม');
    const v = db.prepare('SELECT id FROM visits WHERE doctor_id = ? ORDER BY id LIMIT 1').get(doctorId);
    const no = billing.issueMedCert(v.id, { template_type: 'health_exam', findings: 'ปกติ' }, doctorId);
    setSetting('clinic_name', 'คลินิกใหม่');
    const cert = billing.getMedCert(no);
    assert.equal(cert.content.snapshot.clinic.name, 'คลินิกเดิม');
    assert.equal(cert.content.snapshot.doctor.medical_license, 'ว12345');
  });

  test('จำนวนเงินภาษาไทยอ่านหลักสิบเอ็ด ยี่สิบเอ็ด ล้าน และสตางค์ถูกต้อง', () => {
    assert.equal(bahtText(0), 'ศูนย์บาทถ้วน');
    assert.equal(bahtText(11), 'สิบเอ็ดบาทถ้วน');
    assert.equal(bahtText(21), 'ยี่สิบเอ็ดบาทถ้วน');
    assert.equal(bahtText(1000001.25), 'หนึ่งล้านเอ็ดบาทยี่สิบห้าสตางค์');
    assert.equal(bahtText(21000000), 'ยี่สิบเอ็ดล้านบาทถ้วน');
  });

  test('ใบเสร็จ snapshot ผู้ออก ผู้ชำระ และผู้รับเงิน ไม่เปลี่ยนตาม setting ภายหลัง', () => {
    setSetting('receipt_issuer_name', 'กิจการเดิม');
    setSetting('receipt_tax_id', '1234567890123');
    const { receiptNo } = completedVisit('99-0002', 2);
    const first = billing.getReceipt(receiptNo);
    assert.equal(first.document.issuer.name, 'กิจการเดิม');
    assert.equal(first.document.issuer.tax_id, '1234567890123');
    assert.equal(first.document.payer.name, 'ทดสอบ');
    setSetting('receipt_issuer_name', 'กิจการใหม่');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('ชื่อใหม่', frontId);
    const after = billing.getReceipt(receiptNo);
    assert.equal(after.document.issuer.name, 'กิจการเดิม');
    assert.equal(after.document.cashier.name, 'front-test');
    assert.match(print.receiptHTML(after, { copy: true }), /COPY/);
    assert.throws(() => db.prepare('UPDATE receipt_document_snapshots SET source = source WHERE receipt_no = ?').run(receiptNo), /append-only/);
  });

  test('ตัวเลือกเอกสาร: ชื่อแพทย์บนใบเสร็จ snapshot ณ วันออก และใบนัดแสดงตามการตั้งค่า', () => {
    const first = completedVisit('99-0002', 1);
    const withDoctor = billing.getReceipt(first.receiptNo);
    assert.equal(withDoctor.document.cashier.doctor_name, 'doctor-test');
    assert.match(print.receiptHTML(withDoctor, {}), /แพทย์ผู้ตรวจ/);
    // ปิดตัวเลือกภายหลัง: ใบใหม่ไม่มีชื่อแพทย์ แต่ใบเก่า reprint เหมือนเดิม (snapshot)
    setSetting('receipt_show_doctor', '0');
    const second = completedVisit('99-0002', 1);
    assert.equal(billing.getReceipt(second.receiptNo).document.cashier.doctor_name, undefined);
    assert.equal(billing.getReceipt(first.receiptNo).document.cashier.doctor_name, 'doctor-test');
    setSetting('receipt_show_doctor', '1');
    const appt = appts.create(second.visitId, { days: 7, note: 'ติดตามความดัน' }, doctorId);
    const row = db.prepare(`SELECT a.*, p.prefix, p.first_name, p.last_name, u.display_name doctor_name
      FROM appointments a JOIN patients p ON p.hn = a.hn
      LEFT JOIN visits v ON v.id = a.visit_id LEFT JOIN users u ON u.id = v.doctor_id
      WHERE a.id = ?`).get(appt.id);
    const slip = print.appointmentSlipHTML(row);
    assert.match(slip, /ใบนัด/);
    assert.match(slip, /ติดตามความดัน/);
    assert.match(slip, /doctor-test/);
    setSetting('appt_slip_show_note', '0'); setSetting('appt_slip_show_doctor', '0');
    const hidden = print.appointmentSlipHTML(row);
    assert.equal(/ติดตามความดัน/.test(hidden), false);
    assert.equal(/doctor-test/.test(hidden), false);
    assert.match(hidden, /ใบนัด/);
    setSetting('appt_slip_show_note', '1'); setSetting('appt_slip_show_doctor', '1');
  });

  test('แบบใบรับรองใหม่บังคับการยืนยัน และไม่รับชื่อแบบที่ไม่รู้จัก', () => {
    const v = db.prepare('SELECT id FROM visits WHERE doctor_id = ? ORDER BY id LIMIT 1').get(doctorId);
    assert.throws(() => billing.issueMedCert(v.id, { template_type: 'made_up' }, doctorId), /ไม่รู้จักแบบ/);
    assert.throws(() => billing.issueMedCert(v.id, { template_type: 'general', doctor_confirmed: false }, doctorId), /กรุณายืนยัน/);
    const no = billing.issueMedCert(v.id, { template_type: 'general', purpose: 'attendance', doctor_confirmed: true }, doctorId);
    assert.equal(billing.getMedCert(no).template_key, 'general');
  });

  test('แบบแพทยสภาตรวจข้อมูลจำเป็นและเก็บ metadata/snapshot', () => {
    db.prepare('UPDATE patients SET citizen_id = ?, address = ? WHERE hn = ?').run('1234567890123', 'กรุงเทพฯ', '99-0001');
    const v = db.prepare('SELECT id FROM visits WHERE hn = ? AND doctor_id = ? ORDER BY id LIMIT 1').get('99-0001', doctorId);
    db.prepare('UPDATE visits SET weight_kg=60, height_cm=165, bp_sys=120, bp_dia=80, pulse=72 WHERE id=?').run(v.id);
    const declaration = {
      chronic: { has: false, detail: '' }, accident_surgery: { has: false, detail: '' },
      admitted: { has: false, detail: '' }, other: { has: false, detail: '' }, applicant_confirmed: true,
    };
    const no = billing.issueMedCert(v.id, { template_type: 'tmc_health_th', declaration,
      general_normal: true, standard_exam_confirmed: true, physician_opinion: 'สุขภาพเหมาะสม' }, doctorId);
    const c = billing.getMedCert(no);
    assert.equal(c.template_key, 'tmc_health_th');
    assert.equal(c.template_version, 1);
    assert.equal(c.content.snapshot.patient.citizen_id, '1234567890123');
    assert.match(print.medCertHTML(c), /ใบรับรองการตรวจสุขภาพ/);
  });

  test('ใบรับรองยกเลิกแบบ append-only และพิมพ์มีตรายกเลิก', () => {
    const v = db.prepare('SELECT id FROM visits WHERE doctor_id = ? ORDER BY id LIMIT 1').get(doctorId);
    const no = billing.issueMedCert(v.id, { template_type: 'general', purpose: 'attendance', doctor_confirmed: true }, doctorId);
    billing.voidMedCert(no, 'ออกข้อมูลผิด', doctorId);
    const c = billing.getMedCert(no);
    assert.equal(c.event.action, 'void');
    assert.match(print.medCertHTML(c), /ยกเลิก/);
    assert.throws(() => billing.voidMedCert(no, 'ซ้ำ', doctorId), /ถูกยกเลิกหรือออกแทนแล้ว/);
    assert.throws(() => db.prepare('DELETE FROM med_cert_events WHERE cert_no = ?').run(no), /append-only/);
  });

  test('ออกใบรับรองใหม่แทนเชื่อมเลขใบเดิมและใบใหม่ใน transaction เดียว', () => {
    const v = db.prepare('SELECT id FROM visits WHERE doctor_id = ? ORDER BY id LIMIT 1').get(doctorId);
    const oldNo = billing.issueMedCert(v.id, { template_type: 'general', purpose: 'attendance', doctor_confirmed: true }, doctorId);
    const newNo = billing.issueMedCert(v.id, { template_type: 'general', purpose: 'attendance', doctor_confirmed: true,
      replace_cert_no: oldNo, replace_reason: 'แก้ชื่อวัตถุประสงค์' }, doctorId);
    const old = billing.getMedCert(oldNo);
    assert.equal(old.event.action, 'replace');
    assert.equal(old.event.replacement_cert_no, newNo);
    assert.match(print.medCertHTML(old), new RegExp(newNo));
  });

  // ---- print-at-front: เครื่องพิมพ์อยู่ที่หน้าร้านเครื่องเดียว หมอออกใบที่ห้องตรวจแล้วหน้าร้านพิมพ์ ----
  test('ใบรับรองที่หมอออกขึ้น "รอพิมพ์" ที่หน้าร้าน และหายเมื่อพิมพ์จากเครื่อง host', () => {
    const printEvents = require('./lib/print-events');
    const v = db.prepare('SELECT id FROM visits WHERE doctor_id = ? ORDER BY id LIMIT 1').get(doctorId);
    const no = billing.issueMedCert(v.id, { template_type: 'general', purpose: 'attendance', doctor_confirmed: true }, doctorId);
    const pendingOf = () => (printEvents.pendingForVisits([v.id]).get(v.id) || []).map(d => d.doc_ref);
    assert.ok(pendingOf().includes(no), 'ใบที่เพิ่งออกต้องขึ้นรอพิมพ์');
    // หมอเปิดดูจากเครื่องห้องตรวจ (lan) — ยังต้องรอพิมพ์อยู่ เพราะเครื่องนั้นไม่มีเครื่องพิมพ์จริง
    printEvents.record({ docType: 'medcert', docRef: no, visitId: v.id, userId: doctorId, role: 'doctor', station: 'lan' });
    const afterView = printEvents.pendingForVisits([v.id]).get(v.id).find(d => d.doc_ref === no);
    assert.ok(afterView, 'พิมพ์จากเครื่อง LAN ไม่นับว่าพิมพ์แล้ว');
    assert.ok(afterView.viewed_at, 'ต้องบอกได้ว่าหมอเปิดดูแล้ว');
    // หน้าร้าน (host) กดพิมพ์ → ป้ายหาย
    printEvents.record({ docType: 'medcert', docRef: no, visitId: v.id, userId: frontId, role: 'front', station: 'host' });
    assert.equal(pendingOf().includes(no), false, 'พิมพ์จากเครื่องหน้าร้านแล้วต้องไม่รอพิมพ์อีก');
    const events = printEvents.eventsForVisit(v.id).filter(e => e.doc_ref === no);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.station), ['lan', 'host']);
  });

  test('ใบที่ void ไม่ขึ้นรอพิมพ์ และใบที่ถูกแทนขึ้นเฉพาะใบใหม่', () => {
    const printEvents = require('./lib/print-events');
    const v = db.prepare('SELECT id FROM visits WHERE doctor_id = ? ORDER BY id DESC LIMIT 1').get(doctorId);
    const pendingOf = () => (printEvents.pendingForVisits([v.id]).get(v.id) || []).map(d => d.doc_ref);
    const voided = billing.issueMedCert(v.id, { template_type: 'general', purpose: 'attendance', doctor_confirmed: true }, doctorId);
    billing.voidMedCert(voided, 'ออกผิดคน', doctorId);
    assert.equal(pendingOf().includes(voided), false, 'ใบที่ยกเลิกแล้วห้ามให้หน้าร้านพิมพ์');
    const oldNo = billing.issueMedCert(v.id, { template_type: 'general', purpose: 'attendance', doctor_confirmed: true }, doctorId);
    const newNo = billing.issueMedCert(v.id, { template_type: 'general', purpose: 'attendance', doctor_confirmed: true,
      replace_cert_no: oldNo, replace_reason: 'แก้จำนวนวันพัก' }, doctorId);
    const pending = pendingOf();
    assert.equal(pending.includes(oldNo), false, 'ใบเดิมที่ถูกแทนแล้วห้ามขึ้นรอพิมพ์');
    assert.ok(pending.includes(newNo), 'ใบใหม่ต้องขึ้นรอพิมพ์');
  });

  test('document_print_events แก้/ลบไม่ได้ (append-only) และปฏิเสธค่าที่ไม่ถูกต้อง', () => {
    const printEvents = require('./lib/print-events');
    const v = db.prepare('SELECT id FROM visits WHERE doctor_id = ? ORDER BY id LIMIT 1').get(doctorId);
    printEvents.record({ docType: 'appointment', docRef: '4242', visitId: v.id, userId: frontId, role: 'front', station: 'host' });
    assert.throws(() => db.prepare("UPDATE document_print_events SET station = 'lan' WHERE doc_ref = '4242'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM document_print_events WHERE doc_ref = '4242'").run(), /append-only/);
    assert.throws(() => printEvents.record({ docType: 'ใบอื่น', docRef: 'x', visitId: v.id, userId: frontId, role: 'front', station: 'host' }), /ชนิดเอกสาร/);
    assert.throws(() => printEvents.record({ docType: 'medcert', docRef: '', visitId: v.id, userId: frontId, role: 'front', station: 'host' }), /เลขที่เอกสาร/);
    assert.throws(() => printEvents.record({ docType: 'medcert', docRef: 'MC1', visitId: v.id, userId: frontId, role: 'front', station: 'ห้องหมอ' }), /เครื่องไหน/);
    assert.equal(printEvents.stationOf(true), 'host');
    assert.equal(printEvents.stationOf(false), 'lan');
  });

  test('backup มี DB, ไฟล์แนบ, manifest และ checksum', () => {
    fs.writeFileSync(path.join(ATTACH_DIR, 'lab-test.txt'), 'lab result', 'utf8');
    fs.writeFileSync(path.join(ASSET_DIR, 'logo-test.txt'), 'logo', 'utf8');
    const cloudDir = path.join(tempDir, 'cloud-sync'); setSetting('backup_cloud_dest', cloudDir);
    const usbDir = path.join(tempDir, 'usb-external'); setSetting('backup_dest_1', usbDir);
    // จำลอง virtual drive ที่อ่านไฟล์กลับไม่ได้ทันทีหลัง copy สองครั้งแรก
    const originalReadFileSync = fs.readFileSync;
    let delayedCloudReads = 2;
    fs.readFileSync = function delayedRead(file, ...args) {
      if (delayedCloudReads > 0 && String(file).startsWith(cloudDir) && String(file).includes('.partial-')) {
        delayedCloudReads--;
        throw Object.assign(new Error('simulated cloud metadata delay'), { code: 'ENOENT' });
      }
      return originalReadFileSync.call(fs, file, ...args);
    };
    let r;
    try { r = backup.runBackup(); }
    finally { fs.readFileSync = originalReadFileSync; }
    assert.equal(r.ok, 1);
    assert.equal(delayedCloudReads, 0);
    const local = r.targets.find(t => t.kind === 'local');
    assert.equal(local.ok, true);
    const manifests = fs.readdirSync(path.join(tempDir, 'backups')).filter(f => f.endsWith('.manifest.json'));
    assert.equal(manifests.length, 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, 'backups', manifests[0]), 'utf8'));
    assert.equal(manifest.database.integrity, 'ok');
    assert.equal(manifest.attachments[0].name, 'lab-test.txt');
    assert.equal(manifest.assets[0].name, 'logo-test.txt');
    // M1: backup ที่ออกนอกเครื่อง (USB/external) ต้องเข้ารหัสเสมอ ห้ามมี .db plaintext หลุดออกไป
    const external = r.targets.find(t => t.kind === 'external');
    assert.equal(external.state, 'encrypted_to_sync_folder');
    assert.ok(fs.readdirSync(usbDir).some(f => f.endsWith('.db.enc')));
    assert.equal(fs.readdirSync(usbDir).some(f => /^clinic-\d{8}-\d{6}(?:-\d{3})?\.db$/.test(f)), false);
    const cloud = r.targets.find(t => t.kind === 'cloud_sync');
    assert.equal(cloud.state, 'encrypted_to_sync_folder');
    const encryptedDb = fs.readdirSync(cloudDir).find(f => f.endsWith('.db.enc'));
    assert.ok(encryptedDb);
    assert.ok(fs.readdirSync(cloudDir).some(f => f.endsWith('.manifest.json.enc')));
    assert.equal(fs.readdirSync(cloudDir).some(f => f.includes('.partial-')), false);
    assert.equal(fs.readdirSync(path.join(tempDir, 'backups')).some(f => f.startsWith('.cloud-stage-')), false);
    // อ่านกุญแจจากไฟล์ในเครื่องโดยตรง (ไม่มี API/ฟังก์ชันสาธารณะที่คืนกุญแจเต็มออกมาแล้ว)
    const keyText = fs.readFileSync(path.join(tempDir, 'cloud-backup.key')).toString('base64');
    const plainDb = path.join(tempDir, 'backups', encryptedDb.replace(/\.enc$/, ''));
    assert.equal(backup.decryptHash(path.join(cloudDir, encryptedDb), Buffer.from(keyText, 'base64')), require('node:crypto').createHash('sha256').update(fs.readFileSync(plainDb)).digest('hex'));
    const recoveryFile = path.join(tempDir, 'recovery-key.txt');
    fs.writeFileSync(recoveryFile, `CLINIC-BACKUP-KEY-1:${keyText}`, 'utf8');
    const restoreOut = path.join(tempDir, 'restore-check');
    const restored = require('node:child_process').spawnSync(process.execPath,
      [path.join(__dirname, 'tools', 'restore-cloud-backup.js'), cloudDir, recoveryFile, restoreOut], { encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
    assert.ok(fs.existsSync(path.join(restoreOut, 'RESTORE-VERIFIED.txt')));
    assert.ok(fs.existsSync(path.join(restoreOut, 'data', 'clinic.db')));
  });

  test('ซ้อมกู้ข้อมูล (runDrill) อ่านกุญแจในเครื่องรูปแบบ raw ได้ และกู้ encrypted backup สำเร็จ', () => {
    // regression กันบั๊ก H1: local key เป็น raw 32 bytes แต่ตัวอ่านเคยคาดหวัง format ข้อความอย่างเดียว
    const recoveryService = require('./lib/recovery-service');
    setSetting('backup_dest_1', path.join(tempDir, 'drill-external'));
    // ตรึงเวลาให้สองรอบอยู่ในวินาทีเดียวกัน: ต้องได้ชื่อ -000/-001 และผ่านทั้งคู่ ไม่พึ่ง timing ของเครื่อง
    const RealDate = Date, fixedMs = RealDate.now() + 60 * 60 * 1000;
    global.Date = class FixedDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fixedMs])); }
      static now() { return fixedMs; }
    };
    try {
      assert.equal(backup.runBackup().ok, 1);
      assert.equal(backup.runBackup().ok, 1);
    } finally { global.Date = RealDate; }
    const drilled = recoveryService.runDrill();
    assert.equal(drilled.ok, true);
    assert.ok(drilled.backupCreatedAt);
  });

  test('เตือนแพ้ยา (S1): แพ้ Penicillin สั่ง Amoxicillin ถูกด่าน 409, ยืนยัน allergyAck แล้วผ่าน, จับแพ้ข้ามกลุ่ม NSAIDs', () => {
    const patients = require('./lib/patients');
    const hnAllergy = 'AL-001';
    addPatient(hnAllergy);
    patients.addAllergy(hnAllergy, 'Penicillin', 'ผื่นทั้งตัว', doctorId);
    const amoxiLines = [{ type: 'drug', ref_id: drugId, name: 'Amoxicillin 500mg', qty: 10, unit: 'เม็ด', price_each: 5 }];
    // matcher: ชนข้ามกลุ่ม (Penicillin → Amoxicillin) และไม่เตือนมั่ว (Paracetamol)
    assert.equal(patients.allergyConflicts(hnAllergy, amoxiLines).length, 1);
    assert.equal(patients.allergyConflicts(hnAllergy, [{ type: 'drug', name: 'Paracetamol 500mg' }]).length, 0);
    // finishExam ไม่มี ack → ต้องโดนกัน / มี ack → ผ่าน
    const v = visits.create(hnAllergy, frontId);
    visits.transition(v.id, 'call', doctorId);
    assert.throws(() => visits.finishExam(v.id, { note: { cc: 'ทดสอบแพ้ยา' }, lines: amoxiLines }, doctorId), /แพ้/);
    const done = visits.finishExam(v.id, { note: { cc: 'ทดสอบแพ้ยา' }, lines: amoxiLines, allergyAck: true }, doctorId);
    assert.ok(done.order.id);
    // กลุ่ม NSAIDs: บันทึกแพ้ Ibuprofen (NSAIDs) ต้องจับ Diclofenac/Aspirin ด้วย
    const hnNsaid = 'AL-002';
    addPatient(hnNsaid);
    patients.addAllergy(hnNsaid, 'Ibuprofen (NSAIDs)', 'หน้าบวม', doctorId);
    assert.equal(patients.allergyConflicts(hnNsaid, [{ type: 'drug', name: 'Diclofenac 25mg' }]).length, 1);
    assert.equal(patients.allergyConflicts(hnNsaid, [{ type: 'drug', name: 'Aspirin 81mg' }]).length, 1);
    assert.equal(patients.allergyConflicts(hnNsaid, [{ type: 'drug', name: 'Omeprazole 20mg' }]).length, 0);
  });

  test('Re-med จากประวัติ: เพิ่มยาต่อท้าย ไม่ซ้ำ ไม่ทับค่าปัจจุบัน และไม่ลากค่าบริการเก่ามา', () => {
    const current = [
      { type: 'service', ref_id: 90, name: 'ค่าตรวจ', qty: 1, price_each: 100 },
      { type: 'drug', ref_id: 11, name: 'Metformin 500mg', qty: 60, instructions: 'หลังอาหาร', _expanded: true },
    ];
    const historical = [
      { type: 'drug', ref_id: 11, name: 'Metformin 500mg', qty: 30, instructions: 'ก่อนอาหาร' },
      { type: 'drug', ref_id: 12, name: 'Amlodipine 5mg', qty: 30, instructions: 'วันละ 1 เม็ด', _expanded: true },
      { type: 'service', ref_id: 91, name: 'ค่าฉีดยา', qty: 1, price_each: 50 },
      { type: 'discount', name: 'ส่วนลด', qty: 1, price_each: -20 },
    ];
    const result = mergeRemedLines(current, historical);
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.lines.length, 3);
    assert.equal(result.lines[1].qty, 60, 'ยาเดิมต้องคงจำนวนที่หมอแก้ไว้');
    assert.equal(result.lines[1].instructions, 'หลังอาหาร', 'ยาเดิมต้องไม่ถูกทับวิธีใช้');
    assert.equal(result.lines[2].name, 'Amlodipine 5mg');
    assert.equal(result.lines[2]._expanded, undefined, 'ไม่ยกสถานะ UI เก่ามาด้วย');
    assert.equal(result.lines.some(l => l.name === 'ค่าฉีดยา'), false);
  });

  // ---- security round 1: limiter / auth_events / access_log / host allowlist ----
  test('limiter: จาก LAN ผิด 3 ครั้งเริ่มหน่วง, ผิดครบ 10 บล็อก 15 นาที, ผู้ใช้อื่นเครื่องเดียวกันไม่โดนหน่วง, สำเร็จแล้วรีเซ็ต', () => {
    const security = require('./lib/security');
    security.resetLimiter();
    const lan = '192.168.77.5';
    for (let i = 0; i < 3; i++) { assert.equal(security.precheck('login', lan, 'somebody').ok, true); security.noteFailure('login', lan, 'somebody'); }
    const gate = security.precheck('login', lan, 'somebody');
    assert.equal(gate.ok, false); assert.equal(gate.status, 429); assert.match(gate.message, /ลองใหม่ได้ในอีก/);
    assert.equal(security.precheck('login', lan, 'other-user').ok, true, 'ผู้ใช้อื่นจาก IP เดียวกันไม่โดน backoff');
    // ผิดจนครบ 10 (นับรวม 3 ครั้งแรก) → blocked ทั้ง IP; noteFailure คืน true ตอนเพิ่งบล็อก
    let blockedSignal = false;
    for (let i = 3; i < 10; i++) blockedSignal = security.noteFailure('login', lan, `user${i}`) || blockedSignal;
    assert.equal(blockedSignal, true, 'ต้องส่งสัญญาณ locked_out ตอนถึงเพดาน');
    const blocked = security.precheck('login', lan, 'yet-another');
    assert.equal(blocked.ok, false); assert.match(blocked.message, /ผิดหลายครั้งเกินไป/); assert.ok(blocked.retryAfterSec > 60);
    assert.equal(security.precheck('login', '192.168.77.6', 'yet-another').ok, true, 'เครื่องอื่นไม่โดน');
    assert.equal(security.precheck('login', '127.0.0.1', 'somebody').ok, true, 'เครื่อง host ไม่โดนจาก LAN');
    // loopback หลวมกว่า: 5 ครั้งยังไม่หน่วง
    for (let i = 0; i < 5; i++) security.noteFailure('login', '127.0.0.1', 'front');
    assert.equal(security.precheck('login', '127.0.0.1', 'front').ok, true);
    security.noteFailure('login', '127.0.0.1', 'front');
    assert.equal(security.precheck('login', '127.0.0.1', 'front').ok, false, 'ครั้งที่ 6 บน host เริ่มหน่วง');
    security.noteSuccess('login', '127.0.0.1', 'front');
    assert.equal(security.precheck('login', '127.0.0.1', 'front').ok, true, 'สำเร็จแล้วรีเซ็ต');
    security.resetLimiter();
  });

  test('auth_events / access_log บันทึกได้ ไม่เก็บรหัสที่พิมพ์ผิด และ append-only', () => {
    const security = require('./lib/security');
    security.recordAuthEvent('login_fail', { remoteAddress: '::ffff:192.168.77.9', username: 'x' });
    security.recordAuthEvent('login_ok', { remoteAddress: '127.0.0.1', username: 'front-test', userId: frontId });
    security.recordAccess('view_patient', { session: { userId: frontId, role: 'front' }, remoteAddress: '127.0.0.1', ref: '99-0001' });
    const ev = db.prepare("SELECT * FROM auth_events WHERE event = 'login_fail' ORDER BY id DESC LIMIT 1").get();
    assert.equal(ev.station, 'lan'); assert.equal(ev.remote, '192.168.77.9');
    assert.equal(Object.keys(ev).some(k => /pass|pin/i.test(k)), false, 'ไม่มีคอลัมน์รหัส/PIN');
    assert.throws(() => db.prepare('UPDATE auth_events SET event = ? WHERE id = ?').run('login_ok', ev.id), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM auth_events WHERE id = ?').run(ev.id), /append-only/);
    const al = db.prepare("SELECT * FROM access_log WHERE ref = '99-0001' ORDER BY id DESC LIMIT 1").get();
    assert.equal(al.action, 'view_patient'); assert.equal(al.station, 'host');
    assert.throws(() => db.prepare('DELETE FROM access_log WHERE id = ?').run(al.id), /append-only/);
    assert.throws(() => security.recordAuthEvent('bogus', { remoteAddress: '127.0.0.1' }), /ไม่รู้จัก/);
    const summary = security.authSummary({ hours: 1 });
    assert.ok(summary.totals.login_fail >= 1 && summary.fails.some(f => f.remote === '192.168.77.9'));
    assert.ok(security.accessSearch({ ref: '99-0001' }).length >= 1);
  });

  test('Host/Origin allowlist: รับ localhost/IP เครื่องนี้/ชื่อเครื่อง ปฏิเสธโดเมนอื่น และ Origin null', () => {
    const security = require('./lib/security');
    const os = require('node:os');
    assert.equal(security.hostAllowed('localhost:8080'), true);
    assert.equal(security.hostAllowed('127.0.0.1'), true);
    assert.equal(security.hostAllowed('[::1]:8443'), true);
    assert.equal(security.hostAllowed(`${os.hostname()}:8443`), true);
    assert.equal(security.hostAllowed('evil.example:8080'), false);
    assert.equal(security.hostAllowed(''), false);
    assert.equal(security.originAllowed(undefined), true, 'ไม่มี Origin (curl/tool) ผ่าน');
    assert.equal(security.originAllowed('http://localhost:8080'), true);
    assert.equal(security.originAllowed('https://evil.example'), false);
    assert.equal(security.originAllowed('null'), false);
  });

  // ---- Phase 1 updater: schema safety (รันใน child process เพราะ lib/db.js เปิด+migrate ตอน require) ----
  const { spawnSync } = require('node:child_process');
  const { DatabaseSync } = require('node:sqlite');
  const { SCHEMA_VERSION } = require('./lib/schema-version');
  const dbModule = path.join(__dirname, 'lib', 'db.js');
  const verifyTool = path.join(__dirname, 'tools', 'migrate-and-verify.js');
  const childEnv = dir => {
    const env = { ...process.env, CLINIC_DATA_DIR: dir };
    return env;
  };
  const openDb = dir => spawnSync(process.execPath, ['--no-warnings', '-e', `require(${JSON.stringify(dbModule)})`],
    { env: childEnv(dir), encoding: 'utf8' });
  const userVersion = dir => {
    const d = new DatabaseSync(path.join(dir, 'clinic.db'), { readOnly: true });
    try { return d.prepare('PRAGMA user_version').get().user_version; } finally { d.close(); }
  };

  test('schema-version.js อ่านได้โดยไม่เปิดฐาน และตรงกับที่ lib/db.js ใช้', () => {
    assert.equal(typeof SCHEMA_VERSION, 'number');
    assert.equal(require('./lib/db').SCHEMA_VERSION, SCHEMA_VERSION);
    assert.equal(userVersion(tempDir), SCHEMA_VERSION, 'ฐาน regression ต้อง migrate ถึงรุ่นล่าสุด');
    const src = fs.readFileSync(path.join(__dirname, 'lib', 'schema-version.js'), 'utf8');
    assert.equal(/require\(['"]\.\/db/.test(src), false, 'schema-version.js ห้าม require lib/db.js');
  });

  test('โปรแกรมปฏิเสธฐานข้อมูลที่ schema ใหม่กว่าตัวเอง (SCHEMA_TOO_NEW) โดยไม่แตะฐาน', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-newer-schema-'));
    try {
      const d = new DatabaseSync(path.join(dir, 'clinic.db'));
      d.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      d.close();
      const before = fs.statSync(path.join(dir, 'clinic.db')).size;
      const r = openDb(dir);
      assert.notEqual(r.status, 0, 'ต้องออกด้วย error');
      assert.match(r.stderr, /รุ่นใหม่กว่า/, 'ข้อความต้องเป็นภาษาคน');
      assert.match(r.stderr, /SCHEMA_TOO_NEW/);
      assert.equal(userVersion(dir), SCHEMA_VERSION + 1, 'ห้ามแก้ user_version');
      assert.equal(fs.statSync(path.join(dir, 'clinic.db')).size, before, 'ห้ามเขียนอะไรลงฐาน');
      const d2 = new DatabaseSync(path.join(dir, 'clinic.db'), { readOnly: true });
      try {
        assert.equal(d2.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c, 0, 'ห้ามสร้างตาราง');
      } finally { d2.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // ถอย schema ทีละขั้นจากรุ่นล่าสุด — เพิ่ม migration ใหม่ต้องเพิ่มขั้นตอนถอยที่นี่คู่กันเสมอ
  // (ย้อนเฉพาะ "สิ่งที่รุ่นนั้นเพิ่ม" ไม่ใช่ลบทั้งฐาน เพื่อให้ migrate ขาขึ้นเจอสภาพจริงของเครื่องเก่า)
  const DOWNGRADE_STEPS = {
    17: `ALTER TABLE drugs DROP COLUMN default_dose_json;`,
    16: `ALTER TABLE services DROP COLUMN cost;`,
    15: `ALTER TABLE appointments DROP COLUMN doctor_id; ALTER TABLE visits DROP COLUMN preferred_doctor_id;`,
    14: `DROP TABLE appointment_events;`,
    13: `DROP TABLE drug_lots; ALTER TABLE drugs DROP COLUMN expiry_warn_days;`,
    12: `DROP TABLE client_ops;`,
    11: `DROP TABLE auth_events; DROP TABLE access_log;`,
    10: `DROP TABLE document_print_events;`,
    9: `DROP TABLE med_cert_events; DROP TABLE receipt_document_snapshots;
        ALTER TABLE users DROP COLUMN display_name_en;
        ALTER TABLE receipt_lines DROP COLUMN item_code;
        ALTER TABLE med_certs DROP COLUMN template_key;
        ALTER TABLE med_certs DROP COLUMN template_version;
        ALTER TABLE med_certs DROP COLUMN language;`,
  };
  function downgradeTo(dir, target) {
    const d = new DatabaseSync(path.join(dir, 'clinic.db'));
    try {
      for (let v = SCHEMA_VERSION; v > target; v--) {
        assert.ok(DOWNGRADE_STEPS[v], `ไม่มีขั้นตอนถอยของ schema v${v} — เพิ่ม migration แล้วต้องเพิ่มที่นี่ด้วย`);
        d.exec(DOWNGRADE_STEPS[v]);
      }
      d.exec(`PRAGMA user_version = ${target}`);
    } finally { d.close(); }
    assert.equal(userVersion(dir), target);
  }

  for (const from of [16, 15, 14, 13, 9, 8]) {
    test(`migration สังเคราะห์ ${from}→${SCHEMA_VERSION} ผ่าน, ซ้ำแล้ว idempotent, และ migrate-and-verify ตรวจ/ปฏิเสธถูก`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clinic-migrate-${from}to${SCHEMA_VERSION}-`));
      try {
        // 1) สร้างฐานรุ่นล่าสุดด้วยโค้ดจริง แล้วถอย schema กลับไปที่รุ่นเก่า
        assert.equal(openDb(dir).status, 0);
        downgradeTo(dir, from);
        // 2) เปิดด้วยโปรแกรม → migrate ขึ้นรุ่นล่าสุด
        const up = openDb(dir);
        assert.equal(up.status, 0, up.stderr);
        assert.equal(userVersion(dir), SCHEMA_VERSION);
        // 3) เปิดซ้ำ → idempotent
        assert.equal(openDb(dir).status, 0);
        assert.equal(userVersion(dir), SCHEMA_VERSION);
        // 4) migrate-and-verify --rehearsal --expect (จำนวนก่อน = 0 ทุกตาราง) → ผ่าน
        const expectFile = path.join(dir, 'expect.json');
        fs.writeFileSync(expectFile, JSON.stringify({ user_version: from, patients: 0, visits: 0, receipts: 0, med_certs: 0 }));
        const ok = spawnSync(process.execPath, ['--no-warnings', verifyTool, '--rehearsal', '--expect', expectFile],
          { env: childEnv(dir), encoding: 'utf8' });
        assert.equal(ok.status, 0, ok.stderr);
        const report = JSON.parse(ok.stdout.trim().split('\n').pop());
        assert.equal(report.user_version, SCHEMA_VERSION);
        assert.equal(report.markers_ok, true);
        assert.equal(report.rehearsal, true);
        // 5) expect ที่ receipts ไม่ตรง (append-only ต้องเท่ากัน) → ไม่ผ่าน
        fs.writeFileSync(expectFile, JSON.stringify({ receipts: 5 }));
        const bad = spawnSync(process.execPath, ['--no-warnings', verifyTool, '--rehearsal', '--expect', expectFile],
          { env: childEnv(dir), encoding: 'utf8' });
        assert.notEqual(bad.status, 0);
        assert.match(bad.stderr, /receipts: ก่อน 5 หลัง 0/);
        // 6) --rehearsal โดยไม่ตั้ง CLINIC_DATA_DIR → ปฏิเสธก่อนแตะอะไร (กันซ้อมกับฐานจริง)
        const env = { ...process.env }; delete env.CLINIC_DATA_DIR;
        const refused = spawnSync(process.execPath, ['--no-warnings', verifyTool, '--rehearsal'], { env, encoding: 'utf8' });
        assert.equal(refused.status, 2);
        assert.match(refused.stderr, /ห้ามชี้ไปที่ app\/data/);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }

  // ชุดทดลอง "เปิดวันใหม่ให้เอง" (lib/demo-day.js) — ปัญหาจริง 2026-08-17: ข้ามวันแล้วคิวว่าง + 7 visit ค้าง
  // ทดสอบบนฐานแยก (child process + CLINIC_DATA_DIR ใหม่) ที่ seed ชุดทดลองจริง (seed --demo + seed-mock-clinic → คนไข้ mock ชุดจริง
  // ชื่อต้องตรงกับ TODAY_QUEUE) แล้วเลื่อน visit วันนี้ไปเป็น "เมื่อวาน" จำลองการข้ามวัน
  test('ชุดทดลองข้ามวัน: ปิดคิวค้าง + สร้างคิววันนี้ 7 ราย เฉพาะ demo_mode และไม่ยัดทับเมื่อมีคิววันนี้แล้ว', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-demo-day-'));
    try {
      const run = (args, extraEnv = {}) => spawnSync(process.execPath, ['--no-warnings', ...args],
        { cwd: __dirname, env: { ...childEnv(dir), ...extraEnv }, encoding: 'utf8', timeout: 120000 });
      const seeded = run(['seed.js', '--demo']);
      assert.equal(seeded.status, 0, seeded.stderr);
      const mocked = run(['seed-mock-clinic.js']);
      assert.equal(mocked.status, 0, mocked.stderr);
      const script = path.join(dir, 'demo-day-probe.js');
      fs.writeFileSync(script, `
        const { db, setSetting, today } = require(${JSON.stringify(dbModule)});
        const dd = require(${JSON.stringify(path.join(__dirname, 'lib', 'demo-day.js'))});
        const byState = () => Object.fromEntries(db.prepare('SELECT state, COUNT(*) c FROM visits WHERE visit_date = ? GROUP BY state').all(today()).map(r => [r.state, r.c]));
        const out = {};
        // จำลองข้ามวัน: visit ของ "วันนี้" ทั้งหมดกลายเป็นของเมื่อวาน (คิวค้าง 7 = WAITING4/IN_EXAM1/DISPENSING2 ของ seed-mock-day)
        db.prepare("UPDATE visits SET visit_date = date(visit_date, '-1 day') WHERE visit_date = ?").run(today());
        out.staleBefore = db.prepare("SELECT COUNT(*) c FROM visits WHERE visit_date < ? AND state IN ('WAITING','IN_EXAM','DISPENSING')").get(today()).c;
        out.receiptsBefore = db.prepare('SELECT COUNT(*) c FROM receipts').get().c;
        setSetting('demo_mode', '0');
        out.notDemo = dd.rolloverDemoDay();
        out.staleAfterNotDemo = db.prepare("SELECT COUNT(*) c FROM visits WHERE visit_date < ? AND state IN ('WAITING','IN_EXAM','DISPENSING')").get(today()).c;
        setSetting('demo_mode', '1');
        out.first = dd.rolloverDemoDay();
        out.todayByState = byState();
        out.staleAfter = db.prepare("SELECT COUNT(*) c FROM visits WHERE visit_date < ? AND state IN ('WAITING','IN_EXAM','DISPENSING')").get(today()).c;
        out.cancelledWithReason = db.prepare('SELECT COUNT(*) c FROM visits WHERE cancel_reason = ?').get(dd.CANCEL_REASON).c;
        out.dispensingWithNoteAndOrder = db.prepare(\`SELECT COUNT(*) c FROM visits v WHERE v.visit_date = ? AND v.state = 'DISPENSING'
          AND EXISTS (SELECT 1 FROM note_versions n WHERE n.visit_id = v.id) AND EXISTS (SELECT 1 FROM order_versions o WHERE o.visit_id = v.id)\`).get(today()).c;
        out.waitingWithCcDraft = db.prepare(\`SELECT COUNT(*) c FROM visits v JOIN note_drafts d ON d.visit_id = v.id WHERE v.visit_date = ? AND v.state = 'WAITING'\`).get(today()).c;
        out.receiptsAfter = db.prepare('SELECT COUNT(*) c FROM receipts').get().c;
        out.second = dd.rolloverDemoDay();
        out.todayCountAfterSecond = db.prepare('SELECT COUNT(*) c FROM visits WHERE visit_date = ?').get(today()).c;
        console.log(JSON.stringify(out));
      `);
      const probe = run([script]);
      assert.equal(probe.status, 0, probe.stderr);
      const out = JSON.parse(probe.stdout.trim().split('\n').pop());
      assert.equal(out.staleBefore, 7, 'ก่อนเริ่มต้องมีคิวค้าง 7 (จาก seed-mock-day)');
      assert.equal(out.notDemo.skipped, 'not_demo');
      assert.equal(out.staleAfterNotDemo, 7, 'ชุดจริง (demo_mode=0) ห้ามแตะอะไร');
      assert.equal(out.first.cancelled, 7);
      assert.equal(out.first.created, 7);
      assert.deepEqual(out.todayByState, { WAITING: 4, IN_EXAM: 1, DISPENSING: 2 });
      assert.equal(out.staleAfter, 0);
      assert.equal(out.cancelledWithReason, 7);
      assert.equal(out.dispensingWithNoteAndOrder, 2, 'รอเก็บเงินต้องมี note+order จริงให้ทดลองคิดเงิน');
      assert.equal(out.waitingWithCcDraft, 4, 'รอตรวจต้องมี CC ให้หมอเห็น');
      assert.equal(out.receiptsAfter, out.receiptsBefore, 'ไม่สร้างบิลเพิ่ม — รายงานวันใหม่เริ่มศูนย์');
      assert.equal(out.second.skipped, 'has_visits_today', 'มีคิววันนี้แล้วต้องไม่ยัดซ้ำ');
      assert.equal(out.todayCountAfterSecond, 7);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // ---- session persistence (2026-08-24 เจ้าของเคาะ "ต้องไม่หลุด"): restart ธรรมดา session ต้องรอด · หมดอายุ 20 ชม. ----
  test('session รอดข้าม process (จำลอง server restart) · cookie ปลอมไม่ผ่าน · หมดอายุ 20 ชม.', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-session-'));
    try {
      const authModule = path.join(__dirname, 'lib', 'auth.js');
      const create = spawnSync(process.execPath, ['--no-warnings', '-e',
        `const a=require(${JSON.stringify(authModule)});a.createUser({username:'synthetic',displayName:'หมอทดสอบ',role:'doctor',password:'Synthetic-test-123'});process.stdout.write(a.createSession(a.login('synthetic','Synthetic-test-123'),'127.0.0.1'));`],
      { env: childEnv(dir), encoding: 'utf8' });
      assert.equal(create.status, 0, create.stderr);
      const cookie = create.stdout.trim();
      assert(cookie.includes('.'), 'ต้องได้ cookie sid.sig');
      const readScript = `const a=require(${JSON.stringify(authModule)});const s=a.getSession(process.env.TEST_COOKIE);process.stdout.write(JSON.stringify(s?{userId:s.userId,role:s.role,locked:s.locked}:null));`;
      const read = spawnSync(process.execPath, ['--no-warnings', '-e', readScript],
        { env: { ...childEnv(dir), TEST_COOKIE: cookie }, encoding: 'utf8' });
      assert.equal(read.status, 0, read.stderr);
      assert.deepEqual(JSON.parse(read.stdout), { userId: 1, role: 'doctor', locked: false },
        'process ใหม่ (= server restart) ต้องเห็น session เดิม — หมอไม่หลุด');
      const forged = spawnSync(process.execPath, ['--no-warnings', '-e', readScript],
        { env: { ...childEnv(dir), TEST_COOKIE: cookie.split('.')[0] + '.deadbeef' }, encoding: 'utf8' });
      assert.equal(JSON.parse(forged.stdout), null, 'ลายเซ็น cookie ผิดต้องไม่ผ่านแม้ sid อยู่ในไฟล์');
      const file = path.join(dir, 'sessions.json');
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const s of Object.values(stored.sessions)) s.createdAt -= 25 * 3600 * 1000;
      fs.writeFileSync(file, JSON.stringify(stored));
      const expired = spawnSync(process.execPath, ['--no-warnings', '-e', readScript],
        { env: { ...childEnv(dir), TEST_COOKIE: cookie }, encoding: 'utf8' });
      assert.equal(JSON.parse(expired.stdout), null, 'session อายุเกิน 20 ชม. ต้องหมดอายุแม้ไฟล์ยังอยู่ (sid ไม่อมตะ)');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // ---- exactly-once ทน server ตายจริง (codex NO-GO 2026-08-24) ----
  // จังหวะ: (ก) ตายก่อน COMMIT → ต้องไม่มีอะไรเกิด, retry สร้างครั้งเดียว (ข) ตายหลัง commit ก่อนคำตอบถึง browser
  // (เคสที่ทำ HN เบิ้ลหน้างาน) → retry ได้ HN เดิม ไม่เบิ้ล · cookie เดิมใช้ได้ข้ามทุก restart (session persistence จริง)
  // "ระหว่าง patient กับ visit" หายไปโดยโครงสร้าง — สองอย่างอยู่ใน txn เดียว (ก) พิสูจน์ว่า atomic
  test('exactly-once ทน server ตายจริง (ลงทะเบียน/เก็บเงิน/ใบรับรอง/รับยาเข้า): ก่อน commit / หลัง commit ก่อนตอบ + cookie รอดข้าม restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-crash-'));
    const driver = path.join(dir, 'driver.js');
    fs.writeFileSync(driver, `'use strict';
const { spawn, spawnSync } = require('node:child_process');
const APP = ${JSON.stringify(__dirname)};
const port = Number(process.env.CRASH_PORT), token = process.env.CLINIC_TEST_INSTANCE_TOKEN;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ready = async () => { try { return (await fetch('http://127.0.0.1:' + port + '/api/recovery/ready')).status === 200; } catch { return false; } };
const waitFor = async (cond, ms) => { for (let t = Date.now(); Date.now() - t < ms;) { if (await cond()) return true; await sleep(200); } throw new Error('timeout'); };
let server = null;
const start = () => { server = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: APP, env: process.env, stdio: 'ignore', windowsHide: true }); };
(async () => {
  const out = {};
  spawnSync(process.execPath, ['--no-warnings', 'seed.js', '--demo'], { cwd: APP, env: process.env });
  start(); await waitFor(ready, 15000);
  const loginRes = await fetch('http://127.0.0.1:' + port + '/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'front', password: 'front123' }) });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const post = async (body, crash) => {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/api/patients', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie,
          ...(crash ? { 'X-Clinic-Test-Token': token, 'X-Clinic-Test-Crash': crash } : {}) },
        body: JSON.stringify(body) });
      return { status: res.status, data: JSON.parse(await res.text()) };
    } catch { return { status: 0, data: null }; } // connection ขาด = สิ่งที่ browser เจอ
  };
  const search = async q => {
    const res = await fetch('http://127.0.0.1:' + port + '/api/patients/search?q=' + encodeURIComponent(q), { headers: { Cookie: cookie } });
    return { status: res.status, data: await res.json() };
  };
  const visitsOf = async hn => {
    const res = await fetch('http://127.0.0.1:' + port + '/api/queue', { headers: { Cookie: cookie } });
    const rows = await res.json();
    return (rows.queue || []).filter(v => v.hn === hn).length;
  };
  // (ก) ตายก่อน COMMIT
  const bodyA = { first_name: 'เคสก่อนคอมมิต', sex: 'M', op_id: 'aaaaaaaa-1111-2222-3333-444444444444', queue: true, cc: 'ก' };
  out.crashA = (await post(bodyA, 'before-commit')).status; // 0 = connection ขาด
  await waitFor(async () => !(await ready()), 5000); start(); await waitFor(ready, 15000);
  out.afterCrashA = (await search('เคสก่อนคอมมิต')).data.length; // ต้อง 0 — WAL ทิ้ง txn ที่ไม่ commit
  const retryA = await post(bodyA);
  out.retryAStatus = retryA.status; out.retryAHn = retryA.data && retryA.data.hn;
  out.afterRetryA = (await search('เคสก่อนคอมมิต')).data.length; // ต้อง 1
  out.visitsA = await visitsOf(out.retryAHn);
  // (ข) ตายหลัง commit ก่อนตอบ — เคสหน้างานตัวจริง
  const bodyB = { first_name: 'เคสหลังคอมมิต', sex: 'F', op_id: 'bbbbbbbb-1111-2222-3333-444444444444', queue: true, cc: 'ข' };
  out.crashB = (await post(bodyB, 'after-commit')).status;
  await waitFor(async () => !(await ready()), 5000); start(); await waitFor(ready, 15000);
  const afterB = await search('เคสหลังคอมมิต');
  out.afterCrashB = afterB.data.length; // ต้อง 1 — commit ไปแล้วก่อนตาย
  const retryB = await post(bodyB); // ผู้ใช้กดซ้ำเพราะไม่เห็นคำตอบ
  out.retryBStatus = retryB.status;
  out.retryBSameHn = retryB.data && retryB.data.hn === afterB.data[0].hn;
  out.afterRetryB = (await search('เคสหลังคอมมิต')).data.length; // ต้อง 1 — ไม่เบิ้ล
  out.visitsB = await visitsOf(afterB.data[0].hn); // ต้อง 1 — คิวไม่เบิ้ล
  // codex NO-GO รอบ 2: คนจริงไม่ได้กดซ้ำด้วยข้อมูลเดิมเป๊ะ — แก้ช่อง / สลับปุ่ม ก็ต้องไม่เกิด HN ใหม่
  const edited = await post({ ...bodyB, first_name: 'เคสหลังคอมมิตแก้ชื่อ' });
  out.editedStatus = edited.status; // ต้อง 409
  out.editedRecovery = !!(edited.data && edited.data.already_registered && edited.data.already_registered.hn === afterB.data[0].hn);
  const switched = await post({ first_name: bodyB.first_name, sex: bodyB.sex, op_id: bodyB.op_id }); // สลับเป็น "บันทึกอย่างเดียว"
  out.switchedStatus = switched.status; // ต้อง 409
  out.switchedRecovery = !!(switched.data && switched.data.already_registered && switched.data.already_registered.hn === afterB.data[0].hn);
  out.afterVariants = (await search('เคสหลังคอมมิต')).data.length; // ต้องยัง 1 — ไม่มีท่าไหนสร้างคนใหม่
  // ---- flow อื่นตามกติกา resilience ข้อ 1 (1.0.4 — failure-injection 2026-08-25): pay / medcert / receive ----
  // เคสก่อน COMMIT พิสูจน์แล้วที่ (ก) — ทุก flow วิ่งผ่าน exactlyOnce ตัวเดียวกัน txn เดียวกัน
  const req = async (cookie2, method, p, body, crash) => {
    try {
      const res = await fetch('http://127.0.0.1:' + port + p, { method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie2,
          ...(crash ? { 'X-Clinic-Test-Token': token, 'X-Clinic-Test-Crash': crash } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: JSON.parse(await res.text()) };
    } catch { return { status: 0, data: null }; }
  };
  const dLoginRes = await fetch('http://127.0.0.1:' + port + '/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'doctor', password: 'doctor123' }) });
  const dCookie = (dLoginRes.headers.get('set-cookie') || '').split(';')[0];
  const vidC = retryB.data.visit_id; // คิวของเคสหลังคอมมิต — หมอตรวจจบแล้วหน้าร้านเก็บเงิน
  await req(dCookie, 'POST', '/api/visits/' + vidC + '/call', {});
  const para = (await req(dCookie, 'GET', '/api/items/search?q=Para')).data.find(i => i.type === 'drug');
  const fin = await req(dCookie, 'POST', '/api/visits/' + vidC + '/finish-exam',
    { note: { dx_text: 'crash test' }, lines: [{ type: 'drug', ref_id: para.id, qty: 4 }], base_version_id: null });
  const qtyOf = async () => (await req(cookie, 'GET', '/api/drugs')).data.find(d => d.id === para.id).qty_on_hand;
  // (1) เก็บเงิน: ตายหลัง commit → retry (op เดิม) ต้องได้ใบเสร็จเดิม สต็อกตัดครั้งเดียว
  const q0 = await qtyOf();
  const payBody = { order_version_id: fin.data.order.id, pay_method: 'cash', op_id: 'cccccccc-1111-2222-3333-444444444444' };
  out.payCrash = (await req(cookie, 'POST', '/api/visits/' + vidC + '/pay', payBody, 'after-commit')).status;
  await waitFor(async () => !(await ready()), 5000); start(); await waitFor(ready, 15000);
  const payRetry = await req(cookie, 'POST', '/api/visits/' + vidC + '/pay', payBody);
  out.payRetryStatus = payRetry.status;
  const vC = (await req(cookie, 'GET', '/api/visits/' + vidC)).data;
  out.payIssued = vC.receipts.filter(r => r.status === 'ISSUED').length;
  out.payRetrySame = !!(payRetry.data && payRetry.data.receiptNo === vC.receipts[0].receipt_no);
  out.payCut = q0 - await qtyOf();
  // จ่ายซ้ำแบบไม่มี op_id (client เก่า/ทางตรง) ต้องได้ภาษาคน + ชี้เลขใบเสร็จ ไม่ใช่ UNIQUE constraint ดิบ
  const payNoOp = await req(cookie, 'POST', '/api/visits/' + vidC + '/pay', { order_version_id: fin.data.order.id, pay_method: 'cash' });
  out.payNoOpStatus = payNoOp.status;
  out.payNoOpFriendly = !!(payNoOp.data && payNoOp.data.error && !/UNIQUE|constraint/i.test(payNoOp.data.error)
    && payNoOp.data.error.includes(vC.receipts[0].receipt_no));
  // (2) ใบรับรองแพทย์: ตายหลัง commit → retry ได้ใบเดิม · แก้ฟอร์มก่อนกดซ้ำ → 409 ชี้ใบเดิม ไม่ออกใหม่
  const mcBody = { diagnosis_text: 'crash', rest_days: '1', op_id: 'dddddddd-1111-2222-3333-444444444444' };
  out.mcCrash = (await req(dCookie, 'POST', '/api/visits/' + vidC + '/medcert', mcBody, 'after-commit')).status;
  await waitFor(async () => !(await ready()), 5000); start(); await waitFor(ready, 15000);
  const mcRetry = await req(dCookie, 'POST', '/api/visits/' + vidC + '/medcert', mcBody);
  out.mcRetryStatus = mcRetry.status;
  const certs = (await req(cookie, 'GET', '/api/visits/' + vidC)).data.med_certs;
  out.mcCount = certs.length;
  out.mcSame = !!(mcRetry.data && mcRetry.data.cert_no === certs[0].cert_no);
  const mcEdited = await req(dCookie, 'POST', '/api/visits/' + vidC + '/medcert', { ...mcBody, rest_days: '2' });
  out.mcEditedStatus = mcEdited.status;
  out.mcEditedRecovery = !!(mcEdited.data && mcEdited.data.already_issued && mcEdited.data.already_issued.cert_no === certs[0].cert_no);
  out.mcCountAfter = (await req(cookie, 'GET', '/api/visits/' + vidC)).data.med_certs.length;
  // (3) รับยาเข้า: ตายหลัง commit → retry ไม่รับเบิ้ล (move+cost+expiry อยู่ txn เดียว) · op ใหม่ = ตั้งใจรับเพิ่ม ต้องได้จริง
  const q1 = await qtyOf();
  const rcBody = { qty: 7, cost: 9.5, expiry_date: '2027-06-30', expiry_warn_days: 60, reason: 'crash receive', op_id: 'eeeeeeee-1111-2222-3333-444444444444' };
  out.rcCrash = (await req(cookie, 'POST', '/api/drugs/' + para.id + '/receive', rcBody, 'after-commit')).status;
  await waitFor(async () => !(await ready()), 5000); start(); await waitFor(ready, 15000);
  out.rcRetryStatus = (await req(cookie, 'POST', '/api/drugs/' + para.id + '/receive', rcBody)).status;
  out.rcGained = (await qtyOf()) - q1;
  const rcDrug = (await req(cookie, 'GET', '/api/drugs')).data.find(d => d.id === para.id);
  out.rcCost = rcDrug.cost;
  out.rcExpiry = rcDrug.expiry_date; // v13: lot ต้องมากับ commit เดียวกับยอด (derive จาก drug_lots)
  out.rcWarn = rcDrug.expiry_warn_days;
  out.rcLots = (await req(cookie, 'GET', '/api/drugs/' + para.id + '/lots')).data.length; // retry เดิมห้ามได้ lot เบิ้ล
  out.rcNewStatus = (await req(cookie, 'POST', '/api/drugs/' + para.id + '/receive',
    { ...rcBody, expiry_date: '2027-09-30', op_id: 'ffffffff-1111-2222-3333-444444444444' })).status;
  out.rcGainedTotal = (await qtyOf()) - q1;
  out.rcLotsAfterNew = (await req(cookie, 'GET', '/api/drugs/' + para.id + '/lots')).data.length;
  out.rcExpiryNew = (await req(cookie, 'GET', '/api/drugs')).data.find(d => d.id === para.id).expiry_date;
  out.searchAuth = (await search('x')).status; // 200 = cookie เดิมรอดข้าม restart ทั้งหมด
  try { server.kill(); } catch {}
  console.log(JSON.stringify(out));
})().catch(e => { console.error(e.message); process.exit(1); });
`);
    try {
      const port = 18000 + Math.floor(Math.random() * 20000);
      const result = spawnSync(process.execPath, ['--no-warnings', driver], {
        cwd: __dirname, encoding: 'utf8', timeout: 180000, // 5 จังหวะ kill+restart จริง
        env: { ...childEnv(dir), CRASH_PORT: String(port), CLINIC_PORT: String(port),
          CLINIC_TEST_INSTANCE_TOKEN: 'crash-harness-token', CLINIC_IDLE_LOCK_MS: '600000' },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const out = JSON.parse(result.stdout.trim().split('\n').pop());
      assert.equal(out.crashA, 0, 'ตายก่อน commit: browser ต้องเห็น connection ขาด');
      assert.equal(out.afterCrashA, 0, 'ตายก่อน commit: ต้องไม่มีคนไข้เกิดขึ้นเลย (atomic ทั้ง patient+visit)');
      assert.equal(out.retryAStatus, 201, 'retry แล้วต้องสำเร็จ');
      assert.equal(out.afterRetryA, 1, 'retry แล้วคนไข้มีคนเดียว');
      assert.equal(out.visitsA, 1, 'retry แล้วคิวมีใบเดียว');
      assert.equal(out.crashB, 0, 'ตายหลัง commit: browser เห็น connection ขาดทั้งที่บันทึกแล้ว');
      assert.equal(out.afterCrashB, 1, 'ตายหลัง commit: คนไข้ถูกบันทึกไปแล้วจริง');
      assert.equal(out.retryBStatus, 201, 'ผู้ใช้กดซ้ำต้องได้คำตอบดี');
      assert.equal(out.retryBSameHn, true, 'กดซ้ำได้ HN เดิม ไม่ใช่คนใหม่');
      assert.equal(out.afterRetryB, 1, 'กดซ้ำแล้วคนไข้ยังมีคนเดียว — ไม่มี HN เบิ้ล');
      assert.equal(out.visitsB, 1, 'กดซ้ำแล้วคิวยังใบเดียว');
      assert.equal(out.editedStatus, 409, 'แก้ช่องแล้วกดซ้ำ → 409 ไม่สร้างใหม่');
      assert.equal(out.editedRecovery, true, '409 ต้องคืน HN เดิมให้ UI พาไปหาคนไข้ที่บันทึกแล้ว');
      assert.equal(out.switchedStatus, 409, 'สลับปุ่มแล้วกดซ้ำ → 409 ไม่สร้างใหม่');
      assert.equal(out.switchedRecovery, true, 'สลับปุ่มก็ได้ HN เดิมกลับมาเหมือนกัน');
      assert.equal(out.afterVariants, 1, 'ผ่านทุกท่ากดซ้ำ คนไข้ยังมีคนเดียว');
      // flow อื่นตามกติกา resilience ข้อ 1 (1.0.4)
      assert.equal(out.payCrash, 0, 'เก็บเงิน: ตายหลัง commit browser เห็น connection ขาด');
      assert.equal(out.payRetryStatus, 201, 'เก็บเงิน: กดซ้ำต้องได้คำตอบดี');
      assert.equal(out.payRetrySame, true, 'เก็บเงิน: กดซ้ำได้ใบเสร็จเดิม ไม่ออกใบใหม่');
      assert.equal(out.payIssued, 1, 'เก็บเงิน: ใบเสร็จ ISSUED มีใบเดียว');
      assert.equal(out.payCut, 4, 'เก็บเงิน: สต็อกตัดครั้งเดียวตามจำนวนจริง');
      assert.equal(out.payNoOpStatus, 409, 'จ่ายซ้ำไม่มี op_id → 409');
      assert.equal(out.payNoOpFriendly, true, 'จ่ายซ้ำต้องได้ภาษาคน + เลขใบเสร็จ ไม่ใช่ UNIQUE constraint ดิบ');
      assert.equal(out.mcCrash, 0, 'ใบรับรอง: ตายหลัง commit browser เห็น connection ขาด');
      assert.equal(out.mcRetryStatus, 201, 'ใบรับรอง: กดซ้ำต้องได้คำตอบดี');
      assert.equal(out.mcCount, 1, 'ใบรับรอง: มีใบเดียว ไม่เบิ้ล');
      assert.equal(out.mcSame, true, 'ใบรับรอง: กดซ้ำได้เลขใบเดิม');
      assert.equal(out.mcEditedStatus, 409, 'ใบรับรอง: แก้ฟอร์มแล้วกดซ้ำ → 409 ไม่ออกใหม่');
      assert.equal(out.mcEditedRecovery, true, 'ใบรับรอง: 409 ต้องชี้ใบเดิมให้ UI พาไปดู');
      assert.equal(out.mcCountAfter, 1, 'ใบรับรอง: ผ่านทุกท่ายังมีใบเดียว');
      assert.equal(out.rcCrash, 0, 'รับยาเข้า: ตายหลัง commit browser เห็น connection ขาด');
      assert.equal(out.rcRetryStatus, 200, 'รับยาเข้า: กดซ้ำต้องได้คำตอบดี');
      assert.equal(out.rcGained, 7, 'รับยาเข้า: กดซ้ำแล้วยอดเพิ่มครั้งเดียว ไม่เบิ้ล');
      assert.equal(out.rcCost, 9.5, 'รับยาเข้า: ทุนถูกบันทึกใน txn เดียวกับยอด (ตายหลัง commit ทุนต้องมาแล้ว)');
      assert.equal(out.rcExpiry, '2027-06-30', 'รับยาเข้า: lot (v13) มากับ commit เดียวกับยอด — ไม่มีสถานะครึ่งๆ');
      assert.equal(out.rcWarn, 60, 'รับยาเข้า: เกณฑ์เตือนรายยา (v13) มากับ commit เดียวกัน');
      assert.equal(out.rcLots, 1, 'รับยาเข้า: retry op เดิมต้องไม่สร้าง lot เบิ้ล (lot อยู่ใน txn ของ exactlyOnce)');
      assert.equal(out.rcNewStatus, 200, 'รับยาเข้า: เปิดกล่องใหม่ (op ใหม่) รับเพิ่มได้จริง');
      assert.equal(out.rcGainedTotal, 14, 'รับยาเข้า: op ใหม่รับเพิ่มอีกรอบ ยอดรวมถูก');
      assert.equal(out.rcLotsAfterNew, 2, 'รับยาเข้า: op ใหม่ = lot ใหม่อีกแถว (เก็บแยกทุก lot)');
      assert.equal(out.rcExpiryNew, '2027-06-30', 'รับยาเข้า: ตัวเตือนยังเป็น lot ที่ใกล้หมดสุด ไม่ถูก lot ใหม่เขียนทับ');
      assert.equal(out.searchAuth, 200, 'cookie เดิมใช้ได้ข้ามทุก restart (session persistence กับ server จริง)');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  console.log(`\n${passed} regression tests ผ่านทั้งหมด (DB ชั่วคราว: ${tempDir})`);
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
