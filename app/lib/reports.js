'use strict';
// รายงานรายวัน + CSV export (ทางหนีไฟ brief §2/§6)
const { db, today } = require('./db');

function daily(date) {
  date = date || today();
  const d0 = `${date} 00:00:00`, d1 = `${date} 99:99:99`;
  const visitsCount = db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN state = 'COMPLETED' THEN 1 ELSE 0 END) completed,
      SUM(CASE WHEN state = 'CANCELLED' THEN 1 ELSE 0 END) cancelled,
      SUM(CASE WHEN state NOT IN ('COMPLETED','CANCELLED') THEN 1 ELSE 0 END) open
    FROM visits WHERE visit_date = ?`).get(date);
  const money = db.prepare(`
    SELECT COUNT(*) receipts,
      ROUND(SUM(total), 2) total,
      ROUND(SUM(CASE WHEN pay_method = 'cash' THEN total ELSE 0 END), 2) cash,
      ROUND(SUM(CASE WHEN pay_method = 'transfer' THEN total ELSE 0 END), 2) transfer,
      ROUND(SUM(discount), 2) discount
    FROM receipts WHERE status = 'ISSUED' AND created_at BETWEEN ? AND ?`).get(d0, d1);
  const voids = db.prepare(`SELECT receipt_no, total, void_reason, voided_at FROM receipts
    WHERE status = 'VOID' AND voided_at BETWEEN ? AND ? ORDER BY voided_at`).all(d0, d1);
  const receipts = db.prepare(`SELECT r.receipt_no, r.patient_name, r.total, r.discount, r.pay_method, r.status, r.created_at, r.void_reason
    FROM receipts r WHERE r.created_at BETWEEN ? AND ? ORDER BY r.receipt_no`).all(d0, d1);
  const drugsDispensed = db.prepare(`
    SELECT rl.name, SUM(rl.qty) qty, rl.unit, ROUND(SUM(rl.amount), 2) amount,
      ROUND(SUM(rl.qty * COALESCE(rl.cost_each, 0)), 2) cost,
      ROUND(SUM(rl.amount - rl.qty * COALESCE(rl.cost_each, 0)), 2) profit,
      SUM(CASE WHEN rl.cost_each IS NULL THEN 1 ELSE 0 END) no_cost_lines
    FROM receipt_lines rl JOIN receipts r ON r.receipt_no = rl.receipt_no
    WHERE r.status = 'ISSUED' AND rl.line_type = 'drug' AND r.created_at BETWEEN ? AND ?
    GROUP BY rl.name, rl.unit ORDER BY qty DESC`).all(d0, d1);
  // Direct contribution only; NULL cost is unknown, never a free service.
  const cogs = db.prepare(`
    SELECT rl.line_type, ROUND(SUM(rl.qty * COALESCE(rl.cost_each, 0)), 2) cost,
      SUM(CASE WHEN rl.cost_each IS NULL THEN 1 ELSE 0 END) unknown_cost
    FROM receipt_lines rl JOIN receipts r ON r.receipt_no = rl.receipt_no
    WHERE r.status = 'ISSUED' AND r.created_at BETWEEN ? AND ? GROUP BY rl.line_type`).all(d0, d1);
  applyDirectCosts(money, cogs);
  money.unknown_cost_items = unknownCostItems(d0, d1);
  // คุณภาพข้อมูล: visit ที่ note ว่าง (plan §2 อนุญาตแต่ต้องโชว์ในรายงานปิดวัน)
  const emptyNotes = db.prepare(`
    SELECT v.id, v.queue_no, p.first_name, p.last_name FROM visits v
    JOIN patients p ON p.hn = v.hn
    WHERE v.visit_date = ? AND v.state = 'COMPLETED'
      AND NOT EXISTS (SELECT 1 FROM note_versions n WHERE n.visit_id = v.id
        AND (COALESCE(n.cc,'') != '' OR COALESCE(n.hpi,'') != '' OR COALESCE(n.pe,'') != ''
             OR COALESCE(n.dx_text,'') != '' OR COALESCE(n.note,'') != ''))`).all(date);
  return { date, visits: visitsCount, money, receipts, voids, drugs_dispensed: drugsDispensed, empty_notes: emptyNotes };
}

// ---------- สมุดรายรับรายเดือน (เชิงบัญชี/ภาษี) ----------
// นับเฉพาะใบเสร็จ ISSUED = รายรับจริงหลัง void/refund; แยกหมวดยา/ค่าบริการจาก receipt_lines
function monthlyLedger(year) {
  const y0 = `${year}-01-01 00:00:00`, y1 = `${year}-12-31 99:99:99`;
  const months = db.prepare(`
    SELECT substr(created_at, 1, 7) AS month,
      COUNT(*) receipts,
      ROUND(SUM(total), 2) total,
      ROUND(SUM(CASE WHEN pay_method = 'cash' THEN total ELSE 0 END), 2) cash,
      ROUND(SUM(CASE WHEN pay_method = 'transfer' THEN total ELSE 0 END), 2) transfer,
      ROUND(SUM(discount), 2) discount
    FROM receipts WHERE status = 'ISSUED' AND created_at BETWEEN ? AND ?
    GROUP BY month ORDER BY month`).all(y0, y1);
  const byType = db.prepare(`
    SELECT substr(r.created_at, 1, 7) AS month, rl.line_type,
      ROUND(SUM(rl.amount), 2) amount,
      ROUND(SUM(rl.qty * COALESCE(rl.cost_each, 0)), 2) cost,
      SUM(CASE WHEN rl.cost_each IS NULL THEN 1 ELSE 0 END) unknown_cost
    FROM receipt_lines rl JOIN receipts r ON r.receipt_no = rl.receipt_no
    WHERE r.status = 'ISSUED' AND r.created_at BETWEEN ? AND ?
    GROUP BY month, rl.line_type`).all(y0, y1);
  const voids = db.prepare(`
    SELECT substr(voided_at, 1, 7) AS month, COUNT(*) count, ROUND(SUM(total), 2) amount
    FROM receipts WHERE status = 'VOID' AND voided_at BETWEEN ? AND ?
    GROUP BY month`).all(y0, y1);
  for (const m of months) {
    const drug = byType.find(t => t.month === m.month && t.line_type === 'drug') || {};
    m.drug_amount = drug.amount || 0;
    m.service_amount = (byType.find(t => t.month === m.month && t.line_type === 'service') || {}).amount || 0;
    applyDirectCosts(m, byType.filter(t => t.month === m.month));
    const v = voids.find(x => x.month === m.month);
    m.void_count = v ? v.count : 0;
    m.void_amount = v ? v.amount : 0;
  }
  const sum = k => Math.round(months.reduce((s, m) => s + (m[k] || 0), 0) * 100) / 100;
  return {
    year, months,
    total: { receipts: sum('receipts'), total: sum('total'), cash: sum('cash'), transfer: sum('transfer'),
      discount: sum('discount'), drug_amount: sum('drug_amount'), service_amount: sum('service_amount'),
      drug_cost: sum('drug_cost'), service_cost: sum('service_cost'), direct_cost: sum('direct_cost'),
      gross_profit: sum('unknown_cost_lines') ? null : sum('gross_profit'), unknown_cost_lines: sum('unknown_cost_lines'),
      unknown_drug_cost_lines: sum('unknown_drug_cost_lines'), unknown_service_cost_lines: sum('unknown_service_cost_lines'),
      unknown_cost_items: unknownCostItems(y0, y1) },
    half1: Math.round(months.filter(m => Number(m.month.slice(5)) <= 6).reduce((s, m) => s + m.total, 0) * 100) / 100,
  };
}

// Names come from immutable receipt lines, never the current catalog. This only
// identifies missing costs; changing a catalog must not rewrite historical data.
function unknownCostItems(start, end) {
  return db.prepare(`
    SELECT rl.line_type, rl.name, COUNT(*) lines
    FROM receipts r JOIN receipt_lines rl ON rl.receipt_no = r.receipt_no
    WHERE r.status = 'ISSUED' AND r.created_at BETWEEN ? AND ? AND rl.cost_each IS NULL
    GROUP BY rl.line_type, rl.name ORDER BY rl.line_type, rl.name`).all(start, end);
}

function applyDirectCosts(money, rows) {
  const drug = rows.find(r => r.line_type === 'drug') || {};
  const service = rows.find(r => r.line_type === 'service') || {};
  money.drug_cost = drug.cost || 0;
  money.service_cost = service.cost || 0;
  money.direct_cost = Math.round((money.drug_cost + money.service_cost) * 100) / 100;
  money.unknown_drug_cost_lines = drug.unknown_cost || 0;
  money.unknown_service_cost_lines = service.unknown_cost || 0;
  money.unknown_cost_lines = rows.reduce((sum, r) => sum + (r.unknown_cost || 0), 0);
  // Retain the API field name for existing clients, but do not return fabricated profits.
  money.gross_profit = money.unknown_cost_lines ? null : Math.round(((money.total || 0) - money.direct_cost) * 100) / 100;
}

// รายงานเงินสดรับ รายใบเสร็จทั้งปี (แนบให้นักบัญชี/สรรพากร)
function ledgerCSV(year) {
  const rows = db.prepare(`
    SELECT substr(created_at, 1, 10) AS date, receipt_no, total, pay_method, status,
      CASE WHEN status = 'VOID' THEN void_reason ELSE '' END AS note
    FROM receipts WHERE created_at BETWEEN ? AND ? ORDER BY receipt_no`)
    .all(`${year}-01-01 00:00:00`, `${year}-12-31 99:99:99`);
  const lines = ['วันที่,เลขที่ใบเสร็จ,จำนวนเงิน,ช่องทาง,สถานะ,หมายเหตุ'];
  for (const r of rows) {
    lines.push([r.date, r.receipt_no, r.status === 'VOID' ? 0 : r.total,
      r.pay_method === 'cash' ? 'เงินสด' : 'โอน',
      r.status === 'VOID' ? 'ยกเลิก' : 'ปกติ', csvEscape(r.note)].join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// ---------- CSV export ----------
const EXPORT_TABLES = ['patients', 'allergy_log', 'visits', 'note_versions', 'order_versions', 'order_acks',
  'drugs', 'services', 'stock_movements', 'receipts', 'receipt_lines', 'med_certs', 'fav_sets',
  'attachments', 'users', 'backup_log', 'appointments', 'text_presets'];

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCSV(table) {
  if (!EXPORT_TABLES.includes(table)) throw Object.assign(new Error('ไม่อนุญาต table นี้'), { status: 400 });
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) return '﻿(empty)\n';
  const cols = Object.keys(rows[0]).filter(c => !(table === 'users' && (c === 'pass_hash' || c === 'pin_hash')));
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => csvEscape(r[c])).join(','));
  return '﻿' + lines.join('\r\n'); // BOM ให้ Excel เปิดภาษาไทยถูก
}

module.exports = { daily, exportCSV, EXPORT_TABLES, monthlyLedger, ledgerCSV };
