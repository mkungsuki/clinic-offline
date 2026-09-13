'use strict';
// สร้าง SQLite snapshot ก่อน migration โดยไม่ require lib/db.js (จึงไม่ trigger migration)
// usage: node tools/pre-upgrade-snapshot.js <source.db> <snapshot.db>
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const [sourceArg, snapshotArg] = process.argv.slice(2);
if (!sourceArg || !snapshotArg) throw new Error('ใช้: node tools/pre-upgrade-snapshot.js <source.db> <snapshot.db>');
const source = path.resolve(sourceArg), snapshot = path.resolve(snapshotArg);
if (!fs.existsSync(source)) throw new Error(`ไม่พบฐานข้อมูล: ${source}`);
if (fs.existsSync(snapshot)) throw new Error(`snapshot มีอยู่แล้ว: ${snapshot}`);
fs.mkdirSync(path.dirname(snapshot), { recursive: true });

const db = new DatabaseSync(source);
try { db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`); }
finally { db.close(); }

const check = new DatabaseSync(snapshot, { readOnly: true });
try {
  const count = table => check.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  const result = {
    snapshot, integrity: check.prepare('PRAGMA integrity_check').get().integrity_check,
    user_version: check.prepare('PRAGMA user_version').get().user_version,
    patients: count('patients'), visits: count('visits'), receipts: count('receipts'), med_certs: count('med_certs'),
  };
  if (result.integrity !== 'ok') throw new Error(`integrity_check: ${result.integrity}`);
  console.log(JSON.stringify(result));
} finally { check.close(); }
