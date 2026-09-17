'use strict';
// Synthetic databases only. No HTTP server, live install, or production database access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function worker(mode, appRoot) {
  const { ensureTrialLots, MARKER } = require('./seed-trial-lots');
  if (['no-env', 'default-path', 'startup-no-profile', 'startup-different-root'].includes(mode)) {
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(request, ...args) {
      if (request === './lib/db') throw Error('rejected seed must not open db.js');
      return original.call(this, request, ...args);
    };
    const result = ensureTrialLots({ freshSeed: !mode.startsWith('startup-'), appRoot });
    assert.equal(result.skipped, { 'no-env': 'explicit_data_required', 'default-path': 'default_data_not_trial',
      'startup-no-profile': 'not_trial_install', 'startup-different-root': 'different_app_root' }[mode]);
    return;
  }
  const { db, today, getSetting, setSetting } = require('./lib/db');
  const stock = require('./lib/stock');
  const rows = () => db.prepare('SELECT * FROM drug_lots ORDER BY id').all();
  const balance = () => ({
    quantities: db.prepare('SELECT id,qty_on_hand FROM drugs ORDER BY id').all(),
    movements: db.prepare('SELECT * FROM stock_movements ORDER BY id').all(),
  });
  const before = balance();
  const run = () => ensureTrialLots({ appRoot });
  const front = db.prepare("SELECT id FROM users WHERE role='front' LIMIT 1").get();
  const amlo = db.prepare("SELECT id FROM drugs WHERE name='Amlodipine 5mg'").get();
  const localOffset = days => {
    const date = new Date(today() + 'T00:00:00');
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  try {
    if (mode === 'fresh') {
      // The actual shipped seed must include the examples, including after a fresh reset.
      const log = console.log;
      console.log = () => {};
      try { require('./seed-mock-clinic'); } finally { console.log = log; }
      assert.equal(rows().length, 6);
      assert.equal(getSetting(MARKER), '1');
      const freshBalance = balance();
      assert.equal(run().skipped, 'already_seeded');
      assert.deepEqual(balance(), freshBalance);
    } else if (mode === 'legacy') {
      assert.equal(rows().length, 0);
      assert.equal(run().created, 6, 'previously seeded installation gets examples on startup');
    } else if (mode === 'custom-warning') {
      setSetting('stock_expiry_warn_days', '700');
      db.prepare('UPDATE drugs SET expiry_warn_days=7 WHERE id=?').run(amlo.id);
      assert.equal(run().created, 6);
      assert.equal(stock.listDrugs().find(d => d.id === amlo.id).expiry_date, localOffset(7));
      const otherLots = rows().filter(l => l.drug_id !== amlo.id && !l.cleared_at && l.expiry_date > today());
      assert(otherLots.every(l => l.expiry_date > localOffset(700)), 'far examples must respect the existing shared warning setting');
      assert.deepEqual(balance(), before);
      return;
    } else if (mode === 'manual') {
      const id = stock.addLot(amlo.id, { expiry_date: localOffset(10), lot_label: 'ล็อตที่ผู้ใช้ฝึกกรอกเอง', qty: 41, userId: front.id });
      stock.clearLot(id, { reason: 'ผู้ใช้ฝึกปิดเอง', userId: front.id });
      const original = rows()[0];
      const result = run();
      assert.equal(result.created, 3);
      assert.deepEqual(result.preserved, ['Amlodipine 5mg']);
      assert.deepEqual(rows()[0], original);
      assert.equal(stock.listLots(amlo.id, true).length, 1, 'closed history also prevents synthetic additions to that drug');
    } else if (mode === 'not-demo') {
      setSetting('demo_mode', '0');
      assert.equal(run().skipped, 'not_demo');
      assert.equal(rows().length, 0);
      assert.equal(getSetting(MARKER, ''), '');
    } else if (mode === 'production-profile') {
      assert.equal(run().skipped, 'not_trial_install');
      assert.equal(rows().length, 0);
      assert.equal(ensureTrialLots({ freshSeed: true, appRoot }).skipped, 'default_data_not_trial');
    } else if (mode === 'redirected') {
      assert.equal(run().skipped, 'redirected_data');
      assert.equal(rows().length, 0);
    } else if (mode === 'crash-mid') {
      db.function('trial_test_crash', () => process.exit(86));
      db.exec(`CREATE TEMP TRIGGER trial_test_crash_after_second_lot AFTER INSERT ON drug_lots
        WHEN (SELECT COUNT(*) FROM drug_lots) = 2 BEGIN SELECT trial_test_crash(); END`);
      run();
      assert.fail('failure injection must terminate the child during the transaction');
    } else if (mode === 'retry-mid') {
      assert.equal(rows().length, 0, 'interrupted transaction must roll back all example rows');
      assert.equal(getSetting(MARKER, ''), '', 'marker must roll back with the examples');
      assert.equal(run().created, 6);
    } else if (mode === 'crash-after') {
      assert.equal(run().created, 6);
      process.exit(87); // Simulate loss of confirmation after commit.
    } else if (mode === 'retry-after') {
      assert.equal(rows().length, 6);
      assert.equal(run().skipped, 'already_seeded');
    }

    if (!['not-demo', 'production-profile', 'redirected', 'manual'].includes(mode)) {
      const seeded = rows();
      assert.equal(seeded.length, 6);
      assert(seeded.every(l => l.lot_label.startsWith('ตัวอย่างฝึกใช้ ·')));
      assert(seeded.every(l => l.qty_received === null), 'date-only examples must not invent per-lot quantities');
      assert.equal(seeded.filter(l => l.cleared_at).length, 1);
      const drug = stock.listDrugs().find(d => d.id === amlo.id);
      assert.equal(drug.expiry_date, localOffset(30));
      assert.equal(drug.active_lots, 2);
      assert(seeded.some(l => !l.cleared_at && l.expiry_date < today()), 'there must be a visible expired lot');
      assert(seeded.some(l => !l.cleared_at && l.expiry_date === localOffset(365)), 'there must be a lot outside the default warning interval');
      const earliest = stock.listLots(amlo.id)[0];
      const beforeClose = balance();
      stock.clearLot(earliest.id, { reason: 'ฝึกเก็บล็อตตัวอย่างออก', userId: front.id });
      assert.equal(stock.listDrugs().find(d => d.id === amlo.id).expiry_date, localOffset(365), 'closing the first active lot must reveal the next date');
      const afterPractice = rows();
      assert.equal(run().skipped, 'already_seeded');
      assert.deepEqual(rows(), afterPractice, 'restarting must preserve practice, not recreate closed examples');
      assert.deepEqual(balance(), beforeClose, 'closing a date-only example must not alter stock');
    }
    if (mode !== 'fresh') assert.deepEqual(balance(), before, 'adding lot dates must leave every quantity and movement unchanged');
  } finally { db.close(); }
}

