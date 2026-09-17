'use strict';
// Every subprocess/database lives under this suite's unique temporary root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function worker(mode, appRoot) {
  if (mode === 'seed-old' || mode === 'seed-fresh') {
    if (mode === 'seed-old') {
      const Module = require('node:module');
      const load = Module._load;
      Module._load = function(request, ...args) {
        if (request === './seed-trial-dose-defaults') return { ensureTrialDoseDefaults: () => {} };
        return load.call(this, request, ...args);
      };
    }
    const log = console.log;
    console.log = () => {};
    process.argv.push('--demo');
    try { require('./seed'); require('./seed-mock-clinic'); }
    finally { console.log = log; require('./lib/db').db.close(); }
    return;
  }
  const { ensureTrialDoseDefaults, MARKER } = require('./seed-trial-dose-defaults');
  if (['no-env', 'no-profile', 'production-profile', 'redirected', 'different-app-root'].includes(mode)) {
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, ...args) {
      if (request === './lib/db') throw Error('guard must reject before opening database');
      return load.call(this, request, ...args);
    };
    const result = ensureTrialDoseDefaults({ appRoot, freshSeed: mode === 'no-env' });
    assert.equal(result.skipped, { 'no-env': 'explicit_data_required', 'no-profile': 'not_trial_install',
      'production-profile': 'not_trial_install', redirected: 'redirected_data', 'different-app-root': 'different_app_root' }[mode]);
    return;
  }
  const { db, getSetting, setSetting } = require('./lib/db');
  const template = require('./public/dose-template');
  const run = () => ensureTrialDoseDefaults({ appRoot });
  const drug = name => db.prepare('SELECT * FROM drugs WHERE name=?').get(name);
  const frozen = () => ({
    ...Object.fromEntries(['order_versions', 'receipt_lines', 'receipt_document_snapshots', 'stock_movements']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    balances: db.prepare('SELECT id,qty_on_hand FROM drugs ORDER BY id').all(),
  });
  const before = frozen();
  try {
    if (mode === 'fresh') {
      assert.equal(getSetting(MARKER), '1');
      assert.equal(run().skipped, 'already_seeded');
    } else if (mode === 'legacy') {
      assert.equal(drug('Amlodipine 5mg').default_dose_json, null, 'old seed reproduced text-only catalog');
      assert.equal(JSON.parse(db.prepare("SELECT lines_json FROM fav_sets WHERE name='ชุดติดตามความดัน'").get().lines_json)[0].dose, undefined);
      assert.deepEqual(run(), { drugs: 30, sets: 3, preserved: [] });
    } else if (mode === 'changed') {
      db.prepare("UPDATE drugs SET default_instructions='ผู้ใช้แก้วิธีใช้เอง' WHERE name='Amlodipine 5mg'").run();
      db.prepare("UPDATE drugs SET name='ชื่อยาที่ผู้ใช้แก้เอง' WHERE name='Losartan 50mg'").run();
      db.prepare("UPDATE drugs SET default_dose_json=? WHERE name='Metformin 500mg'")
        .run(JSON.stringify(template.normalize({ mode: 'standard', m: 0.5 }, 'เม็ด')));
      db.prepare("UPDATE drugs SET dose_mode='prn' WHERE name='Cetirizine 10mg'").run();
      db.prepare("UPDATE drugs SET unit='หน่วยที่ผู้ใช้แก้' WHERE name='Simvastatin 20mg'").run();
      db.prepare("UPDATE fav_sets SET dx_text='ผู้ใช้แก้ชุดเอง' WHERE name='ชุดโรคกระเพาะ'").run();
      const savedDrugs = db.prepare("SELECT * FROM drugs WHERE name IN ('Amlodipine 5mg','ชื่อยาที่ผู้ใช้แก้เอง','Metformin 500mg','Cetirizine 10mg','Simvastatin 20mg') ORDER BY id").all();
      const savedSets = db.prepare("SELECT * FROM fav_sets WHERE name IN ('ชุดติดตามความดัน','ชุดโรคกระเพาะ') ORDER BY id").all();
      const result = run();
      assert.equal(result.drugs, 25);
      assert.equal(result.sets, 1);
      assert.deepEqual(db.prepare("SELECT * FROM drugs WHERE id IN (" + savedDrugs.map(d => d.id).join(',') + ") ORDER BY id").all(), savedDrugs);
      assert.deepEqual(db.prepare("SELECT * FROM fav_sets WHERE name IN ('ชุดติดตามความดัน','ชุดโรคกระเพาะ') ORDER BY id").all(), savedSets);
      assert.deepEqual(frozen(), before);
      assert.equal(run().skipped, 'already_seeded');
      return;
    } else if (mode === 'changed-set-lines') {
      const sets = db.prepare('SELECT * FROM fav_sets ORDER BY id').all();
      const changes = [
        lines => { lines[0].qty = 77; },
        lines => { lines[0].instructions = 'คำสั่งที่ผู้ใช้ฝึกแก้'; },
        lines => { lines[0].dose = template.normalize({ mode: 'standard', m: 0.5 }, lines[0].unit); },
      ];
      for (let i = 0; i < sets.length; i++) {
        const lines = JSON.parse(sets[i].lines_json);
        changes[i](lines);
        db.prepare('UPDATE fav_sets SET lines_json=? WHERE id=?').run(JSON.stringify(lines), sets[i].id);
      }
      const saved = db.prepare('SELECT * FROM fav_sets ORDER BY id').all();
      assert.equal(run().sets, 0);
      assert.deepEqual(db.prepare('SELECT * FROM fav_sets ORDER BY id').all(), saved);
      assert.deepEqual(frozen(), before);
      return;
    } else if (mode === 'not-demo') {
      setSetting('demo_mode', '0');
      assert.equal(run().skipped, 'not_demo');
      assert.equal(getSetting(MARKER, ''), '');
      assert.equal(drug('Amlodipine 5mg').default_dose_json, null);
      return;
    } else if (mode === 'crash-before') {
      db.function('trial_dose_kill', () => process.exit(86));
      db.exec(`CREATE TEMP TRIGGER trial_dose_crash AFTER UPDATE OF default_dose_json ON drugs
        WHEN (SELECT COUNT(*) FROM drugs WHERE default_dose_json IS NOT NULL)=2
        BEGIN SELECT trial_dose_kill(); END`);
      run();
      assert.fail('test child must die inside seed transaction');
    } else if (mode === 'retry-before') {
      assert.equal(getSetting(MARKER, ''), '');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM drugs WHERE default_dose_json IS NOT NULL').get().n, 0);
      assert(db.prepare('SELECT lines_json FROM fav_sets').all().every(f => JSON.parse(f.lines_json).every(l => !l.dose)), 'preset updates roll back with catalog');
      assert.deepEqual(run(), { drugs: 30, sets: 3, preserved: [] });
    } else if (mode === 'crash-after') {
      assert.equal(run().drugs, 30);
      process.exit(87); // Lost acknowledgement after the atomic commit.
    } else if (mode === 'retry-after') {
      const amlo = drug('Amlodipine 5mg');
      db.prepare('UPDATE drugs SET default_instructions=? WHERE id=?').run('การฝึกที่ทำหลังอัปเดต', amlo.id);
      assert.equal(run().skipped, 'already_seeded');
      assert.equal(drug('Amlodipine 5mg').default_instructions, 'การฝึกที่ทำหลังอัปเดต');
    }
    const amlo = template.read(drug('Amlodipine 5mg'));
    assert.equal(amlo.m, 1);
    assert.equal(amlo.days, 0, 'no duration invented from text or old quantities');
    assert.equal(template.perDay(amlo) * 7, 7, 'bulk seven days is calculable from the authored example');
    const metformin = template.read(drug('Metformin 500mg'));
    assert.equal(metformin.m, 1);
    assert.equal(metformin.e, 1);
    assert.equal(metformin.timing, 'หลังอาหาร');
    assert.equal(template.perDay(metformin) * 7, 14);
    for (const name of ['Paracetamol 500mg', 'Chloramphenicol eye drops', 'Salbutamol inhaler', 'CPM 4mg']) {
      const d = drug(name), dose = template.read(d);
      assert.equal(dose.mode, 'manual', name + ': no inferred range, time slot, or stock-unit conversion');
      assert.equal(template.perDay(dose), 0);
      assert.equal(template.text(dose, d.unit), d.default_instructions);
    }
    const fav = JSON.parse(db.prepare("SELECT lines_json FROM fav_sets WHERE name='ชุดติดตามความดัน'").get().lines_json)[0];
    assert.equal(fav.dose.m, 1);
    assert.equal(fav.dose.days, 0);
    assert.equal(fav.qty, 10, 'keep authored synthetic preset quantity');
    assert.equal(fav.dose.qty_source, 'manual');
    assert.equal(fav.instructions, 'เช้า 1 เม็ด');
    assert.equal(run().skipped, 'already_seeded');
    assert.deepEqual(frozen(), before, 'history, legal snapshots, balances and movements cannot be backfilled');
  } finally { db.close(); }
}

