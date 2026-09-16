'use strict';
// Stock: ledger (stock_movements) คือ source of truth; drugs.qty_on_hand เป็น cache
// การขยับ stock ทุกกรณีผ่าน move() เท่านั้น (plan §1)
const { db, txn, now, round2 } = require('./db');
const DoseTemplate = require('../public/dose-template');

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

const TYPES = ['receive', 'dispense', 'adjust', 'void_return'];

// qty: + เข้าคลัง / - ออกจากคลัง — ติดลบได้ (ไม่ block การขาย, badge เตือนให้นับ: plan §4)
function move(drugId, type, qty, { ref, reason, userId }) {
  if (!TYPES.includes(type)) throw err(`ประเภท movement ไม่ถูกต้อง: ${type}`);
  qty = Number(qty);
  if (!qty || !isFinite(qty)) throw err('จำนวนไม่ถูกต้อง');
  if ((type === 'receive' || type === 'void_return') && qty <= 0) throw err('จำนวนรับเข้าต้องเป็นบวก');
  if (type === 'dispense' && qty >= 0) throw err('dispense ต้องเป็นลบ');
  return txn(() => {
    const d = db.prepare('SELECT id FROM drugs WHERE id = ?').get(drugId);
    if (!d) throw err(`ไม่พบยา id ${drugId}`, 404);
    db.prepare(`INSERT INTO stock_movements (drug_id, type, qty, ref, reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(drugId, type, qty, ref || null, reason || null, userId, now());
    db.prepare('UPDATE drugs SET qty_on_hand = ROUND(qty_on_hand + ?, 3) WHERE id = ?').run(qty, drugId);
  });
}

// checked invariant: cache ตรง ledger ไหม (ปุ่ม recheck + รายงานปิดวัน)
function reconcile() {
  return db.prepare(`
    SELECT d.id, d.name, d.qty_on_hand,
           ROUND(COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.drug_id = d.id), 0), 3) AS ledger_qty
    FROM drugs d
    WHERE ABS(d.qty_on_hand - COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.drug_id = d.id), 0)) > 0.001`)
    .all();
}

function listDrugs(includeInactive = false) {
  // expiry_date = lot ที่ใกล้หมดสุดที่ยังไม่ปิด (derive สดจาก drug_lots — ไม่มี cache ให้เพี้ยน)
  return db.prepare(`SELECT d.*,
      (SELECT MIN(l.expiry_date) FROM drug_lots l WHERE l.drug_id = d.id AND l.cleared_at IS NULL) AS expiry_date,
      (SELECT COUNT(*) FROM drug_lots l WHERE l.drug_id = d.id AND l.cleared_at IS NULL) AS active_lots
    FROM drugs d ${includeInactive ? '' : 'WHERE d.active = 1'} ORDER BY d.name`).all();
}
function listServices(includeInactive = false) {
  return db.prepare(`SELECT * FROM services ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`).all();
}

function searchItems(q, limit = 15) {
  const like = `%${String(q || '').trim().replace(/[%_\\]/g, c => '\\' + c)}%`;
  const drugs = db.prepare(`SELECT id, 'drug' AS type, name, generic_name, unit, price, qty_on_hand, default_instructions, dose_mode, default_dose_json
    FROM drugs WHERE active = 1 AND (name LIKE ? ESCAPE '\\' OR generic_name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')
    ORDER BY name LIMIT ?`).all(like, like, like, limit);
  const services = db.prepare(`SELECT id, 'service' AS type, name, NULL AS generic_name, 'ครั้ง' AS unit, price,
    NULL AS qty_on_hand, NULL AS default_instructions
    FROM services WHERE active = 1 AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`).all(like, limit);
  return [...drugs, ...services];
}

// วันหมดอายุระบบ lot (v13): หมอกรอกทุก lot ตอนรับเข้า ระบบเลือก lot ใกล้หมดสุดมาเตือนเอง
function normalizeExpiry(value) {
  const s = String(value == null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(s + 'T00:00:00').getTime())) {
    throw err('วันหมดอายุไม่ถูกต้อง — เลือกจากปฏิทิน');
  }
  return s;
}
// เกณฑ์เตือนรายยา (หมอ 2026-08-31: supplier แต่ละยาต่างกัน) — NULL = ใช้ค่ากลาง stock_expiry_warn_days
function normalizeWarnDays(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw err('เกณฑ์เตือนของยาต้องเป็นจำนวนวัน 1–3650 หรือเว้นว่าง = ใช้ค่ากลาง');
  return n;
}

// ---- drug_lots: ชั้นข้อมูลวันหมดอายุรายลอต — ไม่แตะยอดสต็อก (ยอดเป็นเรื่องของ stock_movements เท่านั้น) ----
function addLot(drugId, { expiry_date, lot_label, qty, userId }) {
  const d = db.prepare('SELECT id FROM drugs WHERE id = ?').get(drugId);
  if (!d) throw err(`ไม่พบยา id ${drugId}`, 404);
  const r = db.prepare(`INSERT INTO drug_lots (drug_id, expiry_date, lot_label, qty_received, received_at, received_by)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(drugId, normalizeExpiry(expiry_date), String(lot_label || '').trim() || null,
      qty == null || qty === '' ? null : Number(qty), now(), userId || null);
  return Number(r.lastInsertRowid);
}
// ปิด lot (หมด/เก็บออกจากตู้แล้ว) — ห้ามลบแถว: cleared_* คือประวัติว่าใครปิดเมื่อไหร่
function clearLot(lotId, { reason, userId }) {
  const lot = db.prepare('SELECT id, cleared_at FROM drug_lots WHERE id = ?').get(lotId);
  if (!lot) throw err('ไม่พบ lot นี้', 404);
  if (lot.cleared_at) throw err('lot นี้ถูกปิดไปแล้ว', 409);
  db.prepare('UPDATE drug_lots SET cleared_at = ?, cleared_by = ?, cleared_reason = ? WHERE id = ?')
    .run(now(), userId || null, String(reason || '').trim() || null, lotId);
}
// แก้ lot ที่คีย์ผิด (วัน/ชื่อ lot) — แก้ได้เฉพาะ lot ที่ยังไม่ปิด
function updateLot(lotId, { expiry_date, lot_label }) {
  const lot = db.prepare('SELECT id, cleared_at FROM drug_lots WHERE id = ?').get(lotId);
  if (!lot) throw err('ไม่พบ lot นี้', 404);
  if (lot.cleared_at) throw err('lot นี้ถูกปิดไปแล้ว — แก้ไม่ได้', 409);
  db.prepare('UPDATE drug_lots SET expiry_date = ?, lot_label = ? WHERE id = ?')
    .run(normalizeExpiry(expiry_date), String(lot_label || '').trim() || null, lotId);
}
function listLots(drugId, includeCleared = false) {
  return db.prepare(`SELECT l.*, u.display_name AS received_by_name, c.display_name AS cleared_by_name
    FROM drug_lots l LEFT JOIN users u ON u.id = l.received_by LEFT JOIN users c ON c.id = l.cleared_by
    WHERE l.drug_id = ? ${includeCleared ? '' : 'AND l.cleared_at IS NULL'}
    ORDER BY l.cleared_at IS NOT NULL, l.expiry_date, l.id`).all(drugId);
}

