'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-doctors-'));
process.env.CLINIC_DATA_DIR=temp;
const {db,now,today}=require('./lib/db'),auth=require('./lib/auth'),visits=require('./lib/visits'),appts=require('./lib/appointments'),doctors=require('./lib/doctors');
let count=0,serial=0;
const test=(name,fn)=>{fn();count++;console.log('PASS multi doctor: '+name);};
const user=(name,role='doctor')=>Number(auth.createUser({username:name,displayName:name,role,password:'Synthetic-123',pin:'1234'}).lastInsertRowid);
const A=user('หมอ เอ'),B=user('หมอ บี'),front=user('หน้าร้าน','front');
function patient(){const hn='98-'+String(++serial).padStart(4,'0');db.prepare('INSERT INTO patients(hn,first_name,sex,created_by,created_at) VALUES(?,?,?,?,?)').run(hn,'สังเคราะห์','F',front,now());return hn;}
try{
 test('call conflict names actual doctor and rapid requeue rounds stay distinct',()=>{
  const v=visits.create(patient(),front);visits.transition(v.id,'call',A);
  assert.throws(()=>visits.transition(v.id,'call',B),e=>e.status===409&&e.message.includes('หมอ เอ')&&!e.message.includes('IN_EXAM'));
  const round1=visits.transition(v.id,'requeue',A).requeued_at;visits.transition(v.id,'call',A);
  const round2=visits.transition(v.id,'requeue',A).requeued_at;assert(round2>round1);assert.equal(visits.get(v.id).state,'WAITING');
 });
 test('replacement requires confirmation and preserves examiner-independent default',()=>{
  const v=visits.create(patient(),front);visits.transition(v.id,'call',B);
  const first=appts.create(v.id,{days:7,doctor_id:A},B);
  assert.equal(first.doctor_id,A);assert.equal(first.doctor_name,'หมอ เอ');
  let conflict;try{appts.create(v.id,{days:14},B);}catch(e){conflict=e;}assert.equal(conflict.status,409);assert.match(conflict.message,/หมอ เอ/);
  assert.equal(appts.detail(first.id).cancelled,0);
  assert.throws(()=>appts.create(v.id,{days:14,confirm_replace:true,replace_revision:'outdated'},B),e=>e.status===409);
  const next=appts.create(v.id,{days:14,confirm_replace:true,replace_revision:conflict.replace_appointment.revision},B);
  assert.equal(next.doctor_id,A);assert.equal(appts.detail(first.id).cancelled,1);assert.match(appts.history(first.id).events[0].note,/หมอ เอ/);
  assert.equal(appts.upcomingForPatient(next.hn).doctor_name,'หมอ เอ');
  assert.equal(appts.forMonth(next.appt_date.slice(0,7)).find(a=>a.id===next.id).doctor_id,A);
 });
 test('reschedule and rebook preserve doctor; explicit changes and no preference work',()=>{
  const v=visits.create(patient(),front);visits.transition(v.id,'call',B);
  const a=appts.create(v.id,{days:7},B);assert.equal(a.doctor_id,B);
  assert.equal(appts.reschedule(a.id,{days:9},front).doctor_id,B);
  const day=new Date();day.setDate(day.getDate()+11);const date=day.getFullYear()+'-'+String(day.getMonth()+1).padStart(2,'0')+'-'+String(day.getDate()).padStart(2,'0');
  assert.equal(appts.contact(a.id,{outcome:'rebooked',rebook_date:date,doctor_id:A},front).doctor_id,A);
  assert.throws(()=>appts.reschedule(a.id,{days:12,doctor_id:front},front),/หมอที่เลือก/);
  assert.equal(appts.detail(a.id).doctor_id,A);
  assert.equal(appts.reschedule(a.id,{days:13,doctor_id:null},front).doctor_id,null);
 });
 test('today appointment sets preference with no front-desk input; walk-in remains shared',()=>{
  const hn=patient();db.prepare('INSERT INTO appointments(hn,appt_date,days,created_by,created_at,doctor_id) VALUES(?,?,?,?,?,?)').run(hn,today(),0,A,now(),A);
  const v=visits.create(hn,front);assert.equal(visits.get(v.id).preferred_doctor_id,A);
  assert.equal(visits.todayQueue().find(a=>a.id===v.id).preferred_doctor_name,'หมอ เอ');
  assert.equal(visits.transition(v.id,'call',B).doctor_id,B);
  assert.equal(visits.get(visits.create(patient(),front).id).preferred_doctor_id,null);
  assert.equal(visits.get(visits.create(patient(),front,{},'',A).id).preferred_doctor_id,A);
  assert.throws(()=>visits.create(patient(),front,{},'',front),/หมอที่เลือก/);
 });
 test('one active doctor disables all multi-doctor presentation and replacement prompts',()=>{
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(B);assert.equal(doctors.multiple(),false);
  const v=visits.create(patient(),front);appts.create(v.id,{days:7,doctor_id:A},A);
  assert.doesNotThrow(()=>appts.create(v.id,{days:8},front));db.prepare('UPDATE users SET active=1 WHERE id=?').run(B);
 });
 test('change appointment defaults by patient across visits, never another patient or unspecified doctor',()=>{
  const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'public/exam.html'),'utf8');
  const code=source.slice(source.indexOf('let previousAppointment ='),source.indexOf('// Appointment retries'));
  for(const [previous,expected]of [[{visit_id:1,hn:'SYNTH-A',doctor_id:A},A],[{visit_id:2,hn:'SYNTH-A',doctor_id:A},A],[{visit_id:1,hn:'SYNTH-B',doctor_id:A},B],[{visit_id:1,hn:'SYNTH-A',doctor_id:null},B]]){
   let selected;vm.runInNewContext(code+';previousAppointment='+JSON.stringify(previous)+';renderAppt();',{cur:{id:2,hn:'SYNTH-A',doctor_id:B},ME:{user_id:B},document:{getElementById:()=>({classList:{remove(){}},innerHTML:''})},doctorSelect:(_id,value)=>{selected=value;return '';},decorateApptButtons(){}});assert.equal(selected,expected);
  }
 });
 test('real print route preserves single-doctor examiner and falls back for legacy multi-doctor appointments',()=>{
  const vm=require('node:vm'),print=require('./lib/print'),{setSetting}=require('./lib/db');
  const v=visits.create(patient(),front);visits.transition(v.id,'call',A);const a=appts.create(v.id,{days:7,doctor_id:B},A);
  const source=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');let handler,html;
  vm.runInNewContext(source.slice(source.indexOf("route('GET', '/print/appointment/:id'"),source.indexOf('// ==================== server')),{db,print,doctors,route:(_method,_url,fn)=>handler=fn,send:(_res,status,value)=>{assert.equal(status,200);html=value;}});
  const render=()=>handler({params:{id:a.id},query:{},res:{}});
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(B);render();assert(html.includes('แพทย์ผู้ตรวจ'));assert(html.includes('หมอ เอ'));assert(!html.includes('หมอ บี'));
  db.prepare('UPDATE users SET active=1 WHERE id=?').run(B);render();assert(html.includes('นัดกับ'));assert(html.includes('หมอ บี'));
  db.prepare('UPDATE appointments SET doctor_id=NULL WHERE id=?').run(a.id);render();assert(html.includes('นัดกับ'));assert(html.includes('หมอ เอ'));
  for(const count of [1,2]){db.prepare('UPDATE users SET active=? WHERE id=?').run(count===1?0:1,B);setSetting('appt_slip_show_doctor','0');render();assert(!html.includes('หมอ เอ'));assert(!html.includes('แพทย์ผู้ตรวจ'));}
  setSetting('appt_slip_show_doctor','1');
 });
 for(const from of [13,14])test('populated '+from+' → 15 migration preserves records and leaves both new columns NULL',()=>{
  const dir=path.join(temp,'legacy'+from);fs.mkdirSync(dir);const file=path.join(dir,'clinic.db');db.prepare('VACUUM INTO ?').run(file);
  const {DatabaseSync}=require('node:sqlite'),copy=new DatabaseSync(file);
  copy.exec('ALTER TABLE drugs DROP COLUMN default_dose_json; ALTER TABLE services DROP COLUMN cost; ALTER TABLE appointments DROP COLUMN doctor_id; ALTER TABLE visits DROP COLUMN preferred_doctor_id;'+(from===13?'DROP TABLE appointment_events;':'')+'PRAGMA user_version='+from);
  const appointments=copy.prepare('SELECT COUNT(*) n FROM appointments').get().n,visitCount=copy.prepare('SELECT COUNT(*) n FROM visits').get().n;
  const events=from===14?copy.prepare('SELECT * FROM appointment_events ORDER BY id').all():[];copy.close();
  const result=spawnSync(process.execPath,['--no-warnings','-e',`const {db}=require('./lib/db');console.log(JSON.stringify({version:db.prepare('PRAGMA user_version').get().user_version,appointments:db.prepare('SELECT COUNT(*) n FROM appointments').get().n,visits:db.prepare('SELECT COUNT(*) n FROM visits').get().n,inferred:db.prepare('SELECT COUNT(*) n FROM appointments WHERE doctor_id IS NOT NULL').get().n+db.prepare('SELECT COUNT(*) n FROM visits WHERE preferred_doctor_id IS NOT NULL').get().n,events:db.prepare('SELECT * FROM appointment_events ORDER BY id').all(),integrity:db.prepare('PRAGMA integrity_check').get().integrity_check}));db.close()`],{cwd:__dirname,env:{...process.env,CLINIC_DATA_DIR:dir},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{version:require('./lib/schema-version').SCHEMA_VERSION,appointments,visits:visitCount,inferred:0,events:events.map(e=>({...e})),integrity:'ok'});
 });
 console.log('MULTI DOCTOR UNIT PASS: '+count);
}finally{db.close();fs.rmSync(temp,{recursive:true,force:true});}
