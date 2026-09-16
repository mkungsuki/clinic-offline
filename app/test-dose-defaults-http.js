'use strict';
// Invoked only by the isolated npm run test:http harness.
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict'),{spawn,spawnSync}=require('child_process');
module.exports=async function(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-dose-http-')),token=crypto.randomBytes(24).toString('hex'),port=33000+crypto.randomInt(7000),base='http://127.0.0.1:'+port;
 const env={...process.env,CLINIC_DATA_DIR:dir,CLINIC_PORT:String(port),CLINIC_HTTPS_PORT:'0',CLINIC_TEST_INSTANCE_TOKEN:token};let server,count=0;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function start(){server=spawn(process.execPath,['--no-warnings','server.js'],{cwd:__dirname,env,stdio:'ignore',windowsHide:true});for(let i=0;i<100;i++){try{if((await fetch(base+'/api/test-instance',{headers:{'X-Clinic-Test-Token':token}})).status===200)return;}catch{}await sleep(50);}throw Error('dose test startup failed');}
 async function req(cookie,method,url,body,crash){try{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(crash?{'X-Clinic-Test-Token':token,'X-Clinic-Test-Crash':crash}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}catch(e){if(crash)return {status:0};throw e;}}
 const login=async(u,p)=>{const r=await req(null,'POST','/api/login',{username:u,password:p});assert.equal(r.status,200);return r.cookie;};
 const check=n=>{count++;console.log('DOSE HTTP PASS: '+n);};
 const template={mode:'standard',m:0.5,n:0,e:0,b:0,days:7,timing:'',times:[],additional_instructions:'คำแนะนำสังเคราะห์'};
 try{
  assert.equal(spawnSync(process.execPath,['--no-warnings','seed.js','--demo'],{cwd:__dirname,env,stdio:'ignore',windowsHide:true}).status,0);await start();let front=await login('front','front123');const doctor=await login('doctor','doctor123');
  assert.equal((await req(doctor,'POST','/api/drugs',{name:'forbidden',unit:'เม็ด',default_dose:template})).status,403);check('ordinary doctor cannot edit drug master');
  for(const phase of ['before-commit','after-commit'])for(const edit of [false,true]){
   const name='synthetic-dose-'+phase+'-'+edit,body={name,unit:'เม็ด',price:10,cost:2,default_dose:template,op_id:crypto.randomUUID()};
   const id=edit?(await req(front,'POST','/api/drugs',{...body,default_dose:{...template,m:2},op_id:crypto.randomUUID()})).data.id:null;
   const method=edit?'PATCH':'POST',url='/api/drugs'+(edit?'/'+id:'');assert.equal((await req(front,method,url,body,phase)).status,0);
   for(let i=0;i<100&&server.exitCode===null;i++)await sleep(20);assert.notEqual(server.exitCode,null);await start();front=await login('front','front123');
   const before=(await req(front,'GET','/api/drugs')).data.filter(x=>x.name===name);assert.equal(before.length,edit||phase==='after-commit'?1:0);
   if(before.length)assert.equal(JSON.parse(before[0].default_dose_json).m,phase==='after-commit'?0.5:2);
   const a=await req(front,method,url,body),b=await req(front,method,url,body);assert.equal(a.status,edit?200:201);assert.deepEqual(a.data,b.data);
   const rows=(await req(front,'GET','/api/drugs')).data.filter(x=>x.name===name);assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0].default_dose_json).m,0.5);
   const conflict=await req(front,method,url,{...body,default_dose:{...template,m:9}});assert.equal(conflict.status,409);assert.equal(conflict.data.saved_drug.id,a.data.id);check((edit?'edit':'create')+' '+phase+' crash/retry commits once with original numeric template');
  }
  for(const m of ['1/2',-1,true])assert.equal((await req(front,'POST','/api/drugs',{name:'invalid',unit:'เม็ด',default_dose:{...template,m}})).status,400);check('invalid numeric templates rejected by server');
  const legacy=await req(front,'POST','/api/drugs',{name:'legacy-prose',unit:'เม็ด',default_instructions:'ครั้งละ 1/2 เม็ด วันละ 1 ครั้ง'});assert.equal(legacy.status,201);const found=(await req(front,'GET','/api/items/search?q=legacy-prose')).data[0];assert.equal(found.default_dose_json,null);assert.equal(found.default_instructions,'ครั้งละ 1/2 เม็ด วันละ 1 ครั้ง');check('legacy text roundtrips without numeric inference');
  console.log('DOSE HTTP TOTAL: '+count);
 }finally{if(server?.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}}
};
