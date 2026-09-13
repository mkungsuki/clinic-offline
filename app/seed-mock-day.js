'use strict';
// จำลอง "คลินิกวันที่คนแน่นทั้งวัน" สำหรับทดลองใช้งานจริง (UAT) — Doctor friendly first
//   - บิลช่วงเช้าจ่ายแล้ว 13 ใบ (เงินสด/โอน/เงินทอน/ส่วนลด/หัตถการ/เย็บแผล) + ตัด stock จริง
//   - คิวตอนนี้: รอตรวจ 4 (มีไข้สูง/ความดันสูงให้ chip แดงทำงาน, 1 คนยังไม่วัด vitals)
//     กำลังตรวจ 1, รอจ่ายยา-รอเก็บเงิน 2 (1 รายมีส่วนลดจากหมอ), ยกเลิก 1 (รอนานกลับก่อน)
//   - เรื้อรัง 3 คนมีประวัติย้อนหลังหลายเดือน (กราฟ BP/น้ำตาล/น้ำหนักทำงาน) + แพ้ยา + นัดวันนี้/สัปดาห์หน้า
//   - ยาใกล้หมด 1 ตัว (Salbutamol) ให้ป้ายเตือน stock ทำงาน
//
// ⛔ กันพลาด: รันได้เฉพาะเมื่อ set CLINIC_DATA_DIR (sandbox) เท่านั้น — ห้ามรันใส่ข้อมูลจริง
// วิธีใช้: ดับเบิลคลิก "เปิดระบบทดลอง.cmd" ที่ root โปรเจกต์ (จัดการให้ครบเองทุกขั้น)
if (!process.env.CLINIC_DATA_DIR) {
  console.error('⛔ seed-mock-day ต้องรันผ่าน "เปิดระบบทดลอง.cmd" หรือ set CLINIC_DATA_DIR ชี้ sandbox เท่านั้น');
  console.error('   (กันการเผลอรันใส่ฐานข้อมูลจริงที่ app/data)');
  process.exit(1);
}
const { db, txn, setSetting, nextReceiptNo, nextCounter } = require('./lib/db');
const patients = require('./lib/patients');
const stock = require('./lib/stock');

const doctor = db.prepare("SELECT id, display_name FROM users WHERE role = 'doctor' AND active = 1 LIMIT 1").get();
const front = db.prepare("SELECT id, display_name FROM users WHERE role = 'front' AND active = 1 LIMIT 1").get();
if (!doctor || !front) { console.error('ไม่มี user demo — รัน: node seed.js --demo ก่อน'); process.exit(1); }
if (db.prepare('SELECT COUNT(*) c FROM patients').get().c > 0) {
  console.log('มีคนไข้อยู่แล้ว — seed-mock-day ใช้กับฐานข้อมูลเปล่าเท่านั้น (ลบโฟลเดอร์ sandbox แล้วเริ่มใหม่)');
  process.exit(0);
}
const DOC = doctor.id, FRONT = front.id;

