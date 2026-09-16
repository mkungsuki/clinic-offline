'use strict';
// สร้างฐานข้อมูล "ชุดทดลอง" สำหรับหมอทดลองใช้งานก่อนเริ่มใช้จริง
// ข้อมูลทั้งหมดในไฟล์นี้เป็นข้อมูลสังเคราะห์ ไม่มีบุคคลหรือคลินิกจริง
// เลขบัตรประชาชนตัวอย่างมี 13 หลักเพื่อทดลองหน้าจอเท่านั้น และไม่ได้รับรอง checksum
//
// กันพลาด: ต้องระบุ CLINIC_DATA_DIR ชี้ไปยังโฟลเดอร์ทดลองแยกจาก app/data เสมอ
if (!process.env.CLINIC_DATA_DIR) {
  console.error('⛔ ชุดข้อมูลทดลองต้องติดตั้งผ่านชุด Clinic ทดลองเท่านั้น');
  process.exit(1);
}

// ใช้สถานการณ์ "วันคลินิกกำลังดำเนิน" ที่ผ่านการทดลองแล้วเป็นฐานก่อน
require('./seed-mock-day');

const { db, txn, setSetting, nextCounter, nextReceiptNo } = require('./lib/db');
const patients = require('./lib/patients');
const stock = require('./lib/stock');
const commonDrugs = require('./lib/common-drugs.json').drugs;

const doctor = db.prepare("SELECT id, display_name FROM users WHERE role = 'doctor' AND active = 1 LIMIT 1").get();
const front = db.prepare("SELECT id, display_name FROM users WHERE role = 'front' AND active = 1 LIMIT 1").get();
if (!doctor || !front) {
  console.error('ไม่พบบัญชีชุดทดลอง กรุณาสร้างฐานด้วย seed.js --demo ก่อน');
  process.exit(1);
}
const DOC = doctor.id;
const FRONT = front.id;

const pad = n => String(n).padStart(2, '0');
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const syntheticAddress = '99 หมู่ 9 ต.ตัวอย่าง อ.เมือง จ.ตัวอย่าง 90000';

