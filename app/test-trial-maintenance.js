'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawnSync,spawn}=require('node:child_process');
let passed=0;
const check=(name,fn)=>{fn();passed++;console.log('TRIAL TOOLS PASS: '+name);};
const roots=[];
function fixture(action='uninstall',real=false){
 const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'clinic trial tools ภาษาไทย (ทดสอบ)-'));roots.push(sandbox);
 fs.writeFileSync(path.join(sandbox,'trial-tools-test.marker'),'synthetic-trial-tools-only');
 const root=path.join(sandbox,'ชุดทดลอง'),id=crypto.randomUUID(),dir=path.join(sandbox,'เครื่องมือ',id),app=path.join(root,'app');
 for(const p of [dir,path.join(root,'update'),path.join(root,'runtime'),path.join(app,'data'),path.join(sandbox,'Desktop'),path.join(sandbox,'Startup')])fs.mkdirSync(p,{recursive:true});
 fs.writeFileSync(path.join(root,'update/installed.marker'),'synthetic');
 fs.writeFileSync(path.join(root,'update/install-profile.json'),JSON.stringify({product:'clinic-offline',variant:'trial'}));
 fs.writeFileSync(path.join(app,'data/training.txt'),'synthetic training');
 for(const name of ['trial-maintenance.ps1','windows-shortcuts.ps1'])fs.copyFileSync(path.join(__dirname,'scripts',name),path.join(dir,name));
 fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({root,action,id}));
 fs.writeFileSync(path.join(dir,'run.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CLINIC_TRIAL_PS%" -TestMode\r\nexit /b %errorlevel%\r\n','ascii');
 if(real){for(const p of require('./tools/build-update-package').collectReleasePaths(__dirname,'trial').filter(p=>!p.startsWith('vendor/'))){fs.mkdirSync(path.dirname(path.join(app,p)),{recursive:true});fs.copyFileSync(path.join(__dirname,p),path.join(app,p));}fs.copyFileSync(process.execPath,path.join(root,'runtime/node.exe'));}
 const env={...process.env,CLINIC_INSTALL_TEST:'1',CLINIC_TEST_INSTANCE_TOKEN:'synthetic-tools',CLINIC_TRIAL_TOOLS_TEST_ROOT:sandbox,CLINIC_TRIAL_TOOLS_CONFIRM:'yes',CLINIC_TRIAL_PS:path.join(dir,'trial-maintenance.ps1')};
 const run=(extra={})=>spawnSync('cmd.exe',['/d','/c','run.cmd'],{cwd:dir,env:{...env,...extra},encoding:'utf8',windowsHide:true,timeout:90000});
 return {root,app,sandbox,id,dir,env,run,state:()=>JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'))};
}
async function main(){try{
 check('cloud placeholders are not junctions; shortcut classifier fails closed',()=>{
  const script=path.join(__dirname,'scripts/windows-shortcuts.ps1');
  const r=spawnSync('powershell.exe',['-NoProfile','-Command',`. $env:CLINIC_TAG_SCRIPT; foreach($tag in @(0x9000001AL,0x9000101AL,0x9000F01AL)){if(-not [ClinicCloudTag]::Allowed($tag)){exit 1}}; foreach($tag in @(0xA0000003L,0xA000000CL,0x8000001BL,0)){if([ClinicCloudTag]::Allowed($tag)){exit 2}}`],{env:{...process.env,CLINIC_TAG_SCRIPT:script},encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);
 });
 check('folder uninstaller runs through cmd on Thai path and deletes itself cleanly',()=>{
  const f=fixture();fs.mkdirSync(path.join(f.app,'scripts'),{recursive:true});
  for(const name of ['trial-uninstall.ps1','trial-maintenance.ps1','windows-shortcuts.ps1'])fs.copyFileSync(path.join(__dirname,'scripts',name),path.join(f.app,'scripts',name));
  const entry=require('./lib/trial-uninstall-entry');entry.ensure(f.root);
  const bytes=fs.readFileSync(path.join(f.root,entry.filename),'utf8');assert(!/(?<!\r)\n/.test(bytes));
  const r=spawnSync('cmd.exe',['/d','/c','call "%CLINIC_ENTRY%"'],{windowsVerbatimArguments:true,cwd:f.root,env:{...f.env,CLINIC_ENTRY:path.join(f.root,entry.filename)},encoding:'utf8',windowsHide:true,timeout:90000});
  assert.equal(r.status,0,r.stdout+r.stderr);assert(!fs.existsSync(f.root));assert(!fs.readdirSync(f.sandbox).some(n=>n.startsWith('clinic-trial-removing-')));
 });
 check('standalone uninstaller resumes renamed folder with original operation',()=>{
  const f=fixture();assert.notEqual(f.run({CLINIC_TRIAL_TOOLS_FAIL:'after-rename'}).status,0);
  const source=path.join(f.sandbox,'ตัวถอน แยก'),scripts=path.join(source,'app/scripts');fs.mkdirSync(scripts,{recursive:true});
  for(const name of ['trial-uninstall.ps1','trial-maintenance.ps1','windows-shortcuts.ps1'])fs.copyFileSync(path.join(__dirname,'scripts',name),path.join(scripts,name));
  const entry=require('./lib/trial-uninstall-entry');fs.writeFileSync(path.join(source,entry.filename),entry.content());
  const r=spawnSync('cmd.exe',['/d','/c','call "%CLINIC_ENTRY%"'],{windowsVerbatimArguments:true,cwd:source,env:{...f.env,CLINIC_ENTRY:path.join(source,entry.filename)},encoding:'utf8',windowsHide:true,timeout:90000});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(f.state().phase,'complete');assert(!fs.existsSync(path.join(f.sandbox,'clinic-trial-removing-'+f.id)));assert(fs.existsSync(source));
 });
 check('upgraded trial gets root command; production and package do not',()=>{
  const f=fixture(),entry=require('./lib/trial-uninstall-entry');entry.ensure(f.root);assert(fs.existsSync(path.join(f.root,entry.filename)));fs.unlinkSync(path.join(f.root,entry.filename));
  fs.writeFileSync(path.join(f.root,'update/install-profile.json'),JSON.stringify({product:'clinic-offline',variant:'production'}));entry.ensure(f.root);assert(!fs.existsSync(path.join(f.root,entry.filename)));
  fs.unlinkSync(path.join(f.root,'update/installed.marker'));entry.ensure(f.root);assert(!fs.existsSync(path.join(f.root,entry.filename)));
 });
 check('package uninstaller refuses when no installed trial exists',()=>{
  const f=fixture(),entry=require('./lib/trial-uninstall-entry');fs.unlinkSync(path.join(f.root,'update/installed.marker'));fs.mkdirSync(path.join(f.app,'scripts'),{recursive:true});
  for(const name of ['trial-uninstall.ps1','trial-maintenance.ps1','windows-shortcuts.ps1'])fs.copyFileSync(path.join(__dirname,'scripts',name),path.join(f.app,'scripts',name));
  fs.writeFileSync(path.join(f.root,entry.filename),entry.content());
  const r=spawnSync('cmd.exe',['/d','/c','call "%CLINIC_ENTRY%"'],{windowsVerbatimArguments:true,cwd:f.root,env:{...f.env,CLINIC_ENTRY:path.join(f.root,entry.filename)},encoding:'utf8',windowsHide:true,timeout:90000});assert.notEqual(r.status,0);assert(fs.existsSync(path.join(f.app,'data/training.txt')));
 });
 check('cancel keeps program and training; replay stays cancelled',()=>{const f=fixture(),r=f.run({CLINIC_TRIAL_TOOLS_CONFIRM:'no'});assert.equal(r.status,2,r.stdout+r.stderr);assert(fs.existsSync(path.join(f.app,'data/training.txt')));assert.equal(f.run().status,2);});
 for(const kind of ['production','marker','junction'])check('refuse '+kind+' without deleting synthetic data',()=>{const f=fixture();if(kind==='production')fs.writeFileSync(path.join(f.root,'update/install-profile.json'),'{}');if(kind==='marker')fs.unlinkSync(path.join(f.root,'update/installed.marker'));if(kind==='junction'){const outside=path.join(f.sandbox,'unrelated');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep.txt'),'keep');fs.symlinkSync(outside,path.join(f.app,'data/link'),'junction');}assert.notEqual(f.run().status,0);assert(fs.existsSync(path.join(f.app,'data/training.txt')));});
 check('uninstall deletes verified trial only; replay does not touch a new installation',()=>{const f=fixture();fs.mkdirSync(path.join(f.sandbox,'production'));fs.writeFileSync(path.join(f.sandbox,'production/keep.txt'),'keep');const r=f.run();assert.equal(r.status,0,r.stdout+r.stderr);assert(!fs.existsSync(f.root));assert(fs.existsSync(path.join(f.sandbox,'production/keep.txt')));fs.mkdirSync(f.root);fs.writeFileSync(path.join(f.root,'new-install.txt'),'keep');assert.equal(f.run().status,0);assert(fs.existsSync(path.join(f.root,'new-install.txt')));});
 for(const phase of ['after-rename','after-delete'])check('uninstall resumes '+phase+' with same operation',()=>{const f=fixture();const r=f.run({CLINIC_TRIAL_TOOLS_FAIL:phase});assert.notEqual(r.status,0,r.stdout);assert.equal(f.run().status,0);assert.equal(f.state().phase,'complete');assert(!fs.existsSync(f.root));});
 check('retry in same helper resumes after rename without a new operation',()=>{const f=fixture();const r=f.run({CLINIC_TRIAL_TOOLS_FAIL:'after-rename',CLINIC_TRIAL_TOOLS_RETRY_ONCE:'1'});assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(f.state().phase,'complete');assert(!fs.existsSync(f.root));});
 for(const phase of ['prepared','after-retire','after-swap','after-delete'])check('reset survives '+phase+' and repeated command cannot reset new work',()=>{
  const f=fixture('reset',true),r=f.run({CLINIC_TRIAL_TOOLS_KILL:phase});assert.notEqual(r.status,0,r.stdout+r.stderr);
  if(phase!=='prepared'){
   const before=fs.existsSync(path.join(f.app,'data/clinic.db'));
   const stopped=spawnSync(path.join(f.root,'runtime/node.exe'),['--no-warnings','server.js'],{cwd:f.app,env:f.env,encoding:'utf8',windowsHide:true,timeout:8000});assert.equal(stopped.status,12,stopped.stderr);assert.equal(fs.existsSync(path.join(f.app,'data/clinic.db')),before);
  }
  const retry=f.run();assert.equal(retry.status,0,retry.stdout+retry.stderr);assert.equal(f.state().phase,'complete');assert(!fs.existsSync(path.join(f.app,'data/training.txt')));
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(f.app,'data/clinic.db'),{readOnly:true});assert(db.prepare('SELECT COUNT(*) n FROM patients').get().n>0);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
  fs.writeFileSync(path.join(f.app,'data/new-work.txt'),'synthetic');assert.equal(f.run().status,0);assert(fs.existsSync(path.join(f.app,'data/new-work.txt')));assert(!fs.existsSync(path.join(f.root,'update/trial-maintenance-pending.json')));
 });
 check('in-progress updater prevents either action',()=>{const f=fixture();fs.writeFileSync(path.join(f.root,'update/apply.lock'),JSON.stringify({pid:process.pid}));assert.notEqual(f.run().status,0);assert(fs.existsSync(path.join(f.app,'data/training.txt')));});
 check('test switch without token cannot act',()=>{const f=fixture();assert.notEqual(f.run({CLINIC_TEST_INSTANCE_TOKEN:''}).status,0);assert(fs.existsSync(f.root));});
 const f=fixture('uninstall',true),owned=spawn(path.join(f.root,'runtime/node.exe'),['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}),other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 try{await new Promise(r=>setTimeout(r,350));const result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);await new Promise(r=>setTimeout(r,150));assert(owned.exitCode!==null||owned.signalCode!==null);assert.equal(other.exitCode,null);passed++;console.log('TRIAL TOOLS PASS: stops owned runtime only');}finally{owned.kill();other.kill();}
 console.log('TRIAL TOOLS TOTAL: '+passed);
 return passed;
}finally{for(const p of roots){assert(path.resolve(p).startsWith(path.join(os.tmpdir(),'clinic trial tools ')));fs.rmSync(p,{recursive:true,force:true});}}}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports=main;
