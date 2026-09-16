'use strict';
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), assert=require('node:assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-medication-sheet-'));
process.env.CLINIC_DATA_DIR=dir;
const {db,setSetting}=require('./lib/db');
const sheet=require('./lib/medication-sheet');
const {matchReceiptDoses,provenDose,doseVisual}=require('./lib/medication-visual');
const {sanitizeDose,doseText}=require('./lib/notes');
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS medication sheet: '+name);}
const r={receipt_no:'SYNTHETIC',status:'ISSUED',patient_name:'คนไข้สมมติ',hn:'TEST',created_at:'2026-09-13',document:{issuer:{name:'คลินิกสมมติ',phone:'ทดสอบ'}},lines:[
 {line_type:'drug',name:'ยาสมมติ <script>',qty:5,unit:'เม็ด',instructions:'เมื่อมีอาการเท่านั้น\nคำสั่งเฉพาะราย <b>ไม่แปลง</b>'},
 {line_type:'service',name:'ค่าบริการไม่ใช่ยา',qty:1},
]};
try {
 const dose=sanitizeDose({mode:'standard',m:1,e:0.5,timing:'หลังอาหาร',days:7});
 const orderLine={type:'drug',ref_id:1,name:'ยาสังเคราะห์',qty:11,unit:'เม็ด',instructions:doseText(dose,'เม็ด'),dose};
 const receiptLine={...orderLine,line_type:'drug'};
 test('visual proof requires exact immutable instructions',()=>{assert.equal(provenDose(receiptLine,dose),dose);assert.equal(provenDose({...receiptLine,instructions:'ข้อความแก้เอง'},dose),null);assert.equal(provenDose(receiptLine,{...dose,instructions_source:'manual'}),null);assert.equal(provenDose({...receiptLine,unit:''},dose),null);});
 test('old, malformed, missing and incomplete metadata safely fall back',()=>{for(const bad of [null,{},[],[null],[{...orderLine,dose:null}]])assert.deepEqual(matchReceiptDoses([receiptLine],bad),[null]);for(const bad of [{...dose,m:NaN},{...dose,e:-1},{...dose,days:1.5},{...dose,timing:'เดาเอง'},{...dose,mode:'manual'}])assert.equal(provenDose(receiptLine,bad),null);});
 test('all positional fields must match; changed quantity never borrows old dose',()=>{for(const [key,value] of Object.entries({type:'service',ref_id:9,name:'ชื่อใหม่',qty:10,unit:'อื่น',instructions:'แก้เอง'}))assert.deepEqual(matchReceiptDoses([receiptLine],[{...orderLine,[key]:value}]),[null]);assert.deepEqual(matchReceiptDoses([receiptLine],[orderLine,orderLine]),[null]);});
 test('duplicate medicines remain positional, reordering falls back for all lines',()=>{const secondDose=sanitizeDose({mode:'standard',b:2}),second={...orderLine,dose:secondDose,instructions:doseText(secondDose,'เม็ด')};const receipts=[receiptLine,{...second,line_type:'drug'}];assert.deepEqual(matchReceiptDoses(receipts,[orderLine,second]),[dose,secondDose]);assert.deepEqual(matchReceiptDoses(receipts,[second,orderLine]),[null,null]);});
 test('order discounts are excluded, services still participate in identity match',()=>{const service={type:'service',ref_id:2,name:'บริการสังเคราะห์',qty:1,unit:'ครั้ง',instructions:''};assert.deepEqual(matchReceiptDoses([receiptLine,{...service,line_type:'service'}],[orderLine,{type:'discount',amount:1},service]),[dose,null]);assert.deepEqual(matchReceiptDoses([receiptLine,{...service,line_type:'service',qty:2}],[orderLine,service]),[null,null]);});
 test('four labelled slots and fraction, zero dose never becomes a number to take',()=>{const html=doseVisual(dose,'เม็ด');assert.equal((html.match(/class="dose-cell/g)||[]).length,4);for(const label of ['เช้า','กลางวัน','เย็น','ก่อนนอน','½ เม็ด','ไม่ต้องใช้','หลังอาหาร','7 วัน'])assert(html.includes(label));assert(!html.includes('0 เม็ด'));assert.equal((html.match(/<svg /g)||[]).length,4);});
 test('exact times and PRN retain their own meanings, not meal grids',()=>{const exact=sanitizeDose({mode:'exact_times',times:[{time:'07:30',amount:0.5},{time:'22:00',amount:1}]});assert.equal(provenDose({...receiptLine,instructions:doseText(exact,'เม็ด')},exact),exact);const html=doseVisual(exact,'เม็ด');assert(html.includes('07:30'));assert(!html.includes('dose-grid'));assert.equal(provenDose(receiptLine,{...exact,times:[null]}),null);const prn=sanitizeDose({mode:'prn',prn_amount:1,prn_indication:'อาการสังเคราะห์ <b>',prn_interval_hours:6,prn_max_per_day:3});assert.equal(provenDose({...receiptLine,instructions:doseText(prn,'เม็ด')},prn),prn);const p=doseVisual(prn,'เม็ด');assert(p.includes('ห่างอย่างน้อย 6 ชม.'));assert(p.includes('ไม่เกิน 3 ครั้ง/วัน'));assert(p.includes('&lt;b&gt;'));assert(!p.includes('dose-grid'));});
 test('visual sample uses same proof, optional text style has no graphics',()=>{assert(sheet.sample({}).includes('data-dose-mode="standard"'));assert(sheet.sample({}).includes('อ่านตามข้อความ'));assert(!sheet.sample({style:'text'}).includes('<svg '));assert(sheet.sample({style:'text'}).includes(doseText(dose,'เม็ด')));});
 test('real receipt follows its exact order version; master changes and reissue cannot substitute it',()=>{
   const auth=require('./lib/auth'),stock=require('./lib/stock'),visits=require('./lib/visits'),billing=require('./lib/billing');
   const front=Number(auth.createUser({username:'visual-front',displayName:'สังเคราะห์',role:'front',password:'Test-pass-123'}).lastInsertRowid);
   const doctor=Number(auth.createUser({username:'visual-doctor',displayName:'สังเคราะห์',role:'doctor',password:'Test-pass-123'}).lastInsertRowid);
   const drug=stock.upsertDrug({name:'ยาสังเคราะห์เดิม',unit:'เม็ด',price:2});stock.move(drug,'receive',100,{reason:'สังเคราะห์',userId:front});
   db.prepare("INSERT INTO patients(hn,first_name,sex,created_at,created_by) VALUES ('VISUAL','สังเคราะห์','F',datetime('now'),?)").run(front);
   const visit=visits.create('VISUAL',front);visits.transition(visit.id,'call',doctor);
   const done=visits.finishExam(visit.id,{note:{cc:'สังเคราะห์',dx_text:'สังเคราะห์'},lines:[{type:'drug',ref_id:drug,qty:11,dose}],baseVersionId:null},doctor);
   const paid=billing.pay(visit.id,{orderVersionId:done.order.id,payMethod:'cash',userId:front});const original=billing.getReceipt(paid.receiptNo);
   assert(sheet.render(original).includes('data-dose-mode="standard"'));
   db.prepare("UPDATE drugs SET name='ยาสังเคราะห์ใหม่',default_instructions='คำสั่งใหม่' WHERE id=?").run(drug);
   assert(sheet.render(original).includes('ยาสังเคราะห์เดิม'));assert(!sheet.render(original).includes('ยาสังเคราะห์ใหม่'));
   assert(!sheet.render({...original,visit_id:visit.id+999}).includes('<svg '));
   const reissued=billing.voidAndReissue(paid.receiptNo,{newLines:[{type:'drug',ref_id:drug,qty:5,instructions:original.lines[0].instructions}],returnedStock:false,voidReason:'ทดสอบแก้บิล',payMethod:'cash',userId:front});
   const next=billing.getReceipt(reissued.receiptNo);assert(next);assert(!sheet.render(next).includes('<svg '));assert(sheet.render(next).includes('อ่านตามข้อความ'));
 });
 test('off by default, no button, direct URL guard',()=>{assert.equal(sheet.enabled(),false);assert.equal(sheet.link(r),'');assert.match(sheet.problem(r),/ยังไม่ได้เปิด/);});
 test('only enumerated settings accepted before write',()=>{for(const body of [{medication_sheet_enabled:true},{medication_sheet_font:'12'},{medication_sheet_font:'200'},{medication_sheet_paper:'R58'}])assert.throws(()=>sheet.validateSettings(body),/ใบยาอ่านง่าย/);sheet.validateSettings({medication_sheet_enabled:'1',medication_sheet_font:'24',medication_sheet_paper:'A5'});});
 setSetting('medication_sheet_enabled','1');
 test('button only on issued medicine receipt; missing/void/no drugs rejected',()=>{assert.match(sheet.link(r),/\/print\/medication\/SYNTHETIC/);assert.match(sheet.problem(null),/ไม่พบ/);assert.match(sheet.problem({...r,status:'VOID'}),/ยกเลิก/);assert.equal(sheet.link({...r,status:'VOID'}),'');assert.match(sheet.problem({...r,lines:[]}),/ไม่มีรายการยา/);});
 test('blank instructions block entire patient-ready sheet',()=>{assert.match(sheet.problem({...r,lines:[...r.lines,{line_type:'drug',instructions:'   '}]}),/ไม่มีวิธีใช้/);assert.equal(sheet.problem(r),'');});
 test('snapshots preserved, services excluded, HTML escaped, no inferred timing',()=>{const html=sheet.render(r);assert.match(html,/เมื่อมีอาการเท่านั้น\nคำสั่งเฉพาะราย &lt;b&gt;ไม่แปลง&lt;\/b&gt;/);assert.match(html,/ยาสมมติ &lt;script&gt;/);assert(!html.includes('ค่าบริการไม่ใช่ยา'));assert(!html.includes('หลังอาหารเช้า'));assert.match(html,/จำนวนที่ได้รับ 5 เม็ด/);});
 test('physical paper and minimum fonts, invalid query cannot shrink',()=>{for(const paper of sheet.PAPERS)for(const font of sheet.FONTS){const html=sheet.render(r,{paper,font});assert(html.includes(`size: ${paper} portrait`));assert(html.includes(`font-size:${font}pt`));}assert.match(sheet.render(r,{paper:'R58',font:'6'}),/size: A4 portrait/);assert.match(sheet.render(r,{font:'6'}),/font-size:20pt/);});
 test('saved defaults and one-off overrides do not persist',()=>{setSetting('medication_sheet_font','24');setSetting('medication_sheet_paper','A5');assert.match(sheet.render(r),/font-size:24pt/);assert.match(sheet.render(r,{font:'18',paper:'A4'}),/font-size:18pt/);assert.match(sheet.render(r),/size: A5 portrait/);});
 test('retries/render have no database writes or source mutation',()=>{const before=JSON.stringify(r),changes=db.prepare('SELECT total_changes() n').get().n;for(let i=0;i<3;i++)sheet.render(r);assert.equal(JSON.stringify(r),before);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);});
 test('synthetic preview marked; no automatic print; validate before print',()=>{assert.match(sheet.sample({}),/ตัวอย่าง — ข้อมูลสมมติ/);const html=sheet.render(r);assert(!html.includes("addEventListener('load'"));assert.match(html,/fetch\(location.href/);assert(html.indexOf('if(!response.ok)')<html.indexOf('window.print()'));assert.match(html,/role="alert"/);assert.match(html,/medicationPaginationReady/);});
 test('switch back off takes effect',()=>{setSetting('medication_sheet_enabled','0');assert.equal(sheet.link(r),'');assert.match(sheet.problem(r),/ยังไม่ได้เปิด/);});
 console.log(`Medication sheet: ${passed} tests passed`);
}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
