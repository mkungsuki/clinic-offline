'use strict';
// Exercise both shipped trial seed writers on fresh synthetic databases only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tempParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, 'clinic-trial-seed-costs-'));
let passed = 0;

function run(dir, args) {
  const result = spawnSync(process.execPath, ['--no-warnings', ...args], {
    cwd: __dirname,
    env: { ...process.env, CLINIC_DATA_DIR: dir },
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || 'Synthetic seed subprocess did not finish');
  return result.stdout;
}

function checkFixture(expectedCost) {
  const assert = require('node:assert/strict');
  const { db } = require('./lib/db');
  const stock = require('./lib/stock');
  const reports = require('./lib/reports');
  // Suppress ordinary seed output; only assertion results return to the parent.
  const log = console.log;
  console.log = () => {};
  try {
    const services = db.prepare('SELECT id, cost FROM services').all();
    assert.equal(services.length, 4);
    assert(services.every(s => s.cost === null), 'default costs must remain unknown');
    if (expectedCost !== null) {
      for (const service of services) stock.upsertService({ cost: expectedCost }, service.id);
    }
    require('./seed-mock-day');
    const dayLines = db.prepare("SELECT id, cost_each FROM receipt_lines WHERE line_type='service' ORDER BY id").all();
    assert(dayLines.length > 0, 'day seed must produce service receipts');
    assert(dayLines.every(l => l.cost_each === expectedCost), 'day seed must snapshot the configured cost including zero/null');
    const lastDayLine = db.prepare('SELECT MAX(id) id FROM receipt_lines').get().id;

    require('./seed-mock-clinic');
    const historicalLines = db.prepare("SELECT id, cost_each FROM receipt_lines WHERE line_type='service' AND id>? ORDER BY id").all(lastDayLine);
    assert(historicalLines.length > 0, 'clinic seed must add historical service receipts');
    assert(historicalLines.every(l => l.cost_each === expectedCost), 'historical seed must snapshot the configured cost including zero/null');

    const snapshots = () => db.prepare('SELECT id, line_type, ref_id, cost_each FROM receipt_lines ORDER BY id').all();
    const before = snapshots();
    const years = db.prepare('SELECT DISTINCT substr(created_at,1,4) year FROM receipts ORDER BY year').all();
    const ledgers = () => years.map(y => reports.monthlyLedger(Number(y.year)));
    const beforeReports = ledgers();
    for (const ledger of beforeReports) {
      if (expectedCost === null) {
        assert(ledger.total.unknown_service_cost_lines > 0);
        assert.equal(ledger.total.gross_profit, null);
      } else {
        assert.equal(ledger.total.unknown_service_cost_lines, 0);
        assert.equal(typeof ledger.total.gross_profit, 'number');
      }
    }
    for (const service of services) stock.upsertService({ cost: 999 }, service.id);
    assert.deepEqual(snapshots(), before, 'editing catalog cannot alter already-issued synthetic snapshots');
    assert.deepEqual(ledgers(), beforeReports, 'editing catalog cannot rewrite historical reports');
    log(JSON.stringify({ day: dayLines.length, historical: historicalLines.length }));
  } finally {
    console.log = log;
    db.close();
  }
}

try {
  for (const scenario of [{ name: 'unknown', cost: null }, { name: 'zero', cost: 0 }, { name: 'positive', cost: 20.25 }]) {
    const dir = path.join(root, scenario.name);
    fs.mkdirSync(dir);
    run(dir, ['seed.js', '--demo']);
    const counts = JSON.parse(run(dir, ['-e', `(${checkFixture.toString()})(${JSON.stringify(scenario.cost)});`]));
    for (const check of [
      `day snapshots preserve ${scenario.name} (${counts.day} lines)`,
      `historical snapshots preserve ${scenario.name} (${counts.historical} lines)`,
      `${scenario.name} snapshots/reports remain unchanged after catalog edit`,
    ]) {
      passed++;
      console.log('PASS trial seed costs: ' + check);
    }
  }
  console.log(`Trial seed costs: ${passed} tests passed`);
} finally {
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), tempParent, 'cleanup must stay inside the temporary directory');
  assert(path.basename(resolved).startsWith('clinic-trial-seed-costs-'), 'cleanup must target only this test root');
  fs.rmSync(resolved, { recursive: true, force: true });
}
