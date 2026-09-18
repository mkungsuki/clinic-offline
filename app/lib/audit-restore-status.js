'use strict';
// Read-only evidence adapter. Deliberately does not import db/recovery/password modules.
const fs = require('node:fs');
const path = require('node:path');

const TITLE = 'ผลการกู้ที่ตัวช่วยบันทึกไว้บนเครื่องนี้';
const CAVEAT = 'ข้อมูลนี้เป็นผลที่ตัวช่วยบันทึกไว้ ไม่ได้ยืนยันที่มาของฐานข้อมูลปัจจุบัน ประวัติในโปรแกรมอาจย้อนกลับตามสำเนาที่กู้';
const ACTOR = 'ตัวช่วยกู้บนเครื่องหลัก — ไม่ระบุบัญชี';
function result(state, message, extra = {}) {
  return { state, title: TITLE, message, actor: ACTOR, caveat: CAVEAT, ...extra };
}
function safeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}
function noLinks(file) {
  let current = path.resolve(file);
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('UNSAFE_EVIDENCE');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function readJson(file) {
  noLinks(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('INVALID_EVIDENCE');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_EVIDENCE');
  return value;
}

function readStatus({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) return result('unknown', 'ยังยืนยันผลการกู้ไม่ได้');
  const parent = path.dirname(path.resolve(dataDir));
  let operation;
  try { operation = readJson(path.join(parent, 'recovery-operation.json')); }
  catch (error) {
    return error.code === 'ENOENT'
      ? result('missing', 'ยังไม่พบผลการกู้ที่ตัวช่วยบันทึกไว้บนเครื่องนี้')
      : result('unknown', 'อ่านผลการกู้ไม่ได้ จึงยังยืนยันผลไม่ได้');
  }
  if (typeof operation.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(operation.id)) return result('unknown', 'หลักฐานการกู้ไม่ครบ จึงยังยืนยันผลไม่ได้');
  const matches = [];
  try {
    const root = path.join(parent, 'recovery-rollbacks');
    noLinks(root);
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length > 5000) return result('unknown', 'มีหลักฐานหลายรายการเกินขอบเขตที่ตรวจได้ จึงยังยืนยันผลไม่ได้');
    for (const entry of entries) {
      if (!entry.name.startsWith('before-')) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('UNSAFE_EVIDENCE');
      const journal = readJson(path.join(root, entry.name, 'restore-journal.json'));
      if (journal.operationId === operation.id) matches.push(journal);
    }
  } catch (error) {
    if (error.code === 'ENOENT' && ['prepared', 'published'].includes(operation.state)) return result('pending', 'การกู้ครั้งล่าสุดยังไม่มีผลยืนยันว่าจบแล้ว');
    return result('unknown', 'หลักฐานการกู้ไม่ครบหรืออ่านไม่ได้ จึงยังยืนยันผลไม่ได้');
  }
  if (matches.length !== 1) return result('unknown', 'หลักฐานการกู้ไม่ตรงกัน จึงยังยืนยันผลไม่ได้');
  const journal = matches[0];
  if (typeof journal.state === 'string' && journal.state.startsWith('rolled-back')) return result('rolled-back', 'การกู้ครั้งนั้นถูกย้อนกลับไปใช้ข้อมูลเดิม');
  if (['prepared', 'published'].includes(operation.state) || ['prepared', 'moving-old', 'old-preserved', 'publishing-new', 'rolling-back', 'rolling-back-after-start-failure'].includes(journal.state)) {
    return result('pending', 'การกู้ครั้งล่าสุดยังไม่มีผลยืนยันว่าจบแล้ว');
  }
  if (operation.state !== 'complete' || journal.state !== 'committed') return result('unknown', 'ยังยืนยันผลการกู้ครั้งล่าสุดไม่ได้');
  const backupCreatedAt = safeDate(operation.backupCreatedAt) || safeDate(operation.result?.backupCreatedAt);
  return result('complete', 'ตัวช่วยรายงานว่ากู้สำเร็จ', backupCreatedAt ? { backupCreatedAt } : { dateNotice: 'ไม่ทราบวันที่สำเนา' });
}

module.exports = { readStatus };
