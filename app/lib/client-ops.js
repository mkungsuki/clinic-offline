'use strict';
// exactly-once registry สำหรับ operation ที่ browser อาจส่งซ้ำหลัง connection ขาด (incident 2026-08-24)
// หลัก: browser แนบ op_id (UUID ต่อการเปิดฟอร์ม 1 ครั้ง) → ครั้งแรกบันทึกผลไว้ ครั้งซ้ำคืนผลเดิม
// payload_hash กัน op_id เดียวกันถูกใช้กับข้อมูลคนละชุด (ไม่มีทางเกิดจาก client ปกติ — ถ้าเกิด = ปฏิเสธ ไม่เดา)
const crypto = require('node:crypto');
const { db, now } = require('./db');

const OP_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;

function normalizeOpId(value) {
  return typeof value === 'string' && OP_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

// hash เฉพาะเนื้อหา (ตัด op_id ออก) — retry จาก client เดิมส่ง body เดิมเป๊ะ จึง hash ตรงกันเสมอ
function hashPayload(body) {
  const clone = { ...body };
  delete clone.op_id;
  return crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex');
}

function lookup(kind, opId) {
  return db.prepare('SELECT * FROM client_ops WHERE op_id = ? AND kind = ?').get(opId, kind) || null;
}

// เรียกภายใน txn เดียวกับงานจริงเสมอ — ผลกับบันทึก op ต้อง commit ด้วยกัน
function record(kind, opId, payloadHash, result) {
  db.prepare('INSERT INTO client_ops (op_id, kind, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(opId, kind, payloadHash, JSON.stringify(result), now());
}

// registry เป็น cache กัน retry ระยะสั้น — เก็บ 7 วันพอ (ฟอร์มค้างข้ามสัปดาห์ไม่ใช่ retry แล้ว)
function prune() {
  try { db.prepare("DELETE FROM client_ops WHERE created_at < datetime('now', 'localtime', '-7 days')").run(); } catch {}
}

module.exports = { normalizeOpId, hashPayload, lookup, record, prune };
