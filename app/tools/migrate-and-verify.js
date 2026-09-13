'use strict';
// เรียก migration ปัจจุบันแล้วตรวจ integrity / schema / จำนวนแถวสำคัญ หลังอัปเกรด
//
// ใช้:
//   node tools/migrate-and-verify.js [--expect <ไฟล์ json จาก pre-upgrade-snapshot.js>] [--rehearsal]
//
//   --expect     เทียบจำนวนหลัง migrate กับก่อน migrate: receipts/med_certs ต้องเท่ากันเป๊ะ (append-only)
//                patients/visits ต้องไม่น้อยกว่าเดิม — รูปแบบไฟล์ = บรรทัด JSON ที่ pre-upgrade-snapshot.js พิมพ์ออกมา
//   --rehearsal  โหมดซ้อม (updater ใช้): บังคับให้มี CLINIC_DATA_DIR ที่ไม่ใช่ app/data — ห้ามซ้อมกับฐานจริง
//
// ไม่มี --rehearsal = ใช้กับฐานตาม CLINIC_DATA_DIR หรือ app/data (ขั้นตอน migrate จริงตามกฎเหล็กข้อ 6 —
// ต้องมี snapshot ที่ verify แล้วก่อน) · ผลลัพธ์พิมพ์เฉพาะตัวเลข/สถานะ ไม่มีข้อมูลคนไข้หรือกุญแจ
const path = require('node:path');
const fs = require('node:fs');
const { SCHEMA_VERSION, SCHEMA_MARKERS, COUNT_TABLES } = require('../lib/schema-version');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const rehearsal = process.argv.includes('--rehearsal');
const expectFile = argValue('--expect');

// ---- ด่านความปลอดภัยก่อน require lib/db.js (ซึ่งจะเปิด+migrate ทันที) ----
const defaultDataDir = path.resolve(__dirname, '..', 'data');
const dataDir = process.env.CLINIC_DATA_DIR ? path.resolve(process.env.CLINIC_DATA_DIR) : defaultDataDir;
if (rehearsal && dataDir.toLowerCase() === defaultDataDir.toLowerCase()) {
  console.error('ซ้อม migration ไม่ได้: โหมด --rehearsal ต้องตั้ง CLINIC_DATA_DIR ไปยังสำเนาที่แยกไว้ ห้ามชี้ไปที่ app/data (ฐานจริง)');
  process.exit(2);
}
if (!fs.existsSync(path.join(dataDir, 'clinic.db'))) {
  console.error(`ไม่พบฐานข้อมูลที่ ${path.join(dataDir, 'clinic.db')} — ไม่สร้างฐานใหม่ในโหมดตรวจ`);
  process.exit(2);
}

let expected = null;
if (expectFile) {
  try { expected = JSON.parse(fs.readFileSync(expectFile, 'utf8')); }
  catch (e) { console.error(`อ่านไฟล์ --expect ไม่ได้: ${e.message}`); process.exit(2); }
}

const { db, DB_PATH } = require('../lib/db'); // migrate() รันตรงนี้ (หรือโยน SCHEMA_TOO_NEW)

try {
  const count = table => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(x => x.name === col);

  const result = {
    database: DB_PATH,
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    foreign_keys: db.prepare('PRAGMA foreign_key_check').all().length === 0 ? 'ok' : 'broken',
    user_version: db.prepare('PRAGMA user_version').get().user_version,
    expected_version: SCHEMA_VERSION,
    markers_ok: SCHEMA_MARKERS.tables.every(hasTable) && SCHEMA_MARKERS.columns.every(([t, c]) => hasColumn(t, c)),
  };
  for (const t of [...COUNT_TABLES.exact, ...COUNT_TABLES.atLeast]) result[t] = count(t);

  const problems = [];
  if (result.integrity !== 'ok') problems.push(`integrity_check=${result.integrity}`);
  if (result.foreign_keys !== 'ok') problems.push('foreign_key_check พบความเชื่อมโยงไม่ครบ');
  if (result.user_version !== SCHEMA_VERSION) problems.push(`user_version=${result.user_version} ไม่ใช่ ${SCHEMA_VERSION}`);
  if (!result.markers_ok) problems.push('วัตถุ schema ที่คาดไว้ไม่ครบ');
  if (expected) {
    for (const t of COUNT_TABLES.exact) {
      if (typeof expected[t] === 'number' && expected[t] !== result[t]) problems.push(`${t}: ก่อน ${expected[t]} หลัง ${result[t]} (ต้องเท่ากัน)`);
    }
    for (const t of COUNT_TABLES.atLeast) {
      if (typeof expected[t] === 'number' && result[t] < expected[t]) problems.push(`${t}: ก่อน ${expected[t]} หลัง ${result[t]} (หายไป)`);
    }
    if (typeof expected.user_version === 'number' && expected.user_version > result.user_version) {
      problems.push(`snapshot อยู่ที่ schema ${expected.user_version} ใหม่กว่าโปรแกรม`);
    }
  }
  result.rehearsal = rehearsal;
  result.ok = problems.length === 0;
  if (!result.ok) throw new Error(`ตรวจ migration ไม่ผ่าน: ${problems.join(' · ')} — ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result));
} finally { db.close(); }
