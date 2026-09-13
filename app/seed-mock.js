'use strict';
// Mock เคสเรื้อรังมีประวัติย้อนหลังหลายเดือน — ไว้ดูหน้าตา history panel, กราฟ BP/น้ำตาล, สมุดรายรับ
// ใช้กับ DB ทดสอบเท่านั้น (รัน seed.js --demo มาก่อน) — รัน: node --no-warnings seed-mock.js
// หมายเหตุ: mock ไม่แตะ stock ledger เพื่อให้ยอดสต็อกปัจจุบันยังตรงความจริง
const { db, txn, nextReceiptNo, nextCounter } = require('./lib/db');
const patients = require('./lib/patients');
const stock = require('./lib/stock');

const doctor = db.prepare("SELECT id FROM users WHERE role = 'doctor' AND active = 1 LIMIT 1").get();
const front = db.prepare("SELECT id FROM users WHERE role = 'front' AND active = 1 LIMIT 1").get();
if (!doctor || !front) { console.error('ไม่มี user demo — รัน: node seed.js --demo ก่อน'); process.exit(1); }
const DOC = doctor.id, FRONT = front.id;

if (db.prepare("SELECT hn FROM patients WHERE last_name LIKE '%(mock)%'").get()) {
  console.log('มีข้อมูล mock อยู่แล้ว — ข้าม (ล้างได้โดยลบโฟลเดอร์ data แล้ว seed ใหม่)');
  process.exit(0);
}

// ยาเบาหวานยังไม่มีใน demo — เพิ่ม
if (!db.prepare("SELECT id FROM drugs WHERE name LIKE 'Metformin%'").get()) {
  const id = stock.upsertDrug({ name: 'Metformin 500mg', unit: 'เม็ด', price: 2, reorder_level: 100,
    default_instructions: 'ครั้งละ 1 เม็ด วันละ 2 ครั้ง หลังอาหารเช้า-เย็น' });
  stock.move(id, 'receive', 1000, { reason: 'ยอดตั้งต้น (mock)', userId: FRONT });
}

const drugByName = n => db.prepare('SELECT * FROM drugs WHERE name = ?').get(n);
const svcByName = n => db.prepare('SELECT * FROM services WHERE name = ?').get(n);
function mkLine(kind, name, qty) {
  if (kind === 'drug') {
    const d = drugByName(name);
    return { type: 'drug', ref_id: d.id, name: d.name, qty, unit: d.unit, price_each: d.price, instructions: d.default_instructions || '' };
  }
  const s = svcByName(name);
  return { type: 'service', ref_id: s.id, name: s.name, qty, unit: 'ครั้ง', price_each: s.price, instructions: '' };
}

