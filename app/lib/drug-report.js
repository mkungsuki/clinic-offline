'use strict';
// Read-only receipt-basis management report; never backfill issued documents.
const { db, today, now } = require('./db');
const cents = value => Math.round(Number(value) * 100);
const money = value => value / 100;
const keyOf = l => JSON.stringify([l.ref_id == null ? `legacy:${l.name}` : l.ref_id, l.unit || '']);

// Allocate across ALL lines (including services), in integer cents. Ties use
// immutable line id. Allocation is an estimate for this report, not a tax record.
function allocateDiscount(lines, discount) {
  const amounts = lines.map(l => cents(l.amount));
  const sum = amounts.reduce((s, n) => s + n, 0);
  if (!amounts.every(n => Number.isSafeInteger(n) && n >= 0) ||
      !Number.isSafeInteger(sum) || !Number.isSafeInteger(discount) || discount < 0 || discount > sum) return null;
  if (!sum) return amounts.map(() => 0);
  const parts = amounts.map((n, i) => {
    const product = BigInt(n) * BigInt(discount);
    return { i, value: Number(product / BigInt(sum)), remainder: product % BigInt(sum) };
  });
  let left = discount - parts.reduce((s, p) => s + p.value, 0);
  const ranked = [...parts].sort((a, b) => a.remainder === b.remainder
    ? lines[a.i].id - lines[b.i].id : a.remainder > b.remainder ? -1 : 1);
  for (const p of ranked) { if (!left) break; p.value++; left--; }
  return parts.map(p => p.value);
}

function monthlyDrugs(month = today().slice(0, 7)) {
  if (typeof month !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) {
    throw Object.assign(new Error('เดือนรายงานไม่ถูกต้อง — เลือกเดือนและปีใหม่'), { status: 400 });
  }
  const start = `${month}-01 00:00:00`, end = `${month}-31 23:59:59`;
  const rows = new Map();
  function row(l) {
    const key = keyOf(l);
    if (!rows.has(key)) rows.set(key, { drug_id: l.ref_id, name: l.name, unit: l.unit || '',
      qty: 0, gross: 0, discount: 0, net: 0, cost: 0, unknown_cost_lines: 0,
      review_receipts: new Set(), allocation_incomplete: false, stock_now: null, expiry_date: null });
    return rows.get(key);
  }
  const lines = db.prepare(`SELECT l.*, r.discount AS bill_discount, r.total AS bill_total,
    EXISTS(SELECT 1 FROM receipts old WHERE old.visit_id = r.visit_id AND old.receipt_no != r.receipt_no) AS revised
    FROM receipts r JOIN receipt_lines l ON l.receipt_no = r.receipt_no
    WHERE r.status = 'ISSUED' AND r.created_at BETWEEN ? AND ? ORDER BY r.receipt_no, l.id`).all(start, end);
  const bills = new Map();
  for (const l of lines) { if (!bills.has(l.receipt_no)) bills.set(l.receipt_no, []); bills.get(l.receipt_no).push(l); }
  for (const bill of bills.values()) {
    const allocated = allocateDiscount(bill, cents(bill[0].bill_discount));
    const consistent = allocated && bill.reduce((s, l) => s + cents(l.amount), 0)
      - cents(bill[0].bill_discount) === cents(bill[0].bill_total);
    bill.forEach((l, i) => {
      if (l.line_type !== 'drug') return;
      const r = row(l);
      r.name = l.name;
      r.qty += l.qty; r.gross += cents(l.amount);
      if (consistent) { r.discount += allocated[i]; r.net += cents(l.amount) - allocated[i]; }
      else r.allocation_incomplete = true;
      if (l.cost_each == null || !Number.isFinite(l.cost_each) || l.cost_each < 0) r.unknown_cost_lines++;
      else r.cost += cents(l.qty * l.cost_each);
      if (l.revised) r.review_receipts.add(l.receipt_no);
    });
  }
  // Include both issue-month and cancellation-month. Do not guess cash refunds
  // or returned stock from a free-text void_reason, nor silently erase warnings.
  const voidLines = db.prepare(`SELECT l.* FROM receipts r JOIN receipt_lines l ON l.receipt_no = r.receipt_no
    WHERE r.status = 'VOID' AND l.line_type = 'drug' AND
      (r.created_at BETWEEN ? AND ? OR r.voided_at BETWEEN ? AND ?) ORDER BY l.id`).all(start, end, start, end);
  for (const l of voidLines) row(l).review_receipts.add(l.receipt_no);
  const stocks = db.prepare(`SELECT d.id, d.name, d.unit, d.active,
    COALESCE((SELECT ROUND(SUM(m.qty), 3) FROM stock_movements m WHERE m.drug_id = d.id), 0) AS stock_now,
    (SELECT MIN(l.expiry_date) FROM drug_lots l WHERE l.drug_id = d.id AND l.cleared_at IS NULL) AS expiry_date
    FROM drugs d ORDER BY d.id`).all();
  for (const d of stocks) {
    const k = keyOf({ ref_id: d.id, unit: d.unit });
    if (!rows.has(k) && !d.active && !d.stock_now && !d.expiry_date) continue;
    const r = row({ ref_id: d.id, name: d.name, unit: d.unit });
    r.stock_now = d.stock_now; r.expiry_date = d.expiry_date;
  }
  const result = [...rows.values()].map(r => ({ ...r, qty: Math.round(r.qty * 1000) / 1000,
    gross: money(r.gross), discount: r.allocation_incomplete ? null : money(r.discount),
    net: r.allocation_incomplete ? null : money(r.net),
    cost: r.unknown_cost_lines || r.review_receipts.size ? null : money(r.cost),
    profit: r.unknown_cost_lines || r.review_receipts.size || r.allocation_incomplete ? null : money(r.net - r.cost),
    review_receipts: r.review_receipts.size,
  })).sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'th') || (a.drug_id || 0) - (b.drug_id || 0));
  return { month, as_of: now(), basis: 'current_issued_receipts', rows: result,
    issued_receipts: bills.size, void_receipts: new Set(voidLines.map(l => l.receipt_no)).size };
}

module.exports = { monthlyDrugs, allocateDiscount };
