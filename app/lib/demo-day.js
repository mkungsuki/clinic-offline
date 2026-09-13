'use strict';
// "เปิดวันใหม่ให้ชุดทดลอง" — ทำงานเฉพาะฐานที่ demo_mode = '1' (ชุดทดลอง) เท่านั้น ชุดจริงไม่แตะเด็ดขาด
//
// ปัญหาจริง (เจ้าของ 2026-08-17): seed-mock-day สร้าง "วันคลินิก" ณ วันติดตั้ง พอข้ามวัน คิววันนี้ว่าง +
// visit 7 รายกลายเป็น "ตกค้าง (ข้ามวัน)" ทุกเช้า → หมอที่ทดลองเห็นแต่หน้าว่าง
//
// สิ่งที่ทำ (เมื่อ demo และ "วันนี้ยังไม่มี visit เลย"):
//   1. ปิด visit ค้างจากวันก่อน (WAITING/IN_EXAM/DISPENSING) เป็นยกเลิก ผ่าน visits.transition('cancel') ปกติ
//      พร้อมเหตุผล — ไม่แตะ stock/บิล (cancel ไม่มีผลต่อ stock ตามกติกา)
//   2. สร้างคิววันนี้ชุดเดิม 7 ราย (คนไข้ mock ชุดเดียวกับ seed-mock-day ส่วนที่ 3): รอตรวจ 4 (มีไข้สูง/BP สูง/
//      เด็กยังไม่วัด vitals), กำลังตรวจ 1, รอเก็บเงิน 2 (1 รายมีส่วนลด) — ผ่าน visits.create/transition/finishExam
//      ของจริง จึงได้ queue_no/note/order/แพ้ยา ตามกติกาเดียวกับหน้าจอ
// สิ่งที่ "ไม่ทำ": ถ้าวันนี้มี visit แล้ว (หมอลงทะเบียนเองไปแล้ว) → ไม่ยุ่ง · ไม่สร้างบิลย้อนหลัง (รายงานวันใหม่เริ่มศูนย์
//   เหมือนคลินิกจริง) · ไม่ลงทะเบียนคนไข้ใหม่ (ถ้าหาคนไข้ mock ไม่เจอ ข้ามรายนั้น)
// เรียกจาก server.js ตอนบูต + ทุก 10 นาที (จับข้ามเที่ยงคืนขณะ server เปิดค้าง)
const { db, txn, today, getSetting } = require('./db');
const visits = require('./visits');

const CANCEL_REASON = 'ข้ามวัน — ชุดทดลองปิดวันให้อัตโนมัติ';

// คิววันนี้ชุดเดิม (ชื่อตรงกับ seed-mock-day ส่วนที่ 3) — ลำดับ = ลำดับคิว
const TODAY_QUEUE = [
  { first: 'สายฝน', last: 'ครืดคราด', state: 'DISPENSING', vitals: { weight_kg: 55, height_cm: 159, temp_c: 37.6, pulse: 82 },
    cc: 'ไอ เจ็บคอ น้ำมูก 3 วัน',
    note: { cc: 'ไอ เจ็บคอ น้ำมูก 3 วัน', pe: 'pharynx แดง tonsil ไม่โต ปอดปกติ', dx_text: 'URI', icd10: 'J06.9', note: 'พัก ดื่มน้ำอุ่น' },
    lines: [['drug', 'Paracetamol 500mg', 10], ['drug', 'CPM 4mg', 10], ['drug', 'Cetirizine 10mg', 5, 'ครั้งละ 1 เม็ด ก่อนนอน ถ้าคัดจมูกมาก'], ['service', 'ค่าตรวจรักษา', 1]] },
  { first: 'ประเสริฐ', last: 'ถ่ายคล่อง', state: 'DISPENSING', vitals: { weight_kg: 58, height_cm: 163, temp_c: 36.9, bp_sys: 126, bp_dia: 80, pulse: 78 },
    cc: 'ถ่ายเหลว 3 ครั้งเช้านี้',
    note: { cc: 'ถ่ายเหลว 3 ครั้งเช้านี้', pe: 'ท้องนิ่ม ไม่ dehydrate', dx_text: 'Acute diarrhea', icd10: 'A09', note: 'ผู้สูงอายุ — เน้นจิบ ORS บ่อยๆ' },
    lines: [['drug', 'ORS ผงเกลือแร่', 5], ['service', 'ค่าตรวจรักษา', 1], ['discount', 'ส่วนลดผู้สูงอายุ', 30]] },
  { first: 'เกรียงไกร', last: 'ท้องอืด', state: 'IN_EXAM', vitals: { weight_kg: 74, height_cm: 168, temp_c: 36.8, bp_sys: 124, bp_dia: 80, pulse: 72 }, cc: 'ท้องอืด แน่นท้องหลังอาหาร' },
  { first: 'สมพร', last: 'มีสุข', state: 'WAITING', vitals: { weight_kg: 69.2, height_cm: 155, bp_sys: 138, bp_dia: 84, pulse: 76, glucose: 132 }, cc: 'มารับยาตามนัด' },
  { first: 'อาทิตย์', last: 'ร้อนรุ่ม', state: 'WAITING', vitals: { weight_kg: 64, height_cm: 174, temp_c: 38.9, pulse: 102 }, cc: 'ไข้สูง ปวดเมื่อยตัว 2 วัน' },
  { first: 'ลำดวน', last: 'ตึงต้นคอ', state: 'WAITING', vitals: { weight_kg: 66, height_cm: 156, bp_sys: 172, bp_dia: 98, pulse: 88 }, cc: 'ปวดตึงต้นคอ มึนหัว' },
  { first: 'ข้าวหอม', last: 'คันยิก', state: 'WAITING', vitals: {}, cc: 'ผื่นคันตามตัว' }, // ยังไม่วัด vitals — ให้ทดลองวัดเอง
];

