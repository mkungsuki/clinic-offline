'use strict';
// All files are synthetic; the reader must not load db.js or any key reader.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {readStatus}=require('./lib/audit-restore-status');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-audit-restore-'));
const dataDir=path.join(root,'data'); fs.mkdirSync(dataDir);
const id='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const operationFile=path.join(root,'recovery-operation.json');
const journalDir=path.join(root,'recovery-rollbacks','before-synthetic'); fs.mkdirSync(journalDir,{recursive:true});
const journalFile=path.join(journalDir,'restore-journal.json');
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
function put(operation,journal){fs.writeFileSync(operationFile,JSON.stringify(operation));fs.writeFileSync(journalFile,JSON.stringify(journal));}
try {
  test('ไม่มีไฟล์ไม่แปลว่ากู้สำเร็จ',()=>assert.equal(readStatus({dataDir}).state,'missing'));
  test('ต้องมี complete และ committed ที่ตรงคำสั่งเดียวกัน',()=>{put({id,state:'complete',result:{backupCreatedAt:'2099-01-01 12:00:00'}},{operationId:id,state:'committed'});const r=readStatus({dataDir});assert.equal(r.state,'complete');assert.equal(r.backupCreatedAt,'2099-01-01 12:00:00');assert.match(r.message,/ตัวช่วยรายงาน/);});
  test('committed อย่างเดียวไม่ยืนยันว่าจบ',()=>{put({id,state:'published',backupCreatedAt:'2099-01-01 12:00:00'},{operationId:id,state:'committed'});assert.equal(readStatus({dataDir}).state,'pending');});
  test('operation ใหม่ไม่รับผลสำเร็จของรอบเก่า',()=>{put({id:other,state:'prepared'},{operationId:id,state:'committed'});const r=readStatus({dataDir});assert.equal(r.state,'unknown');assert.equal(r.backupCreatedAt,undefined);});
  test('rollback หลังเริ่มแอปไม่ขึ้นแสดงย้อนกลับ',()=>{put({id,state:'complete'},{operationId:id,state:'rolled-back-after-start-failure'});assert.equal(readStatus({dataDir}).state,'rolled-back');});
  test('กำลังย้อนกลับยังไม่รับรองข้อมูลเดิมกลับแล้ว',()=>{put({id,state:'published'},{operationId:id,state:'rolling-back-after-start-failure'});assert.equal(readStatus({dataDir}).state,'pending');});
  test('วันจบไม่ใช่วันสำเนา',()=>{put({id,state:'complete'},{operationId:id,state:'committed',finishedAt:'2099-02-01 00:00:00'});const r=readStatus({dataDir});assert.equal(r.state,'complete');assert.equal(r.backupCreatedAt,undefined);assert.match(r.dateNotice,/ไม่ทราบ/);});
  test('ไฟล์เสียไม่เปิดเผยเนื้อหา/ตำแหน่ง',()=>{fs.writeFileSync(operationFile,'CORRUPT-PRIVATE-PATH');const r=readStatus({dataDir});assert.equal(r.state,'unknown');assert.ok(!JSON.stringify(r).includes(root));assert.ok(!JSON.stringify(r).includes('CORRUPT'));});
  test('ไฟล์ใหญ่ถูกปฏิเสธโดยไม่อ่านเนื้อหา',()=>{fs.writeFileSync(operationFile,'x'.repeat(128*1024+1));assert.equal(readStatus({dataDir}).state,'unknown');});
  test('ไม่คืนตำแหน่งหรือข้อมูลปลดล็อกจากหลักฐาน',()=>{put({id,state:'complete',sourceDirectory:'SYNTHETIC-PRIVATE-SOURCE',result:{appUrl:'SYNTHETIC-PRIVATE-URL'}},{operationId:id,state:'committed',payloads:['SYNTHETIC-PRIVATE-PAYLOAD']});const r=readStatus({dataDir});assert.ok(!JSON.stringify(r).includes('SYNTHETIC-PRIVATE'));});
  test('หลักฐานซ้ำหรือขัดกันไม่รับรองสำเร็จ',()=>{const second=path.join(root,'recovery-rollbacks','before-second');fs.mkdirSync(second);fs.writeFileSync(path.join(second,'restore-journal.json'),JSON.stringify({operationId:id,state:'committed'}));assert.equal(readStatus({dataDir}).state,'unknown');fs.unlinkSync(path.join(second,'restore-journal.json'));fs.rmdirSync(second);});
  test('ตัวอ่านไม่มีผลเขียนและไม่เปิดฐาน',()=>{const before=fs.statSync(operationFile).mtimeMs;readStatus({dataDir});assert.equal(fs.statSync(operationFile).mtimeMs,before);assert.ok(!require.cache[require.resolve('./lib/db')]);assert.ok(!fs.existsSync(path.join(dataDir,'clinic.db')));});
  test('ไม่ตาม junction ออกจากโฟลเดอร์หลักฐาน',()=>{const external=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-audit-other-'));try{fs.writeFileSync(path.join(external,'restore-journal.json'),JSON.stringify({operationId:id,state:'committed'}));const junction=path.join(root,'recovery-rollbacks','before-link');fs.symlinkSync(external,junction,'junction');assert.equal(readStatus({dataDir}).state,'unknown');fs.unlinkSync(junction);}finally{fs.unlinkSync(path.join(external,'restore-journal.json'));fs.rmdirSync(external);}});
  console.log(`${passed} audit restore tests passed`);
} finally { fs.rmSync(root,{recursive:true,force:true}); }