if (process.argv[2] === '--worker') {
  worker(process.argv[3], process.argv[4]);
} else {
  const tempParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, 'clinic-trial-lots-'));
  let passed = 0;
  function invoke(args, dataDir, expected = 0) {
    const env = { ...process.env };
    if (dataDir) env.CLINIC_DATA_DIR = dataDir;
    else delete env.CLINIC_DATA_DIR;
    const result = spawnSync(process.execPath, ['--no-warnings', ...args], {
      cwd: __dirname, env, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, expected, result.stderr || result.stdout || 'child process failed');
    return result;
  }
  function fixture(name, { fresh = false, variant = 'trial', profile = true } = {}) {
    const install = path.join(root, name);
    const appRoot = path.join(install, 'app');
    const data = path.join(appRoot, 'data');
    fs.mkdirSync(data, { recursive: true });
    if (profile) {
      fs.mkdirSync(path.join(install, 'update'));
      fs.writeFileSync(path.join(install, 'update', 'install-profile.json'), JSON.stringify({ product: 'clinic-offline', variant }));
      fs.writeFileSync(path.join(install, 'update', 'installed.marker'), 'synthetic-trial-test');
    }
    invoke(['seed.js', '--demo'], data);
    if (!fresh) invoke(['seed-mock-day.js'], data);
    return { appRoot, data };
  }
  function check(name, f, mode = name, exit = 0) {
    invoke([__filename, '--worker', mode, f.appRoot], f.data, exit);
    passed++;
    console.log('PASS trial lots: ' + name);
  }
  try {
    check('fresh', fixture('fresh', { fresh: true }));
    check('legacy', fixture('legacy'));
    check('custom-warning', fixture('custom-warning'));
    check('manual', fixture('manual'));
    check('not-demo', fixture('not-demo'));
    check('production-profile', fixture('production-profile', { variant: 'production' }));
    const redirected = fixture('redirected');
    redirected.appRoot = fixture('another-install').appRoot;
    check('redirected', redirected);
    const noEnv = { appRoot: path.join(root, 'unconfigured', 'app') };
    check('no-env', noEnv);
    check('startup-no-profile', noEnv);
    assert(!fs.existsSync(noEnv.appRoot), 'rejected default call must create no directories');
    check('default-path', { appRoot: path.join(root, 'default', 'app'), data: path.join(root, 'default', 'app', 'data') });
    assert(!fs.existsSync(path.join(root, 'default')), 'rejected explicit default path must create no directories');
    const otherRoot = fixture('different-root');
    check('startup-different-root', { appRoot: otherRoot.appRoot });
    const mid = fixture('mid-crash');
    check('crash-mid', mid, 'crash-mid', 86);
    check('retry-mid', mid);
    const after = fixture('after-crash');
    check('crash-after', after, 'crash-after', 87);
    check('retry-after', after);
    console.log(`Trial lots: ${passed} tests passed`);
  } finally {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), tempParent, 'cleanup must stay in the temporary directory');
    assert(path.basename(resolved).startsWith('clinic-trial-lots-'), 'cleanup must target this synthetic test only');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