function isDemo() { return getSetting('demo_mode', '0') === '1'; }

function findPatientHn(first, last) {
  const p = db.prepare(`SELECT hn, duplicate_of_hn FROM patients WHERE first_name = ? AND last_name = ? ORDER BY hn LIMIT 1`).get(first, last);
  return p ? (p.duplicate_of_hn || p.hn) : null;
}

function buildLines(defs) {
  const out = [];
  for (const [kind, name, qty, instructions] of defs) {
    if (kind === 'discount') { out.push({ type: 'discount', name, price_each: -qty }); continue; }
    const row = kind === 'drug'
      ? db.prepare('SELECT id, default_instructions FROM drugs WHERE name = ? AND active = 1').get(name)
      : db.prepare('SELECT id FROM services WHERE name = ?').get(name);
    if (!row) continue; // ยา/บริการไม่มีในฐานนี้ → ข้ามรายการ ไม่ล้มทั้งวัน
    out.push(kind === 'drug'
      ? { type: 'drug', ref_id: row.id, qty, instructions: instructions ?? (row.default_instructions || '') }
      : { type: 'service', ref_id: row.id, qty });
  }
  return out;
}

// คืน { skipped: เหตุผล } เมื่อไม่ทำอะไร หรือ { cancelled, created } เมื่อเปิดวันใหม่แล้ว
function rolloverDemoDay() {
  if (!isDemo()) return { skipped: 'not_demo' };
  const day = today();
  if (db.prepare('SELECT COUNT(*) c FROM visits WHERE visit_date = ?').get(day).c > 0) return { skipped: 'has_visits_today' };
  // ต้องเป็นฐานที่มีคนไข้ mock ชุดเดิมจริง — ฐาน demo อื่น (เช่น test-http ที่ seed --demo เปล่า) ไม่ยุ่งเลย แม้จะมี visit ค้าง
  if (!TODAY_QUEUE.some(item => findPatientHn(item.first, item.last))) return { skipped: 'no_mock_patients' };
  const doctor = db.prepare("SELECT id FROM users WHERE role = 'doctor' AND active = 1 ORDER BY id LIMIT 1").get();
  const front = db.prepare("SELECT id FROM users WHERE role = 'front' AND active = 1 ORDER BY id LIMIT 1").get();
  if (!doctor || !front) return { skipped: 'no_users' };
  return txn(() => {
    // 1) ปิด visit ค้างข้ามวันทั้งหมด (ต้องทำก่อน เพราะ create ห้ามคนไข้มีคิวค้าง)
    let cancelled = 0;
    for (const v of visits.stale()) {
      visits.transition(v.id, 'cancel', front.id, { reason: CANCEL_REASON });
      cancelled++;
    }
    // 2) คิววันนี้ชุดเดิม
    const created = [];
    for (const item of TODAY_QUEUE) {
      const hn = findPatientHn(item.first, item.last);
      if (!hn) continue;
      if (db.prepare(`SELECT id FROM visits WHERE hn = ? AND state IN ('WAITING','IN_EXAM','DISPENSING')`).get(hn)) continue;
      const { id } = visits.create(hn, front.id, item.vitals, item.cc);
      if (item.state === 'IN_EXAM' || item.state === 'DISPENSING') visits.transition(id, 'call', doctor.id);
      if (item.state === 'DISPENSING') {
        visits.finishExam(id, { note: item.note, lines: buildLines(item.lines || []), allergyAck: true }, doctor.id);
      }
      created.push({ id, hn, state: item.state });
    }
    return { cancelled, created: created.length, day };
  });
}

// hook สำหรับ server: บูต + ตามรอบ · ห้าม throw ออกไปล้ม server — บันทึก log แล้วปล่อยผ่าน
function runSafely(log = console) {
  try {
    const r = rolloverDemoDay();
    if (!r.skipped) log.log(`[demo] เปิดวันใหม่ ${r.day}: ปิดคิวค้าง ${r.cancelled} · สร้างคิววันนี้ ${r.created}`);
    return r;
  } catch (error) {
    log.error('[demo] เปิดวันใหม่ไม่สำเร็จ (ไม่กระทบระบบ):', error.message);
    return { skipped: 'error', error: error.message };
  }
}

module.exports = { rolloverDemoDay, runSafely, TODAY_QUEUE, CANCEL_REASON };
