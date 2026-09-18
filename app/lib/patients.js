'use strict';
const { db, txn, now, nextHN } = require('./db');
const audit = require('./audit');

function normPhone(p) { return String(p || '').replace(/[^0-9]/g, ''); }
function escLike(s) { return String(s).replace(/[%_\\]/g, c => '\\' + c); }

// ลงทะเบียน: บังคับแค่ ชื่อ + เพศ (+อายุหรือวันเกิด ถ้ามี) ตาม principle "free text first"
function register(data, userId) {
  return txn(() => {
    const hn = nextHN();
    db.prepare(`INSERT INTO patients (hn, prefix, first_name, last_name, sex, birth_date, citizen_id, phone, phone_norm, address, chronic, emergency_name, emergency_phone, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hn, data.prefix || '', data.first_name.trim(), (data.last_name || '').trim(), data.sex,
        data.birth_date || null, data.citizen_id || null, data.phone || null, normPhone(data.phone) || null,
        data.address || null, data.chronic || '', data.emergency_name || null, data.emergency_phone || null,
        now(), userId);
    if (data.allergies) {
      for (const a of String(data.allergies).split(/[,\n]/).map(s => s.trim()).filter(Boolean)) {
        db.prepare(`INSERT INTO allergy_log (hn, action, substance, created_by, created_at) VALUES (?, 'add', ?, ?, ?)`)
          .run(hn, a, userId, now());
      }
    }
    return hn;
  });
}

function update(hn, data, userId) {
  return txn(() => {
  const before = db.prepare('SELECT * FROM patients WHERE hn=?').get(hn);
  if (!before) throw Object.assign(new Error('ไม่พบคนไข้'), {status:404});
  const fields = ['prefix', 'first_name', 'last_name', 'sex', 'birth_date', 'citizen_id', 'phone', 'address', 'chronic', 'emergency_name', 'emergency_phone'];
  const sets = [], vals = [];
  for (const f of fields) if (f in data) { sets.push(`${f} = ?`); vals.push(data[f] === '' ? null : data[f]); }
  if ('phone' in data) { sets.push('phone_norm = ?'); vals.push(normPhone(data.phone) || null); }
  if (!sets.length) return;
  sets.push('updated_at = ?', 'updated_by = ?');
  vals.push(now(), userId, hn);
  db.prepare(`UPDATE patients SET ${sets.join(', ')} WHERE hn = ?`).run(...vals);
  audit.record({category:'patient',entityId:hn,ref:hn,before,after:db.prepare('SELECT * FROM patients WHERE hn=?').get(hn),actorId:userId});
  });
}

// ค้นหา: ชื่อบางส่วน/เบอร์/HN/ปชช. — LIKE scan เร็วพอที่หลักหมื่น row (plan A4)
function search(q, limit = 20) {
  q = String(q || '').trim();
  if (!q) return [];
  const like = `%${escLike(q)}%`;
  const digits = normPhone(q);
  return db.prepare(`
    SELECT hn, prefix, first_name, last_name, sex, birth_date, phone, chronic FROM patients
    WHERE duplicate_of_hn IS NULL AND (
      hn LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\'
      OR (first_name || ' ' || last_name) LIKE ? ESCAPE '\\'
      OR (? != '' AND (phone_norm LIKE ? OR citizen_id LIKE ?))
    )
    ORDER BY first_name LIMIT ?`)
    .all(like, like, like, like, digits, `%${digits}%`, `%${digits}%`, limit);
}

function get(hn) {
  const p = db.prepare('SELECT * FROM patients WHERE hn = ?').get(hn);
  if (!p) return null;
  p.allergies = activeAllergies(hn);
  return p;
}

// แพ้ยา active = ทุก add ที่ยังไม่มี remove ชี้ถึง
function activeAllergies(hn) {
  return db.prepare(`
    SELECT a.id, a.substance, a.reaction, a.created_at FROM allergy_log a
    WHERE a.hn = ? AND a.action = 'add'
      AND NOT EXISTS (SELECT 1 FROM allergy_log r WHERE r.action = 'remove' AND r.ref_id = a.id)
    ORDER BY a.id`).all(hn);
}

function addAllergy(hn, substance, reaction, userId) {
  db.prepare(`INSERT INTO allergy_log (hn, action, substance, reaction, created_by, created_at)
    VALUES (?, 'add', ?, ?, ?, ?)`).run(hn, substance.trim(), reaction || null, userId, now());
}

function removeAllergy(hn, refId, reason, userId) {
  const orig = db.prepare(`SELECT * FROM allergy_log WHERE id = ? AND hn = ? AND action = 'add'`).get(refId, hn);
  if (!orig) throw Object.assign(new Error('ไม่พบรายการแพ้ยา'), { status: 404 });
  db.prepare(`INSERT INTO allergy_log (hn, action, ref_id, substance, reason, created_by, created_at)
    VALUES (?, 'remove', ?, ?, ?, ?, ?)`).run(hn, refId, orig.substance, reason || null, userId, now());
}

function markDuplicate(hn, primaryHn, userId) {
  return txn(() => {
  const before = db.prepare('SELECT * FROM patients WHERE hn=?').get(hn);
  if (!before) throw Object.assign(new Error('ไม่พบคนไข้'), {status:404});
  if (hn === primaryHn) throw Object.assign(new Error('HN ซ้ำกับตัวเอง'), { status: 400 });
  const primary = db.prepare('SELECT hn, duplicate_of_hn FROM patients WHERE hn = ?').get(primaryHn);
  if (!primary) throw Object.assign(new Error('ไม่พบ HN หลัก'), { status: 404 });
  if (primary.duplicate_of_hn) throw Object.assign(new Error('HN หลักเป็นตัวซ้ำเสียเอง'), { status: 400 });
  db.prepare('UPDATE patients SET duplicate_of_hn = ?, updated_at = ?, updated_by = ? WHERE hn = ?')
    .run(primaryHn, now(), userId, hn);
  audit.record({category:'patient',action:'merge',entityId:hn,ref:hn,before,after:{duplicate_of_hn:primaryHn},actorId:userId});
  });
}

// ---------- เตือนแพ้ยาตอนสั่ง (S1) ----------
// กลุ่มแพ้ข้ามที่พบบ่อยในคลินิก GP — เตือนไว้ก่อน หมอเป็นคนตัดสินใจสุดท้าย (ยืนยันแล้วสั่งได้)
const ALLERGY_GROUPS = {
  penicillin: ['penicillin', 'amoxicillin', 'amoxycillin', 'ampicillin', 'cloxacillin', 'dicloxacillin',
    'augmentin', 'amoxiclav', 'เพนิซิลลิน', 'เพนนิซิลลิน', 'อะม็อกซี่', 'อะม็อกซิ'],
  nsaid: ['nsaid', 'ibuprofen', 'diclofenac', 'naproxen', 'aspirin', 'mefenamic', 'ponstan',
    'piroxicam', 'celecoxib', 'etoricoxib', 'indomethacin', 'ketorolac', 'แอสไพริน', 'ไอบูโพรเฟน'],
  sulfa: ['sulfa', 'sulfonamide', 'sulfamethoxazole', 'cotrimoxazole', 'trimoxazole', 'bactrim',
    'sulfasalazine', 'ซัลฟา'],
};
function allergyTerms(substance) {
  const tokens = String(substance || '').toLowerCase().split(/[^a-z0-9ก-๙]+/).filter(t => t.length >= 3);
  const terms = new Set(tokens);
  for (const token of tokens) {
    for (const [group, members] of Object.entries(ALLERGY_GROUPS)) {
      if (token === group || token === `${group}s` || members.includes(token)) {
        for (const m of members) terms.add(m);
      }
    }
  }
  return [...terms];
}
// คืนรายการชนกันระหว่างประวัติแพ้ของคนไข้กับ order lines — ใช้ทั้งเตือนบนจอและด่านฝั่ง server
function allergyConflicts(hn, lines) {
  const conflicts = [];
  for (const allergy of activeAllergies(hn)) {
    const terms = allergyTerms(allergy.substance);
    for (const line of lines || []) {
      if (line.type !== 'drug') continue;
      // ชื่อจาก master ตาม ref_id เป็นหลัก (client ส่งชื่อไม่มา/สะกดผิด ก็ยังจับได้)
      const master = line.ref_id ? db.prepare('SELECT name FROM drugs WHERE id = ?').get(line.ref_id) : null;
      // ตรวจทั้งชื่อจาก master (กัน client ส่งชื่อเพี้ยน) และชื่อที่ส่งมา (กัน ref เพี้ยน)
      const names = [master && master.name, line.name].filter(Boolean).map(n => String(n).toLowerCase());
      if (names.some(n => terms.some(t => n.includes(t)))) {
        conflicts.push({ substance: allergy.substance, drug: line.name || master.name });
      }
    }
  }
  return conflicts;
}

module.exports = { register, update, search, get, activeAllergies, addAllergy, removeAllergy, markDuplicate, normPhone, allergyConflicts };
