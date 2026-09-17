'use strict';
// Date-only, clearly labelled synthetic examples. Shipped in the trial package only.
// Never receive/adjust stock here: drug_lots does not track a lot's remaining quantity.
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'demo_stock_lots_v1';
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function trialProfile(appRoot) {
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(appRoot, '..', 'update', 'install-profile.json'), 'utf8'));
    return profile.product === 'clinic-offline' && profile.variant === 'trial';
  } catch { return false; }
}

function ensureTrialLots({ freshSeed = false, appRoot = __dirname } = {}) {
  const defaultData = path.join(appRoot, 'data');
  const explicitData = process.env.CLINIC_DATA_DIR;
  const installedTrial = trialProfile(appRoot);
  // Check before requiring db.js: a rejected invocation must not even create a database.
  if (freshSeed) {
    if (!explicitData) return { skipped: 'explicit_data_required' };
    if (samePath(explicitData, defaultData) && !installedTrial) return { skipped: 'default_data_not_trial' };
    if (fs.existsSync(path.join(appRoot, '..', 'update', 'install-profile.json')) && !installedTrial) {
      return { skipped: 'not_trial_install' };
    }
  } else {
    if (!installedTrial || !fs.existsSync(path.join(appRoot, '..', 'update', 'installed.marker'))) {
      return { skipped: 'not_trial_install' };
    }
    if (explicitData && !samePath(explicitData, defaultData)) return { skipped: 'redirected_data' };
    if (!explicitData && !samePath(appRoot, __dirname)) return { skipped: 'different_app_root' };
  }
  const { db, txn, getSetting, setSetting, today, DATA_DIR } = require('./lib/db');
  // The loaded db singleton must match the requested installation, including test callers.
  if (!samePath(DATA_DIR, explicitData || defaultData)) return { skipped: 'different_loaded_data' };
  if (getSetting('demo_mode', '0') !== '1') return { skipped: 'not_demo' };
  if (getSetting(MARKER, '') === '1') return { skipped: 'already_seeded' };

  const front = db.prepare("SELECT id FROM users WHERE role='front' AND active=1 ORDER BY id LIMIT 1").get();
  if (!front) return { skipped: 'no_demo_user' };
  const stock = require('./lib/stock');
  const offset = days => {
    const date = new Date(today() + 'T00:00:00');
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const examples = [
    { name: 'Amlodipine 5mg', lots: [
      { days: 30, near: true, label: 'ตัวอย่างฝึกใช้ · LOT-AMLO-A' },
      { days: 365, far: true, label: 'ตัวอย่างฝึกใช้ · LOT-AMLO-B' },
      { days: -90, label: 'ตัวอย่างฝึกใช้ · LOT-AMLO-เก็บออกแล้ว', closed: true },
    ] },
    { name: 'Amoxicillin 500mg', lots: [
      { days: -7, label: 'ตัวอย่างฝึกใช้ · LOT-AMOX-A' },
      { days: 180, far: true, label: 'ตัวอย่างฝึกใช้ · LOT-AMOX-B' },
    ] },
    { name: 'Paracetamol 500mg', lots: [
      { days: 365, far: true, label: 'ตัวอย่างฝึกใช้ · LOT-PARA-A' },
    ] },
  ];
  return txn(() => {
    let created = 0;
    const preserved = [];
    for (const example of examples) {
      const drug = db.prepare('SELECT id,expiry_warn_days FROM drugs WHERE name=? AND active=1').get(example.name);
      if (!drug) continue;
      // Preserve all existing practice, including edited/closed lots, as a complete group.
      if (db.prepare('SELECT id FROM drug_lots WHERE drug_id=? LIMIT 1').get(drug.id)) {
        preserved.push(example.name);
        continue;
      }
      const configuredWarn = Number(drug.expiry_warn_days ?? getSetting('stock_expiry_warn_days', '90'));
      const warningDays = Number.isInteger(configuredWarn) && configuredWarn > 0 && configuredWarn <= 3650 ? configuredWarn : 90;
      for (const lot of example.lots) {
        const days = lot.near ? Math.min(lot.days, warningDays) : lot.far ? Math.max(lot.days, warningDays + 180) : lot.days;
        const id = stock.addLot(drug.id, { expiry_date: offset(days), lot_label: lot.label, userId: front.id });
        if (lot.closed) stock.clearLot(id, { reason: 'ตัวอย่างฝึกใช้ — เก็บออกจากตู้แล้ว', userId: front.id });
        created++;
      }
    }
    // Same transaction: a crash cannot leave partial examples or duplicate them on retry.
    setSetting(MARKER, '1');
    return { created, preserved };
  });
}

module.exports = { ensureTrialLots, MARKER };