function dateFromAge(age, month = 1, day = 15) {
  return `${now.getFullYear() - age}-${pad(month)}-${pad(day)}`;
}
function monthsAgo(n, day = 10) {
  const d = new Date(now.getFullYear(), now.getMonth() - n, day);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function futureDate(days) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function ageFromBirth(birthDate) {
  if (!birthDate) return null;
  const b = new Date(`${birthDate}T00:00:00`);
  let age = now.getFullYear() - b.getFullYear();
  if (now < new Date(now.getFullYear(), b.getMonth(), b.getDate())) age--;
  return age;
}
function countWhere(predicate) {
  return db.prepare('SELECT birth_date, chronic FROM patients').all().filter(predicate).length;
}

setSetting('demo_mode', '1');
setSetting('setup_required', '0');
setSetting('clinic_name', 'สุขใจคลินิกเวชกรรม (ชุดทดลอง)');
setSetting('clinic_name_en', 'Sukjai Medical Clinic (Trial)');

// เติมคลังจากรายการมาตรฐานให้มีอย่างน้อย 30 รายการ พร้อมต้นทุน/ราคาขายสำหรับทดลองรายงาน
let lowSlots = 2; // รวม Salbutamol เดิมอีก 1 ตัว = ยาใกล้หมด 3 ตัว
for (const [index, item] of commonDrugs.entries()) {
  if (db.prepare('SELECT COUNT(*) c FROM drugs').get().c >= 30) break;
  if (db.prepare('SELECT id FROM drugs WHERE name = ?').get(item.name)) continue;
  const isLow = lowSlots > 0;
  const price = 2 + (index % 8) * 2.5;
  const cost = Math.max(0.25, Math.round(price * 0.42 * 100) / 100);
  const id = stock.upsertDrug({
    code: `TRIAL-${String(index + 1).padStart(3, '0')}`,
    name: item.name,
    generic_name: item.generic_name,
    unit: item.unit,
    price,
    cost,
    reorder_level: isLow ? 5 : 50,
    default_instructions: item.default_instructions,
    dose_mode: item.dose_mode,
  });
  stock.move(id, 'receive', isLow ? 3 : 800, { reason: 'ยอดตั้งต้นชุดทดลอง', userId: FRONT });
  if (isLow) lowSlots--;
}

// ให้ยาหลักพอสำหรับประวัติเรื้อรังหลายเดือน โดยผ่าน stock ledger เท่านั้น
for (const name of ['Amlodipine 5mg', 'Metformin 500mg']) {
  const d = db.prepare('SELECT id FROM drugs WHERE name = ?').get(name);
  if (d) stock.move(d.id, 'receive', 10000, { reason: 'สำรองสำหรับประวัติสังเคราะห์', userId: FRONT });
}

const firstNames = [
  'กมล', 'กาญจนา', 'ขวัญใจ', 'จันทร์เพ็ญ', 'ชลธิชา', 'ชาญชัย', 'ณรงค์', 'ดวงใจ', 'ธนพล', 'นภา',
  'นรินทร์', 'บัวบาน', 'ปกรณ์', 'ปิยะดา', 'พรชัย', 'พิมพ์ใจ', 'มยุรา', 'มนัส', 'รัตนา', 'วรพล',
  'วาสนา', 'วิชัย', 'ศศิธร', 'สมจิต', 'สมพร', 'สุนิสา', 'สุรชัย', 'อารีย์', 'อรุณ', 'อัญชลี',
  'แก้วตา', 'เดือนฉาย', 'เพ็ญศรี', 'เรืองฤทธิ์', 'เอกชัย', 'สายใจ', 'น้ำฝน', 'ต้นกล้า', 'ฟ้าใส', 'ภูผา',
];
const lastNames = [
  'ใจเย็น', 'อยู่สุข', 'เพิ่มพูน', 'มั่นคง', 'แสงทอง', 'บุญช่วย', 'ดีพร้อม', 'สุขสันต์', 'ชื่นใจ', 'คงดี',
  'งามพร้อม', 'รุ่งเรือง', 'มีสุข', 'ใจกล้า', 'ศรีสว่าง', 'ทองแท้', 'รักดี', 'สมบูรณ์', 'พูนผล', 'เย็นใจ',
];
let syntheticIndex = 0;
const newChronic = [];
const newPatients = [];

function registerSynthetic({ cohort, age, chronic = '', sex }) {
  syntheticIndex++;
  const resolvedSex = sex || (syntheticIndex % 2 ? 'F' : 'M');
  const child = cohort === 'child';
  const prefix = child
    ? (resolvedSex === 'F' ? 'ด.ญ.' : 'ด.ช.')
    : (resolvedSex === 'F' ? (age >= 50 ? 'นาง' : 'น.ส.') : 'นาย');
  const first = firstNames[(syntheticIndex * 7) % firstNames.length];
  const last = lastNames[(syntheticIndex * 11 + Math.floor(syntheticIndex / firstNames.length)) % lastNames.length];
  const citizen = syntheticIndex % 7 === 0 ? `9${String(syntheticIndex).padStart(12, '0')}` : null;
  const hn = patients.register({
    prefix,
    first_name: first,
    last_name: `${last}${syntheticIndex}`,
    sex: resolvedSex,
    birth_date: dateFromAge(age, (syntheticIndex % 12) + 1, (syntheticIndex % 24) + 1),
    citizen_id: citizen,
    phone: `000-${String(syntheticIndex).padStart(3, '0')}-${String(syntheticIndex * 13).padStart(4, '0').slice(-4)}`,
    address: syntheticAddress,
    chronic,
  }, FRONT);
  newPatients.push(hn);
  if (chronic) newChronic.push({ hn, chronic, index: syntheticIndex });
  return hn;
}

// ทำให้กลุ่มสำคัญครบตามเป้าหมาย โดยยอมให้ผู้สูงอายุซ้อนกับกลุ่มโรคเรื้อรังได้ตามชีวิตจริง
while (countWhere(p => ageFromBirth(p.birth_date) >= 65) < 20) {
  const chronic = syntheticIndex % 2 ? 'ความดันโลหิตสูง' : 'เบาหวานชนิดที่ 2';
  registerSynthetic({ cohort: 'elder', age: 67 + (syntheticIndex % 17), chronic });
}
while (countWhere(p => String(p.chronic || '').trim() !== '') < 30) {
  const chronic = syntheticIndex % 2 ? 'ความดันโลหิตสูง' : 'เบาหวานชนิดที่ 2';
  registerSynthetic({ cohort: 'chronic', age: 42 + (syntheticIndex % 19), chronic });
}
while (countWhere(p => ageFromBirth(p.birth_date) < 15) < 15) {
  registerSynthetic({ cohort: 'child', age: 4 + (syntheticIndex % 10) });
}
while (db.prepare('SELECT COUNT(*) c FROM patients').get().c < 100) {
  registerSynthetic({ cohort: 'general', age: 18 + (syntheticIndex % 42) });
}

const service = db.prepare("SELECT * FROM services WHERE name = 'ค่าตรวจรักษา'").get();
const issuer = {
  name: 'สุขใจคลินิกเวชกรรม (ชุดทดลอง)',
  address: '123/45 ถ.สุขสบาย ต.ในเมือง อ.เมือง จ.อุบลราชธานี 34000',
  phone: '045-123-456',
  tax_id: '', branch: '', book_no: '', clinic_license: '10101000164',
  logo_file: '', footer: '', vat_note: '',
};

function historicalVisit(profile, monthNo) {
  const date = monthsAgo(monthNo, 8 + (profile.index % 12));
  const when = `${date} 09:${pad(10 + (profile.index % 40))}:00`;
  const isDm = profile.chronic.includes('เบาหวาน');
  const drug = db.prepare('SELECT * FROM drugs WHERE name = ?').get(isDm ? 'Metformin 500mg' : 'Amlodipine 5mg');
  const qty = isDm ? 60 : 30;
  const systolic = 156 - (6 - monthNo) * 3 - (profile.index % 5);
  const diastolic = 94 - (6 - monthNo) * 2;
  const glucose = isDm ? 168 - (6 - monthNo) * 6 - (profile.index % 7) : null;
  const lines = [
    { type: 'drug', ref_id: drug.id, name: drug.name, qty, unit: drug.unit, price_each: drug.price, instructions: drug.default_instructions || '' },
    { type: 'service', ref_id: service.id, name: service.name, qty: 1, unit: 'ครั้ง', price_each: service.price, instructions: '' },
  ];

  txn(() => {
    const queueNo = nextCounter('queue', date);
    const visit = db.prepare(`INSERT INTO visits (hn, visit_date, queue_no, state, doctor_id,
        weight_kg, height_cm, temp_c, bp_sys, bp_dia, pulse, glucose,
        vitals_updated_by, vitals_updated_at, created_by, created_at, completed_at)
      VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, 36.7, ?, ?, 74, ?, ?, ?, ?, ?, ?)`)
      .run(profile.hn, date, queueNo, DOC,
        55 + (profile.index % 25), 150 + (profile.index % 25), systolic, diastolic, glucose,
        FRONT, when, FRONT, when, when);
    const visitId = Number(visit.lastInsertRowid);
    db.prepare(`INSERT INTO note_versions (visit_id, version, cc, pe, dx_text, icd10, note, vitals_json, created_by, created_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(visitId, 'มารับยาตามนัด', `BP ${systolic}/${diastolic}${glucose ? `, DTX ${glucose}` : ''}`,
        isDm ? 'Type 2 diabetes mellitus' : 'Essential hypertension', isDm ? 'E11.9' : 'I10',
        'รับประทานยาสม่ำเสมอ นัดติดตาม 1 เดือน',
        JSON.stringify({ weight_kg: 55 + (profile.index % 25), height_cm: 150 + (profile.index % 25), bp_sys: systolic, bp_dia: diastolic, glucose }),
        DOC, when);
    const order = db.prepare(`INSERT INTO order_versions (visit_id, version, lines_json, created_by, created_at)
      VALUES (?, 1, ?, ?, ?)`).run(visitId, JSON.stringify(lines), DOC, when);
    const orderVersionId = Number(order.lastInsertRowid);
    const receiptNo = nextReceiptNo();
    const patient = db.prepare('SELECT prefix, first_name, last_name, address FROM patients WHERE hn = ?').get(profile.hn);
    const patientName = `${patient.prefix || ''}${patient.first_name} ${patient.last_name || ''}`.trim();
    const subtotal = Math.round((drug.price * qty + service.price) * 100) / 100;
    db.prepare(`INSERT INTO receipts (receipt_no, visit_id, hn, patient_name, order_version_id,
        subtotal, discount, total, pay_method, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'cash', 'ISSUED', ?, ?)`)
      .run(receiptNo, visitId, profile.hn, patientName, orderVersionId, subtotal, subtotal, FRONT, when);
    const insertLine = db.prepare(`INSERT INTO receipt_lines
      (receipt_no, line_type, ref_id, name, qty, unit, price_each, amount, instructions, cost_each, item_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertLine.run(receiptNo, 'drug', drug.id, drug.name, qty, drug.unit, drug.price,
      Math.round(drug.price * qty * 100) / 100, drug.default_instructions || null, drug.cost ?? null, drug.code || null);
    insertLine.run(receiptNo, 'service', service.id, service.name, 1, 'ครั้ง', service.price, service.price, null, null, null);
    db.prepare(`INSERT INTO stock_movements (drug_id, type, qty, ref, reason, created_by, created_at)
      VALUES (?, 'dispense', ?, ?, NULL, ?, ?)`).run(drug.id, -qty, receiptNo, FRONT, when);
    db.prepare('UPDATE drugs SET qty_on_hand = ROUND(qty_on_hand - ?, 3) WHERE id = ?').run(qty, drug.id);
    db.prepare(`INSERT INTO receipt_document_snapshots
        (receipt_no, template_key, template_version, issuer_json, payer_json, payment_json, cashier_json, source, created_by, created_at)
      VALUES (?, 'receipt_a5', 2, ?, ?, ?, ?, 'new_issue', ?, ?)`)
      .run(receiptNo, JSON.stringify(issuer), JSON.stringify({ name: patientName, address: patient.address || '', tax_id: '' }),
        JSON.stringify({ method: 'cash', cash_received: subtotal, change: 0, transfer_ref: '' }),
        JSON.stringify({ name: front.display_name, doctor_name: doctor.display_name }), FRONT, when);
  });
}

// ประวัติ 6 เดือนสำหรับผู้ป่วยเรื้อรังที่เพิ่มใหม่ ทำให้กราฟและรายงานย้อนหลังมีข้อมูลจริงให้สำรวจ
for (const profile of newChronic) {
  for (let monthNo = 6; monthNo >= 1; monthNo--) historicalVisit(profile, monthNo);
}

// แพ้ยาอย่างน้อย 10 คน ครบกลุ่มที่ระบบต้องเตือน
const allergyKinds = [
  ['Penicillin', 'ผื่นแดงและหายใจไม่สะดวก'],
  ['NSAIDs', 'หน้าบวม'],
  ['Sulfa', 'ผื่นลมพิษ'],
];
let allergyCount = db.prepare(`SELECT COUNT(DISTINCT a.hn) c FROM allergy_log a
  WHERE a.action = 'add' AND NOT EXISTS (SELECT 1 FROM allergy_log r WHERE r.action = 'remove' AND r.ref_id = a.id)`).get().c;
const allergyCandidates = db.prepare(`SELECT p.hn FROM patients p WHERE NOT EXISTS (
  SELECT 1 FROM allergy_log a WHERE a.hn = p.hn AND a.action = 'add') ORDER BY p.hn`).all();
for (const [i, p] of allergyCandidates.entries()) {
  if (allergyCount >= 10) break;
  const [substance, reaction] = allergyKinds[i % allergyKinds.length];
  patients.addAllergy(p.hn, substance, reaction, DOC);
  allergyCount++;
}

// นัดล่วงหน้า 25 นัดใน 4 สัปดาห์ และจงใจให้วันที่สองมี 6 นัดเพื่อทดลองมองวันแน่น
const appointmentOffsets = [2, 2, 2, 2, 2, 2, 4, 5, 7, 8, 9, 11, 12, 14, 15, 16, 18, 19, 21, 22, 23, 25, 26, 27, 28];
let futureAppointmentCount = db.prepare(`SELECT COUNT(*) c FROM appointments
  WHERE cancelled = 0 AND appt_date > date('now', 'localtime')`).get().c;
let addedAppointments = 0;
const appointmentPatients = db.prepare('SELECT hn FROM patients ORDER BY hn').all();
while (futureAppointmentCount < 25) {
  const p = appointmentPatients[(addedAppointments * 7) % appointmentPatients.length];
  const days = appointmentOffsets[addedAppointments % appointmentOffsets.length];
  db.prepare(`INSERT INTO appointments (hn, visit_id, appt_date, days, note, created_by, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?)`).run(p.hn, futureDate(days), days,
      addedAppointments % 3 === 0 ? 'ติดตามอาการและรับยาต่อ' : 'นัดติดตาม', DOC, `${today} 08:00:00`);
  futureAppointmentCount++;
  addedAppointments++;
}

// ชุดยาตัวอย่างสำหรับทดลองปุ่มชุดยาและการปักดาว
if (db.prepare('SELECT COUNT(*) c FROM fav_sets').get().c === 0) {
  const favDefs = [
    ['ชุดหวัดผู้ใหญ่', 'J06.9', ['Paracetamol 500mg', 'Chlorpheniramine 4mg']],
    ['ชุดโรคกระเพาะ', 'K30', ['Omeprazole 20mg', 'Domperidone 10mg']],
    ['ชุดติดตามความดัน', 'I10', ['Amlodipine 5mg']],
  ];
  const insertFav = db.prepare(`INSERT INTO fav_sets (name, dx_text, icd10, lines_json, created_by)
    VALUES (?, ?, ?, ?, ?)`);
  for (const [name, icd, drugNames] of favDefs) {
    const lines = drugNames.map(drugName => {
      const d = db.prepare('SELECT * FROM drugs WHERE name = ?').get(drugName);
      if (!d) return null;
      return { type: 'drug', ref_id: d.id, name: d.name, qty: 10, unit: d.unit, price_each: d.price,
        instructions: d.default_instructions || '', dose_mode: d.dose_mode || 'manual' };
    }).filter(Boolean);
    insertFav.run(name, name.replace(/^ชุด/, ''), icd, JSON.stringify(lines), DOC);
  }
}

require('./seed-appointment-followup').seedAppointmentFollowup();

const summary = {
  patients: db.prepare('SELECT COUNT(*) c FROM patients').get().c,
  chronic: countWhere(p => String(p.chronic || '').trim() !== ''),
  children: countWhere(p => ageFromBirth(p.birth_date) < 15),
  elderly: countWhere(p => ageFromBirth(p.birth_date) >= 65),
  allergies: db.prepare(`SELECT COUNT(DISTINCT a.hn) c FROM allergy_log a WHERE a.action = 'add'
    AND NOT EXISTS (SELECT 1 FROM allergy_log r WHERE r.action = 'remove' AND r.ref_id = a.id)`).get().c,
  appointments: db.prepare(`SELECT COUNT(*) c FROM appointments
    WHERE cancelled = 0 AND appt_date > date('now', 'localtime')`).get().c,
  drugs: db.prepare('SELECT COUNT(*) c FROM drugs WHERE active = 1').get().c,
  receipts: db.prepare("SELECT COUNT(*) c FROM receipts WHERE status = 'ISSUED'").get().c,
};
console.log(`ชุดทดลองพร้อม: คนไข้ ${summary.patients} คน · เรื้อรัง ${summary.chronic} · เด็ก ${summary.children} · ผู้สูงอายุ ${summary.elderly}`);
console.log(`แพ้ยา ${summary.allergies} คน · นัดล่วงหน้า ${summary.appointments} นัด · ยา ${summary.drugs} รายการ · ใบเสร็จ ${summary.receipts} ใบ`);
