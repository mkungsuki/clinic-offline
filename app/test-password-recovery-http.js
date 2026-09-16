'use strict';
// Invoked only by npm run test:http. Every server/assistant uses synthetic temp data.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process');
module.exports=async function(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clinic password http ไทย -')),data=path.join(root,'old/data'),fresh=path.join(root,'new/data'),cloud=path.join(root,'cloud'),token=crypto.randomUUID();
 const port=22000+crypto.randomInt(8000),newPort=40000+crypto.randomInt(6000),base='http://127.0.0.1:'+port,newBase='http://127.0.0.1:'+newPort;
 const env={...process.env,CLINIC_DATA_DIR:data,CLINIC_PORT:String(port),CLINIC_HTTPS_PORT:'0',CLINIC_TEST_INSTANCE_TOKEN:token};
 const nextEnv={...env,CLINIC_DATA_DIR:fresh,CLINIC_PORT:String(newPort)};
 const password='synthetic password recovery 123';let server,assistant,assistantBase,assistantToken,count=0;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),check=n=>{count++;console.log('PASSWORD HTTP PASS: '+n)};
 async function req(origin,cookie,method,url,body,crash){try{const r=await fetch(origin+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(origin===assistantBase?{'X-Recovery-Token':assistantToken}:{}),...(crash?{'X-Clinic-Test-Token':token,'X-Clinic-Test-Crash':crash}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}}catch(e){if(crash)return{status:0};throw e}}
 async function ready(origin){for(let i=0;i<200;i++){try{if((await fetch(origin+'/api/test-instance',{headers:{'X-Clinic-Test-Token':token}})).status===200)return}catch{}await sleep(50)}throw Error('password fixture startup failed')}
 async function start(){server=spawn(process.execPath,['--no-warnings','server.js'],{cwd:__dirname,env,stdio:'ignore',windowsHide:true});await ready(base)}
 async function exited(child){for(let i=0;i<200&&child.exitCode===null&&child.signalCode===null;i++)await sleep(20);assert(child.exitCode!==null||child.signalCode!==null,'child still running')}
 async function login(origin,who='admin'){const r=await req(origin,null,'POST','/api/login',{username:who,password:who==='admin'?'admin1234':'front123'});assert.equal(r.status,200);return r.cookie}
 async function helper(){
  let output='';assistant=spawn(process.execPath,['--no-warnings','recovery-assistant.js'],{cwd:__dirname,env:nextEnv,stdio:['ignore','pipe','pipe'],windowsHide:true});assistant.stdout.on('data',b=>{output+=b.toString()});
  for(let i=0;i<200&&!/http:\/\/127\.0\.0\.1:\d+/.test(output);i++)await sleep(50);
  assistantBase=output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert(assistantBase,'assistant URL missing');
  const html=await(await fetch(assistantBase)).text();assistantToken=html.match(/const TOKEN='([^']+)'/)[1];
 }
 try{
  fs.mkdirSync(cloud,{recursive:true});assert.equal(spawnSync(process.execPath,['--no-warnings','seed.js','--demo'],{cwd:__dirname,env,stdio:'ignore',windowsHide:true}).status,0);await start();let admin=await login(base);const front=await login(base,'front');
  await req(base,admin,'POST','/api/settings',{backup_cloud_dest:cloud});assert.equal((await req(base,front,'POST','/api/recovery/password',{})).status,403);check('only signed-in admin may set recovery password');
  const body={password,confirmation:password,pin:'9999',op_id:crypto.randomUUID(),expected_id:''};
  assert.equal((await req(base,admin,'POST','/api/recovery/password',{...body,pin:'wrong'})).status,401);assert(!fs.existsSync(path.join(data,'recovery-password.json')));check('admin PIN checked before wrapping');
  assert.equal((await req(base,admin,'POST','/api/recovery/password',body,'after-password-save')).status,0);await exited(server);await start();admin=await login(base);
  const id=(await req(base,admin,'GET','/api/recovery/health')).data.password.id;assert.equal(id,body.op_id);
  const saved=await req(base,admin,'POST','/api/recovery/password',body);assert.equal(saved.status,200);assert.equal(saved.data.password.changed,false);assert(saved.data.backup.targets.find(x=>x.kind==='cloud_sync')?.passwordCopy);assert(!JSON.stringify(saved.data).includes(password));check('crash after password commit; replay copies same envelope without changing password');
  assert.equal((await req(base,admin,'POST','/api/recovery/drill',{method:'password',password:'wrong synthetic pass'})).status,400);
  const moved=path.join(cloud,'saved-envelope.tmp');fs.renameSync(path.join(cloud,'clinic-recovery.wrapped.json'),moved);
  assert.equal((await req(base,admin,'POST','/api/recovery/drill',{method:'password',password})).status,400);fs.renameSync(moved,path.join(cloud,'clinic-recovery.wrapped.json'));check('password drill rejects wrong/missing envelope despite local key present');
  assert.equal((await req(base,admin,'POST','/api/recovery/drill',{method:'password',password},'after-password-drill')).status,0);await exited(server);await start();admin=await login(base);
  const health=(await req(base,admin,'GET','/api/recovery/health')).data;assert.equal(health.drillMethod,'password');assert(health.drillFresh);assert.equal((await req(base,admin,'POST','/api/recovery/drill',{method:'password',password})).status,200);check('drill durable result survives lost reply and safe retry');
  assert(!fs.existsSync(path.join(fresh,'cloud-backup.key')));assert(!fs.existsSync(path.join(fresh,'clinic.db')));await helper();
  assert.equal((await req(assistantBase,null,'POST','/api/source',{directory:cloud})).status,200);
  let state=(await req(assistantBase,null,'GET','/api/status')).data;assert.equal(state.kitAvailable,false);const source=state.sources.find(s=>s.technicianPath===cloud);assert(source.locked);assert.equal(source.points.length,0);
  assert.equal((await req(assistantBase,null,'POST','/api/unlock',{sourceId:source.id,password:'incorrect fixture pass'})).status,400);
  assert.equal((await req(assistantBase,null,'POST','/api/unlock',{sourceId:source.id,password})).status,200);state=(await req(assistantBase,null,'GET','/api/status')).data;const point=state.sources.find(s=>s.id===source.id).points[0];assert(point.encrypted);check('fresh assistant discovers locked cloud folder and opens it with password only, no Kit');
  const op_id=crypto.randomUUID(),restore={sourceId:source.id,manifestFile:point.id,challenge:state.challenge,op_id,testCrash:'after-complete',testToken:token};
  const restored=await req(assistantBase,null,'POST','/api/restore',restore,'after-complete');assert.equal(restored.status,0,restored.data?.error?.message);await exited(assistant);await ready(newBase);
  const newerAdmin=await login(newBase);await req(newBase,newerAdmin,'POST','/api/settings',{clinic_name:'synthetic work after restore'});
  await helper();const replay=await req(assistantBase,null,'POST','/api/restore',{op_id});assert.equal(replay.status,200);assert.equal((await req(newBase,newerAdmin,'GET','/api/settings')).data.clinic_name,'synthetic work after restore');check('actual restore starts clean machine; lost final reply replay never overwrites subsequent work');
  await req(assistantBase,null,'POST','/api/source',{directory:cloud});state=(await req(assistantBase,null,'GET','/api/status')).data;
  const latestSource=state.sources.find(s=>s.technicianPath===cloud);await req(assistantBase,null,'POST','/api/unlock',{sourceId:latestSource.id,password});state=(await req(assistantBase,null,'GET','/api/status')).data;
  const publishedId=crypto.randomUUID(),publishedPoint=state.sources.find(s=>s.id===latestSource.id).points[0];
  const published=await req(assistantBase,null,'POST','/api/restore',{op_id:publishedId,sourceId:latestSource.id,manifestFile:publishedPoint.id,challenge:state.challenge,testCrash:'after-publish',testToken:token},'after-publish');
  assert.equal(published.status,0,published.data?.error?.message);await exited(assistant);await helper();assert.equal((await req(assistantBase,null,'GET','/api/status')).data.lastOperation.state,'published');
  const movedCloud=path.join(root,'source-temporarily-unavailable');fs.renameSync(cloud,movedCloud);
  const resumed=await req(assistantBase,null,'POST','/api/restore',{op_id:publishedId});assert.equal(resumed.status,200);assert.match(resumed.data.sourceWarning,/หยุดใช้เครื่องเก่า/);await ready(newBase);
  assert.equal((await req(assistantBase,null,'GET','/api/status')).data.lastOperation.result.sourceWarning,resumed.data.sourceWarning);fs.renameSync(movedCloud,cloud);
  check('crash after publish resumes startup without republish; unavailable source leaves durable warning and usable clinic');
  assert.equal((await req(newBase,newerAdmin,'GET','/api/recovery/health')).data.password.ready,true);
  const oldBackup=await req(base,admin,'POST','/api/backup/run',{});assert.equal(oldBackup.data.ok,0);assert.match(oldBackup.data.targets.find(t=>t.kind==='cloud_sync').error,/เครื่องที่กู้ข้อมูลแล้ว/);check('restored key/envelope usable; old machine cannot overwrite claimed destination');
  const beforeRollbackAdmin=await login(newBase);await req(newBase,beforeRollbackAdmin,'POST','/api/settings',{clinic_name:'synthetic original before failed restore'});
  const ownerCount=fs.readdirSync(cloud).filter(n=>n.startsWith('clinic-owner-')).length;
  await req(assistantBase,null,'POST','/api/source',{directory:cloud});state=(await req(assistantBase,null,'GET','/api/status')).data;
  const rollbackSource=state.sources.find(s=>s.technicianPath===cloud);await req(assistantBase,null,'POST','/api/unlock',{sourceId:rollbackSource.id,password});state=(await req(assistantBase,null,'GET','/api/status')).data;
  const rollbackId=crypto.randomUUID(),rollbackPoint=state.sources.find(s=>s.id===rollbackSource.id).points[0];
  const failedStart=await req(assistantBase,null,'POST','/api/restore',{op_id:rollbackId,sourceId:rollbackSource.id,manifestFile:rollbackPoint.id,challenge:state.challenge,testFailStart:true,testCrash:'after-rollback',testToken:token},'after-rollback');
  assert.equal(failedStart.status,0);await exited(assistant);await helper();
  const rollbackRetry=await req(assistantBase,null,'POST','/api/restore',{op_id:rollbackId});assert.equal(rollbackRetry.status,400);assert.match(rollbackRetry.data.error.message,/ข้อมูลเดิมกลับแล้ว/);await ready(newBase);
  assert.equal((await req(assistantBase,null,'GET','/api/status')).data.lastOperation.state,'rolled-back');
  const originalAdmin=await login(newBase);assert.equal((await req(newBase,originalAdmin,'GET','/api/settings')).data.clinic_name,'synthetic original before failed restore');
  assert.equal(fs.readdirSync(cloud).filter(n=>n.startsWith('clinic-owner-')).length,ownerCount);
  check('startup failure rollback survives lost reply; retry reports original data, never claims failed recovery owner');
  console.log('PASSWORD HTTP TOTAL: '+count);
 }finally{
  if(assistant?.exitCode===null){assistant.kill();await exited(assistant)}
  if(server?.exitCode===null){server.kill();await exited(server)}
  try{const control=fs.readFileSync(path.join(fresh,'recovery-control.token'),'utf8').trim();await fetch(newBase+'/api/system/prepare-restore',{method:'POST',headers:{'X-Recovery-Control':control}});await sleep(1000)}catch{}
  fs.rmSync(root,{recursive:true,force:true});
 }
};
