'use strict';
// Visit state machine — ทางเข้าเดียวของการเปลี่ยน state ทั้งระบบ (plan §2)
const { db, txn, now, today, nextQueueNo } = require('./db');
const notes = require('./notes');
const patients = require('./patients');
const doctors = require('./doctors');

const STATES = ['WAITING', 'IN_EXAM', 'DISPENSING', 'COMPLETED', 'CANCELLED'];

// event -> { from: [states], to }
const TRANSITIONS = {
  call: { from: ['WAITING'], to: 'IN_EXAM' },          // หมอเรียกตรวจ
  requeue: { from: ['IN_EXAM'], to: 'WAITING' },        // คืนคิว → ไปท้ายแถว
  finish_exam: { from: ['IN_EXAM'], to: 'DISPENSING' }, // จบตรวจ → promote note + ส่งจ่ายยา
  pay: { from: ['DISPENSING'], to: 'COMPLETED' },       // เรียกจาก billing txn เท่านั้น
  cancel: { from: ['WAITING', 'IN_EXAM', 'DISPENSING'], to: 'CANCELLED' },
  refund: { from: ['COMPLETED'], to: 'CANCELLED' },     // เรียกจาก billing refund txn เท่านั้น
};

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

function get(id) {
  return db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
}

function create(hn, userId, vitals = {}, cc = '', preferredDoctorId) {
  return txn(() => {
    const patient = db.prepare('SELECT hn, duplicate_of_hn FROM patients WHERE hn = ?').get(hn);
    if (!patient) throw err('ไม่พบคนไข้', 404);
    const useHn = patient.duplicate_of_hn || hn; // visit ใหม่ลง HN หลักเสมอ (plan A14)
    const open = db.prepare(`SELECT id FROM visits WHERE hn = ? AND state IN ('WAITING','IN_EXAM','DISPENSING')`).get(useHn);
    if (open) throw err(`คนไข้มีคิวค้างอยู่แล้ว (visit #${open.id})`);
    const scheduled = db.prepare('SELECT doctor_id FROM appointments WHERE hn=? AND appt_date=? AND cancelled=0 ORDER BY id DESC LIMIT 1').get(useHn,today());
    const preferred = preferredDoctorId === undefined ? (scheduled?.doctor_id ?? null) : doctors.validate(preferredDoctorId);
    const queueNo = nextQueueNo();
    const r = db.prepare(`INSERT INTO visits (hn, visit_date, queue_no, state, created_by, created_at,
        weight_kg, height_cm, temp_c, bp_sys, bp_dia, pulse, glucose, vitals_updated_by, vitals_updated_at)
      VALUES (?, ?, ?, 'WAITING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(useHn, today(), queueNo, userId, now(),
        vitals.weight_kg || null, vitals.height_cm || null, vitals.temp_c || null,
        vitals.bp_sys || null, vitals.bp_dia || null, vitals.pulse || null, vitals.glucose || null,
        Object.keys(vitals).length ? userId : null, Object.keys(vitals).length ? now() : null);
    const visitId = Number(r.lastInsertRowid);
    db.prepare('UPDATE visits SET preferred_doctor_id=? WHERE id=?').run(preferred,visitId);
    // front บันทึก "มาด้วยอาการ" ตอนรับเข้าคิว → ลง draft ให้หมอเห็นในคิวและ prefill ช่อง CC (UAT B4)
    const chiefComplaint = String(cc || '').trim().slice(0, 500);
    if (chiefComplaint) notes.saveDraft(visitId, { cc: chiefComplaint }, userId);
    return { id: visitId, queue_no: queueNo };
  });
}

// ทางเข้าเดียว: ตรวจความถูกต้องของ event + side effects ต่อ event ในที่เดียว
function transition(visitId, event, userId, opts = {}) {
  const t = TRANSITIONS[event];
  if (!t) throw err(`ไม่รู้จัก event: ${event}`);
  return txn(() => {
    const v = get(visitId);
    if (!v) throw err('ไม่พบ visit', 404);
    if (!t.from.includes(v.state)) {
      if(event==='call'){
        const owner=v.doctor_id&&db.prepare('SELECT display_name FROM users WHERE id=?').get(v.doctor_id);
        throw err(v.state==='IN_EXAM'?`${doctors.multiple()&&owner?owner.display_name:'หมอ'}เรียกคิวที่ ${v.queue_no} แล้ว กรุณาดูคิวล่าสุดก่อนเลือกคนไข้`:`คิวที่ ${v.queue_no} ไม่ได้รอตรวจแล้ว กรุณาดูคิวล่าสุดก่อนเลือกคนไข้`,409);
      }
      throw err(`ทำไม่ได้: visit อยู่สถานะ ${v.state}`,409);
    }

    const sets = ['state = ?'];
    const vals = [t.to];

    if (event === 'call') { sets.push('doctor_id = ?'); vals.push(userId); }
    if(event==='requeue'){
      // Monotonic round identity, including repeated requeues within one second.
      const previous=v.requeued_at?new Date(v.requeued_at.replace(' ','T')).getTime():0;
      const stamp=new Date(Math.max(Date.now(),Number.isFinite(previous)?previous+1:0));
      const local=new Date(stamp.getTime()-stamp.getTimezoneOffset()*60000).toISOString().replace('T',' ').replace('Z','');
      sets.push('requeued_at = ?');vals.push(local);
    }
    if (event === 'finish_exam') {
      // promote draft → note version ใน txn เดียวกัน: จบ visit โดยไม่มีเวชระเบียนเป็นไปไม่ได้
      notes.commitNoteFromDraft(v, userId);
      if (!notes.latestOrderVersion(visitId)) notes.saveOrderVersion(visitId, [], null, userId);
    }
    if (event === 'pay') { sets.push('completed_at = ?'); vals.push(now()); }
    if (event === 'cancel' || event === 'refund') {
      if (!opts.reason) throw err('ต้องระบุเหตุผลการยกเลิก');
      sets.push('cancel_reason = ?'); vals.push(opts.reason);
    }
    vals.push(visitId, v.state);
    // guard ด้วย state เดิมกัน race (สอง request ชน txn serialize อยู่แล้ว แต่กันไว้อีกชั้น)
    const r = db.prepare(`UPDATE visits SET ${sets.join(', ')} WHERE id = ? AND state = ?`).run(...vals);
    if (r.changes !== 1) throw err('สถานะเปลี่ยนไปแล้ว กรุณา refresh', 409);
    return get(visitId);
  });
}

// จบตรวจแบบ request เดียว: note + order + state อยู่ใน transaction เดียวกัน
// ถ้าส่วนใดล้มเหลว ทุกส่วน rollback เพื่อไม่ทิ้ง visit ครึ่งทาง
function finishExam(visitId, { note, lines, baseVersionId, allergyAck } = {}, userId) {
  return txn(() => {
    const v = get(visitId);
    if (!v) throw err('ไม่พบ visit', 404);
    if (v.state !== 'IN_EXAM') throw err(`ทำไม่ได้: visit อยู่สถานะ ${v.state}`, 409);
    if (v.doctor_id !== userId) throw err('จบตรวจได้เฉพาะแพทย์เจ้าของ visit', 403);
    // ด่านแพ้ยา (S1): มีรายการชนประวัติแพ้ → ต้องยืนยันจากหน้าจอเท่านั้นถึงผ่าน
    const conflicts = patients.allergyConflicts(v.hn, lines || []);
    if (conflicts.length && !allergyAck) {
      const detail = conflicts.map(c => `แพ้ ${c.substance} แต่รายการมี ${c.drug}`).join(' · ');
      throw err(`คนไข้มีประวัติแพ้ยาชนกับรายการ: ${detail} — ต้องยืนยันบนหน้าจอก่อนจบตรวจ`, 409);
    }
    notes.saveDraft(visitId, note || {}, userId);
    const order = notes.saveOrderVersion(visitId, lines || [], null, userId, baseVersionId);
    const visit = transition(visitId, 'finish_exam', userId);
    return { visit, order };
  });
}

function updateVitals(visitId, vitals, userId) {
  const v = get(visitId);
  if (!v) throw err('ไม่พบ visit', 404);
  if (['COMPLETED', 'CANCELLED'].includes(v.state)) throw err('visit ปิดแล้ว แก้ vitals ไม่ได้', 409);
  db.prepare(`UPDATE visits SET weight_kg = ?, height_cm = ?, temp_c = ?, bp_sys = ?, bp_dia = ?, pulse = ?, glucose = ?,
      vitals_updated_by = ?, vitals_updated_at = ? WHERE id = ?`)
    .run(vitals.weight_kg || null, vitals.height_cm || null, vitals.temp_c || null,
      vitals.bp_sys || null, vitals.bp_dia || null, vitals.pulse || null, vitals.glucose || null,
      userId, now(), visitId);
}

// คิววันนี้เท่านั้น — visit ค้างข้ามวันไม่ปน (plan finding 15); คืนคิวแล้วไปท้ายแถว
function todayQueue() {
  // cc: ร่างของหมอ/ที่ front กรอกตอนรับคิวมาก่อน ถ้าไม่มีค่อยดูจาก note ที่ commit แล้ว (UAT B3)
  return db.prepare(`
    SELECT v.*, p.prefix, p.first_name, p.last_name, p.birth_date, p.chronic,
           u.display_name AS doctor_name, pref.display_name AS preferred_doctor_name,
           COALESCE(json_extract(d.payload_json, '$.cc'),
             (SELECT nv.cc FROM note_versions nv WHERE nv.visit_id = v.id ORDER BY nv.version DESC LIMIT 1)) AS cc
    FROM visits v JOIN patients p ON p.hn = v.hn
    LEFT JOIN users u ON u.id = v.doctor_id
    LEFT JOIN users pref ON pref.id = v.preferred_doctor_id
    LEFT JOIN note_drafts d ON d.visit_id = v.id
    WHERE v.visit_date = ?
    ORDER BY COALESCE(v.requeued_at, v.created_at)`).all(today());
}

// visit ตกค้างข้ามวัน — ทางออกมีแค่ cancel หรือเข้า flow จ่ายเงินปกติ (liveness, plan finding 17)
function stale() {
  return db.prepare(`
    SELECT v.*, p.prefix, p.first_name, p.last_name FROM visits v JOIN patients p ON p.hn = v.hn
    WHERE v.visit_date < ? AND v.state IN ('WAITING','IN_EXAM','DISPENSING')
    ORDER BY v.visit_date, v.queue_no`).all(today());
}

// vitals ล่าสุดจาก visit ก่อนหน้า — ใช้เติมส่วนสูง + โชว์ค่าเดิมตอนวัดรอบใหม่
function lastVitals(hn, excludeVisitId = 0) {
  return db.prepare(`
    SELECT visit_date, weight_kg, height_cm, temp_c, bp_sys, bp_dia, pulse, glucose FROM visits
    WHERE hn = ? AND id != ? AND state != 'CANCELLED'
      AND (weight_kg IS NOT NULL OR height_cm IS NOT NULL OR bp_sys IS NOT NULL
           OR temp_c IS NOT NULL OR pulse IS NOT NULL OR glucose IS NOT NULL)
    ORDER BY id DESC LIMIT 1`).get(hn, excludeVisitId) || null;
}

// ข้อมูลกราฟ BP/น้ำตาล/น้ำหนัก ตามเวลา (เคสหลักคลินิก: HT/DM)
function trends(hn) {
  return db.prepare(`
    SELECT visit_date, bp_sys, bp_dia, pulse, glucose, weight_kg FROM visits
    WHERE hn = ? AND state != 'CANCELLED'
      AND (bp_sys IS NOT NULL OR glucose IS NOT NULL OR weight_kg IS NOT NULL)
    ORDER BY visit_date, id`).all(hn);
}

function history(hn, limit = 50) {
  const visits = db.prepare(`
    SELECT v.id, v.visit_date, v.queue_no, v.state, v.weight_kg, v.temp_c, v.bp_sys, v.bp_dia, v.pulse, v.glucose,
           u.display_name AS doctor_name
    FROM visits v LEFT JOIN users u ON u.id = v.doctor_id
    WHERE v.hn = ? AND v.state != 'CANCELLED'
    ORDER BY v.id DESC LIMIT ?`).all(hn, limit);
  const noteQ = db.prepare('SELECT * FROM note_versions WHERE visit_id = ? ORDER BY version DESC LIMIT 1');
  const orderQ = db.prepare('SELECT * FROM order_versions WHERE visit_id = ? ORDER BY version DESC LIMIT 1');
  for (const v of visits) {
    v.note = noteQ.get(v.id) || null;
    const ov = orderQ.get(v.id);
    v.order_lines = ov ? JSON.parse(ov.lines_json) : [];
  }
  return visits;
}

module.exports = { STATES, TRANSITIONS, get, create, transition, finishExam, updateVitals, todayQueue, stale, history, lastVitals, trends };
