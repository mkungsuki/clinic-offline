'use strict';
const { db } = require('./db');
function active() { return db.prepare("SELECT id,display_name FROM users WHERE role='doctor' AND active=1 ORDER BY id").all(); }
function multiple() { return active().length > 1; }
function validate(value) {
  if (value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || !active().some(d => d.id === id))
    throw Object.assign(new Error('หมอที่เลือกไม่ได้เปิดใช้งานแล้ว กรุณาเลือกใหม่'), { status:400 });
  return id;
}
module.exports = { active, multiple, validate };
