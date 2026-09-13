'use strict';
// Seed ข้อมูลตั้งต้น: admin user + ค่าบริการพื้นฐาน + ICD-10 ชุดที่พบบ่อยในคลินิก GP
// รัน: npm run seed  (เพิ่ม --demo เพื่อใส่ยา/คนไข้ตัวอย่างสำหรับ UAT)
const { db, setSetting } = require('./lib/db');
const auth = require('./lib/auth');
const stock = require('./lib/stock');

const demo = process.argv.includes('--demo');

function haveUsers() { return db.prepare('SELECT COUNT(*) c FROM users').get().c > 0; }

if (!haveUsers()) {
  auth.createUser({ username: 'admin', displayName: 'ผู้ดูแลระบบ', role: 'admin', password: 'admin1234', pin: '9999' });
  console.log('สร้างผู้ใช้ admin แล้ว (รหัสผ่าน: admin1234 — เปลี่ยนทันทีที่หน้า "ตั้งค่า")');
  setSetting('clinic_name', 'คลินิกเวชกรรม');
  setSetting('setup_required', '1');
} else {
  console.log('มีผู้ใช้อยู่แล้ว — ข้ามการสร้าง admin');
}

// ค่าบริการพื้นฐาน (finding 3: บิลต้องมีมากกว่ายา)
if (db.prepare('SELECT COUNT(*) c FROM services').get().c === 0) {
  for (const [name, price] of [['ค่าตรวจรักษา', 100], ['ค่าทำแผล', 100], ['ค่าฉีดยา', 50], ['ค่าเย็บแผล', 300]]) {
    stock.upsertService({ name, price });
  }
  console.log('เพิ่มค่าบริการพื้นฐาน 4 รายการ');
}

// ICD-10 ชุดพบบ่อยในคลินิก GP (ค้นได้ ไม่บังคับใช้ — brief §2)
const ICD = [
  ['J00', 'Acute nasopharyngitis (common cold)', 'หวัด'],
  ['J02.9', 'Acute pharyngitis, unspecified', 'คออักเสบ'],
  ['J06.9', 'Acute upper respiratory infection', 'URI ติดเชื้อทางเดินหายใจส่วนบน'],
  ['J20.9', 'Acute bronchitis', 'หลอดลมอักเสบเฉียบพลัน'],
  ['J45.9', 'Asthma, unspecified', 'หอบหืด'],
  ['A09', 'Diarrhoea and gastroenteritis', 'ท้องเสีย ลำไส้อักเสบ'],
  ['K30', 'Functional dyspepsia', 'อาหารไม่ย่อย/โรคกระเพาะ'],
  ['K29.7', 'Gastritis, unspecified', 'กระเพาะอักเสบ'],
  ['R51', 'Headache', 'ปวดศีรษะ'],
  ['G43.9', 'Migraine, unspecified', 'ไมเกรน'],
  ['M62.6', 'Muscle strain', 'กล้ามเนื้ออักเสบ/ยอก'],
  ['M54.5', 'Low back pain', 'ปวดหลังส่วนล่าง'],
  ['M79.1', 'Myalgia', 'ปวดกล้ามเนื้อ'],
  ['I10', 'Essential (primary) hypertension', 'ความดันโลหิตสูง'],
  ['E11.9', 'Type 2 diabetes mellitus', 'เบาหวานชนิดที่ 2'],
  ['E78.5', 'Hyperlipidaemia, unspecified', 'ไขมันในเลือดสูง'],
  ['L23.9', 'Allergic contact dermatitis', 'ผื่นแพ้สัมผัส'],
  ['L50.9', 'Urticaria, unspecified', 'ลมพิษ'],
  ['H10.9', 'Conjunctivitis, unspecified', 'ตาแดง เยื่อบุตาอักเสบ'],
  ['N39.0', 'Urinary tract infection', 'ติดเชื้อทางเดินปัสสาวะ'],
  ['R42', 'Dizziness and giddiness', 'เวียนศีรษะ'],
  ['R50.9', 'Fever, unspecified', 'ไข้'],
  ['T14.0', 'Superficial injury', 'แผลถลอก/ฟกช้ำ'],
  ['T14.1', 'Open wound', 'แผลเปิด'],
  ['B34.9', 'Viral infection, unspecified', 'ติดเชื้อไวรัส'],
  ['J03.9', 'Acute tonsillitis', 'ทอนซิลอักเสบ'],
  ['H66.9', 'Otitis media, unspecified', 'หูชั้นกลางอักเสบ'],
  ['K59.0', 'Constipation', 'ท้องผูก'],
  ['R11', 'Nausea and vomiting', 'คลื่นไส้อาเจียน'],
  ['Z00.0', 'General medical examination', 'ตรวจสุขภาพทั่วไป'],
];
const insIcd = db.prepare('INSERT INTO icd10 (code, term_en, term_th) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING');
for (const [c, en, th] of ICD) insIcd.run(c, en, th);
console.log(`ICD-10 พร้อมใช้ ${ICD.length} รหัส`);

if (demo) {
  setSetting('demo_mode', '1');
  auth.createUser({ username: 'doctor', displayName: 'นพ.ทดสอบ ระบบดี', role: 'doctor', password: 'doctor123', pin: '1111' });
  auth.createUser({ username: 'front', displayName: 'คุณหน้า บ้านคลินิก', role: 'front', password: 'front123', pin: '2222' });
  const DRUGS = [
    ['Paracetamol 500mg', 'เม็ด', 2, 0.5, 500, 100, 'ครั้งละ 1-2 เม็ด ทุก 4-6 ชม. เวลาปวด/มีไข้'],
    ['Amoxicillin 500mg', 'แคปซูล', 5, 2.2, 300, 50, 'ครั้งละ 1 แคปซูล วันละ 3 ครั้ง หลังอาหาร จนหมด'],
    ['Cetirizine 10mg', 'เม็ด', 3, 0.9, 200, 30, 'ครั้งละ 1 เม็ด วันละ 1 ครั้ง ก่อนนอน'],
    ['Omeprazole 20mg', 'แคปซูล', 4, 1.3, 200, 30, 'ครั้งละ 1 แคปซูล วันละ 1 ครั้ง ก่อนอาหารเช้า'],
    ['CPM 4mg', 'เม็ด', 1, 0.15, 300, 50, 'ครั้งละ 1 เม็ด วันละ 3 ครั้ง (อาจง่วง)'],
    ['Ibuprofen 400mg', 'เม็ด', 3, 0.8, 200, 40, 'ครั้งละ 1 เม็ด วันละ 3 ครั้ง หลังอาหารทันที'],
    ['ORS ผงเกลือแร่', 'ซอง', 5, 2.0, 100, 20, 'ละลายน้ำ 250 มล. จิบบ่อยๆ'],
    ['Amlodipine 5mg', 'เม็ด', 3, 0.7, 300, 60, 'ครั้งละ 1 เม็ด วันละ 1 ครั้ง เช้า'],
  ];
  for (const [name, unit, price, cost, qty, reorder, instr] of DRUGS) {
    const id = stock.upsertDrug({ name, unit, price, cost, reorder_level: reorder, default_instructions: instr });
    stock.move(id, 'receive', qty, { reason: 'ยอดตั้งต้น (demo)', userId: 1 });
  }
  console.log(`เพิ่มผู้ใช้ demo (doctor/doctor123, front/front123) + ยา ${DRUGS.length} ตัว`);
}
console.log('seed เสร็จ');
