'use strict';
// Run only under npm run test:http: real Windows runtime swap, synthetic clinic, random port.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process'),runtime=require('./lib/runtime'),maintenance=require('./scripts/runtime-maintenance');
module.exports=async function(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clinic runtime ทดสอบ (LTS)-')),app=path.join(root,'app'),port=41000+crypto.randomInt(6000),base='http://127.0.0.1:'+port,token=crypto.randomBytes(24).toString('hex');
 const old=process.env.CLINIC_TEST_OLD_RUNTIME;if(!old||!fs.existsSync(old))throw Error('Set CLINIC_TEST_OLD_RUNTIME to the previous Node executable for runtime rehearsal');
 const oldHash=crypto.createHash('sha256').update(fs.readFileSync(old)).digest('hex');assert.notEqual(oldHash,runtime.SHA256);
 const original={...process.env};let server,passed=0;
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 fs.mkdirSync(app);fs.mkdirSync(path.join(root,'runtime'));fs.mkdirSync(path.join(root,'update'));fs.writeFileSync(path.join(root,'update','installed.marker'),'synthetic');fs.writeFileSync(path.join(root,'synthetic-runtime.marker'),'synthetic');
 for(const relative of require('./tools/build-update-package').collectReleasePaths(__dirname,'trial')){const dest=path.join(app,relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(__dirname,relative),dest);}
 fs.copyFileSync(old,path.join(root,'runtime','node.exe'));
 const lan=Object.values(os.networkInterfaces()).flat().find(a=>a.family==='IPv4'&&!a.internal&&!a.address.startsWith('169.254.'));assert(lan);
 const certDir=path.join(root,'cert');require('./lib/cert').generateCert({outDir:certDir,ips:['127.0.0.1',lan.address],name:'ClinicRuntimeSynthetic',years:1});
 Object.assign(process.env,{CLINIC_DATA_DIR:path.join(app,'data'),CLINIC_PORT:String(port),CLINIC_HTTPS_PORT:String(port+1),CLINIC_CERT_DIR:certDir,CLINIC_TEST_INSTANCE_TOKEN:token,CLINIC_RUNTIME_TEST:'1',CLINIC_SUPERVISOR_TEST:'1',CLINIC_UPDATE_PORT_ATTEMPTS:'2',CLINIC_UPDATE_TEST:'1'});
 async function ready(){for(let i=0;i<120;i++){try{if((await fetch(base+'/api/test-instance',{headers:{'X-Clinic-Test-Token':token}})).status===200)return;}catch{}await pause(50);}throw Error('Runtime fixture failed to open');}
 async function stop(){await require('./update-assistant').stopClinic(app,port);await require('./update-assistant').ensurePortFree(port);await pause(250);}
 async function start(){server=spawn(path.join(root,'runtime','node.exe'),['--no-warnings','launch/supervisor.js'],{cwd:app,env:process.env,stdio:'ignore',windowsHide:true});await ready();}
 async function auth(){const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin1234'})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
 async function state(){const cookie=await auth();return (await fetch(base+'/api/admin/runtime-status',{headers:{Cookie:cookie}})).json();}
 const check=name=>{passed++;console.log('RUNTIME HTTP PASS: '+name);};
 try{
  const seed=spawnSync(path.join(root,'runtime','node.exe'),['--no-warnings','seed.js','--demo'],{cwd:app,env:process.env,encoding:'utf8',windowsHide:true});assert.equal(seed.status,0,seed.stderr);await start();
  assert.equal((await state()).needed,true);check('old Node shown as needing maintenance');
  assert.throws(()=>maintenance.checkRoot(__dirname,true));check('package / non-test root refused');
  fs.writeFileSync(path.join(root,'runtime-test.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CLINIC_RUNTIME_TEST_PS%" -TestMode\r\nexit /b %errorlevel%\r\n','ascii');
  const elevated=spawnSync('cmd.exe',['/d','/c','runtime-test.cmd'],{cwd:root,env:{...process.env,CLINIC_RUNTIME_TEST_PS:path.join(app,'scripts','runtime-elevated.ps1'),CLINIC_RUNTIME_EXE:runtime.pinned(app),CLINIC_RUNTIME_SHA:runtime.SHA256},encoding:'utf8',windowsHide:true});assert.equal(elevated.status,0,elevated.stderr);assert(elevated.stdout.includes('v'+runtime.VERSION));check('cmd to PowerShell on Thai spaced parenthesized path runs pinned Node headlessly and logs');
  await assert.rejects(()=>maintenance.run(root,port,{testMode:true,failAt:'before-swap'}));await ready();assert.equal((await state()).needed,true);check('failure before swap keeps old executable and restarts clinic');
  await assert.rejects(()=>maintenance.run(root,port,{testMode:true,failAt:'after-swap'}));await ready();assert.equal((await state()).needed,true);check('failure after swap rolls back executable and preserves DB');
  const result=await maintenance.run(root,port,{testMode:true});assert(result.changed);await ready();const s=await state();assert.equal(s.current,runtime.VERSION);assert.equal(s.needed,false);assert.equal(s.outcome.state,'complete');check('actual old to LTS swap and database health verified');
  const lanStatus=await new Promise((resolve,reject)=>require('node:https').get('https://'+lan.address+':'+(port+1)+'/api/recovery/ready',{rejectUnauthorized:false},r=>{r.resume();resolve(r.statusCode);}).on('error',reject));assert.equal(lanStatus,200);check('same executable path and server reachable over HTTPS LAN after runtime upgrade');
  await stop();fs.copyFileSync(old,path.join(root,'runtime','node.exe'));await start();
  const crash=spawnSync(runtime.pinned(app),['--no-warnings','-e',"require(process.env.SYNTH_HELPER).run(process.env.SYNTH_ROOT,Number(process.env.CLINIC_PORT),{testMode:true}).catch(()=>process.exit(2))"],{cwd:app,env:{...process.env,SYNTH_HELPER:path.join(app,'scripts','runtime-maintenance.js'),SYNTH_ROOT:root,CLINIC_RUNTIME_KILL_AT:'after-swap'},encoding:'utf8',windowsHide:true});
  assert.equal(crash.status,87,crash.stderr);runtime.verify(path.join(root,'runtime','node.exe'));
  const repeat=await maintenance.run(root,port,{testMode:true});assert.equal(repeat.changed,false);await ready();assert.equal((await state()).needed,false);check('actual helper death after atomic swap: stale lock recovered, retry restarts without another swap');
  console.log('RUNTIME HTTP TOTAL: '+passed);
 }finally{try{await stop();}catch{}if(server?.exitCode===null)server.kill();for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);}
};
