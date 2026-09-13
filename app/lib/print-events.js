'use strict';
// บันทึกว่าใครพิมพ์เอกสารใบไหนเมื่อไหร่ จากเครื่องไหน (append-only, schema v10)
//
// ทำไมต้องมี: คลินิกมีเครื่องพิมพ์ตัวเดียวที่หน้าร้าน หมอออกใบรับรองที่ห้องตรวจแล้วพิมพ์เองไม่ได้
// หน้าร้านจึงต้องเห็นข้ามเครื่องว่า "ใบไหนยังรอพิมพ์" — สถานะนี้อยู่ในตารางนี้เท่านั้น
// ห้ามไปแตะ med_certs (append-only ตามกฎเหล็กข้อ 4)
const { db, now } = require('./db');

const DOC_TYPES = ['medcert', 'receipt', 'appointment'];
const CERT_TYPE_TH = { general: 'ทั่วไป', tmc_health_th: 'ตรวจสุขภาพ', tmc_driving_th: 'ใบขับขี่', tmc_driving_en: 'ใบขับขี่ EN' };

function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// เครื่องที่ต่อเครื่องพิมพ์คือเครื่องที่รัน server เอง (เข้าผ่าน localhost) — เครื่องอื่นเข้าผ่าน LAN
function stationOf(isLoopback) { return isLoopback ? 'host' : 'lan'; }

function record({ docType, docRef, visitId, userId, role, station }) {
  if (!DOC_TYPES.includes(docType)) throw err('ชนิดเอกสารไม่ถูกต้อง');
  const ref = String(docRef || '').trim();
  if (!ref || ref.length > 64) throw err('เลขที่เอกสารไม่ถูกต้อง');
  if (!['host', 'lan'].includes(station)) throw err('ไม่ทราบว่าสั่งพิมพ์จากเครื่องไหน');
  const visit = visitId == null || visitId === '' ? null : Number(visitId);
  if (visit !== null && !Number.isInteger(visit)) throw err('visit ไม่ถูกต้อง');
  db.prepare(`INSERT INTO document_print_events (doc_type, doc_ref, visit_id, printed_by, printed_role, station, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(docType, ref, visit, userId, role, station, now());
  return { ok: true, doc_type: docType, doc_ref: ref, station };
}

// ใบรับรองของ visit เหล่านี้ที่ยังไม่เคยถูกพิมพ์จากเครื่องหน้าร้าน (station='host')
// และยังไม่ถูก void/ออกใบใหม่แทน — ใบที่ถูกแทนแล้วมี row ใน med_cert_events จึงหลุดออกเอง
// เหลือเฉพาะใบใหม่ซึ่งยังไม่มี event (acceptance ข้อ 4)
function pendingForVisits(visitIds) {
  const result = new Map();
  const ids = [...new Set((visitIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return result;
  const holes = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT m.visit_id, m.cert_no, m.template_key, m.created_at, m.doctor_name,
           (SELECT MAX(pe.created_at) FROM document_print_events pe
              WHERE pe.doc_type = 'medcert' AND pe.doc_ref = m.cert_no AND pe.station = 'lan') AS viewed_at
    FROM med_certs m
    LEFT JOIN med_cert_events e ON e.cert_no = m.cert_no
    WHERE m.visit_id IN (${holes}) AND e.cert_no IS NULL
      AND NOT EXISTS (SELECT 1 FROM document_print_events p
        WHERE p.doc_type = 'medcert' AND p.doc_ref = m.cert_no AND p.station = 'host')
    ORDER BY m.created_at`).all(...ids);
  for (const row of rows) {
    if (!result.has(row.visit_id)) result.set(row.visit_id, []);
    result.get(row.visit_id).push({
      doc_type: 'medcert', doc_ref: row.cert_no,
      label: `ใบรับรอง ${row.cert_no}`,
      kind: CERT_TYPE_TH[row.template_key] || row.template_key || 'ใบรับรองแพทย์',
      issued_at: row.created_at, issued_by_name: row.doctor_name || '',
      viewed_at: row.viewed_at || null,
    });
  }
  return result;
}

// เติม pending_docs ให้ payload คิว (poll ทุก 3 วิ) — query เดียวสำหรับทั้งคิว ไม่ยิงต่อแถว
function attachPendingDocs(queue) {
  const pending = pendingForVisits(queue.map(v => v.id));
  for (const visit of queue) visit.pending_docs = pending.get(visit.id) || [];
  return queue;
}

// ประวัติการพิมพ์ของ visit สำหรับกล่อง "เอกสารของ visit นี้" ที่ช่องคิดเงิน
function eventsForVisit(visitId) {
  return db.prepare(`
    SELECT p.doc_type, p.doc_ref, p.station, p.created_at, p.printed_role, u.display_name AS printed_by_name
    FROM document_print_events p LEFT JOIN users u ON u.id = p.printed_by
    WHERE p.visit_id = ? ORDER BY p.created_at`).all(Number(visitId));
}

module.exports = { record, pendingForVisits, attachPendingDocs, eventsForVisit, stationOf, DOC_TYPES };
