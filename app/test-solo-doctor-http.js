'use strict';
// Called only by the isolated npm run test:http harness.
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict'),{spawn,spawnSync}=require('child_process');
module.exports=async function(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-solo-http-')),token=crypto.randomBytes(24).toString('hex'),port=28000+crypto.randomInt(4000),base='http://127.0.0.1:'+port;
 const env={...process.env,CLINIC_DATA_DIR:dir,CLINIC_PORT:String(port),CLINIC_HTTPS_PORT:'0',CLINIC_TEST_INSTANCE_TOKEN:token};let server,passed=0;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function start(){server=spawn(process.execPath,['--no-warnings','server.js'],{cwd:__dirname,env,stdio:'ignore',windowsHide:true});for(let i=0;i<150;i++){try{if((await fetch(base+'/api/test-instance',{headers:{'X-Clinic-Test-Token':token}})).status===200)return;}catch{}await sleep(40);}throw Error('solo start timeout');}
 async function stop(){if(server?.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}}
 async function req(cookie,method,url,body,crash){try{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(crash?{'X-Clinic-Test-Token':token,'X-Clinic-Test-Crash':crash}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}catch(e){if(crash)return {status:0};throw e;}}
 const login=async(name,password)=>{const r=await req(null,'POST','/api/login',{username:name,password});assert.equal(r.status,200);return r.cookie;};
 const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
 const check=n=>{passed++;console.log('SOLO HTTP PASS: '+n);};
 const counts=id=>JSON.parse(spawnSync(process.execPath,['--no-warnings','-e',`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);const id=Number(process.argv[2]);const out={};for(const t of ['note_versions','order_versions','receipts'])out[t]=db.prepare('SELECT COUNT(*) AS n FROM '+t+' WHERE visit_id=?').get(id).n;console.log(JSON.stringify(out));db.close();`,path.join(dir,'clinic.db'),String(id)],{encoding:'utf8',windowsHide:true}).stdout);
 let admin,doctor,front,uid,service;
 async function freshVisit(){const p=ok(await req(doctor,'POST','/api/patients',{first_name:'สังเคราะห์',sex:'F',queue:true,op_id:crypto.randomUUID()}),201);const id=p.visit_id;ok(await req(doctor,'POST','/api/visits/'+id+'/call',{op_id:crypto.randomUUID()}));return id;}
 async function restartAfterCrash(){for(let i=0;i<150&&server.exitCode===null;i++)await sleep(20);assert.notEqual(server.exitCode,null);await start();admin=await login('admin','admin1234');doctor=await login('doctor','doctor123');}
 try{
  const seeded=spawnSync(process.execPath,['--no-warnings','seed.js','--demo'],{cwd:__dirname,env,encoding:'utf8',windowsHide:true});assert.equal(seeded.status,0,seeded.stderr);await start();
  admin=await login('admin','admin1234');doctor=await login('doctor','doctor123');front=await login('front','front123');uid=ok(await req(doctor,'GET','/api/me')).user_id;
  assert.equal(ok(await req(doctor,'GET','/api/me')).can_front_desk,false);
  for(const route of ['/api/services','/api/drugs','/api/visits/999/pay','/api/receipts/none/refund'])assert.equal((await req(doctor,'POST',route,{})).status,403);
  for(const role of [doctor,front])assert.equal((await req(role,'PATCH','/api/users/'+uid,{front_desk:true})).status,403);check('default doctor has no front writes and cannot self-grant');
  for(const v of [1,'true',null])assert.equal((await req(admin,'PATCH','/api/users/'+uid,{front_desk:v})).status,400);check('invalid flag rejected');
  for(const phase of ['before-commit','after-commit']){
   ok(await req(admin,'PATCH','/api/users/'+uid,{front_desk:false}));doctor=await login('doctor','doctor123');
   assert.equal((await req(admin,'PATCH','/api/users/'+uid,{front_desk:true},phase)).status,0);await restartAfterCrash();
   assert.equal(ok(await req(doctor,'GET','/api/me')).can_front_desk,phase==='after-commit');
   ok(await req(admin,'PATCH','/api/users/'+uid,{front_desk:true}));doctor=await login('doctor','doctor123');
   const repeat=ok(await req(admin,'PATCH','/api/users/'+uid,{front_desk:true}));assert.equal(repeat.sessions_revoked,false);assert.equal(ok(await req(doctor,'GET','/api/me')).can_front_desk,true);check('grant '+phase+' crash/restart/retry is atomic and idempotent');
  }
  const me=ok(await req(doctor,'GET','/api/me'));assert.equal(me.role,'doctor');assert(me.can_front_desk);assert(ok(await req(admin,'GET','/api/users')).find(u=>u.id===uid).front_desk);
  for(const url of ['/api/users','/api/admin/access-log'])assert.equal((await req(doctor,'GET',url)).status,403);
  service=ok(await req(doctor,'POST','/api/services',{name:'ค่าตรวจสังเคราะห์คนเดียว',price:300,cost:120,op_id:crypto.randomUUID()}),201).id;check('enabled doctor edits service stock without admin privileges');
  for(const phase of ['before-commit','after-commit']){
   const id=await freshVisit(),body={note:{cc:'สังเคราะห์'},lines:[{type:'service',ref_id:service,qty:1}],base_version_id:null,op_id:crypto.randomUUID()};
   assert.equal((await req(doctor,'POST','/api/visits/'+id+'/finish-exam',body,phase)).status,0);await restartAfterCrash();
   assert.equal(counts(id).note_versions,phase==='after-commit'?1:0);
   const a=ok(await req(doctor,'POST','/api/visits/'+id+'/finish-exam',body)),b=ok(await req(doctor,'POST','/api/visits/'+id+'/finish-exam',body));assert.deepEqual(a,b);
   const changed=await req(doctor,'POST','/api/visits/'+id+'/finish-exam',{...body,note:{cc:'changed'}});assert.equal(changed.status,409);assert.equal(changed.data.already_finished.visit.id,id);
   assert.equal(counts(id).note_versions,1);assert.equal(counts(id).order_versions,1);
   const pay={order_version_id:a.order.id,pay_method:'cash',cash_received:300,op_id:crypto.randomUUID()};
   assert.equal((await req(doctor,'POST','/api/visits/'+id+'/pay',pay,phase)).status,0);await restartAfterCrash();
   const paid=ok(await req(doctor,'POST','/api/visits/'+id+'/pay',pay),201);assert.deepEqual(paid,ok(await req(doctor,'POST','/api/visits/'+id+'/pay',pay),201));assert.equal(counts(id).receipts,1);
   const r=ok(await req(doctor,'GET','/api/receipts/'+paid.receiptNo));assert.equal(r.created_by,uid);assert.equal(r.lines[0].cost_each,120);check('one-account registration/exam/pay '+phase+' crash => 1 note, 1 order, 1 receipt with actual doctor actor');
  }
  const permissionOp=crypto.randomUUID();ok(await req(admin,'PATCH','/api/users/'+uid,{front_desk:true,op_id:permissionOp}));ok(await req(admin,'PATCH','/api/users/'+uid,{front_desk:false}));
  ok(await req(admin,'PATCH','/api/users/'+uid,{front_desk:true,op_id:permissionOp}));doctor=await login('doctor','doctor123');assert.equal(ok(await req(doctor,'GET','/api/me')).can_front_desk,false);check('late retry cannot re-enable a permission revoked after the original save');
  ok(await req(admin,'PATCH','/api/users/'+uid,{front_desk:true}));doctor=await login('doctor','doctor123');
  ok(await req(admin,'POST','/api/users',{username:'other-doctor',display_name:'แพทย์สังเคราะห์อื่น',role:'doctor',password:'Synthetic-123'}),201);
  const other=await login('other-doctor','Synthetic-123');const p=ok(await req(other,'POST','/api/patients',{first_name:'สังเคราะห์เจ้าของคิวอื่น',sex:'M',queue:true}),201);ok(await req(other,'POST','/api/visits/'+p.visit_id+'/call',{}));assert.equal((await req(doctor,'POST','/api/visits/'+p.visit_id+'/finish-exam',{note:{},lines:[]})).status,403);assert.equal((await req(doctor,'POST','/api/visits/'+p.visit_id+'/orders',{lines:[]})).status,403);check('front capability does not bypass clinical visit ownership');
  const old=doctor;ok(await req(admin,'PATCH','/api/users/'+uid,{front_desk:false}));assert.equal((await req(old,'GET','/api/me')).status,401);doctor=await login('doctor','doctor123');assert.equal((await req(doctor,'POST','/api/services',{name:'forbidden',price:0})).status,403);check('revocation rejects existing cookie immediately and new session loses front writes');
  assert.equal((await req(admin,'POST','/api/services',{name:'forbidden',price:0})).status,403);assert.equal((await req(front,'POST','/api/services',{name:'front unchanged',price:0,cost:0})).status,201);check('admin remains non-clinical and front existing behavior unchanged');
  console.log('SOLO HTTP TOTAL: '+passed);
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true});}
};