if (process.argv[2] === '--worker') {
  worker(process.argv[3], process.argv[4]);
} else {
  const tempParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, 'clinic-trial-dose-'));
  let passed = 0;
  const invoke = (mode, appRoot, data, expected = 0) => {
    const env = { ...process.env };
    if (data) env.CLINIC_DATA_DIR = data; else delete env.CLINIC_DATA_DIR;
    const result = spawnSync(process.execPath, ['--no-warnings', __filename, '--worker', mode, appRoot],
      { env, cwd: __dirname, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, expected, mode + ': ' + (result.stderr || result.stdout));
  };
  const fixture = (name, fresh = false) => {
    const install = path.join(root, name), appRoot = path.join(install, 'app'), data = path.join(appRoot, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(path.join(install, 'update'));
    fs.writeFileSync(path.join(install, 'update', 'install-profile.json'), JSON.stringify({ product: 'clinic-offline', variant: 'trial' }));
    fs.writeFileSync(path.join(install, 'update', 'installed.marker'), 'synthetic');
    invoke(fresh ? 'seed-fresh' : 'seed-old', appRoot, data);
    return { appRoot, data };
  };
  const pass = name => { passed++; console.log('PASS trial dose defaults: ' + name); };
  try {
    for (const mode of ['fresh', 'legacy', 'changed', 'changed-set-lines', 'not-demo']) {
      const f = fixture(mode, mode === 'fresh');
      invoke(mode, f.appRoot, f.data);
      pass(mode);
    }
    for (const phase of ['before', 'after']) {
      const f = fixture('crash-' + phase);
      invoke('crash-' + phase, f.appRoot, f.data, phase === 'before' ? 86 : 87);
      invoke('retry-' + phase, f.appRoot, f.data);
      pass('actual child death ' + phase + ' commit, retry is atomic/idempotent');
    }
    const guardRoot = path.join(root, 'guard', 'app');
    fs.mkdirSync(guardRoot, { recursive: true });
    invoke('no-env', guardRoot, null); pass('no implicit data directory');
    invoke('no-profile', guardRoot, path.join(guardRoot, 'data')); pass('uninstalled/unknown profile blocked before database open');
    fs.mkdirSync(path.join(guardRoot, '..', 'update'));
    fs.writeFileSync(path.join(guardRoot, '..', 'update', 'install-profile.json'), JSON.stringify({ product: 'clinic-offline', variant: 'production' }));
    fs.writeFileSync(path.join(guardRoot, '..', 'update', 'installed.marker'), 'synthetic');
    invoke('production-profile', guardRoot, path.join(guardRoot, 'data')); pass('production profile blocked before database open');
    fs.writeFileSync(path.join(guardRoot, '..', 'update', 'install-profile.json'), JSON.stringify({ product: 'clinic-offline', variant: 'trial' }));
    invoke('redirected', guardRoot, path.join(root, 'other')); pass('redirected installed data blocked before database open');
    invoke('different-app-root', guardRoot, null); pass('foreign appRoot without explicit data blocked before database open');
    console.log(`Trial dose defaults: ${passed} tests passed`);
  } finally {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), tempParent);
    assert(path.basename(resolved).startsWith('clinic-trial-dose-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
