'use strict';
// Note drafts (overwrite ได้ กันไฟดับ) / note versions + order versions (append-only)
const { db, txn, now, round2 } = require('./db');

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

// ---------- note draft ----------
function saveDraft(visitId, payload, userId) {
  db.prepare(`INSERT INTO note_drafts (visit_id, payload_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(visit_id) DO UPDATE SET payload_json = excluded.payload_json,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(visitId, JSON.stringify(payload), userId, now());
}
function getDraft(visitId) {
  const r = db.prepare('SELECT * FROM note_drafts WHERE visit_id = ?').get(visitId);
  return r ? { ...JSON.parse(r.payload_json), _updated_at: r.updated_at } : null;
}

// promote draft → version — เรียกจาก visits.transition('finish_exam') ใน txn เดียวกันเสมอ
function commitNoteFromDraft(visit, userId) {
  const draft = getDraft(visit.id) || {};
  const version = nextVersion('note_versions', visit.id);
  const vitals = {
    weight_kg: visit.weight_kg, height_cm: visit.height_cm, temp_c: visit.temp_c,
    bp_sys: visit.bp_sys, bp_dia: visit.bp_dia, pulse: visit.pulse, glucose: visit.glucose,
  };
  db.prepare(`INSERT INTO note_versions (visit_id, version, cc, hpi, pe, dx_text, icd10, note, vitals_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(visit.id, version, draft.cc || null, draft.hpi || null, draft.pe || null,
      draft.dx_text || null, draft.icd10 || null, draft.note || null,
      JSON.stringify(vitals), userId, now());
  db.prepare('DELETE FROM note_drafts WHERE visit_id = ?').run(visit.id);
  return version;
}

// แก้ note หลังจบตรวจ/ปิด visit = version ใหม่เสมอ (append-only)
function amendNote(visitId, payload, userId) {
  return txn(() => {
    const version = nextVersion('note_versions', visitId);
    if (version === 1) throw err('ยังไม่มี note ฉบับแรก (ต้องผ่านจบตรวจก่อน)');
    db.prepare(`INSERT INTO note_versions (visit_id, version, cc, hpi, pe, dx_text, icd10, note, vitals_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT vitals_json FROM note_versions WHERE visit_id = ? AND version = ?), ?, ?)`)
      .run(visitId, version, payload.cc || null, payload.hpi || null, payload.pe || null,
        payload.dx_text || null, payload.icd10 || null, payload.note || null,
        visitId, version - 1, userId, now());
    return version;
  });
}

function nextVersion(table, visitId) {
  return (db.prepare(`SELECT COALESCE(MAX(version), 0) v FROM ${table} WHERE visit_id = ?`).get(visitId).v) + 1;
}

function noteVersions(visitId) {
  return db.prepare('SELECT n.*, u.display_name AS author FROM note_versions n LEFT JOIN users u ON u.id = n.created_by WHERE visit_id = ? ORDER BY version').all(visitId);
}

// ---------- order versions ----------
// line: {type:'drug'|'service'|'discount', ref_id, name, qty, unit, price_each, instructions, dose?}
// dose modes: standard | exact_times | prn | manual
// เก็บ calculated_qty แยกจาก qty (จำนวนจ่ายจริง) เพื่อไม่ซ่อน manual override
// ยา: ราคายึด master เสมอ | ค่าบริการ: หมอ override ราคาได้ (default จาก master)
// ส่วนลด: เก็บเป็น line ติดลบใน order — ตอนออกบิล billing จะพับเข้า receipts.discount
function sanitizeDose(d) {
  if (!d) return null;
  const num = x => { const v = Number(x); return isFinite(v) && v > 0 ? v : 0; };
  const mode = ['standard', 'exact_times', 'prn', 'manual'].includes(d.mode) ? d.mode : 'standard';
  const dose = {
    mode,
    m: num(d.m), n: num(d.n), e: num(d.e), b: num(d.b),
    timing: ['ก่อนอาหาร', 'หลังอาหาร', 'พร้อมอาหาร', ''].includes(d.timing) ? d.timing : '',
    days: Math.floor(num(d.days)),
    times: Array.isArray(d.times) ? d.times.slice(0, 8).map(x => ({
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(x.time || '')) ? String(x.time) : '',
      amount: num(x.amount),
    })).filter(x => x.time && x.amount) : [],
    prn_amount: num(d.prn_amount),
    prn_indication: String(d.prn_indication || '').trim(),
    prn_interval_hours: num(d.prn_interval_hours),
    prn_max_per_day: num(d.prn_max_per_day),
    qty_source: d.qty_source === 'manual' ? 'manual' : 'calculated',
    instructions_source: d.instructions_source === 'manual' ? 'manual' : 'calculated',
  };
  const hasStandard = (dose.m + dose.n + dose.e + dose.b) > 0;
  const hasExact = dose.times.length > 0;
  const hasPrn = dose.prn_amount > 0 || dose.prn_indication;
  return mode === 'manual' || hasStandard || hasExact || hasPrn ? dose : null;
}
// จำนวนจ่ายจริงปัดขึ้นเป็นหน่วยเต็ม (เม็ดครึ่งให้คนไข้หักเอง แต่จ่ายเป็นเม็ดเต็ม)
function doseQty(dose) {
  if (!dose || !['standard', 'exact_times'].includes(dose.mode || 'standard')) return 0;
  const perDay = dose.mode === 'exact_times'
    ? dose.times.reduce((s, x) => s + x.amount, 0)
    : dose.m + dose.n + dose.e + dose.b;
  return dose.days > 0 ? Math.ceil(perDay * dose.days) : 0;
}
function doseText(dose, unit) {
  const u = unit || 'เม็ด';
  if (dose.mode === 'exact_times') {
    let t = dose.times.map(x => `${x.time} ${x.amount} ${u}`).join(' / ');
    if (dose.timing) t += ` ${dose.timing}`;
    if (dose.days) t += ` · ${dose.days} วัน`;
    return t;
  }
  if (dose.mode === 'prn') {
    let t = `ครั้งละ ${dose.prn_amount || '-'} ${u} เมื่อ${dose.prn_indication || 'มีอาการ'}`;
    if (dose.prn_interval_hours) t += ` ห่างอย่างน้อย ${dose.prn_interval_hours} ชม.`;
    if (dose.prn_max_per_day) t += ` ไม่เกิน ${dose.prn_max_per_day} ครั้ง/วัน`;
    return t;
  }
  if (dose.mode === 'manual') return '';
  const seg = [];
  if (dose.m) seg.push(`เช้า ${dose.m} ${u}`);
  if (dose.n) seg.push(`เที่ยง ${dose.n} ${u}`);
  if (dose.e) seg.push(`เย็น ${dose.e} ${u}`);
  if (dose.b) seg.push(`ก่อนนอน ${dose.b} ${u}`);
  let t = seg.join(' / ');
  if (dose.timing) t += ` ${dose.timing}`;
  if (dose.days) t += ` · ${dose.days} วัน`;
  return t;
}

function buildLines(rawLines) {
  const out = [];
  for (const l of rawLines || []) {
    if (l.type === 'drug') {
      const d = db.prepare('SELECT * FROM drugs WHERE id = ? AND active = 1').get(l.ref_id);
      if (!d) throw err(`ไม่พบยา id ${l.ref_id}`, 404);
      const dose = sanitizeDose(l.dose);
      const calculatedQty = doseQty(dose);
      const qty = calculatedQty > 0 && dose.qty_source !== 'manual' ? calculatedQty : Number(l.qty);
      if (!qty || qty <= 0) throw err(`จำนวนไม่ถูกต้อง: ${d.name}`);
      // วิธีใช้: ที่ผู้ใช้พิมพ์ > ประกอบจาก dose > default ของยา
      const instructions = (l.instructions && String(l.instructions).trim())
        || (dose ? doseText(dose, d.unit) : '')
        || d.default_instructions || '';
      if (dose) dose.calculated_qty = calculatedQty || null;
      out.push({ type: 'drug', ref_id: d.id, name: d.name, qty, calculated_qty: calculatedQty || null, unit: d.unit,
        price_each: d.price, dose, instructions });
    } else if (l.type === 'service') {
      const s = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(l.ref_id);
      if (!s) throw err(`ไม่พบค่าบริการ id ${l.ref_id}`, 404);
      const qty = Number(l.qty);
      if (!qty || qty <= 0) throw err(`จำนวนไม่ถูกต้อง: ${s.name}`);
      let price = s.price;
      const ov = Number(l.price_each);
      if (l.price_each != null && isFinite(ov) && ov >= 0) price = round2(ov);
      out.push({ type: 'service', ref_id: s.id, name: s.name, qty, unit: 'ครั้ง',
        price_each: price, default_price: s.price, instructions: '' });
    } else if (l.type === 'discount') {
      const amt = round2(Math.abs(Number(l.amount != null ? l.amount : l.price_each)));
      if (!amt) throw err('จำนวนส่วนลดไม่ถูกต้อง');
      const name = String(l.name || '').trim();
      if (!name) throw err('ต้องระบุเหตุผลส่วนลด');
      out.push({ type: 'discount', ref_id: null, name, qty: 1, unit: '', price_each: -amt, instructions: '' });
    } else throw err(`line type ไม่ถูกต้อง: ${l.type}`);
  }
  return out;
}

// หน้าคลินิกบันทึกจำนวนที่จ่ายจริงต่ำกว่าคำสั่งได้ (เช่น stock ไม่พอ) พร้อมเหตุผล+รอหมอ ack
// แต่ห้ามเพิ่ม/ถอด/สลับยา หรือแก้วิธีใช้แทนแพทย์
function validateFrontOrderEdit(previousLines, rawLines) {
  const next = buildLines(rawLines);
  const prevDrugs = (previousLines || []).filter(l => l.type === 'drug');
  const nextDrugs = next.filter(l => l.type === 'drug');
  if (prevDrugs.length !== nextDrugs.length) throw err('หน้าคลินิกเพิ่มหรือลบรายการยาไม่ได้ กรุณาส่งกลับให้แพทย์แก้', 403);
  for (const old of prevDrugs) {
    const cur = nextDrugs.find(l => l.ref_id === old.ref_id);
    if (!cur) throw err(`เปลี่ยนรายการยา ${old.name} ไม่ได้ กรุณาส่งกลับให้แพทย์แก้`, 403);
    if (cur.qty > old.qty) throw err(`เพิ่มจำนวน ${old.name} เกินคำสั่งแพทย์ไม่ได้`, 403);
    const schedule = d => {
      if (!d) return null;
      const x = { ...d }; delete x.qty_source; delete x.calculated_qty; delete x.instructions_source;
      return x;
    };
    if ((cur.instructions || '') !== (old.instructions || '') || JSON.stringify(schedule(cur.dose)) !== JSON.stringify(schedule(old.dose))) {
      throw err(`แก้วิธีใช้ ${old.name} ไม่ได้ กรุณาส่งกลับให้แพทย์แก้`, 403);
    }
  }
  return next;
}

function saveOrderVersion(visitId, rawLines, editReason, userId, baseVersionId = undefined) {
  return txn(() => {
    const latest = latestOrderVersion(visitId);
    // optimistic concurrency: client ส่ง id ของ version ที่เห็น — stale → 409 (plan §3)
    if (baseVersionId !== undefined && latest && latest.id !== baseVersionId) {
      throw err('รายการถูกแก้โดยคนอื่นแล้ว กรุณาดูรายการล่าสุด', 409);
    }
    const lines = buildLines(rawLines);
    const version = nextVersion('order_versions', visitId);
    const r = db.prepare(`INSERT INTO order_versions (visit_id, version, lines_json, edit_reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(visitId, version, JSON.stringify(lines), editReason || null, userId, now());
    return { id: Number(r.lastInsertRowid), version, lines };
  });
}

function latestOrderVersion(visitId) {
  const r = db.prepare('SELECT * FROM order_versions WHERE visit_id = ? ORDER BY version DESC LIMIT 1').get(visitId);
  if (!r) return null;
  r.lines = JSON.parse(r.lines_json);
  r.acked = !!db.prepare('SELECT 1 FROM order_acks WHERE order_version_id = ?').get(r.id);
  r.subtotal = round2(r.lines.reduce((s, l) => s + l.qty * l.price_each, 0));
  return r;
}

function ackOrder(orderVersionId, userId) {
  const ov = db.prepare('SELECT id FROM order_versions WHERE id = ?').get(orderVersionId);
  if (!ov) throw err('ไม่พบ order version', 404);
  db.prepare(`INSERT INTO order_acks (order_version_id, acked_by, acked_at) VALUES (?, ?, ?)
    ON CONFLICT(order_version_id) DO NOTHING`).run(orderVersionId, userId, now());
}

// รายการที่ front แก้แล้วหมอยังไม่ ack (badge จอหมอ + รายงานปิดวัน)
function pendingAcks() {
  return db.prepare(`
    SELECT ov.id, ov.visit_id, ov.version, ov.edit_reason, ov.created_at, ov.lines_json,
           u.display_name AS edited_by, p.first_name, p.last_name, v.visit_date, v.queue_no
    FROM order_versions ov
    JOIN visits v ON v.id = ov.visit_id
    JOIN patients p ON p.hn = v.hn
    LEFT JOIN users u ON u.id = ov.created_by
    WHERE ov.edit_reason IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM order_acks a WHERE a.order_version_id = ov.id)
    ORDER BY ov.id DESC`).all();
}

module.exports = {
  saveDraft, getDraft, commitNoteFromDraft, amendNote, noteVersions,
  saveOrderVersion, latestOrderVersion, ackOrder, pendingAcks, buildLines, validateFrontOrderEdit,
};