function addVisit(hn, date, v, note, lines, payMethod = 'cash') {
  txn(() => {
    const qno = nextCounter('queue', date);
    const at = `${date} 09:${String(10 + qno).padStart(2, '0')}:00`;
    const r = db.prepare(`INSERT INTO visits (hn, visit_date, queue_no, state, doctor_id,
        weight_kg, height_cm, temp_c, bp_sys, bp_dia, pulse, glucose,
        vitals_updated_by, vitals_updated_at, created_by, created_at, completed_at)
      VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hn, date, qno, DOC, v.w ?? null, v.h ?? null, v.t ?? null, v.s ?? null, v.d ?? null,
        v.p ?? null, v.g ?? null, FRONT, at, FRONT, at, at);
    const vid = Number(r.lastInsertRowid);
    db.prepare(`INSERT INTO note_versions (visit_id, version, cc, hpi, pe, dx_text, icd10, note, vitals_json, created_by, created_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(vid, note.cc || null, note.hpi || null, note.pe || null, note.dx || null, note.icd || null,
        note.note || null, JSON.stringify({ weight_kg: v.w, height_cm: v.h, temp_c: v.t, bp_sys: v.s, bp_dia: v.d, pulse: v.p, glucose: v.g }),
        DOC, at);
    const ov = db.prepare(`INSERT INTO order_versions (visit_id, version, lines_json, created_by, created_at)
      VALUES (?, 1, ?, ?, ?)`).run(vid, JSON.stringify(lines), DOC, at);
    const subtotal = Math.round(lines.reduce((s, l) => s + l.qty * l.price_each, 0) * 100) / 100;
    const rno = nextReceiptNo();
    const p = db.prepare('SELECT prefix, first_name, last_name FROM patients WHERE hn = ?').get(hn);
    db.prepare(`INSERT INTO receipts (receipt_no, visit_id, hn, patient_name, order_version_id,
        subtotal, discount, total, pay_method, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'ISSUED', ?, ?)`)
      .run(rno, vid, hn, `${p.prefix || ''}${p.first_name} ${p.last_name || ''}`.trim(),
        Number(ov.lastInsertRowid), subtotal, subtotal, payMethod, FRONT, at);
    const ins = db.prepare(`INSERT INTO receipt_lines (receipt_no, line_type, ref_id, name, qty, unit, price_each, amount, instructions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of lines) ins.run(rno, l.type, l.ref_id, l.name, l.qty, l.unit, l.price_each,
      Math.round(l.qty * l.price_each * 100) / 100, l.instructions || null);
  });
}

// ========== เคส 1: ลุงประยูร — ความดันสูง มาตามนัดทุกเดือน 7 ครั้ง ==========
const hn1 = patients.register({
  prefix: 'นาย', first_name: 'ประยูร', last_name: 'ใจดี (mock)', sex: 'M', birth_date: '1958-03-12',
  phone: '081-111-1111', chronic: 'ความดันโลหิตสูง', emergency_name: 'สมคิด (ลูกชาย)', emergency_phone: '089-000-1111',
}, FRONT);
const htSeries = [
  ['2026-02-10', 168, 98, 80.5], ['2026-03-10', 160, 95, 80], ['2026-04-09', 155, 92, 79.5],
  ['2026-05-11', 150, 90, 79], ['2026-06-10', 146, 88, 78.5], ['2026-07-10', 142, 86, 78],
  ['2026-08-08', 138, 85, 78],
];
for (const [date, s, d, w] of htSeries) {
  addVisit(hn1, date, { w, h: 168, s, d, p: 74 },
    { cc: 'มารับยาความดันตามนัด', pe: `BP ${s}/${d} mmHg ปกติดี ไม่มีอาการ`, dx: 'Essential hypertension', icd: 'I10', note: 'กินยาสม่ำเสมอ นัดอีก 1 เดือน' },
    [mkLine('drug', 'Amlodipine 5mg', 30), mkLine('service', 'ค่าตรวจรักษา', 1)]);
}

// ========== เคส 2: ป้าสมพร — เบาหวาน + ความดัน คุมน้ำตาลดีขึ้นเรื่อยๆ ==========
const hn2 = patients.register({
  prefix: 'นาง', first_name: 'สมพร', last_name: 'มีสุข (mock)', sex: 'F', birth_date: '1962-11-02',
  phone: '082-222-2222', chronic: 'เบาหวานชนิดที่ 2, ความดันโลหิตสูง', emergency_name: 'มาลี (ลูกสาว)', emergency_phone: '086-000-2222',
}, FRONT);
patients.addAllergy(hn2, 'Penicillin', 'ผื่นขึ้นทั้งตัว', DOC);
const dmSeries = [
  ['2026-03-05', 210, 152, 94, 72.0], ['2026-04-04', 190, 150, 92, 71.5], ['2026-05-06', 175, 148, 90, 70.8],
  ['2026-06-05', 160, 145, 88, 70.2], ['2026-07-06', 148, 142, 87, 69.8], ['2026-08-06', 135, 140, 86, 69.4],
];
for (const [date, g, s, d, w] of dmSeries) {
  addVisit(hn2, date, { w, h: 155, s, d, p: 78, g },
    { cc: 'มารับยาเบาหวาน/ความดันตามนัด', pe: `DTX ${g} mg/dL, BP ${s}/${d}`, dx: 'DM type 2 with hypertension', icd: 'E11.9',
      note: g > 180 ? 'น้ำตาลยังสูง เน้นคุมอาหาร งดของหวาน' : 'คุมได้ดีขึ้น ชมคนไข้ นัดอีก 1 เดือน' },
    [mkLine('drug', 'Metformin 500mg', 60), mkLine('drug', 'Amlodipine 5mg', 30), mkLine('service', 'ค่าตรวจรักษา', 1)],
    date < '2026-06-01' ? 'cash' : 'transfer');
}

// ========== เคส 3: น้องน้ำใส — เด็ก เป็นหวัดมา 2 ครั้ง ==========
const hn3 = patients.register({
  prefix: 'ด.ญ.', first_name: 'น้ำใส', last_name: 'สดชื่น (mock)', sex: 'F', birth_date: '2018-06-15',
  phone: '083-333-3333', emergency_name: 'วิไล (แม่)', emergency_phone: '083-333-3333',
}, FRONT);
addVisit(hn3, '2026-05-20', { w: 21.5, h: 118, t: 38.4, p: 110 },
  { cc: 'ไข้ ไอ น้ำมูก 2 วัน', hpi: 'ไข้ต่ำๆ ไอแห้ง น้ำมูกใส กินได้ เล่นได้', pe: 'pharynx injected เล็กน้อย ปอดปกติ', dx: 'URI', icd: 'J06.9', note: 'เช็ดตัวลดไข้ ดื่มน้ำมากๆ' },
  [mkLine('drug', 'Paracetamol 500mg', 10), mkLine('drug', 'CPM 4mg', 10), mkLine('service', 'ค่าตรวจรักษา', 1)]);
addVisit(hn3, '2026-08-05', { w: 22.0, h: 119, t: 37.9, p: 104 },
  { cc: 'ไข้ ไอ มา 1 วัน', pe: 'คอแดงเล็กน้อย', dx: 'URI', icd: 'J06.9', note: 'อาการน้อยกว่าครั้งก่อน' },
  [mkLine('drug', 'Paracetamol 500mg', 10), mkLine('service', 'ค่าตรวจรักษา', 1)]);

const nVisits = db.prepare("SELECT COUNT(*) c FROM visits v JOIN patients p ON p.hn = v.hn WHERE p.last_name LIKE '%(mock)%'").get().c;
const nReceipts = db.prepare("SELECT COUNT(*) c, ROUND(SUM(total),2) s FROM receipts r JOIN patients p ON p.hn = r.hn WHERE p.last_name LIKE '%(mock)%'").get();
console.log(`mock เสร็จ: คนไข้ 3 คน (${hn1} ลุงประยูร HT, ${hn2} ป้าสมพร DM+HT, ${hn3} น้องน้ำใส URI)`);
console.log(`รวม ${nVisits} visits, ${nReceipts.c} ใบเสร็จ ${nReceipts.s} บาท กระจาย ก.พ.–ส.ค. 2569`);
console.log('ลองที่จอหมอ: ค้น "ประยูร" หรือ "สมพร" → ดูประวัติ + กด "📈 กราฟ BP/น้ำตาล"');
