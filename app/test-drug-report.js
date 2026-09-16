'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-drug-report-'));
process.env.CLINIC_DATA_DIR = dir;
const { db } = require('./lib/db');
const stock = require('./lib/stock');
const { monthlyDrugs, allocateDiscount } = require('./lib/drug-report');
let passed = 0, seq = 0;
function test(name, fn) { fn(); console.log('PASS drug report: ' + name); passed++; }
db.prepare("INSERT INTO patients(hn, first_name, sex, created_at) VALUES('SYNTHETIC', 'รายงานสังเคราะห์', 'F', '2026-01-01')").run();
function drug(name, cost = 2, unit = 'เม็ด') { return stock.upsertDrug({ name, cost, unit, price: 10 }); }
function bill(lines, { month = '2026-01', discount = 0, status = 'ISSUED', voidMonth = null, visitId = null } = {}) {
  const id = ++seq, stamp = month + '-15 12:00:00';
  const v = visitId || Number(db.prepare("INSERT INTO visits(hn, visit_date, queue_no, state, created_by, created_at) VALUES('SYNTHETIC', ?, ?, 'COMPLETED', 1, ?)").run(month + '-15', id, stamp).lastInsertRowid);
  const ov = Number(db.prepare("INSERT INTO order_versions(visit_id, version, lines_json, created_by, created_at) VALUES(?, ?, '[]', 1, ?)").run(v, id, stamp).lastInsertRowid);
  const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const no = 'SYN-' + id;
  db.prepare(`INSERT INTO receipts(receipt_no, visit_id, hn, patient_name, order_version_id, subtotal, discount, total, pay_method, status, created_by, created_at, voided_at)
    VALUES(?, ?, 'SYNTHETIC', 'ข้อมูลสมมติ', ?, ?, ?, ?, 'cash', ?, 1, ?, ?)`).run(no, v, ov, subtotal, discount, Math.round((subtotal-discount)*100)/100, status, stamp, voidMonth ? voidMonth+'-20 12:00:00' : null);
  for (const l of lines) db.prepare(`INSERT INTO receipt_lines(receipt_no,line_type,ref_id,name,qty,unit,price_each,amount,cost_each)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(no, l.type || 'drug', l.id ?? null, l.name || 'ยาสังเคราะห์', l.qty || 1, l.unit || 'เม็ด', l.amount/(l.qty||1), l.amount, l.cost ?? null);
  return { no, visitId: v };
}
const find = (id, month='2026-01', unit='เม็ด') => monthlyDrugs(month).rows.find(r => r.drug_id === id && r.unit === unit);
try {
  test('empty DB and strict month validation', () => {
    assert.deepEqual(monthlyDrugs('2026-01').rows, []);
    for (const m of ['2026-00','2026-13','2026-1','x',null,2026,'2026-01 OR 1=1']) assert.throws(()=>monthlyDrugs(m), /เดือนรายงาน/);
  });
  test('discount includes services; net and snapshot cost reconcile', () => {
    const id = drug('แบ่งส่วนลด');
    bill([{id, qty:10, amount:100, cost:2},{type:'service',name:'บริการ',amount:100}],{discount:20});
    const r = find(id); assert.equal(r.discount,10); assert.equal(r.net,90); assert.equal(r.cost,20); assert.equal(r.profit,70);
  });
  test('largest remainder retains cents, deterministic ties, free lines', () => {
    assert.deepEqual(allocateDiscount([{id:2,amount:1},{id:1,amount:1},{id:3,amount:1}],1),[0,1,0]);
    assert.deepEqual(allocateDiscount([{id:1,amount:0},{id:2,amount:1}],100),[0,100]);
    assert.deepEqual(allocateDiscount([{id:1,amount:0}],0),[0]);
    assert.equal(allocateDiscount([{id:1,amount:1}],101),null);
    for(let d=0;d<=137;d++) {
      const a=allocateDiscount([{id:1,amount:.33},{id:2,amount:.51},{id:3,amount:.53}],d);
      assert.equal(a.reduce((s,n)=>s+n,0),d); a.forEach((n,i)=>assert(n>=0&&n<=[33,51,53][i]));
    }
  });
  test('unknown cost is null, explicit zero is valid; partial data stays unknown', () => {
    const missing=drug('ทุนขาด',null), zero=drug('ทุนศูนย์',0);
    bill([{id:missing,amount:10},{id:missing,amount:10,cost:2},{id:zero,amount:10,cost:0}]);
    assert.equal(find(missing).cost,null); assert.equal(find(missing).profit,null); assert.equal(find(missing).unknown_cost_lines,1);
    assert.equal(find(zero).profit,10);
  });
  test('same-name different IDs stay separate; price/name edits cannot rewrite snapshot', () => {
    const a=drug('ชื่อซ้ำ'), b=drug('ชื่อซ้ำ');
    bill([{id:a,name:'ชื่อเดิม',amount:10,cost:2},{id:b,name:'ชื่อเดิม',amount:20,cost:3}]);
    stock.upsertDrug({name:'ชื่อใหม่',unit:'เม็ด',price:99,cost:88},a);
    assert.equal(find(a).profit,8); assert.equal(find(a).name,'ชื่อเดิม'); assert.equal(find(b).profit,17);
  });
  test('no sales still shows stock/uncleared expiry; no invented lot remaining', () => {
    const id=drug('ของค้าง'); stock.move(id,'receive',40,{reason:'สังเคราะห์',userId:1});
    const old=stock.addLot(id,{expiry_date:'2026-01-01',qty:100});
    stock.addLot(id,{expiry_date:'2027-01-01',qty:40}); stock.clearLot(old,{reason:'สังเคราะห์'});
    const r=find(id); assert.equal(r.qty,0); assert.equal(r.stock_now,40); assert.equal(r.expiry_date,'2027-01-01');
    assert(!('expiring_qty' in r));
  });
  test('unit changes never attach present stock to old unit', () => {
    const id=drug('เปลี่ยนหน่วย'); bill([{id,amount:10,cost:2}]);
    stock.upsertDrug({name:'เปลี่ยนหน่วย',unit:'กล่อง',price:100,cost:20},id);
    assert.equal(find(id).stock_now,null); assert.equal(find(id,'2026-01','กล่อง').qty,0);
  });
  test('void crossing month excluded from sales and flagged in both months', () => {
    const id=drug('คืนข้ามเดือน'); bill([{id,amount:10,cost:2}],{status:'VOID',voidMonth:'2026-02'});
    for(const m of ['2026-01','2026-02']) { const r=find(id,m); assert.equal(r.qty,0); assert.equal(r.profit,null); assert.equal(r.review_receipts,1); }
    assert.equal(find(id,'2026-03').review_receipts,0);
  });
  test('reissued bills with new cost are marked, never accepted as true margin', () => {
    const id=drug('แก้บิล'), old=bill([{id,amount:10,cost:2}],{status:'VOID',voidMonth:'2026-02'});
    bill([{id,amount:15,cost:9}],{month:'2026-02',visitId:old.visitId});
    const r=find(id,'2026-02'); assert.equal(r.net,15); assert.equal(r.profit,null); assert.equal(r.review_receipts,2);
  });
  test('free medicine retains its cost and negative margin', () => {
    const id=drug('ให้ฟรี'); bill([{id,amount:10,cost:2}],{discount:10}); assert.equal(find(id).profit,-2);
  });
  test('legacy orphan item cannot borrow present-day cost', () => {
    bill([{name:'ยาเก่าไม่ทราบทุน',amount:10}]);
    const r=monthlyDrugs('2026-01').rows.find(r=>r.name==='ยาเก่าไม่ทราบทุน'); assert.equal(r.profit,null); assert.equal(r.stock_now,null);
  });
  test('repeated reads never write and API output excludes patient/receipt identifiers', () => {
    const before=db.prepare('SELECT total_changes() n').get().n;
    const r=monthlyDrugs('2026-01'); monthlyDrugs('2026-02'); monthlyDrugs('2026-01');
    assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
    assert(!JSON.stringify(r).includes('SYNTHETIC')); assert(!JSON.stringify(r).includes('SYN-'));
  });
  test('legacy monthly/year totals expose missing-cost counts for UI suppression', () => {
    const lg=require('./lib/reports').monthlyLedger(2026);
    assert(lg.months.find(m=>m.month==='2026-01').unknown_cost_lines>=2);
    assert.equal(lg.total.unknown_cost_lines,lg.months.reduce((s,m)=>s+m.unknown_cost_lines,0));
  });
  console.log(`Drug report: ${passed} tests passed`);
} finally { db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
