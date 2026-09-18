'use strict';
// Only called by test-http.js: synthetic data directory, random port, token-checked server.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
module.exports=async function(){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-audit-http-')),token=crypto.randomBytes(24).toString('hex'),port=32000+crypto.randomInt(8000),base='http://127.0.0.1:'+port;
 const env={...process.env,CLINIC_DATA_DIR:data,CLINIC_PORT:String(port),CLINIC_HTTPS_PORT:'0',CLINIC_TEST_INSTANCE_TOKEN:token};let server,db,passed=0;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function start(){server=spawn(process.execPath,['--no-warnings','server.js'],{cwd:__dirname,env,stdio:'ignore',windowsHide:true});for(let i=0;i<100;i++){try{if((await fetch(base+'/api/test-instance',{headers:{'X-Clinic-Test-Token':token}})).status===200)return;}catch{}await sleep(50);}throw Error('isolated audit start failed');}
 async function stop(){if(server?.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}}
 async function req(cookie,method,url,body,crash){try{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(crash?{'X-Clinic-Test-Token':token,'X-Clinic-Test-Crash':crash}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}catch(e){if(crash)return {status:0};throw e;}}
 const login=async(username,password)=>{const r=await req(null,'POST','/api/login',{username,password});assert.equal(r.status,200);return r.cookie;};
 const check=name=>{passed++;console.log('AUDIT HTTP PASS: '+name);};
 const changes=(category,id)=>db.prepare('SELECT * FROM audit_changes WHERE category=? AND entity_id=? ORDER BY id').all(category,String(id));
 async function restartAfterCrash(){for(let i=0;i<100&&server.exitCode===null;i++)await sleep(20);assert.notEqual(server.exitCode,null);await start();}
 try{
  const seed=spawnSync(process.execPath,['--no-warnings','seed.js','--demo'],{cwd:__dirname,env,encoding:'utf8',windowsHide:true});assert.equal(seed.status,0,seed.stderr);await start();
  db=new DatabaseSync(path.join(data,'clinic.db'));db.exec('PRAGMA busy_timeout=5000');
  let admin=await login('admin','admin1234'),front=await login('front','front123'),doctor=await login('doctor','doctor123');
  for(const cookie of [null,front,doctor]){
   assert.equal((await req(cookie,'GET','/api/admin/audit')).status,cookie?403:401);
   assert.equal((await req(cookie,'GET','/api/admin/audit-detail?key=change:1')).status,cookie?403:401);
  }check('list and sensitive detail require administrator on server');
  const initial=await req(admin,'GET','/api/admin/audit');assert.equal(initial.status,200);assert.equal(initial.data.groups.length,6);assert.ok(initial.data.groups.every(g=>g.rows.length<=3));assert.ok(initial.data.since);check('upgraded database with empty new history renders six bounded groups');
  const created=await req(front,'POST','/api/patients',{first_name:'คนสังเคราะห์ทดสอบ',last_name:'ซ้ำ',sex:'F',queue:true,op_id:crypto.randomUUID()});assert.equal(created.status,201);const {hn,visit_id}=created.data;
  const c2=await req(front,'POST','/api/patients',{first_name:'คนสังเคราะห์ทดสอบ',last_name:'ซ้ำ',sex:'M',op_id:crypto.randomUUID()});assert.equal(c2.status,201);
  assert.equal((await req(front,'PATCH','/api/patients/'+hn,{phone:'0812345678',citizen_id:'1234567890123'})).status,200);
  const patientAudit=changes('patient',hn).at(-1),summary=(await req(admin,'GET','/api/admin/audit?category=patient&q='+encodeURIComponent(hn))).data;
  assert.ok(summary.groups[0].rows.some(r=>r.key==='change:'+patientAudit.id));assert.ok(!JSON.stringify(summary).includes('0812345678'));assert.ok(!JSON.stringify(summary).includes('1234567890123'));
  const detail=(await req(admin,'GET','/api/admin/audit-detail?key=change:'+patientAudit.id)).data;assert.ok(detail.changes.some(c=>c.after==='0812345678'));assert.ok(detail.changes.some(c=>c.after==='1234567890123'));assert.equal(detail.station,'เครื่องหลัก');check('patient summary masks identifiers; admin-expanded details retain exact changes');
  const candidates=(await req(admin,'GET','/api/admin/audit?q='+encodeURIComponent('คนสังเคราะห์ทดสอบ'))).data.candidates;assert.deepEqual(new Set(candidates.map(c=>c.hn)),new Set([hn,c2.data.hn]));check('duplicate patient names resolve to separate HN choices');
  const patch={address:'ที่อยู่สังเคราะห์หลังไฟดับ'};let n=changes('patient',hn).length;
  assert.equal((await req(front,'PATCH','/api/patients/'+hn,patch,'after-commit')).status,0);await restartAfterCrash();front=await login('front','front123');admin=await login('admin','admin1234');doctor=await login('doctor','doctor123');
  assert.equal((await req(front,'PATCH','/api/patients/'+hn,patch)).status,200);assert.equal(changes('patient',hn).length,n+1);check('patient edit crash after commit and immediate retry produces one change');
  await req(doctor,'PATCH','/api/patients/'+hn,{address:'งานแทรกสังเคราะห์จากแพทย์'});await req(front,'PATCH','/api/patients/'+hn,patch);
  const overwritten=changes('patient',hn).at(-1),delta=JSON.parse(overwritten.changes_json);assert.equal(delta.address.before,'งานแทรกสังเคราะห์จากแพทย์');assert.equal(delta.address.after,patch.address);assert.equal(overwritten.actor_role,'front');check('accepted stale-request risk is visible with exact overwritten values and actor');
  const vitals={weight_kg:64,bp_sys:125,bp_dia:79,pulse:71};n=changes('vitals',visit_id).length;
  assert.equal((await req(front,'PATCH','/api/visits/'+visit_id+'/vitals',vitals,'after-commit')).status,0);await restartAfterCrash();front=await login('front','front123');admin=await login('admin','admin1234');
  assert.equal((await req(front,'PATCH','/api/visits/'+visit_id+'/vitals',vitals)).status,200);assert.equal(changes('vitals',visit_id).length,n+1);check('vitals crash after commit and immediate retry produces one change');
  doctor=await login('doctor','doctor123');await req(doctor,'PATCH','/api/visits/'+visit_id+'/vitals',{...vitals,pulse:82});await req(front,'PATCH','/api/visits/'+visit_id+'/vitals',vitals);
  const overwrittenVital=changes('vitals',visit_id).at(-1);assert.equal(JSON.parse(overwrittenVital.changes_json).pulse.before,82);assert.equal(JSON.parse(overwrittenVital.changes_json).pulse.after,71);assert.equal(overwrittenVital.actor_role,'front');check('vitals stale retry records the intervening value it overwrote');
  const setting={clinic_phone:'029999991'};n=changes('settings','clinic').length;
  assert.equal((await req(admin,'POST','/api/settings',setting,'after-commit')).status,0);await restartAfterCrash();admin=await login('admin','admin1234');front=await login('front','front123');
  assert.equal((await req(admin,'POST','/api/settings',setting)).status,200);assert.equal(changes('settings','clinic').length,n+1);check('settings crash after commit and immediate retry produces one change');
  assert.equal((await req(admin,'POST','/api/users',{username:'synthetic-second-admin',display_name:'ผู้ดูแลสังเคราะห์สอง',role:'admin',password:'Synthetic-admin-123'})).status,201);const secondAdmin=await login('synthetic-second-admin','Synthetic-admin-123');
  await req(secondAdmin,'POST','/api/settings',{clinic_phone:'029999990'});await req(admin,'POST','/api/settings',setting);const overwrittenSetting=changes('settings','clinic').at(-1);assert.equal(JSON.parse(overwrittenSetting.changes_json).clinic_phone.before,'029999990');assert.equal(JSON.parse(overwrittenSetting.changes_json).clinic_phone.after,setting.clinic_phone);assert.notEqual(overwrittenSetting.actor_name,'ผู้ดูแลสังเคราะห์สอง');check('settings stale retry records the other administrator change it overwrote');
  const beforeImport=db.prepare('SELECT count(*) n FROM audit_changes').get().n;
  const csv=await req(admin,'POST','/api/drugs/import-csv',{csv:'ยาสังเคราะห์CSV,เม็ด,2,20,5,1\nยาสังเคราะห์CSV2,ขวด,50,2,1,20'});assert.equal(csv.status,200);assert.equal(csv.data.added,2);
  assert.equal(db.prepare('SELECT count(*) n FROM audit_changes').get().n,beforeImport+1);assert.equal(JSON.parse(changes('stock','csv').at(-1).changes_json).added_count.after,2);check('CSV import records one atomic summary without row-level change noise');
  db.exec("CREATE TRIGGER audit_http_failure BEFORE INSERT ON audit_changes BEGIN SELECT RAISE(ABORT,'synthetic secret must not leak'); END;");
  try{
   const failed=await req(admin,'POST','/api/drugs/import-csv',{csv:'ยาสังเคราะห์ต้องrollback,เม็ด,2,20,5,1'});assert.equal(failed.status,503);assert.ok(!JSON.stringify(failed.data).includes('synthetic secret'));assert.equal(db.prepare('SELECT count(*) n FROM drugs WHERE name=?').get('ยาสังเคราะห์ต้องrollback').n,0);
   const saved=db.prepare("SELECT value FROM settings WHERE key='clinic_phone'").get().value;assert.equal((await req(admin,'POST','/api/settings',{clinic_phone:'029999992'})).status,503);assert.equal(db.prepare("SELECT value FROM settings WHERE key='clinic_phone'").get().value,saved);
  }finally{db.exec('DROP TRIGGER audit_http_failure');}check('audit write failure rolls back entire CSV and settings without exposing raw error');
  const backup=await req(front,'POST','/api/backup/run',{});assert.equal(backup.status,200);const meta=JSON.parse(db.prepare('SELECT detail FROM backup_log ORDER BY id DESC LIMIT 1').get().detail);assert.equal(meta.format,3);assert.equal(meta.source,'manual');assert.equal(meta.actor_role,'front');check('manual backup retains real actor in format3 metadata');
  for(const suffix of ['?category=invalid','?from=2026-02-30','?q='+encodeURIComponent('x'.repeat(121))])assert.equal((await req(admin,'GET','/api/admin/audit'+suffix)).status,400);check('invalid search parameters fail with readable errors');
  assert.equal((await req(front,'POST','/api/stock/expiry-warning',{days:123})).status,200);assert.equal(changes('settings','clinic').at(-1).actor_role,'front');check('stock expiry setting retains station user context outside admin form');
  assert.equal((await req(front,'POST','/api/visits/'+visit_id+'/appointment',{days:7,op_id:crypto.randomUUID()})).status,201);
  const appt=db.prepare('SELECT id,hn FROM appointments WHERE hn=? LIMIT 1').get(hn);assert.ok(appt);
  const accessBefore=db.prepare("SELECT count(*) n FROM access_log WHERE action='view_history' AND ref=?").get(appt.hn).n;assert.equal((await req(front,'GET','/api/appointments/'+appt.id+'/history')).status,200);assert.equal(db.prepare("SELECT count(*) n FROM access_log WHERE action='view_history' AND ref=?").get(appt.hn).n,accessBefore+1);check('appointment history records supported access action against its HN');
  console.log('AUDIT HTTP TOTAL: '+passed);
 }finally{await stop();if(db)db.close();}
};
