'use strict';
// เวอร์ชัน schema ที่โค้ดชุดนี้รองรับ — โมดูลนี้ **ห้าม** เปิดฐานข้อมูลหรือ require lib/db.js
// เพื่อให้เครื่องมือ (pre-upgrade-snapshot, migrate-and-verify, updater) อ่านค่านี้ได้
// โดยไม่ trigger migration กับฐานข้อมูลจริง
//
// กติกาเมื่อเพิ่ม migration ใน lib/db.js: บวกเลขนี้ขึ้น 1 และเพิ่มขั้นตอนใน migrateSteps() คู่กันเสมอ
const SCHEMA_VERSION = 13;

// วัตถุ schema ที่ต้องมีเมื่ออยู่ที่ SCHEMA_VERSION — ใช้ตรวจหลัง migrate ว่าไม่ได้ข้ามขั้น
// (ตาราง append-only ของ v9/v10/v11, client_ops ของ v12, drug_lots ของ v13 และคอลัมน์ที่เพิ่มใน v9/v13)
const SCHEMA_MARKERS = {
  tables: ['receipt_document_snapshots', 'med_cert_events', 'document_print_events', 'auth_events', 'access_log', 'client_ops', 'drug_lots'],
  columns: [['users', 'display_name_en'], ['receipt_lines', 'item_code'], ['med_certs', 'template_key'], ['drugs', 'expiry_warn_days']],
};

// ตารางที่ health check ของ updater ใช้เทียบจำนวนก่อน/หลัง:
// exact = append-only ห้ามลดห้ามเพิ่มระหว่าง migrate · atLeast = ห้ามหาย แต่ migration ในอนาคตอาจ merge ตามกฎได้
const COUNT_TABLES = { exact: ['receipts', 'med_certs'], atLeast: ['patients', 'visits'] };

module.exports = { SCHEMA_VERSION, SCHEMA_MARKERS, COUNT_TABLES };
