'use strict';
// Billing — สาม txn ศักดิ์สิทธิ์ของระบบ (plan §2/§4):
//   pay():           receipt + lines + stock dispense + transition ใน txn เดียว
//   voidAndReissue(): void ใบเดิม + ใบใหม่ ใน txn เดียว — COMPLETED ไม่มีจังหวะไร้ใบ ISSUED
//   refund():        void ใบเดิม + transition COMPLETED→CANCELLED ใน txn เดียว
const { db, txn, now, round2, nextReceiptNo, nextCertNo, getSetting } = require('./db');
const notes = require('./notes');
const stock = require('./stock');
const visits = require('./visits');
const { sanitizeCertificate, certificateMeta } = require('./document-templates');

function err(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
function text(v, max = 2000) { return String(v ?? '').trim().slice(0, max); }
function taxId(v) {
  const value = text(v, 30).replace(/[^0-9]/g, '');
  if (value && value.length !== 13) throw err('เลขประจำตัวผู้เสียภาษีของผู้ชำระต้องมี 13 หลัก');
  return value;
}

function patientName(hn) {
  const p = db.prepare('SELECT prefix, first_name, last_name FROM patients WHERE hn = ?').get(hn);
  return `${p.prefix || ''}${p.first_name} ${p.last_name || ''}`.trim();
}

function receiptIssuerSnapshot() {
  return {
    name: getSetting('receipt_issuer_name', '') || getSetting('clinic_name', 'คลินิก'),
    address: getSetting('receipt_issuer_address', '') || getSetting('clinic_address', ''),
    phone: getSetting('clinic_phone', ''), tax_id: getSetting('receipt_tax_id', ''),
    branch: getSetting('receipt_branch', ''), book_no: getSetting('receipt_book_no', ''),
    clinic_license: getSetting('clinic_license', ''), logo_file: getSetting('clinic_logo_file', ''),
    footer: getSetting('document_footer', ''), vat_note: getSetting('receipt_vat_note', ''),
  };
}

function normalizePayer(raw, hn) {
  const patient = db.prepare('SELECT address FROM patients WHERE hn = ?').get(hn) || {};
  return {
    name: text(raw && raw.name, 200) || patientName(hn),
    address: text(raw && raw.address, 1000) || patient.address || '',
    tax_id: taxId(raw && raw.tax_id),
  };
}

function normalizePayment(payMethod, raw, total) {
  if (payMethod === 'cash') {
    const supplied = raw && raw.cash_received;
    const received = supplied === '' || supplied == null ? total : round2(Number(supplied));
    if (!Number.isFinite(received) || received < total) throw err('จำนวนเงินสดที่รับต้องไม่น้อยกว่ายอดสุทธิ');
    return { method: 'cash', cash_received: received, change: round2(received - total), transfer_ref: '' };
  }
  return { method: 'transfer', cash_received: null, change: null, transfer_ref: text(raw && raw.transfer_ref, 200) };
}

function createReceiptSnapshot(receiptNo, { visitId, hn, payMethod, payer, paymentDetails, userId, total }) {
  const cashier = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) || {};
  // ชื่อแพทย์ผู้ตรวจเป็นตัวเลือกของเจ้าของคลินิก — ตัดสิน ณ เวลาออกใบและ snapshot ถาวร
  // เพื่อให้ reprint เหมือนเดิมเสมอแม้เปลี่ยนการตั้งค่าภายหลัง
  const cashierSnap = { name: cashier.display_name || '' };
  if (getSetting('receipt_show_doctor', '1') === '1') {
    const doctor = db.prepare(`SELECT u.display_name FROM visits v JOIN users u ON u.id = v.doctor_id WHERE v.id = ?`).get(visitId);
    if (doctor && doctor.display_name) cashierSnap.doctor_name = doctor.display_name;
  }
  const issuedAt = now();
  db.prepare(`INSERT INTO receipt_document_snapshots
      (receipt_no, template_key, template_version, issuer_json, payer_json, payment_json, cashier_json, source, created_by, created_at)
    VALUES (?, 'receipt_a5', 2, ?, ?, ?, ?, 'new_issue', ?, ?)`)
    .run(receiptNo, JSON.stringify(receiptIssuerSnapshot()), JSON.stringify(normalizePayer(payer, hn)),
      JSON.stringify(normalizePayment(payMethod, paymentDetails, total)),
      JSON.stringify(cashierSnap), userId, issuedAt);
}

