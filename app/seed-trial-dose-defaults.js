'use strict';
// Authored examples for the synthetic trial only. No prose-to-dose parser and no
// changes to saved orders, receipt snapshots, user-authored drugs, or copied history.
const fs = require('node:fs');
const path = require('node:path');
const DoseTemplate = require('./public/dose-template');
const MARKER = 'demo_dose_defaults_v1';
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// These are the literal fixtures in seed.js and seed-mock-day.js. A match is a
// provenance check, never a rule that interprets an arbitrary prescription.
const base = [
  ['Paracetamol 500mg', 'เม็ด', 2, 500, 'ครั้งละ 1-2 เม็ด ทุก 4-6 ชม. เวลาปวด/มีไข้'],
  ['Amoxicillin 500mg', 'แคปซูล', 5, 300, 'ครั้งละ 1 แคปซูล วันละ 3 ครั้ง หลังอาหาร จนหมด'],
  ['Cetirizine 10mg', 'เม็ด', 3, 200, 'ครั้งละ 1 เม็ด วันละ 1 ครั้ง ก่อนนอน', { b: 1 }],
  ['Omeprazole 20mg', 'แคปซูล', 4, 200, 'ครั้งละ 1 แคปซูล วันละ 1 ครั้ง ก่อนอาหารเช้า', { m: 1, timing: 'ก่อนอาหาร' }],
  ['CPM 4mg', 'เม็ด', 1, 300, 'ครั้งละ 1 เม็ด วันละ 3 ครั้ง (อาจง่วง)'],
  ['Ibuprofen 400mg', 'เม็ด', 3, 200, 'ครั้งละ 1 เม็ด วันละ 3 ครั้ง หลังอาหารทันที'],
  ['ORS ผงเกลือแร่', 'ซอง', 5, 100, 'ละลายน้ำ 250 มล. จิบบ่อยๆ'],
  ['Amlodipine 5mg', 'เม็ด', 3, 300, 'ครั้งละ 1 เม็ด วันละ 1 ครั้ง เช้า', { m: 1 }],
  ['Metformin 500mg', 'เม็ด', 2, 1000, 'ครั้งละ 1 เม็ด วันละ 2 ครั้ง หลังอาหารเช้า-เย็น', { m: 1, e: 1, timing: 'หลังอาหาร' }],
  ['Losartan 50mg', 'เม็ด', 3.5, 500, 'ครั้งละ 1 เม็ด วันละ 1 ครั้ง เช้า', { m: 1 }],
  ['Simvastatin 20mg', 'เม็ด', 3, 400, 'ครั้งละ 1 เม็ด วันละ 1 ครั้ง ก่อนนอน', { b: 1 }],
  ['Norfloxacin 400mg', 'เม็ด', 5, 200, 'ครั้งละ 1 เม็ด วันละ 2 ครั้ง หลังอาหาร จนหมด'],
  ['Domperidone 10mg', 'เม็ด', 2, 300, 'ครั้งละ 1 เม็ด วันละ 3 ครั้ง ก่อนอาหาร'],
  ['Chloramphenicol eye drops', 'ขวด', 35, 30, 'หยอดตาข้างที่เป็น ครั้งละ 1-2 หยด วันละ 4 ครั้ง'],
  ['Salbutamol inhaler', 'หลอด', 120, 3, 'พ่น 1-2 puff เวลาหอบ'],
];
const commonSchedules = {
  'Loratadine 10mg': { m: 1, additional_instructions: '(ไม่ง่วง)' },
  'Hydroxyzine 10mg': { m: 1, b: 1, additional_instructions: '(อาจง่วง)' },
};
function definitions() {
  const out = base.map(([name, unit, price, received, instructions, schedule], i) => ({
    name, unit, price, received, instructions, schedule, mode: 'standard', code: null,
    generic: null, reason: i < 8 ? 'ยอดตั้งต้น (demo)' : 'ยอดตั้งต้น',
  }));
  let low = 2;
  for (const [index, item] of require('./lib/common-drugs.json').drugs.entries()) {
    if (out.length >= 30) break;
    if (out.some(d => d.name === item.name)) continue;
    out.push({ name: item.name, unit: item.unit, price: 2 + (index % 8) * 2.5,
      received: low > 0 ? 3 : 800, instructions: item.default_instructions,
      schedule: commonSchedules[item.name], mode: item.dose_mode,
      code: `TRIAL-${String(index + 1).padStart(3, '0')}`, generic: item.generic_name,
      reason: 'ยอดตั้งต้นชุดทดลอง' });
    low--;
  }
  return out;
}
function templateFor(def) {
  // Frequency alone does not specify the clock slots; ranges and dose units that
  // differ from stock units likewise stay manual. No invented duration or amount.
  return DoseTemplate.normalize(def.schedule
    ? { ...DoseTemplate.empty('standard'), ...def.schedule }
    : { ...DoseTemplate.empty('manual'), additional_instructions: def.instructions }, def.unit);
}
function ensureTrialDoseDefaults({ freshSeed = false, appRoot = __dirname } = {}) {
  const defaultData = path.join(appRoot, 'data');
  const explicitData = process.env.CLINIC_DATA_DIR;
  const profilePath = path.join(appRoot, '..', 'update', 'install-profile.json');
  let installedTrial = false;
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    installedTrial = profile.product === 'clinic-offline' && profile.variant === 'trial';
  } catch { /* no install profile */ }
  // Reject before db.js can create/open a database.
  if (freshSeed) {
    if (!explicitData) return { skipped: 'explicit_data_required' };
    if (samePath(explicitData, defaultData) && !installedTrial) return { skipped: 'default_data_not_trial' };
    if (fs.existsSync(profilePath) && !installedTrial) return { skipped: 'not_trial_install' };
  } else {
    if (!installedTrial || !fs.existsSync(path.join(appRoot, '..', 'update', 'installed.marker'))) return { skipped: 'not_trial_install' };
    if (explicitData && !samePath(explicitData, defaultData)) return { skipped: 'redirected_data' };
    if (!explicitData && !samePath(appRoot, __dirname)) return { skipped: 'different_app_root' };
  }
  const { db, txn, DATA_DIR, getSetting, setSetting } = require('./lib/db');
  if (!samePath(DATA_DIR, explicitData || defaultData)) return { skipped: 'different_loaded_data' };
  if (getSetting('demo_mode', '0') !== '1') return { skipped: 'not_demo' };
  if (getSetting(MARKER, '') === '1') return { skipped: 'already_seeded' };

  return txn(() => {
    const eligible = new Map();
    const preserved = [];
    for (const def of definitions()) {
      const matches = db.prepare('SELECT * FROM drugs WHERE name=?').all(def.name);
      const d = matches.length === 1 ? matches[0] : null;
      if (!d) continue;
      const first = db.prepare('SELECT type, qty, reason FROM stock_movements WHERE drug_id=? ORDER BY id LIMIT 1').get(d.id);
      if (d.active !== 1 || d.unit !== def.unit || d.default_instructions !== def.instructions ||
          d.default_dose_json !== null || d.dose_mode !== def.mode || d.code !== def.code ||
          d.generic_name !== def.generic || first?.type !== 'receive' || first.qty !== def.received || first.reason !== def.reason) {
        preserved.push(d.name);
        continue;
      }
      const dose = templateFor(def);
      eligible.set(d.name, { def, drug: d, dose });
    }
    // Upgrade only the three exact untouched seed sets. A changed field or line
    // preserves the whole set, including custom names, quantities and instructions.
    const favDefs = [
      ['ชุดหวัดผู้ใหญ่', 'J06.9', ['Paracetamol 500mg', 'Chlorpheniramine 4mg']],
      ['ชุดโรคกระเพาะ', 'K30', ['Omeprazole 20mg', 'Domperidone 10mg']],
      ['ชุดติดตามความดัน', 'I10', ['Amlodipine 5mg']],
    ];
    const doctor = db.prepare("SELECT id FROM users WHERE username='doctor' AND role='doctor' AND active=1").get();
    let sets = 0;
    for (const [name, icd, names] of favDefs) {
      const matches = db.prepare('SELECT * FROM fav_sets WHERE name=?').all(name);
      const f = matches.length === 1 ? matches[0] : null;
      if (!f || !doctor || f.active !== 1 || f.created_by !== doctor.id || f.dx_text !== name.slice(3) || f.icd10 !== icd || f.cc || f.note_json) continue;
      const members = names.map(n => eligible.get(n));
      if (members.some(m => !m)) continue;
      const expected = members.map(({ def, drug }) => ({ type: 'drug', ref_id: drug.id, name: def.name,
        qty: 10, unit: def.unit, price_each: def.price, instructions: def.instructions, dose_mode: def.mode }));
      if (f.lines_json !== JSON.stringify(expected)) continue;
      const lines = expected.map((line, i) => ({ ...line, dose_mode: members[i].dose.mode,
        dose: { ...members[i].dose, qty_source: 'manual' },
        instructions: DoseTemplate.text(members[i].dose, line.unit) }));
      db.prepare('UPDATE fav_sets SET lines_json=? WHERE id=?').run(JSON.stringify(lines), f.id);
      sets++;
    }
    for (const { drug, dose } of eligible.values()) {
      db.prepare('UPDATE drugs SET default_dose_json=?, dose_mode=?, default_instructions=? WHERE id=?')
        .run(JSON.stringify(dose), dose.mode, DoseTemplate.text(dose, drug.unit), drug.id);
    }
    setSetting(MARKER, '1');
    return { drugs: eligible.size, sets, preserved };
  });
}
module.exports = { ensureTrialDoseDefaults, MARKER };