function upsertDrug(data, id = null) {
  if (!data || typeof data.name !== 'string' || !data.name.trim()) throw err('ใส่ชื่อยา');
  const previous = id ? db.prepare('SELECT * FROM drugs WHERE id=?').get(id) : null;
  if (id && !previous) throw err('ไม่พบรายการยา', 404);
  const hasDefault = Object.hasOwn(data, 'default_dose');
  const template = hasDefault ? DoseTemplate.normalize(data.default_dose, data.unit || 'เม็ด') : null;
  if (!hasDefault && previous?.default_dose_json && ((data.unit && data.unit !== previous.unit) || (data.dose_mode && data.dose_mode !== previous.dose_mode))) throw err('หน่วยหรือรูปแบบยาเปลี่ยน กรุณาทวนตารางวิธีใช้เริ่มต้นก่อนบันทึก');
  if (!hasDefault && previous?.default_dose_json && Object.hasOwn(data, 'default_instructions') && data.default_instructions !== previous.default_instructions) throw err('กรุณาแก้วิธีใช้เริ่มต้นผ่านตารางขนาดยาแล้วบันทึกอีกครั้ง');
  const defaultJson = hasDefault ? (template ? JSON.stringify(template) : null) : previous?.default_dose_json || null;
  const cost = data.cost === '' || data.cost == null ? null : round2(Number(data.cost) || 0);
  // client ที่ไม่ส่ง field มาเลย (เช่น import CSV) ต้องไม่ล้างค่าเดิม — ส่งค่าว่าง = ตั้งใจล้าง (กลับไปใช้ค่ากลาง)
  const hasWarn = 'expiry_warn_days' in data;
  const warnDays = hasWarn ? normalizeWarnDays(data.expiry_warn_days) : null;
  const doseMode = template?.mode || (['standard', 'exact_times', 'prn', 'manual'].includes(data.dose_mode) ? data.dose_mode : previous?.dose_mode || 'standard');
  const instructions = template ? DoseTemplate.text(template, data.unit) : (!hasDefault && previous?.default_dose_json ? previous.default_instructions : data.default_instructions || null);
  const vals = [data.code || null, data.name.trim(), data.generic_name || null, data.unit || previous?.unit || 'เม็ด',
    round2(Number(data.price) || 0), cost, Number(data.reorder_level) || 0, instructions,
    doseMode, data.active === 0 ? 0 : 1];
  if (id) {
    db.prepare(`UPDATE drugs SET code = ?, name = ?, generic_name = ?, unit = ?, price = ?, cost = ?, reorder_level = ?,
      default_instructions = ?, dose_mode = ?, active = ?, default_dose_json = ?${hasWarn ? ', expiry_warn_days = ?' : ''} WHERE id = ?`)
      .run(...vals, defaultJson, ...(hasWarn ? [warnDays] : []), id);
    return id;
  }
  const r = db.prepare(`INSERT INTO drugs (code, name, generic_name, unit, price, cost, reorder_level, default_instructions, dose_mode, active, expiry_warn_days, default_dose_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals, warnDays, defaultJson);
  return Number(r.lastInsertRowid);
}

// อัปเดตทุนล่าสุด (ใช้ตอนรับยาเข้า ราคาทุนรอบใหม่)
function setCost(drugId, cost) {
  db.prepare('UPDATE drugs SET cost = ? WHERE id = ?').run(round2(Number(cost) || 0), drugId);
}

// อัปเดตเกณฑ์เตือนรายยา (ใช้ตอนรับยาเข้า — จังหวะที่หมอนึกถึงรอบสั่งของ supplier เจ้านั้นพอดี)
function setExpiryWarnDays(drugId, days) {
  db.prepare('UPDATE drugs SET expiry_warn_days = ? WHERE id = ?').run(normalizeWarnDays(days), drugId);
}

function upsertService(data, id = null) {
  const old = id == null ? null : db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (id != null && !old) throw err('ไม่พบรายการค่าบริการนี้', 404);
  const name = String(data.name ?? old?.name ?? '').trim();
  if (!name || name.length > 200) throw err('ใส่ชื่อค่าบริการไม่เกิน 200 ตัวอักษร');
  const money = (value, label, nullable) => {
    if (value == null || (typeof value === 'string' && !value.trim())) {
      if (nullable) return null;
      throw err(`กรุณาใส่${label}`);
    }
    if (!['number','string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100000000)
      throw err(`${label}ต้องเป็นตัวเลขตั้งแต่ 0 ถึง 100,000,000 บาท`);
    return round2(Number(value));
  };
  const price = money(data.price === undefined ? old?.price : data.price, 'ราคาขาย', false);
  const cost = money(data.cost === undefined ? old?.cost : data.cost, 'ต้นทุนต่อครั้ง', true);
  const active = data.active === undefined ? old?.active ?? 1 : data.active === 0 || data.active === false ? 0 : 1;
  const vals = [name, price, cost, active];
  if (id != null) { db.prepare('UPDATE services SET name = ?, price = ?, cost = ?, active = ? WHERE id = ?').run(...vals, id); return id; }
  const r = db.prepare('INSERT INTO services (name, price, cost, active) VALUES (?, ?, ?, ?)').run(...vals);
  return Number(r.lastInsertRowid);
}

function movements(drugId, limit = 100) {
  return db.prepare(`SELECT m.*, u.display_name AS by_name FROM stock_movements m
    LEFT JOIN users u ON u.id = m.created_by WHERE m.drug_id = ? ORDER BY m.id DESC LIMIT ?`).all(drugId, limit);
}

function lowStock() {
  return db.prepare('SELECT * FROM drugs WHERE active = 1 AND qty_on_hand <= reorder_level ORDER BY name').all();
}

module.exports = { move, reconcile, listDrugs, listServices, searchItems, upsertDrug, upsertService, setCost, setExpiryWarnDays,
  addLot, clearLot, updateLot, listLots, movements, lowStock };