function insertReceiptWithLines({ visitId, hn, orderVersionId, lines, discount, discountReason, payMethod,
  payer, paymentDetails, userId, moveStock = true }) {
  // line ส่วนลดจาก order (หมอให้) พับเข้า receipts.discount รวมกับส่วนลดหน้าบิล (finding: order ส่วนลด)
  const realLines = lines.filter(l => l.type !== 'discount');
  const discLines = lines.filter(l => l.type === 'discount');
  if (!realLines.length) throw err('ไม่มีรายการยา/บริการในบิล');
  const subtotal = round2(realLines.reduce((s, l) => s + l.qty * l.price_each, 0));
  const lineDiscount = round2(discLines.reduce((s, l) => s + Math.abs(l.price_each) * l.qty, 0));
  const manualDiscount = round2(Number(discount) || 0);
  if (manualDiscount < 0) throw err('ส่วนลดไม่ถูกต้อง');
  if (manualDiscount > 0 && !discountReason) throw err('ต้องระบุเหตุผลส่วนลด');
  const totalDiscount = round2(lineDiscount + manualDiscount);
  if (totalDiscount > subtotal) throw err('ส่วนลดเกินยอดรวม');
  const reason = [...discLines.map(l => l.name), ...(manualDiscount > 0 ? [discountReason] : [])]
    .filter(Boolean).join('; ') || null;
  const total = round2(subtotal - totalDiscount);
  const receiptNo = nextReceiptNo();
  db.prepare(`INSERT INTO receipts (receipt_no, visit_id, hn, patient_name, order_version_id,
      subtotal, discount, discount_reason, total, pay_method, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ISSUED', ?, ?)`)
    .run(receiptNo, visitId, hn, patientName(hn), orderVersionId,
      subtotal, totalDiscount, reason, total, payMethod, userId, now());
  const ins = db.prepare(`INSERT INTO receipt_lines (receipt_no, line_type, ref_id, name, qty, unit, price_each, amount, instructions, cost_each, item_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const drugQ = db.prepare('SELECT cost, code FROM drugs WHERE id = ?');
  const serviceQ = db.prepare('SELECT cost FROM services WHERE id = ?');
  for (const l of realLines) {
    // snapshot ทุน ณ เวลาขาย — แก้ทุนภายหลังไม่กระทบกำไรของบิลเก่า (หลักเดียวกับราคาขาย)
    const drug = l.type === 'drug' ? (drugQ.get(l.ref_id) || {}) : {};
    const cost = l.type === 'drug' ? drug.cost ?? null
      : l.type === 'service' && l.ref_id != null ? serviceQ.get(l.ref_id)?.cost ?? null : null;
    ins.run(receiptNo, l.type, l.ref_id, l.name, l.qty, l.unit, l.price_each,
      round2(l.qty * l.price_each), l.instructions || null, cost, text(l.item_code || drug.code, 100) || null);
    if (l.type === 'drug' && moveStock) stock.move(l.ref_id, 'dispense', -l.qty, { ref: receiptNo, userId });
  }
  // checked invariant ยืนยันใน txn เดียวกัน (plan §4)
  const sum = db.prepare('SELECT ROUND(SUM(amount), 2) s FROM receipt_lines WHERE receipt_no = ?').get(receiptNo).s || 0;
  if (Math.abs(sum - totalDiscount - total) > 0.005) throw err('ยอดรวมไม่ตรงรายการ (invariant)', 500);
  createReceiptSnapshot(receiptNo, { visitId, hn, payMethod, payer, paymentDetails, userId, total });
  const payment = normalizePayment(payMethod, paymentDetails, total);
  return { receiptNo, subtotal, discount: totalDiscount, total, change: payment.change };
}

// รับเงิน: client ส่ง order_version_id ที่เห็นบนจอ — stale → 409 เงินในลิ้นชักตรงใบเสร็จเสมอ (finding 8)
function pay(visitId, { orderVersionId, discount, discountReason, payMethod, payer, paymentDetails, userId }) {
  if (!['cash', 'transfer'].includes(payMethod)) throw err('วิธีจ่ายไม่ถูกต้อง');
  return txn(() => {
    const v = visits.get(visitId);
    if (!v) throw err('ไม่พบ visit', 404);
    // กดซ้ำโดยไม่มี op_id ก็ต้องได้ภาษาคน ไม่ใช่ UNIQUE constraint ดิบจาก index (failure-injection 2026-08-25)
    const paid = db.prepare(`SELECT receipt_no, total FROM receipts WHERE visit_id = ? AND status = 'ISSUED'`).get(visitId);
    if (paid) throw err(`เก็บเงินของคิวนี้ไปแล้ว — ใบเสร็จ ${paid.receipt_no} ยอด ${paid.total} บาท พิมพ์สำเนาหรือแก้บิลได้จากการ์ดใบเสร็จ ไม่ต้องเก็บเงินซ้ำ`, 409);
    const latest = notes.latestOrderVersion(visitId);
    if (!latest) throw err('ยังไม่มีรายการสั่ง');
    if (latest.id !== orderVersionId) throw err('รายการถูกแก้แล้ว กรุณาตรวจสอบรายการล่าสุดก่อนรับเงิน', 409);
    if (!latest.lines.length) throw err('รายการว่าง — เพิ่มรายการหรือยกเลิก visit');
    const result = insertReceiptWithLines({
      visitId, hn: v.hn, orderVersionId: latest.id, lines: latest.lines,
      discount, discountReason, payMethod, payer, paymentDetails, userId,
    });
    visits.transition(visitId, 'pay', userId);
    return result;
  });
}

// แก้บิลหลังจ่าย: void + ออกใหม่ อะตอมมิก; ระบุว่ายากลับเข้าคลัง physical จริงหรือไม่ (finding 9)
function voidAndReissue(receiptNo, { newLines, returnedStock, discount, discountReason, payMethod, payer, paymentDetails, voidReason, userId }) {
  return txn(() => {
    const old = db.prepare(`SELECT * FROM receipts WHERE receipt_no = ?`).get(receiptNo);
    if (!old) throw err('ไม่พบใบเสร็จ', 404);
    if (old.status !== 'ISSUED') throw err('ใบเสร็จถูก void ไปแล้ว', 409);
    if (!voidReason) throw err('ต้องระบุเหตุผลการยกเลิกใบเสร็จ');
    voidReceiptRow(old, voidReason, returnedStock, userId);
    // รายการใหม่บันทึกเป็น order version ใหม่ของ visit (มี audit trail ต่อเนื่อง)
    const ov = notes.saveOrderVersion(old.visit_id, newLines, `แก้บิล (void ${receiptNo}): ${voidReason}`, userId);
    if (!ov.lines.length) throw err('รายการใหม่ว่าง — ถ้าต้องการคืนเงินทั้งหมดใช้เมนูคืนเงิน');
    const oldSnapshot = db.prepare('SELECT payer_json FROM receipt_document_snapshots WHERE receipt_no = ?').get(receiptNo);
    return insertReceiptWithLines({
      visitId: old.visit_id, hn: old.hn, orderVersionId: ov.id, lines: ov.lines,
      discount, discountReason, payMethod: payMethod || old.pay_method, userId,
      payer: payer || (oldSnapshot ? JSON.parse(oldSnapshot.payer_json) : null), paymentDetails,
      // ถ้ายาไม่ได้กลับเข้าคลัง การออกใบใหม่เป็นการแก้เอกสารเท่านั้น
      // ห้ามตัด stock ของรายการใหม่ซ้ำอีกครั้ง (ของจริงออกจากคลินิกไปแล้วในบิลเดิม)
      moveStock: returnedStock,
    });
  });
}

// คืนเงินเต็มจำนวน: void + COMPLETED→CANCELLED อะตอมมิก
function refund(receiptNo, { reason, returnedStock, userId }) {
  return txn(() => {
    const old = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(receiptNo);
    if (!old) throw err('ไม่พบใบเสร็จ', 404);
    if (old.status !== 'ISSUED') throw err('ใบเสร็จถูก void ไปแล้ว', 409);
    if (!reason) throw err('ต้องระบุเหตุผลการคืนเงิน');
    voidReceiptRow(old, reason, returnedStock, userId);
    visits.transition(old.visit_id, 'refund', userId, { reason: `คืนเงิน ${receiptNo}: ${reason}` });
    return { voided: receiptNo, refund_amount: old.total };
  });
}

function voidReceiptRow(old, reason, returnedStock, userId) {
  db.prepare(`UPDATE receipts SET status = 'VOID', void_reason = ?, voided_by = ?, voided_at = ? WHERE receipt_no = ?`)
    .run(reason, userId, now(), old.receipt_no);
  if (returnedStock) {
    const lines = db.prepare(`SELECT * FROM receipt_lines WHERE receipt_no = ? AND line_type = 'drug'`).all(old.receipt_no);
    for (const l of lines) {
      stock.move(l.ref_id, 'void_return', l.qty, { ref: old.receipt_no, reason: `void: ${reason}`, userId });
    }
  }
}

function getReceipt(receiptNo) {
  const r = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(receiptNo);
  if (!r) return null;
  r.lines = db.prepare('SELECT * FROM receipt_lines WHERE receipt_no = ? ORDER BY id').all(receiptNo);
  const snap = db.prepare('SELECT * FROM receipt_document_snapshots WHERE receipt_no = ?').get(receiptNo);
  if (snap) {
    r.document = {
      template_key: snap.template_key, template_version: snap.template_version, source: snap.source,
      issuer: JSON.parse(snap.issuer_json), payer: JSON.parse(snap.payer_json),
      payment: JSON.parse(snap.payment_json), cashier: JSON.parse(snap.cashier_json),
    };
  }
  return r;
}

function receiptsForVisit(visitId) {
  return db.prepare('SELECT * FROM receipts WHERE visit_id = ? ORDER BY created_at').all(visitId);
}

// ---------- ใบรับรองแพทย์: ออกแล้วเป็น record ถาวร reprint ได้เสมอ (finding 26) ----------
function issueMedCert(visitId, content, userId) {
  return txn(() => {
    const v = visits.get(visitId);
    if (!v) throw err('ไม่พบ visit', 404);
    if (!v.doctor_id) throw err('visit นี้ยังไม่มีแพทย์ตรวจ');
    if (v.doctor_id !== userId) throw err('ออกใบรับรองได้เฉพาะแพทย์เจ้าของ visit เท่านั้น', 403);
    const doctor = db.prepare('SELECT display_name, display_name_en, medical_license, specialty FROM users WHERE id = ?').get(v.doctor_id);
    const patient = db.prepare('SELECT prefix, first_name, last_name, citizen_id, address, birth_date, sex FROM patients WHERE hn = ?').get(v.hn);
    const safeContent = sanitizeCertificate(content || {});
    const templateType = safeContent.template_type;
    const official = templateType.startsWith('tmc_');
    if (official) validateOfficialCertificate({ v, doctor, patient, safeContent });
    if (templateType === 'general' && !doctor.medical_license) throw err('กรุณากรอกเลขใบประกอบวิชาชีพของแพทย์ก่อนออกใบรับรอง');
    const issuedAt = now();
    const snapshot = {
      template_version: safeContent.template_version || 1,
      clinic: {
        name: getSetting('clinic_name', 'คลินิก'), address: getSetting('clinic_address', ''),
        phone: getSetting('clinic_phone', ''), license: getSetting('clinic_license', ''),
        logo_file: getSetting('clinic_logo_file', ''), footer: getSetting('document_footer', ''),
        medcert_paper_size: getSetting('medcert_paper_size', 'A4'),
        name_en: getSetting('clinic_name_en', ''), address_en: getSetting('clinic_address_en', ''),
      },
      doctor: { name: doctor.display_name, name_en: doctor.display_name_en || '', medical_license: doctor.medical_license || '', specialty: doctor.specialty || '' },
      patient,
      vitals: { weight_kg: v.weight_kg, height_cm: v.height_cm, temp_c: v.temp_c,
        bp_sys: v.bp_sys, bp_dia: v.bp_dia, pulse: v.pulse, glucose: v.glucose },
      examined_at: v.visit_date, issued_at: issuedAt,
    };
    const documentContent = { ...safeContent, template_type: templateType, snapshot };
    const certNo = nextCertNo();
    db.prepare(`INSERT INTO med_certs (cert_no, visit_id, hn, patient_name, doctor_id, doctor_name, content_json,
        created_by, created_at, template_key, template_version, language)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(certNo, visitId, v.hn, patientName(v.hn), v.doctor_id, doctor.display_name,
        JSON.stringify(documentContent), userId, issuedAt, templateType, safeContent.template_version || 1, safeContent.language || 'th');
    const replaceCertNo = text(content && content.replace_cert_no, 40);
    if (replaceCertNo) {
      const old = db.prepare('SELECT cert_no, visit_id, doctor_id FROM med_certs WHERE cert_no = ?').get(replaceCertNo);
      if (!old || old.visit_id !== visitId || old.doctor_id !== userId) throw err('ใบรับรองเดิมไม่อยู่ใน visit นี้');
      if (db.prepare('SELECT 1 FROM med_cert_events WHERE cert_no = ?').get(replaceCertNo)) throw err('ใบรับรองเดิมถูกยกเลิกหรือออกแทนแล้ว', 409);
      db.prepare(`INSERT INTO med_cert_events (cert_no, action, reason, replacement_cert_no, created_by, created_at)
        VALUES (?, 'replace', ?, ?, ?, ?)`).run(replaceCertNo, text(content.replace_reason, 1000) || 'ออกเอกสารใหม่แทน', certNo, userId, issuedAt);
    }
    return certNo;
  });
}

