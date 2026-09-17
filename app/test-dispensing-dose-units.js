'use strict';
// Synthetic data only. Prove actual billing/stock/printing, not just a formatter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tempParent = fs.realpathSync(os.tmpdir());
const dir = fs.mkdtempSync(path.join(tempParent, 'clinic-dispensing-dose-'));
process.env.CLINIC_DATA_DIR = dir;
const { db } = require('./lib/db');
const D = require('./public/dose-template');
const notes = require('./lib/notes');
const stock = require('./lib/stock');
const auth = require('./lib/auth');
const visits = require('./lib/visits');
const billing = require('./lib/billing');
const sheet = require('./lib/medication-sheet');
const visual = require('./lib/medication-visual');
const { mergeRemedLines } = require('./public/remed');
let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS dispensing/dose: ' + name); }
try {
  const front = Number(auth.createUser({ username: 'unit-front', displayName: 'สังเคราะห์', role: 'front', password: 'Test-pass-123' }).lastInsertRowid);
  const doctor = Number(auth.createUser({ username: 'unit-doctor', displayName: 'สังเคราะห์', role: 'doctor', password: 'Test-pass-123' }).lastInsertRowid);
  const bottle = D.normalize({ ...D.empty(), dose_unit: 'มล.', m: 5, e: 5, days: 7 }, 'ขวด');
  const bottleId = stock.upsertDrug({ name: 'ยาน้ำสังเคราะห์', unit: 'ขวด', price: 50, cost: 20, default_dose: bottle });
  stock.move(bottleId, 'receive', 20, { reason: 'สังเคราะห์', userId: front });
  const interval = D.normalize({ ...D.empty('interval'), interval_amount: 1, interval_min_hours: 4, interval_max_hours: 6 }, 'เม็ด');
  const intervalId = stock.upsertDrug({ name: 'ยาทุกชั่วโมงสังเคราะห์', unit: 'เม็ด', price: 2, cost: 0.5, default_dose: interval });
  stock.move(intervalId, 'receive', 100, { reason: 'สังเคราะห์', userId: front });
  const line = (dose = bottle, qty = 2) => ({ type: 'drug', ref_id: bottleId, qty, dose });

  test('catalog keeps bottle pricing unit and mL dose independently through search/edit', () => {
    const item = stock.searchItems('ยาน้ำสังเคราะห์')[0];
    assert.equal(item.unit, 'ขวด');
    assert.equal(D.read(item).unit, 'ขวด');
    assert.equal(D.read(item).dose_unit, 'มล.');
    assert.equal(item.default_instructions, 'เช้า 5 มล. / เย็น 5 มล. · 7 วัน');
    stock.upsertDrug({ name: item.name, price: 50, cost: 20, default_dose: bottle }, bottleId);
    assert.equal(D.read(stock.searchItems(item.name)[0]).dose_unit, 'มล.');
  });
  test('unit mismatch never calculates bottles, even when forged as calculated', () => {
    assert.equal(D.canCalculateQty(bottle, 'ขวด'), false);
    assert.equal(D.quantity(bottle, 'ขวด'), 0);
    const built = notes.buildLines([line({ ...bottle, qty_source: 'calculated' })])[0];
    assert.equal(built.qty, 2);
    assert.equal(built.dose.qty_source, 'manual');
    assert.equal(built.calculated_qty, null);
    assert.equal(built.dose.calculated_qty, null);
    assert.equal(built.instructions, D.text(bottle, 'ขวด'));
  });
  test('missing/invalid explicit dispensing quantity rejected for bottles and intervals', () => {
    for (const qty of ['', null, undefined, 0, -1, Infinity, true, [], [1], {}, 'n/a']) {
      assert.throws(() => notes.buildLines([{ ...line(bottle), qty }]), /จำนวนจ่ายจริง/);
      assert.throws(() => notes.buildLines([{ ...line(interval), qty, ref_id: intervalId }]), /จำนวนจ่ายจริง/);
    }
  });
  test('same-unit typed doses still calculate and no guessed conversion by unit name', () => {
    const tablet = D.normalize({ ...D.empty(), m: 0.5, days: 7 }, 'เม็ด');
    assert.equal(D.quantity(tablet, 'เม็ด'), 4);
    assert.equal(D.doseUnit(tablet, 'เม็ด'), 'เม็ด');
    assert.equal(D.quantity({ ...tablet, dose_unit: 'mg' }, 'เม็ด'), 0);
    const exact = D.normalize({ ...D.empty('exact_times'), dose_unit: 'มล.', times: [{ time: '09:00', amount: 5 }], days: 4 }, 'ขวด');
    assert.equal(D.quantity(exact, 'ขวด'), 0);
    assert.equal(D.text(exact, 'ขวด'), '09:00 5 มล. · 4 วัน');
  });
  test('interval range and optional symptom remain distinct from PRN and daily totals', () => {
    assert.equal(interval.qty_source, 'manual');
    assert.equal(D.quantity({ ...interval, days: 7, m: 99 }, 'เม็ด'), 0);
    assert.equal(D.text(interval, 'เม็ด'), 'ครั้งละ 1 เม็ด ทุก 4–6 ชม.');
    assert(!D.text(interval, 'เม็ด').includes('เมื่อ'));
    const symptom = D.normalize({ ...interval, interval_indication: 'มีอาการสมมติ' }, 'เม็ด');
    assert.equal(D.text(symptom, 'เม็ด'), 'ครั้งละ 1 เม็ด ทุก 4–6 ชม. เมื่อมีอาการสมมติ');
    const fixed = D.normalize({ ...interval, interval_max_hours: 0 }, 'เม็ด');
    assert.equal(D.text(fixed, 'เม็ด'), 'ครั้งละ 1 เม็ด ทุก 4 ชม.');
    assert.equal(notes.buildLines([{ type: 'drug', ref_id: intervalId, qty: 12, dose: { ...interval, qty_source: 'calculated' } }])[0].qty, 12);
  });
  test('invalid intervals, unit types and unknown modes fail instead of silently becoming standard', () => {
    for (const invalid of [{ interval_amount: 0 }, { interval_min_hours: 0 }, { interval_min_hours: 8, interval_max_hours: 4 }, { interval_min_hours: '4-6' }, { interval_amount: true }, { dose_unit: {} }]) {
      assert.throws(() => D.normalize({ ...interval, ...invalid }, 'เม็ด'));
      assert.throws(() => notes.buildLines([{ type: 'drug', ref_id: intervalId, qty: 12, dose: { ...interval, ...invalid } }]));
    }
    assert.throws(() => notes.sanitizeDose({ mode: 'unknown', m: 2 }), /รูปแบบ/);
    assert.throws(() => stock.upsertDrug({ name: 'invalid', unit: 'เม็ด', dose_mode: 'unknown' }), /รูปแบบ/);
  });
  test('calculated instructions regenerate on server, explicitly manual prose stays literal', () => {
    assert.equal(notes.buildLines([{ ...line(), instructions: 'ข้อความเก่าที่ขัดกับตาราง' }])[0].instructions, D.text(bottle, 'ขวด'));
    const manual = notes.buildLines([{ ...line({ ...bottle, instructions_source: 'manual' }), instructions: 'คำสั่งเฉพาะที่แพทย์พิมพ์เอง' }])[0];
    assert.equal(manual.instructions, 'คำสั่งเฉพาะที่แพทย์พิมพ์เอง');
    const legacy = notes.buildLines([{ ...line(null), instructions: 'วิธีใช้เดิม ไม่เดาขนาด' }])[0];
    assert.equal(legacy.dose, null);
    assert.equal(legacy.instructions, 'วิธีใช้เดิม ไม่เดาขนาด');
  });
  test('front may reduce bottles but cannot alter dose unit or interval schedule', () => {
    const old = notes.buildLines([line()]);
    const next = { ...old[0], qty: 1, dose: { ...old[0].dose, qty_source: 'manual' } };
    assert.equal(notes.validateFrontOrderEdit(old, [next])[0].qty, 1);
    assert.throws(() => notes.validateFrontOrderEdit(old, [{ ...next, dose: { ...next.dose, dose_unit: 'หยด' } }]), /แก้วิธีใช้/);
    const oldInterval = notes.buildLines([{ type: 'drug', ref_id: intervalId, qty: 12, dose: interval }]);
    assert.throws(() => notes.validateFrontOrderEdit(oldInterval, [{ ...oldInterval[0], dose: { ...oldInterval[0].dose, interval_max_hours: 8 } }]), /แก้วิธีใช้/);
    // Historical structured snapshots from 1.0.12 lacked these newly optional keys.
    const oldDose = { mode: 'standard', m: 1, n: 0, e: 0, b: 0, timing: '', days: 7, times: [], prn_amount: 0,
      prn_indication: '', prn_interval_hours: 0, prn_max_per_day: 0, qty_source: 'calculated', instructions_source: 'calculated', additional_instructions: '' };
    const legacy = { type: 'drug', ref_id: intervalId, qty: 7, dose: oldDose, unit: 'เม็ด', instructions: 'เช้า 1 เม็ด · 7 วัน' };
    assert.equal(notes.validateFrontOrderEdit([legacy], [{ ...legacy, qty: 4, dose: { ...oldDose, qty_source: 'manual' } }])[0].qty, 4);
  });
  test('editing quantity or all-days keeps legacy PRN valid without weakening new templates', () => {
    const vm=require('node:vm'),html=fs.readFileSync(path.join(__dirname,'public/exam.html'),'utf8');
    const c={DoseTemplate:D,lines:[],draftDirty:false,toast:()=>{},document:{getElementById:()=>({value:'10'})}};
    vm.createContext(c);
    vm.runInContext(html.slice(html.indexOf('function defaultDose('),html.indexOf('function updDose('))+'\n'+html.slice(html.indexOf('function updDrugQty('),html.indexOf('function useCalculatedQty('))+'\n'+html.slice(html.indexOf('function applyDaysAll('),html.indexOf("attachSearch(document.getElementById('orderAdd')"))+'\nfunction renderOrder(){}',c);
    const legacy={type:'drug',ref_id:intervalId,unit:'เม็ด',qty:6,instructions:'ครั้งละ 1 เม็ด เมื่อมีอาการ',dose:{mode:'prn',prn_amount:1,prn_indication:'',qty_source:'manual',instructions_source:'manual'}};
    c.lines=[structuredClone(legacy)];c.updDrugQty(0,'4');
    const edited=notes.buildLines(c.lines)[0];assert.equal(edited.qty,4);assert.equal(edited.instructions,legacy.instructions);assert.equal(edited.dose.mode,'prn');
    c.lines=[structuredClone(legacy)];c.applyDaysAll();assert.equal(notes.buildLines(c.lines)[0].qty,6);
    assert.throws(()=>notes.buildLines([{...legacy,dose:{...D.empty('prn'),prn_amount:1}}]),/อาการ/);
    assert.throws(()=>notes.sanitizeDose({...legacy.dose,dose_unit:{}}),/หน่วยขนาดยา/);
  });
  test('favorite/history cloning preserves dose units and interval fields without master substitution', () => {
    const saved = notes.buildLines([line(), { type: 'drug', ref_id: intervalId, qty: 12, dose: interval }]);
    const copied = mergeRemedLines([], saved).lines;
    assert.deepEqual(copied, saved);
    const fromFavorite = notes.buildLines(JSON.parse(JSON.stringify(saved)));
    assert.equal(fromFavorite[0].dose.dose_unit, 'มล.');
    assert.equal(fromFavorite[1].dose.interval_max_hours, 6);
    assert.equal(fromFavorite[0].qty, 2);
  });
  test('actual order, invoice, stock and print separate bottles from mL and preserve snapshots', () => {
    db.prepare("INSERT INTO patients(hn,first_name,sex,created_at,created_by) VALUES('UNIT-SYNTH','สังเคราะห์','F',datetime('now'),?)").run(front);
    const visit = visits.create('UNIT-SYNTH', front);
    visits.transition(visit.id, 'call', doctor);
    const done = visits.finishExam(visit.id, { note: { cc: 'สังเคราะห์', dx_text: 'สังเคราะห์' }, lines: [line(), { type: 'drug', ref_id: intervalId, qty: 12, dose: interval }], baseVersionId: null }, doctor);
    const paid = billing.pay(visit.id, { orderVersionId: done.order.id, payMethod: 'cash', userId: front });
    const receipt = billing.getReceipt(paid.receiptNo);
    assert.equal(receipt.lines[0].unit, 'ขวด');
    assert.equal(receipt.lines[0].qty, 2);
    assert.equal(receipt.lines[0].amount, 100);
    assert.equal(receipt.lines[0].cost_each, 20);
    assert.equal(db.prepare('SELECT qty_on_hand q FROM drugs WHERE id=?').get(bottleId).q, 18);
    assert.equal(db.prepare('SELECT qty_on_hand q FROM drugs WHERE id=?').get(intervalId).q, 88);
    const html = sheet.render(receipt);
    assert(html.includes('5 มล.'));
    assert(!html.includes('5 ขวด'));
    assert(html.includes('จำนวนที่ได้รับ 2 ขวด'));
    assert(html.includes('ทุก 4–6 ชม.'));
    assert(!html.includes('data-dose-mode="prn"'));
    assert(html.includes('อ่านตามข้อความ'));
    const before = db.prepare('SELECT lines_json FROM order_versions WHERE id=?').get(done.order.id).lines_json;
    stock.upsertDrug({ name: 'ยาน้ำสังเคราะห์', unit: 'ขวด', price: 99, cost: 80, default_dose: { ...bottle, m: 9 } }, bottleId);
    assert.equal(db.prepare('SELECT lines_json FROM order_versions WHERE id=?').get(done.order.id).lines_json, before);
    assert.equal(sheet.render(billing.getReceipt(paid.receiptNo)), html);
  });
  test('direct interval visual cannot fall into PRN branch', () => {
    assert.equal(visual.doseVisual(interval, 'เม็ด'), '<div class="text-dose-label">อ่านตามข้อความ</div>');
    const rendered = visual.doseVisual(bottle, 'ขวด');
    assert(rendered.includes('5 มล.'));
    assert(!rendered.includes('5 ขวด'));
  });
  console.log(`Dispensing/dose units: ${count} tests passed`);
} finally {
  db.close();
  const resolved = fs.realpathSync(dir);
  assert.equal(path.dirname(resolved), tempParent);
  assert(path.basename(resolved).startsWith('clinic-dispensing-dose-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