// ---------- เวลา ----------
const pad = n => String(n).padStart(2, '0');
const NOW = new Date();
const TODAY = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;
// เปิดคลินิก 08:30 — แต่ห้ามสร้างบันทึกที่ "อยู่ในอนาคต": ถ้า seed ตอนเช้าก่อนเวลานั้น (หรือกลางดึก) clock guard ของ server
// จะเห็นว่าข้อมูลล่าสุดใหม่กว่านาฬิกาแล้วบล็อกการเขียนทั้งระบบ (เจอจริงตอนรัน test 02:00 น.) → บีบเวลาที่ยังไม่ถึงให้อยู่
// ในไม่กี่นาทีที่ผ่านมาโดยคงลำดับก่อน-หลังไว้
const MAX_OPEN_MINUTES = 240;
function at(minutesFromOpen) {
  let d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 8, 30 + minutesFromOpen, 0);
  if (d.getTime() >= NOW.getTime() - 60000) d = new Date(NOW.getTime() - (MAX_OPEN_MINUTES - minutesFromOpen + 2) * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function agoMinutes(m) {
  const d = new Date(NOW.getTime() - m * 60000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function monthsAgo(n, day) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth() - n, day);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- ตั้งค่าคลินิกให้เอกสาร/ใบเสร็จดูจริง ----------
setSetting('clinic_name', 'สุขใจคลินิกเวชกรรม (ระบบทดลอง)');
setSetting('clinic_address', '123/45 ถ.สุขสบาย ต.ในเมือง อ.เมือง จ.อุบลราชธานี 34000');
setSetting('clinic_phone', '045-123-456');
setSetting('clinic_license', '10101000164');
setSetting('clinic_name_en', 'Sukjai Medical Clinic (UAT)');
setSetting('clinic_address_en', '123/45 Suksabai Rd., Nai Mueang, Mueang, Ubon Ratchathani 34000');
setSetting('setup_required', '0');
// แพทย์ demo ต้องมีเลขใบประกอบ เพื่อทดลองออกใบรับรองแพทย์ได้ทุกแบบ
db.prepare(`UPDATE users SET medical_license = 'ว.54321', specialty = 'เวชปฏิบัติทั่วไป',
  display_name_en = 'Todsob Rabobdee, M.D.' WHERE id = ?`).run(DOC);

// ---------- ยาเพิ่มเติมให้คลังดูจริง (มีทุน + รับเข้า) ----------
const EXTRA_DRUGS = [
  // [name, unit, price, cost, receive, reorder, instructions]
  ['Metformin 500mg', 'เม็ด', 2, 0.6, 1000, 100, 'ครั้งละ 1 เม็ด วันละ 2 ครั้ง หลังอาหารเช้า-เย็น'],
  ['Losartan 50mg', 'เม็ด', 3.5, 1.2, 500, 60, 'ครั้งละ 1 เม็ด วันละ 1 ครั้ง เช้า'],
  ['Simvastatin 20mg', 'เม็ด', 3, 1.0, 400, 60, 'ครั้งละ 1 เม็ด วันละ 1 ครั้ง ก่อนนอน'],
  ['Norfloxacin 400mg', 'เม็ด', 5, 1.8, 200, 30, 'ครั้งละ 1 เม็ด วันละ 2 ครั้ง หลังอาหาร จนหมด'],
  ['Domperidone 10mg', 'เม็ด', 2, 0.5, 300, 50, 'ครั้งละ 1 เม็ด วันละ 3 ครั้ง ก่อนอาหาร'],
  ['Chloramphenicol eye drops', 'ขวด', 35, 18, 30, 5, 'หยอดตาข้างที่เป็น ครั้งละ 1-2 หยด วันละ 4 ครั้ง'],
  ['Salbutamol inhaler', 'หลอด', 120, 85, 3, 5, 'พ่น 1-2 puff เวลาหอบ'], // ต่ำกว่าเกณฑ์ → ป้ายเตือนทำงาน
];
for (const [name, unit, price, cost, qty, reorder, instr] of EXTRA_DRUGS) {
  if (db.prepare('SELECT id FROM drugs WHERE name = ?').get(name)) continue;
  const id = stock.upsertDrug({ name, unit, price, cost, reorder_level: reorder, default_instructions: instr });
  stock.move(id, 'receive', qty, { reason: 'ยอดตั้งต้น', userId: FRONT });
}

const drugByName = n => db.prepare('SELECT * FROM drugs WHERE name = ?').get(n);
// เติม Amlodipine ให้พอกับประวัติเรื้อรังย้อนหลัง (demo รับเข้าแค่ 300 — คนไข้ HT ใช้สะสม 420) ไม่ให้เปิดวันมาก็ติดลบ
stock.move(drugByName('Amlodipine 5mg').id, 'receive', 600, { reason: 'รับยาเข้า (สั่งซื้อรอบใหม่)', userId: FRONT });
const svcByName = n => db.prepare('SELECT * FROM services WHERE name = ?').get(n);
function L(kind, name, qty, instructions) {
  if (kind === 'drug') {
    const d = drugByName(name);
    return { type: 'drug', ref_id: d.id, name: d.name, qty, unit: d.unit, price_each: d.price,
      instructions: instructions ?? (d.default_instructions || '') };
  }
  if (kind === 'discount') return { type: 'discount', ref_id: null, name, qty: 1, unit: '', price_each: -qty, instructions: '' };
  const s = svcByName(name);
  return { type: 'service', ref_id: s.id, name: s.name, qty, unit: 'ครั้ง', price_each: s.price, instructions: '' };
}
const round2 = v => Math.round(v * 100) / 100;

// ---------- helper: visit ทุกสถานะ + บิลสมบูรณ์แบบเดียวกับ billing จริง ----------
function insertVisit({ hn, date, when, state, vitals: v = {}, note, lines, queueDate }) {
  const qno = nextCounter('queue', queueDate || date);
  const r = db.prepare(`INSERT INTO visits (hn, visit_date, queue_no, state, doctor_id,
      weight_kg, height_cm, temp_c, bp_sys, bp_dia, pulse, glucose,
      vitals_updated_by, vitals_updated_at, created_by, created_at, completed_at, cancel_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hn, date, qno, state, ['WAITING'].includes(state) ? null : DOC,
      v.w ?? null, v.h ?? null, v.t ?? null, v.s ?? null, v.d ?? null, v.p ?? null, v.g ?? null,
      Object.keys(v).length ? FRONT : null, Object.keys(v).length ? when : null,
      FRONT, when, state === 'COMPLETED' ? when : null, note && note.cancel ? note.cancel : null);
  const vid = Number(r.lastInsertRowid);
  if (note && !note.cancel && state !== 'WAITING') {
    db.prepare(`INSERT INTO note_versions (visit_id, version, cc, hpi, pe, dx_text, icd10, note, vitals_json, created_by, created_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(vid, note.cc || null, note.hpi || null, note.pe || null, note.dx || null, note.icd || null, note.note || null,
        JSON.stringify({ weight_kg: v.w, height_cm: v.h, temp_c: v.t, bp_sys: v.s, bp_dia: v.d, pulse: v.p, glucose: v.g }),
        DOC, when);
  }
  let orderVersionId = null;
  if (lines && lines.length) {
    const ov = db.prepare(`INSERT INTO order_versions (visit_id, version, lines_json, created_by, created_at)
      VALUES (?, 1, ?, ?, ?)`).run(vid, JSON.stringify(lines), DOC, when);
    orderVersionId = Number(ov.lastInsertRowid);
  }
  return { vid, orderVersionId };
}

function payVisit({ vid, orderVersionId, hn, lines, when, payMethod = 'cash', cashReceived = null,
  transferRef = '', manualDiscount = 0, discountReason = null }) {
  return txn(() => {
    const realLines = lines.filter(l => l.type !== 'discount');
    const discLines = lines.filter(l => l.type === 'discount');
    const subtotal = round2(realLines.reduce((s, l) => s + l.qty * l.price_each, 0));
    const lineDiscount = round2(discLines.reduce((s, l) => s + Math.abs(l.price_each) * l.qty, 0));
    const totalDiscount = round2(lineDiscount + manualDiscount);
    const reason = [...discLines.map(l => l.name), ...(manualDiscount > 0 ? [discountReason] : [])].filter(Boolean).join('; ') || null;
    const total = round2(subtotal - totalDiscount);
    const receiptNo = nextReceiptNo();
    const p = db.prepare('SELECT prefix, first_name, last_name, address FROM patients WHERE hn = ?').get(hn);
    const pname = `${p.prefix || ''}${p.first_name} ${p.last_name || ''}`.trim();
    db.prepare(`INSERT INTO receipts (receipt_no, visit_id, hn, patient_name, order_version_id,
        subtotal, discount, discount_reason, total, pay_method, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ISSUED', ?, ?)`)
      .run(receiptNo, vid, hn, pname, orderVersionId, subtotal, totalDiscount, reason, total, payMethod, FRONT, when);
    const ins = db.prepare(`INSERT INTO receipt_lines (receipt_no, line_type, ref_id, name, qty, unit, price_each, amount, instructions, cost_each, item_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const drugQ = db.prepare('SELECT cost, code FROM drugs WHERE id = ?');
    for (const l of realLines) {
      const d = l.type === 'drug' ? (drugQ.get(l.ref_id) || {}) : {};
      ins.run(receiptNo, l.type, l.ref_id, l.name, l.qty, l.unit, l.price_each, round2(l.qty * l.price_each),
        l.instructions || null, l.type === 'drug' ? d.cost ?? null : null, d.code || null);
      if (l.type === 'drug') { // ตัด stock จริงด้วยเวลาเดียวกับบิล (ledger + cache ตรงกัน)
        db.prepare(`INSERT INTO stock_movements (drug_id, type, qty, ref, reason, created_by, created_at)
          VALUES (?, 'dispense', ?, ?, NULL, ?, ?)`).run(l.ref_id, -l.qty, receiptNo, FRONT, when);
        db.prepare('UPDATE drugs SET qty_on_hand = ROUND(qty_on_hand + ?, 3) WHERE id = ?').run(-l.qty, l.ref_id);
      }
    }
    const received = payMethod === 'cash' ? (cashReceived ?? total) : null;
    const payment = payMethod === 'cash'
      ? { method: 'cash', cash_received: received, change: round2(received - total), transfer_ref: '' }
      : { method: 'transfer', cash_received: null, change: null, transfer_ref: transferRef };
    const issuer = {
      name: 'สุขใจคลินิกเวชกรรม (ระบบทดลอง)', address: '123/45 ถ.สุขสบาย ต.ในเมือง อ.เมือง จ.อุบลราชธานี 34000',
      phone: '045-123-456', tax_id: '', branch: '', book_no: '', clinic_license: '10101000164',
      logo_file: '', footer: '', vat_note: '',
    };
    db.prepare(`INSERT INTO receipt_document_snapshots
        (receipt_no, template_key, template_version, issuer_json, payer_json, payment_json, cashier_json, source, created_by, created_at)
      VALUES (?, 'receipt_a5', 2, ?, ?, ?, ?, 'new_issue', ?, ?)`)
      .run(receiptNo, JSON.stringify(issuer),
        JSON.stringify({ name: pname, address: p.address || '', tax_id: '' }),
        JSON.stringify(payment),
        JSON.stringify({ name: front.display_name, doctor_name: doctor.display_name }), FRONT, when);
    return receiptNo;
  });
}

function completedVisit(hn, minutes, vitals, note, lines, payOpts = {}) {
  const when = at(minutes);
  const { vid, orderVersionId } = insertVisit({ hn, date: TODAY, when, state: 'COMPLETED', vitals, note, lines });
  payVisit({ vid, orderVersionId, hn, lines, when: at(minutes + 12), ...payOpts });
  return vid;
}

function makeAppointment(hn, vid, apptDate, days, note, createdAt) {
  db.prepare(`INSERT INTO appointments (hn, visit_id, appt_date, days, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(hn, vid, apptDate, days, note || null, DOC, createdAt);
}

// ============================================================
// ส่วนที่ 1: คนไข้เรื้อรังมีประวัติย้อนหลัง (กราฟทำงาน)
// ============================================================

// ลุงประยูร — HT ตามนัดทุกเดือน 7 ครั้ง คุมได้ดีขึ้นเรื่อยๆ → วันนี้มาตามนัด (จ่ายแล้วช่วงเช้า)
const hnPrayoon = patients.register({
  prefix: 'นาย', first_name: 'ประยูร', last_name: 'ใจดี', sex: 'M', birth_date: '1958-03-12',
  citizen_id: '3341500123456', phone: '081-111-1111', address: '88 หมู่ 2 ต.ขามใหญ่ อ.เมือง จ.อุบลราชธานี',
  chronic: 'ความดันโลหิตสูง', emergency_name: 'สมคิด (ลูกชาย)', emergency_phone: '089-000-1111',
}, FRONT);
const htSeries = [[7, 168, 98, 80.5], [6, 160, 95, 80], [5, 155, 92, 79.5], [4, 150, 90, 79], [3, 146, 88, 78.5], [2, 142, 86, 78], [1, 138, 85, 78]];
let lastPrayoonVid = null;
for (const [mAgo, s, d, w] of htSeries) {
  const date = monthsAgo(mAgo, 10);
  const { vid, orderVersionId } = insertVisit({
    hn: hnPrayoon, date, when: `${date} 09:20:00`, state: 'COMPLETED', vitals: { w, h: 168, s, d, p: 74 },
    note: { cc: 'มารับยาความดันตามนัด', pe: `BP ${s}/${d} mmHg ไม่มีอาการ`, dx: 'Essential hypertension', icd: 'I10', note: 'กินยาสม่ำเสมอ นัดอีก 1 เดือน' },
    lines: [L('drug', 'Amlodipine 5mg', 30), L('service', 'ค่าตรวจรักษา', 1)],
  });
  payVisit({ vid, orderVersionId, hn: hnPrayoon, lines: [L('drug', 'Amlodipine 5mg', 30), L('service', 'ค่าตรวจรักษา', 1)], when: `${date} 09:35:00` });
  lastPrayoonVid = vid;
}
makeAppointment(hnPrayoon, lastPrayoonVid, TODAY, 30, 'รับยาความดัน', `${monthsAgo(1, 10)} 09:40:00`); // นัดวันนี้ — และเขามาแล้ว

// ป้าสมพร — DM+HT + แพ้ Penicillin → วันนี้มาตามนัด กำลัง "รอตรวจ" อยู่ในคิว
const hnSomporn = patients.register({
  prefix: 'นาง', first_name: 'สมพร', last_name: 'มีสุข', sex: 'F', birth_date: '1962-11-02',
  citizen_id: '3341500234567', phone: '082-222-2222', address: '15/3 ถ.แจ้งสนิท ต.ในเมือง อ.เมือง จ.อุบลราชธานี',
  chronic: 'เบาหวานชนิดที่ 2, ความดันโลหิตสูง', emergency_name: 'มาลี (ลูกสาว)', emergency_phone: '086-000-2222',
}, FRONT);
patients.addAllergy(hnSomporn, 'Penicillin', 'ผื่นขึ้นทั้งตัว', DOC);
const dmSeries = [[6, 210, 152, 94, 72.0], [5, 190, 150, 92, 71.5], [4, 175, 148, 90, 70.8], [3, 160, 145, 88, 70.2], [2, 148, 142, 87, 69.8], [1, 135, 140, 86, 69.4]];
let lastSompornVid = null;
for (const [mAgo, g, s, d, w] of dmSeries) {
  const date = monthsAgo(mAgo, 6);
  const lines = [L('drug', 'Metformin 500mg', 60), L('drug', 'Amlodipine 5mg', 30), L('service', 'ค่าตรวจรักษา', 1)];
  const { vid, orderVersionId } = insertVisit({
    hn: hnSomporn, date, when: `${date} 10:05:00`, state: 'COMPLETED', vitals: { w, h: 155, s, d, p: 78, g },
    note: { cc: 'มารับยาเบาหวาน/ความดันตามนัด', pe: `DTX ${g} mg/dL, BP ${s}/${d}`, dx: 'DM type 2 with hypertension', icd: 'E11.9',
      note: g > 180 ? 'น้ำตาลยังสูง เน้นคุมอาหาร งดของหวาน' : 'คุมได้ดีขึ้น ชมคนไข้ นัดอีก 1 เดือน' },
    lines,
  });
  payVisit({ vid, orderVersionId, hn: hnSomporn, lines, when: `${date} 10:20:00`, payMethod: mAgo > 3 ? 'cash' : 'transfer', transferRef: 'PromptPay' });
  lastSompornVid = vid;
}
makeAppointment(hnSomporn, lastSompornVid, TODAY, 30, 'รับยาเบาหวาน+ความดัน เจาะ DTX', `${monthsAgo(1, 6)} 10:25:00`);

// ตาบุญมี — HT+ไขมัน 5 ครั้ง → วันนี้มารับยา (จ่ายแล้วช่วงสาย)
const hnBoonmee = patients.register({
  prefix: 'นาย', first_name: 'บุญมี', last_name: 'แก้วใส', sex: 'M', birth_date: '1950-07-21',
  phone: '083-333-1234', chronic: 'ความดันโลหิตสูง, ไขมันในเลือดสูง',
  emergency_name: 'บุญเรือน (ภรรยา)', emergency_phone: '083-333-1235',
}, FRONT);
for (const [mAgo, s, d] of [[5, 152, 94], [4, 148, 92], [3, 144, 90], [2, 142, 88], [1, 140, 88]]) {
  const date = monthsAgo(mAgo, 18);
  const lines = [L('drug', 'Losartan 50mg', 30), L('drug', 'Simvastatin 20mg', 30), L('service', 'ค่าตรวจรักษา', 1)];
  const { vid, orderVersionId } = insertVisit({
    hn: hnBoonmee, date, when: `${date} 11:00:00`, state: 'COMPLETED', vitals: { w: 65, h: 165, s, d, p: 70 },
    note: { cc: 'มารับยาตามนัด', pe: `BP ${s}/${d}`, dx: 'HT with dyslipidemia', icd: 'I10', note: 'นัด 1 เดือน' }, lines,
  });
  payVisit({ vid, orderVersionId, hn: hnBoonmee, lines, when: `${date} 11:15:00` });
}

// ============================================================
// ส่วนที่ 2: บิลช่วงเช้าวันนี้ (จ่ายแล้ว) — เคสหลากหลาย
// ============================================================
const reg = (data) => patients.register(data, FRONT);

// 08:40 ลุงประยูรมาตามนัด (ต่อจาก series ด้านบน)
completedVisit(hnPrayoon, 10, { w: 77.8, h: 168, s: 136, d: 84, p: 72 },
  { cc: 'มารับยาความดันตามนัด', pe: 'BP 136/84 ไม่มีอาการ', dx: 'Essential hypertension', icd: 'I10', note: 'คุมได้ดี นัดอีก 1 เดือน' },
  [L('drug', 'Amlodipine 5mg', 30), L('service', 'ค่าตรวจรักษา', 1)], { cashReceived: 200 });

// 08:55 เด็กไข้หวัด
const hnPoom = reg({ prefix: 'ด.ช.', first_name: 'ภูมิ', last_name: 'รักเรียน', sex: 'M', birth_date: '2019-01-08', phone: '084-111-2222', emergency_name: 'วันดี (แม่)', emergency_phone: '084-111-2222' });
completedVisit(hnPoom, 25, { w: 18.5, h: 110, t: 38.2, p: 108 },
  { cc: 'ไข้ ไอ น้ำมูก 2 วัน', hpi: 'ไข้ต่ำๆ น้ำมูกใส กินได้ เล่นได้', pe: 'pharynx injected เล็กน้อย ปอดปกติ', dx: 'URI', icd: 'J06.9', note: 'เช็ดตัว ดื่มน้ำมากๆ' },
  [L('drug', 'Paracetamol 500mg', 10, 'ครั้งละครึ่งเม็ด ทุก 4-6 ชม. เวลามีไข้'), L('drug', 'CPM 4mg', 10, 'ครั้งละครึ่งเม็ด วันละ 3 ครั้ง'), L('service', 'ค่าตรวจรักษา', 1)],
  { cashReceived: 500 });

// 09:10 ท้องเสีย
const hnFon = reg({ prefix: 'น.ส.', first_name: 'ฝน', last_name: 'ชุ่มเย็น', sex: 'F', birth_date: '1998-04-30', phone: '085-222-3333' });
completedVisit(hnFon, 40, { w: 52, h: 160, t: 37.2, p: 88 },
  { cc: 'ถ่ายเหลว 5 ครั้งตั้งแต่เมื่อคืน', hpi: 'กินส้มตำร้านใหม่ ไม่มีมูกเลือด ไม่มีไข้สูง', pe: 'ท้องนิ่ม กดไม่เจ็บ ไม่ dehydrate', dx: 'Acute diarrhea', icd: 'A09', note: 'จิบ ORS งดอาหารรสจัด 2 วัน' },
  [L('drug', 'ORS ผงเกลือแร่', 5), L('service', 'ค่าตรวจรักษา', 1)]);

// 09:25 ปวดหลัง + ฉีดยา
const hnChai = reg({ prefix: 'นาย', first_name: 'ชัย', last_name: 'แบกหาม', sex: 'M', birth_date: '1985-09-12', phone: '086-333-4444' });
completedVisit(hnChai, 55, { w: 70, h: 172, s: 128, d: 82, p: 76 },
  { cc: 'ปวดหลังหลังยกกระสอบข้าว 2 วัน', pe: 'paraspinal muscle spasm L2-L4, SLR negative', dx: 'Muscle strain', icd: 'M62.6', note: 'งดยกของหนัก 1 สัปดาห์ ประคบอุ่น' },
  [L('drug', 'Ibuprofen 400mg', 15), L('service', 'ค่าฉีดยา', 1), L('service', 'ค่าตรวจรักษา', 1)], { cashReceived: 200 });

// 09:40 เวียนหัว
const hnTaeng = reg({ prefix: 'นาง', first_name: 'แตงอ่อน', last_name: 'หมุนดี', sex: 'F', birth_date: '1968-12-01', phone: '087-444-5555' });
completedVisit(hnTaeng, 70, { w: 58, h: 152, s: 132, d: 84, p: 80 },
  { cc: 'เวียนหัวบ้านหมุนตอนลุกจากที่นอน', hpi: 'เป็นพักๆ ครั้งละไม่ถึงนาที ไม่มีหูอื้อ', pe: 'Dix-Hallpike positive ขวา, neuro ปกติ', dx: 'BPPV', icd: 'R42', note: 'สอน Epley maneuver แล้ว' },
  [L('drug', 'CPM 4mg', 10, 'ครั้งละ 1 เม็ด เวลาเวียนหัว (อาจง่วง)'), L('service', 'ค่าตรวจรักษา', 1)]);

// 09:55 แผลถูกมีดบาด — เย็บแผล + ทำแผล (บิลหัตถการใหญ่, โอน)
const hnWirat = reg({ prefix: 'นาย', first_name: 'วิรัช', last_name: 'คมมีด', sex: 'M', birth_date: '1990-06-25', phone: '088-555-6666' });
completedVisit(hnWirat, 85, { w: 68, h: 170, t: 36.8, p: 82 },
  { cc: 'มีดบาดนิ้วชี้ซ้ายขณะหั่นหมู', pe: 'แผลฉีกขาด 2.5 ซม. ลึกถึง subcutaneous ไม่โดนเส้นเอ็น', dx: 'Open wound of finger', icd: 'T14.1', note: 'เย็บ 3 stitches นัดตัดไหม 7 วัน ล้างแผลทุกวัน' },
  [L('service', 'ค่าเย็บแผล', 1), L('service', 'ค่าทำแผล', 1), L('drug', 'Amoxicillin 500mg', 15), L('drug', 'Paracetamol 500mg', 10)],
  { payMethod: 'transfer', transferRef: 'K-Bank 09:58' });

// 10:15 ลมพิษ — มีส่วนลดหน้าบิล
const hnKanda = reg({ prefix: 'น.ส.', first_name: 'กานดา', last_name: 'ผิวผ่อง', sex: 'F', birth_date: '1995-02-14', phone: '089-666-7777' });
completedVisit(hnKanda, 105, { w: 50, h: 158, t: 36.9, p: 78 },
  { cc: 'ผื่นลมพิษขึ้นทั้งตัวหลังกินกุ้ง', pe: 'wheal กระจายลำตัว+แขน ไม่มีหน้าบวม ไม่แน่นหน้าอก', dx: 'Urticaria', icd: 'L50.9', note: 'เลี่ยงกุ้ง ถ้าหน้าบวม/แน่นหน้าอกมา รพ.ทันที' },
  [L('drug', 'Cetirizine 10mg', 10), L('drug', 'CPM 4mg', 10), L('service', 'ค่าตรวจรักษา', 1)],
  { manualDiscount: 20, discountReason: 'ลูกค้าประจำ', cashReceived: 200 });

// 10:30 โรคกระเพาะ
const hnSomsak = reg({ prefix: 'นาย', first_name: 'สมศักดิ์', last_name: 'จุกแน่น', sex: 'M', birth_date: '1978-08-08', phone: '081-777-8888' });
completedVisit(hnSomsak, 120, { w: 80, h: 175, s: 130, d: 85, p: 74 },
  { cc: 'จุกแน่นลิ้นปี่หลังอาหาร 1 สัปดาห์', hpi: 'กินกาแฟวันละ 3 แก้ว เครียดงาน ไม่มีถ่ายดำ', pe: 'epigastric tenderness เล็กน้อย', dx: 'Dyspepsia', icd: 'K30', note: 'ลดกาแฟ งดของเผ็ด ถ้าถ่ายดำมาทันที' },
  [L('drug', 'Omeprazole 20mg', 14), L('drug', 'Domperidone 10mg', 21), L('service', 'ค่าตรวจรักษา', 1)]);

// 10:45 เด็กตาแดง
const hnBaitoey = reg({ prefix: 'ด.ญ.', first_name: 'ใบเตย', last_name: 'ตาใส', sex: 'F', birth_date: '2017-11-20', phone: '082-888-9999', emergency_name: 'พรทิพย์ (แม่)', emergency_phone: '082-888-9999' });
completedVisit(hnBaitoey, 135, { w: 24, h: 122, t: 37.0, p: 96 },
  { cc: 'ตาแดงข้างขวา ขี้ตาเยอะ 1 วัน', pe: 'conjunctival injection ขวา ขี้ตาเหลือง cornea ใส', dx: 'Conjunctivitis', icd: 'H10.9', note: 'ล้างมือบ่อยๆ แยกผ้าเช็ดหน้า หยุดเรียน 2 วัน' },
  [L('drug', 'Chloramphenicol eye drops', 1), L('service', 'ค่าตรวจรักษา', 1)], { cashReceived: 200 });

// 11:00 UTI
const hnNipa = reg({ prefix: 'นาง', first_name: 'นิภา', last_name: 'แสบขัด', sex: 'F', birth_date: '1982-03-17', phone: '083-999-0000' });
completedVisit(hnNipa, 150, { w: 60, h: 162, t: 37.4, p: 84 },
  { cc: 'ปัสสาวะแสบขัด ปวดท้องน้อย 2 วัน', pe: 'suprapubic tenderness, no CVA tenderness', dx: 'Cystitis', icd: 'N39.0', note: 'ดื่มน้ำมากๆ ไม่กลั้นปัสสาวะ ถ้าไข้สูง/ปวดหลังมาทันที' },
  [L('drug', 'Norfloxacin 400mg', 6), L('drug', 'Paracetamol 500mg', 10), L('service', 'ค่าตรวจรักษา', 1)],
  { payMethod: 'transfer', transferRef: 'SCB 11:05' });

// 11:20 ตรวจสุขภาพสมัครงาน — เคสสำหรับทดลอง "ออกใบรับรองแพทย์" (มีบัตร ปชช.+ที่อยู่+vitals ครบ)
const hnPong = reg({ prefix: 'นาย', first_name: 'พงษ์', last_name: 'สมัครงาน', sex: 'M', birth_date: '2000-05-05',
  citizen_id: '1341500345678', phone: '084-000-1111', address: '99 หมู่ 5 ต.หนองบ่อ อ.เมือง จ.อุบลราชธานี' });
completedVisit(hnPong, 170, { w: 62, h: 170, t: 36.6, s: 118, d: 76, p: 68 },
  { cc: 'ขอใบรับรองแพทย์ไปสมัครงาน', pe: 'GA ปกติ, HEENT ปกติ, heart/lungs ปกติ, ไม่มีโรคประจำตัว', dx: 'General medical examination', icd: 'Z00.0', note: 'สุขภาพแข็งแรงดี' },
  [L('service', 'ค่าตรวจรักษา', 1)]);

// 11:40 เข่าเสื่อม
const hnJampee = reg({ prefix: 'นาง', first_name: 'จำปี', last_name: 'เข่าลั่น', sex: 'F', birth_date: '1955-10-10', phone: '085-111-0000', chronic: 'ข้อเข่าเสื่อม' });
completedVisit(hnJampee, 190, { w: 72, h: 155, s: 138, d: 86, p: 76 },
  { cc: 'ปวดเข่าสองข้าง ขึ้นบันไดลำบาก', pe: 'crepitus both knees, no effusion', dx: 'Knee osteoarthritis', icd: 'M79.1', note: 'ลดน้ำหนัก บริหารกล้ามเนื้อต้นขา' },
  [L('drug', 'Ibuprofen 400mg', 15, 'ครั้งละ 1 เม็ด หลังอาหารทันที เวลาปวด'), L('drug', 'Paracetamol 500mg', 20), L('service', 'ค่าตรวจรักษา', 1)],
  { payMethod: 'transfer', transferRef: 'PromptPay 11:52' });

// 12:10 ตาบุญมีมารับยา (ต่อจาก series)
completedVisit(hnBoonmee, 220, { w: 64.8, h: 165, s: 138, d: 86, p: 72 },
  { cc: 'มารับยาตามนัด', pe: 'BP 138/86', dx: 'HT with dyslipidemia', icd: 'I10', note: 'นัด 1 เดือน' },
  [L('drug', 'Losartan 50mg', 30), L('drug', 'Simvastatin 20mg', 30), L('service', 'ค่าตรวจรักษา', 1)], { cashReceived: 300 });

// ============================================================
// ส่วนที่ 3: คิวที่ค้างอยู่ตอนนี้ (เล่นต่อได้ทันที)
// ============================================================

// ยกเลิก 1 ราย (รอนานกลับก่อน) — โผล่ในคิวเป็นสถานะยกเลิก
const hnKlab = reg({ prefix: 'นาย', first_name: 'สมหมาย', last_name: 'รีบร้อน', sex: 'M', birth_date: '1993-01-15', phone: '086-222-1111' });
insertVisit({ hn: hnKlab, date: TODAY, when: agoMinutes(95), state: 'CANCELLED', vitals: { t: 37.1, p: 80 }, note: { cancel: 'รอนาน ขอกลับก่อน จะมาใหม่พรุ่งนี้' } });

// DISPENSING — ตรวจเสร็จแล้ว รอหน้าร้านเก็บเงิน (ทดลอง: รับเงิน/พิมพ์ใบเสร็จ)
const hnSaifon = reg({ prefix: 'นาง', first_name: 'สายฝน', last_name: 'ครืดคราด', sex: 'F', birth_date: '1988-07-07', phone: '087-333-2222' });
insertVisit({ hn: hnSaifon, date: TODAY, when: agoMinutes(40), state: 'DISPENSING', vitals: { w: 55, h: 159, t: 37.6, p: 82 },
  note: { cc: 'ไอ เจ็บคอ น้ำมูก 3 วัน', pe: 'pharynx แดง tonsil ไม่โต ปอดปกติ', dx: 'URI', icd: 'J06.9', note: 'พัก ดื่มน้ำอุ่น' },
  lines: [L('drug', 'Paracetamol 500mg', 10), L('drug', 'CPM 4mg', 10), L('drug', 'Cetirizine 10mg', 5, 'ครั้งละ 1 เม็ด ก่อนนอน ถ้าคัดจมูกมาก'), L('service', 'ค่าตรวจรักษา', 1)] });

const hnPrasert = reg({ prefix: 'นาย', first_name: 'ประเสริฐ', last_name: 'ถ่ายคล่อง', sex: 'M', birth_date: '1948-04-04', phone: '088-444-3333' });
insertVisit({ hn: hnPrasert, date: TODAY, when: agoMinutes(30), state: 'DISPENSING', vitals: { w: 58, h: 163, t: 36.9, s: 126, d: 80, p: 78 },
  note: { cc: 'ถ่ายเหลว 3 ครั้งเช้านี้', pe: 'ท้องนิ่ม ไม่ dehydrate', dx: 'Acute diarrhea', icd: 'A09', note: 'ผู้สูงอายุ — เน้นจิบ ORS บ่อยๆ' },
  lines: [L('drug', 'ORS ผงเกลือแร่', 5), L('service', 'ค่าตรวจรักษา', 1), L('discount', 'ส่วนลดผู้สูงอายุ', 30)] });

// IN_EXAM — อยู่ในห้องตรวจ (ทดลอง: เขียน note ต่อ สั่งยา dose grid แล้วจบตรวจ)
const hnKriang = reg({ prefix: 'นาย', first_name: 'เกรียงไกร', last_name: 'ท้องอืด', sex: 'M', birth_date: '1975-12-12', phone: '089-555-4444' });
insertVisit({ hn: hnKriang, date: TODAY, when: agoMinutes(20), state: 'IN_EXAM', vitals: { w: 74, h: 168, t: 36.8, s: 124, d: 80, p: 72 } });

// WAITING — รอตรวจ 4 ราย
insertVisit({ hn: hnSomporn, date: TODAY, when: agoMinutes(25), state: 'WAITING', vitals: { w: 69.2, h: 155, s: 138, d: 84, p: 76, g: 132 } }); // มาตามนัด + แพ้ยา + กราฟ
const hnArtit = reg({ prefix: 'นาย', first_name: 'อาทิตย์', last_name: 'ร้อนรุ่ม', sex: 'M', birth_date: '2002-06-06', phone: '084-666-5555' });
insertVisit({ hn: hnArtit, date: TODAY, when: agoMinutes(18), state: 'WAITING', vitals: { w: 64, h: 174, t: 38.9, p: 102 } }); // ไข้สูง — chip แดง
const hnLamduan = reg({ prefix: 'นาง', first_name: 'ลำดวน', last_name: 'ตึงต้นคอ', sex: 'F', birth_date: '1960-09-09', phone: '085-777-6666' });
insertVisit({ hn: hnLamduan, date: TODAY, when: agoMinutes(12), state: 'WAITING', vitals: { w: 66, h: 156, s: 172, d: 98, p: 88 } }); // BP สูง — chip แดง
const hnKaohom = reg({ prefix: 'ด.ญ.', first_name: 'ข้าวหอม', last_name: 'คันยิก', sex: 'F', birth_date: '2020-02-02', phone: '086-888-7777', emergency_name: 'บัวคำ (ยาย)', emergency_phone: '086-888-7777' });
patients.addAllergy(hnKaohom, 'Ibuprofen (NSAIDs)', 'หน้าบวม', DOC);
insertVisit({ hn: hnKaohom, date: TODAY, when: agoMinutes(5), state: 'WAITING' }); // ยังไม่วัด vitals — ให้ทดลองวัดเอง

// ============================================================
// ส่วนที่ 4: นัดล่วงหน้า (ปฏิทินมีของ)
// ============================================================
function futureDate(days) {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
makeAppointment(hnWirat, null, futureDate(7), 7, 'ตัดไหมนิ้วชี้ซ้าย', at(90));
makeAppointment(hnNipa, null, futureDate(3), 3, 'ฟังผลอาการ ถ้าไม่ดีขึ้นส่งตรวจปัสสาวะ', at(155));
makeAppointment(hnJampee, null, futureDate(14), 14, 'ติดตามอาการปวดเข่า', at(195));

// ---------- สรุป ----------
const q = s => db.prepare(s).get();
const nPatients = q('SELECT COUNT(*) c FROM patients').c;
const nToday = q(`SELECT COUNT(*) c FROM visits WHERE visit_date = '${TODAY}'`).c;
const byState = db.prepare(`SELECT state, COUNT(*) c FROM visits WHERE visit_date = ? GROUP BY state`).all(TODAY);
const rc = q(`SELECT COUNT(*) c, ROUND(SUM(total),2) s FROM receipts WHERE created_at LIKE '${TODAY}%' AND status = 'ISSUED'`);
console.log(`จำลองคลินิกวันเต็มเสร็จ: คนไข้ ${nPatients} คน · visit วันนี้ ${nToday}`);
console.log('สถานะวันนี้: ' + byState.map(r => `${r.state}=${r.c}`).join(' · '));
console.log(`ใบเสร็จวันนี้ ${rc.c} ใบ รวม ${rc.s} บาท`);
console.log('คิวค้างตอนนี้: รอตรวจ 4 (มีไข้ 38.9 / BP 172/98 / เด็กยังไม่วัด vitals) · กำลังตรวจ 1 · รอเก็บเงิน 2');
console.log('ลองต่อ: เข้าระบบ doctor/doctor123 (จอหมอ) และ front/front123 (หน้าร้าน) — ดู UAT-สคริปต์ทดลองหนึ่งวัน.md');
