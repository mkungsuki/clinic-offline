'use strict';
// Invoked only from npm run test:http; synthetic instance, no external URL accepted.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
module.exports=async function(){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-auth-http-')),token=crypto.randomBytes(24).toString('hex'),port=32000+crypto.randomInt(8000),base='http://127.0.0.1:'+port;
 const env={...process.env,CLINIC_DATA_DIR:data,CLINIC_PORT:String(port),CLINIC_HTTPS_PORT:'0',CLINIC_TEST_INSTANCE_TOKEN:token};let server,passed=0;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function start(){server=spawn(process.execPath,['--no-warnings','server.js'],{cwd:__dirname,env,stdio:'ignore',windowsHide:true});for(let i=0;i<100;i++){try{if((await fetch(base+'/api/test-instance',{headers:{'X-Clinic-Test-Token':token}})).status===200)return;}catch{}await sleep(50);}throw Error('isolated auth start failed');}
 async function stop(){if(server?.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}}
 async function req(cookie,method,url,body,crash){try{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(crash?{'X-Clinic-Test-Token':token,'X-Clinic-Test-Crash':crash}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}catch(e){if(crash)return {status:0};throw e;}}
 const login=async(username,password)=>{const r=await req(null,'POST','/api/login',{username,password});assert.equal(r.status,200);return r.cookie;};
 const check=name=>{passed++;console.log('AUTH HTTP PASS: '+name);};
 try{
  const seed=spawnSync(process.execPath,['--no-warnings','seed.js','--demo'],{cwd:__dirname,env,encoding:'utf8',windowsHide:true});assert.equal(seed.status,0,seed.stderr);await start();
  let admin=await login('admin','admin1234');const users=(await req(admin,'GET','/api/users')).data;const doctor=users.find(u=>u.username==='doctor'),adminId=users.find(u=>u.username==='admin').id;
  let d1=await login('doctor','doctor123'),d2=await login('doctor','doctor123');
  assert.equal((await req(d1,'PATCH','/api/users/'+doctor.id,{active:false})).status,403);check('doctor cannot change account permissions');
  assert.equal((await req(admin,'PATCH','/api/users/'+doctor.id,{password:'Synthetic-new-123',pin:'bad',active:false})).status,400);assert.equal((await req(d1,'GET','/api/queue')).status,200);await login('doctor','doctor123');check('invalid multi-field patch changes nothing');
  for(const phase of ['before-commit','after-commit'])for(const change of ['password','pin','active']){
   const username='synthetic-'+phase+'-'+change;
   assert.equal((await req(admin,'POST','/api/users',{username,display_name:'Synthetic account',role:'doctor',password:'Synthetic-old-123',pin:'1234'})).status,201);
   const id=(await req(admin,'GET','/api/users')).data.find(u=>u.username===username).id;
   const c1=await login(username,'Synthetic-old-123'),c2=await login(username,'Synthetic-old-123');
   const body=change==='password'?{password:'Synthetic-new-123'}:change==='pin'?{pin:'5678'}:{active:false};
   assert.equal((await req(admin,'PATCH','/api/users/'+id,body,phase)).status,0);
   for(let i=0;i<100&&server.exitCode===null;i++)await sleep(20);assert.notEqual(server.exitCode,null);await start();
   const expected=phase==='after-commit'?401:200;
   assert.equal((await req(c1,'GET','/api/queue')).status,expected);assert.equal((await req(c2,'GET','/api/queue')).status,expected);
   admin=await login('admin','admin1234');
   assert.equal((await req(admin,'PATCH','/api/users/'+id,body)).status,200);
   assert.equal((await req(c1,'GET','/api/queue')).status,401);
   if(change==='active'){await req(admin,'PATCH','/api/users/'+id,{active:true});assert.equal((await req(c2,'GET','/api/queue')).status,401);}
   const fresh=await login(username,change==='password'?'Synthetic-new-123':'Synthetic-old-123');
   if(change!=='active'){assert.equal((await req(admin,'PATCH','/api/users/'+id,body)).data.sessions_revoked,false);assert.equal((await req(fresh,'GET','/api/queue')).status,200);}
   check(change+' '+phase+': real crash, restart, old cookies revoked, retry safe');
  }
  const result=await req(admin,'PATCH','/api/users/'+adminId,{password:'Synthetic-admin-456'});assert.equal(result.status,200);assert.equal(result.data.reauthenticate,true);assert.equal((await req(admin,'GET','/api/me')).status,401);admin=await login('admin','Synthetic-admin-456');assert.equal((await req(admin,'GET','/api/me')).data.setup_required,false);check('self reset returns reauthentication and new password works');
  await req(admin,'PATCH','/api/users/'+doctor.id,{active:false});assert.equal((await req(d1,'GET','/api/queue')).status,401);assert.equal((await req(d2,'GET','/api/queue')).status,401);check('two active stations lose disabled account access');
  console.log('AUTH HTTP TOTAL: '+passed);
 }finally{await stop();}
};
