'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-service-cost-'));
process.env.CLINIC_DATA_DIR=dir;
const {db,now,today}=require('./lib/db'),auth=require('./lib/auth'),stock=require('./lib/stock'),visits=require('./lib/visits'),billing=require('./lib/billing'),reports=require('./lib/reports');
const front=Number(auth.createUser({username:'cost-front',displayName:'ทดสอบ',role:'front',password:'Synthetic-123',pin:'1234'}).lastInsertRowid);
const doctor=Number(auth.createUser({username:'cost-doctor',displayName:'ทดสอบ',role:'doctor',password:'Synthetic-123',pin:'1234'}).lastInsertRowid);
let serial=0,passed=0;
const test=(name,fn)=>{fn();passed++;console.log('PASS service cost: '+name);};
function pay(lines,extra={}){
 const hn='97-'+String(++serial).padStart(4,'0');db.prepare('INSERT INTO patients(hn,first_name,sex,created_by,created_at) VALUES(?,?,?,?,?)').run(hn,'สังเคราะห์','F',front,now());
 const v=visits.create(hn,front);visits.transition(v.id,'call',doctor);
 const done=visits.finishExam(v.id,{note:{cc:'สังเคราะห์'},lines,baseVersionId:null},doctor);
 return billing.pay(v.id,{orderVersionId:done.order.id,payMethod:'cash',userId:front,...extra});
}
try{
 test('300 service with 120 direct cost leaves 180, not 300',()=>{
  const id=stock.upsertService({name:'หัตถการสังเคราะห์',price:300,cost:120});
  const paid=pay([{type:'service',ref_id:id,qty:1}]);
  assert.equal(db.prepare('SELECT cost_each FROM receipt_lines WHERE receipt_no=?').get(paid.receiptNo).cost_each,120);
  assert.equal(reports.daily(today()).money.gross_profit,180);
 });
 test('quantity, discount and drug cost reconcile daily/month/year',()=>{
  const id=stock.upsertService({name:'ทำสองครั้ง',price:300,cost:120});
  const drug=stock.upsertDrug({name:'ยาสังเคราะห์',unit:'เม็ด',price:10,cost:3});
  pay([{type:'service',ref_id:id,qty:2},{type:'drug',ref_id:drug,qty:2}],{discount:20,discountReason:'สังเคราะห์'});
  const m=reports.daily(today()).money;
  assert.equal(m.total,900);assert.equal(m.drug_cost,6);assert.equal(m.service_cost,360);assert.equal(m.direct_cost,366);assert.equal(m.gross_profit,534);
  const lg=reports.monthlyLedger(Number(today().slice(0,4)));assert.equal(lg.total.gross_profit,534);assert.equal(lg.total.service_cost,360);
  assert.equal(lg.months[0].direct_cost,366);
 });
 test('changing catalog cannot rewrite historical snapshot or report',()=>{
  const old=JSON.stringify(reports.daily(today()).money);
  stock.upsertService({cost:999},1);
  assert.equal(JSON.stringify(reports.daily(today()).money),old);
  assert.equal(db.prepare('SELECT cost_each FROM receipt_lines WHERE ref_id=1 AND line_type=\'service\'').get().cost_each,120);
 });
 test('explicit zero, fractional cost and below-cost sale are supported',()=>{
  const zero=stock.upsertService({name:'ไม่มีทุนตรง',price:0,cost:0}),loss=stock.upsertService({name:'ขาดทุน',price:10,cost:20.25});
  const p=pay([{type:'service',ref_id:zero,qty:1},{type:'service',ref_id:loss,qty:2}]);
  assert.deepEqual(billing.getReceipt(p.receiptNo).lines.map(l=>l.cost_each),[0,20.25]);
  assert.equal(reports.daily(today()).money.gross_profit,513.5);
 });
 test('invalid costs/prices and missing IDs reject without partial edits',()=>{
  const id=stock.upsertService({name:'ตรวจค่า',price:300,cost:120});
  for(const cost of [-1,'bad',Infinity,NaN,true,{},100000001])assert.throws(()=>stock.upsertService({name:'ห้ามเปลี่ยน',cost},id),/ต้นทุน/);
  for(const price of [-1,'bad',Infinity,null,''])assert.throws(()=>stock.upsertService({price},id),/ราคา/);
  assert.equal(stock.listServices().find(s=>s.id===id).name,'ตรวจค่า');
  assert.throws(()=>stock.upsertService({cost:10},999999),/ไม่พบ/);
  stock.upsertService({price:310},id);assert.equal(stock.listServices().find(s=>s.id===id).cost,120);
  stock.upsertService({cost:''},id);assert.equal(stock.listServices().find(s=>s.id===id).cost,null);
 });
 test('unknown service suppresses numeric margin, later cost does not backfill',()=>{
  const id=stock.upsertService({name:'ยังไม่ทราบ',price:300});const p=pay([{type:'service',ref_id:id,qty:1}]);
  stock.upsertService({cost:120},id);
  const m=reports.daily(today()).money;assert.equal(m.unknown_service_cost_lines,1);assert.equal(m.gross_profit,null);
  const lg=reports.monthlyLedger(Number(today().slice(0,4)));assert.equal(lg.total.gross_profit,null);assert.equal(lg.months[0].gross_profit,null);
  assert.equal(billing.getReceipt(p.receiptNo).lines[0].cost_each,null);
  billing.refund(p.receiptNo,{reason:'สังเคราะห์',returnedStock:false,userId:front});
  assert.equal(reports.daily(today()).money.gross_profit,513.5);
 });
 test('same-name service with missing cost cannot borrow another catalog cost',()=>{
  const id=stock.upsertService({name:'หัตถการสังเคราะห์',price:300});
  const p=pay([{type:'service',ref_id:id,qty:1}]);
  assert.equal(billing.getReceipt(p.receiptNo).lines[0].cost_each,null);
  assert.equal(reports.daily(today()).money.gross_profit,null);
 });
 test('void/reissue leaves old receipt immutable and counts only issued replacement',()=>{
  const id=stock.upsertService({name:'แก้บิล',price:300,cost:120});const p=pay([{type:'service',ref_id:id,qty:1}]);
  const before=JSON.stringify(billing.getReceipt(p.receiptNo).lines);
  const re=billing.voidAndReissue(p.receiptNo,{newLines:[{type:'service',ref_id:id,qty:2}],returnedStock:false,voidReason:'สังเคราะห์',payMethod:'cash',userId:front});
  assert.equal(JSON.stringify(billing.getReceipt(p.receiptNo).lines),before);
  assert.equal(billing.getReceipt(re.receiptNo).lines[0].cost_each,120);
  assert.equal(billing.getReceipt(p.receiptNo).status,'VOID');
 });
 test('schema15 migration leaves old service costs/receipt snapshots unknown',()=>{
  const {spawnSync}=require('node:child_process');
  const migration=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-service-migration-'));
  try{
   const run=source=>{const r=spawnSync(process.execPath,['--no-warnings','-e',source],{cwd:__dirname,env:{...process.env,CLINIC_DATA_DIR:migration},encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
   run(`const {db}=require('./lib/db');db.exec("INSERT INTO services(name,price) VALUES('legacy',300); ALTER TABLE drugs DROP COLUMN default_dose_json; ALTER TABLE services DROP COLUMN cost; PRAGMA user_version=15");db.close();`);
   run(`const assert=require('node:assert/strict');const {db}=require('./lib/db');assert.equal(db.prepare('PRAGMA user_version').get().user_version,require('./lib/schema-version').SCHEMA_VERSION);assert.equal(db.prepare('SELECT cost FROM services').get().cost,null);db.close();`);
  }finally{fs.rmSync(migration,{recursive:true,force:true});}
 });
 console.log(`Service cost: ${passed} tests passed`);
}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
