'use strict';
// นัด follow-up: หนึ่งคนไข้มีนัดล่วงหน้า active ได้ 1 นัด (ตั้งใหม่ = แทนของเดิม)
const { db, txn, now, today } = require('./db');

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
function pad(n) { return String(n).padStart(2, '0'); }
function addDays(dateStr, n) {
  const dt = new Date(dateStr + 'T00:00:00');
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function diffDays(from, to) {
  return Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000);
}

function create(visitId, { days, date, note }, userId) {
  const v = db.prepare('SELECT hn FROM visits WHERE id = ?').get(visitId);
  if (!v) throw err('ไม่พบ visit', 404);
  let apptDate, d;
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err('รูปแบบวันที่ไม่ถูกต้อง');
    if (date <= today()) throw err('วันนัดต้องเป็นวันหน้า');
    apptDate = date;
    d = diffDays(today(), date);
  } else {
    d = Math.floor(Number(days));
    if (!d || d <= 0 || d > 400) throw err('จำนวนวันนัดไม่ถูกต้อง');
    apptDate = addDays(today(), d);
  }
  return txn(() => {
    // ตั้งนัดใหม่แทนนัด active เดิมของคนไข้คนนี้
    db.prepare(`UPDATE appointments SET cancelled = 1 WHERE hn = ? AND cancelled = 0 AND appt_date >= ?`)
      .run(v.hn, today());
    const r = db.prepare(`INSERT INTO appointments (hn, visit_id, appt_date, days, note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(v.hn, visitId, apptDate, d, note || null, userId, now());
    return db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(r.lastInsertRowid));
  });
}

function cancel(id) {
  const r = db.prepare('UPDATE appointments SET cancelled = 1 WHERE id = ? AND cancelled = 0').run(id);
  if (!r.changes) throw err('ไม่พบนัด หรือถูกยกเลิกไปแล้ว', 404);
}

// เลื่อนนัดในที่เดียว: เปลี่ยนวัน (และ note ถ้าส่งมา) โดยคงตัวนัดเดิม (UAT D2)
function reschedule(id, { date, days, note }, userId) {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ? AND cancelled = 0').get(id);
  if (!a) throw err('ไม่พบนัด หรือถูกยกเลิกไปแล้ว', 404);
  let apptDate;
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw err('รูปแบบวันที่ไม่ถูกต้อง');
    if (date <= today()) throw err('วันนัดต้องเป็นวันหน้า');
    apptDate = date;
  } else {
    const d = Math.floor(Number(days));
    if (!d || d <= 0 || d > 400) throw err('จำนวนวันนัดไม่ถูกต้อง');
    apptDate = addDays(today(), d);
  }
  db.prepare('UPDATE appointments SET appt_date = ?, days = ?, note = COALESCE(?, note) WHERE id = ?')
    .run(apptDate, diffDays(today(), apptDate), note !== undefined ? (note || null) : null, id);
  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
}

function forMonth(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym)) throw err('รูปแบบเดือนไม่ถูกต้อง');
  return db.prepare(`
    SELECT a.id, a.appt_date, a.days, a.note, a.hn,
           p.prefix, p.first_name, p.last_name, p.phone, p.chronic
    FROM appointments a JOIN patients p ON p.hn = a.hn
    WHERE a.cancelled = 0 AND a.appt_date LIKE ?
    ORDER BY a.appt_date, a.id`).all(ym + '-%');
}

function upcomingForPatient(hn) {
  return db.prepare(`SELECT * FROM appointments WHERE hn = ? AND cancelled = 0 AND appt_date >= ?
    ORDER BY appt_date LIMIT 1`).get(hn, today()) || null;
}

module.exports = { create, cancel, reschedule, forMonth, upcomingForPatient, diffDays };