function validateOfficialCertificate({ v, doctor, patient, safeContent }) {
  if (!doctor.medical_license) throw err('กรุณากรอกเลขใบประกอบวิชาชีพของแพทย์ก่อนออกใบรับรอง');
  if (!patient.citizen_id || !patient.address) throw err('แบบนี้ต้องมีเลขบัตรประชาชนและที่อยู่ของผู้รับการตรวจ');
  for (const [value, label] of [[v.weight_kg, 'น้ำหนัก'], [v.height_cm, 'ส่วนสูง'], [v.bp_sys, 'ความดันบน'], [v.bp_dia, 'ความดันล่าง'], [v.pulse, 'ชีพจร']]) {
    if (value == null || value === '') throw err(`กรุณาบันทึก${label}ก่อนออกใบรับรอง`);
  }
  if (safeContent.language === 'en') {
    if (!doctor.display_name_en) throw err('กรุณากรอกชื่อแพทย์ภาษาอังกฤษก่อนออกแบบภาษาอังกฤษ');
    if (!getSetting('clinic_name_en', '') || !getSetting('clinic_address_en', '')) throw err('กรุณากรอกชื่อและที่อยู่คลินิกภาษาอังกฤษก่อนออกแบบภาษาอังกฤษ');
  }
}

function voidMedCert(certNo, reason, userId) {
  return txn(() => {
    const cert = db.prepare('SELECT * FROM med_certs WHERE cert_no = ?').get(certNo);
    if (!cert) throw err('ไม่พบใบรับรองแพทย์', 404);
    if (cert.doctor_id !== userId) throw err('ยกเลิกได้เฉพาะแพทย์ผู้ออกเอกสาร', 403);
    if (!text(reason)) throw err('กรุณาระบุเหตุผลการยกเลิก');
    if (db.prepare('SELECT 1 FROM med_cert_events WHERE cert_no = ?').get(certNo)) throw err('ใบรับรองนี้ถูกยกเลิกหรือออกแทนแล้ว', 409);
    db.prepare(`INSERT INTO med_cert_events (cert_no, action, reason, replacement_cert_no, created_by, created_at)
      VALUES (?, 'void', ?, NULL, ?, ?)`).run(certNo, text(reason, 1000), userId, now());
    return { ok: true };
  });
}

function getMedCert(certNo) {
  const c = db.prepare('SELECT * FROM med_certs WHERE cert_no = ?').get(certNo);
  if (c) {
    c.content = JSON.parse(c.content_json);
    c.event = db.prepare('SELECT * FROM med_cert_events WHERE cert_no = ?').get(certNo) || null;
    c.meta = certificateMeta(c.content);
  }
  return c;
}
function medCertsForVisit(visitId) {
  return db.prepare(`SELECT m.cert_no, m.created_at, m.template_key, m.template_version, m.language,
      e.action, e.reason, e.replacement_cert_no
    FROM med_certs m LEFT JOIN med_cert_events e ON e.cert_no = m.cert_no
    WHERE m.visit_id = ? ORDER BY m.created_at`).all(visitId);
}

module.exports = { pay, voidAndReissue, refund, getReceipt, receiptsForVisit,
  issueMedCert, voidMedCert, getMedCert, medCertsForVisit, patientName };
