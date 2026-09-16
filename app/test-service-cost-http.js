'use strict';
// Only called by npm run test:http; synthetic instance, no external URL accepted.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
module.exports=async function(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-service-http-')),token=crypto.randomBytes(24).toString('hex'),port=33000+crypto.randomInt(7000),base='http://127.0.0.1:'+port;
 const env={...process.env,CLINIC_DATA_DIR:dir,CLINIC_PORT:String(port),CLINIC_HTTPS_PORT:'0',CLINIC_TEST_INSTANCE_TOKEN:token};let server,passed=0;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function start(){server=spawn(process.execPath,['--no-warnings','server.js'],{cwd:__dirname,env,stdio:'ignore',windowsHide:true});for(let i=0;i<100;i++){try{if((await fetch(base+'/api/test-instance',{headers:{'X-Clinic-Test-Token':token}})).status===200)return;}catch{}await sleep(50);}throw Error('service test start timeout');}
 async function stop(){if(server?.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}}
 async function req(cookie,method,url,body,crash){try{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(crash?{'X-Clinic-Test-Token':token,'X-Clinic-Test-Crash':crash}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}catch(e){if(crash)return {status:0};throw e;}}
 const login=async(name,password)=>{const r=await req(null,'POST','/api/login',{username:name,password});assert.equal(r.status,200);return r.cookie;};
 const check=name=>{passed++;console.log('SERVICE HTTP PASS: '+name);};
 try{
  const seed=spawnSync(process.execPath,['--no-warnings','seed.js','--demo'],{cwd:__dirname,env,encoding:'utf8',windowsHide:true});assert.equal(seed.status,0,seed.stderr);await start();
  let front=await login('front','front123');const doctor=await login('doctor','doctor123');
  assert.equal((await req(doctor,'POST','/api/services',{name:'forbidden',price:300,cost:120})).status,403);check('doctor cannot change service costs');
  for(const phase of ['before-commit','after-commit'])for(const edit of [false,true]){
   const name='synthetic-'+phase+'-'+edit,op_id=crypto.randomUUID();
   const id=edit?(await req(front,'POST','/api/services',{name,price:300,cost:100})).data.id:null;
   const body={name,price:300,cost:120,op_id},method=edit?'PATCH':'POST',url='/api/services'+(edit?'/'+id:'');
   assert.equal((await req(front,method,url,body,phase)).status,0);
   for(let i=0;i<100&&server.exitCode===null;i++)await sleep(20);assert.notEqual(server.exitCode,null);await start();front=await login('front','front123');
   const before=(await req(front,'GET','/api/services')).data.filter(s=>s.name===name);
   assert.equal(before.length,edit||phase==='after-commit'?1:0);if(before.length)assert.equal(before[0].cost,phase==='after-commit'?120:100);
   const a=await req(front,method,url,body),b=await req(front,method,url,body);assert.equal(a.status,edit?200:201);assert.deepEqual(a.data,b.data);
   const rows=(await req(front,'GET','/api/services')).data.filter(s=>s.name===name);assert.equal(rows.length,1);assert.equal(rows[0].cost,120);
   const conflict=await req(front,method,url,{...body,cost:999});assert.equal(conflict.status,409);assert.equal(conflict.data.saved_service.id,a.data.id);
   assert.equal((await req(front,'GET','/api/services')).data.find(s=>s.id===a.data.id).cost,120);
   check((edit?'edit':'create')+' '+phase+': real crash/restart/exactly once/changed retry returns saved result');
  }
  assert.equal((await req(front,'POST','/api/services',{name:'invalid',price:300,cost:-1})).status,400);check('invalid cost rejected');
  const zero=await req(front,'POST','/api/services',{name:'zero',price:300,cost:0}),unknown=await req(front,'POST','/api/services',{name:'unknown',price:300,cost:''});
  const list=(await req(front,'GET','/api/services')).data;assert.equal(list.find(s=>s.id===zero.data.id).cost,0);assert.equal(list.find(s=>s.id===unknown.data.id).cost,null);check('zero and blank remain distinct');
  const op=crypto.randomUUID();await req(front,'PATCH','/api/services/'+zero.data.id,{cost:80,op_id:op});assert.equal((await req(front,'PATCH','/api/services/'+unknown.data.id,{cost:80,op_id:op})).status,409);check('operation scoped to service ID');
  console.log('SERVICE HTTP TOTAL: '+passed);
 }finally{await stop();try{fs.rmSync(dir,{recursive:true,force:true});}catch{}}
};
