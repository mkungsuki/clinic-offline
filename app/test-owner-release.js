'use strict';
// No real/synthetic signing here. The orchestration test stubs the signing and
// signature-verification boundary; test-updater covers actual Ed25519 separately.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const owner=require('./tools/owner-release.cjs'),zip=require('./lib/zip');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-owner-button-'));
const root=path.join(temp,'งานเจ้าของ มีช่องว่าง (ทดสอบ)'),app=path.join(root,'app');
const write=(p,b)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,b);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS owner release: '+name);}
try{
 write(path.join(app,'package.json'),JSON.stringify({version:'1.0.7'}));
 write(path.join(app,'lib/schema-version.js'),'exports.SCHEMA_VERSION=15;');
 write(path.join(app,'public/app.js'),'// synthetic release source');
 for(const file of ['owner-release.cjs','sign-release.ps1'])write(path.join(app,'tools',file),fs.readFileSync(path.join(__dirname,'tools',file)));
 const button=path.join(root,'เซ็นรุ่นใหม่.cmd');write(button,owner.launcherText());
 test('version/schema/URL are computed; invalid or stale-looking version syntax is refused',()=>{
  const plan=owner.preflight({root,testMode:true});assert.equal(plan.version,'1.0.7');assert.equal(plan.schema,15);
  assert.equal(plan.baseUrl,'https://github.com/mkungsuki/mk-artifacts/releases/download/v1.0.7');
  assert.deepEqual(owner.buildOptions(plan,'unused-selected-file',temp).map(x=>[x.variant,x.version,x.baseUrl]),['production','trial'].map(v=>[v,'1.0.7',plan.baseUrl]));
  for(const version of ['01.0.7','1.0','v1.0.7','1.0.7\n--other'])assert.throws(()=>owner.makePlan(version,15));
 });
 test('repeat attempts use distinct output folders and leave old files alone',()=>{
  const a=owner.uniqueOutput(root,'1.0.7'),b=owner.uniqueOutput(root,'1.0.7');assert.notEqual(a,b);
  write(path.join(a,'keep.txt'),'old prepared attempt');assert.equal(fs.readFileSync(path.join(a,'keep.txt'),'utf8'),'old prepared attempt');
  assert(a.startsWith(path.join(root,'dist/updates/v1.0.7')+path.sep));
 });
 test('test mode rejects sign before key lookup or output creation',()=>{
  assert.throws(()=>owner.prepare({root,keyFile:path.join(temp,'DOES-NOT-EXIST'),testMode:true}),e=>e.safeCode==='test');
  const run=spawnSync(process.execPath,[path.join(app,'tools/owner-release.cjs'),'--sign','--test-mode'],{encoding:'utf8',windowsHide:true,env:{...process.env,CLINIC_OWNER_SIGN_CONFIRM:'1',CLINIC_OWNER_KEY_FILE:path.join(temp,'DOES-NOT-EXIST')}});
  assert.equal(run.status,1);assert.equal(JSON.parse(run.stdout).code,'test');assert(!run.stdout.includes('DOES-NOT-EXIST'));assert.equal(run.stderr,'');
 });
 test('launcher is CRLF and PowerShell is BOM UTF8 with CRLF',()=>{
  const text=fs.readFileSync(button,'utf8');assert(!/(?<!\r)\n/.test(text));assert(text.includes('DisableDelayedExpansion'));
  const checkedIn=path.join(__dirname,'../เซ็นรุ่นใหม่.cmd');if(fs.existsSync(checkedIn))assert.equal(fs.readFileSync(checkedIn,'utf8'),text);
  const bytes=fs.readFileSync(path.join(app,'tools/sign-release.ps1'));assert(bytes.subarray(0,3).equals(Buffer.from([239,187,191])));assert(!/(?<!\r)\n/.test(bytes.toString('utf8')));
 });
 if(process.platform==='win32'){
  const runButton=(flags,envTest)=>{
   const report=path.join(temp,'result-'+crypto.randomUUID()+'.json');
   // Keep the UTF8 Thai path out of generated cmd source; inherit it via env.
   const runner=path.join(temp,'runner.cmd');write(runner,'@echo off\r\ncall "%CLINIC_BUTTON_TEST_ENTRY%" '+flags+'\r\nexit /b %errorlevel%\r\n');
   const env={...process.env,CLINIC_BUTTON_TEST_ENTRY:button,CLINIC_SIGN_TEST_REPORT:report,CLINIC_INSTALL_TEST:envTest?'1':'0',CLINIC_OWNER_KEY_FILE:path.join(temp,'MUST-NOT-READ'),CLINIC_OWNER_SIGN_CONFIRM:'1'};
   const result=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c',runner],{env,encoding:'utf8',windowsHide:true,timeout:60000});
   assert(!result.error,result.error?.message);assert(fs.existsSync(report),'headless result file missing');
   return {status:result.status,report:JSON.parse(fs.readFileSync(report,'utf8').replace(/^\uFEFF/,''))};
  };
  test('real cmd→PowerShell on Thai/space/parentheses path via env test mode',()=>{const r=runButton('',true);assert.equal(r.status,0);assert(r.report.ok);assert(r.report.message.includes('1.0.7'));});
  test('real cmd→PowerShell via -TestMode is headless and never signs',()=>{
   const r=runButton('-TestMode',false);assert.equal(r.status,0);assert(r.report.ok);
   const base=path.join(root,'dist/updates/v1.0.7');for(const dir of fs.readdirSync(base))assert(!fs.existsSync(path.join(base,dir,'พร้อมให้ผู้ดูแลตรวจ.json')));
  });
  test('invalid version displays a Thai headless failure; no false success',()=>{
   write(path.join(app,'package.json'),'{"version":"invalid"}');const r=runButton('',true);assert.equal(r.status,1);assert.equal(r.report.ok,false);assert(r.report.message.includes('เลขรุ่น'));write(path.join(app,'package.json'),'{"version":"1.0.7"}');
  });
  test('missing helper fails in headless result before selecting a key',()=>{
   const tool=path.join(app,'tools/owner-release.cjs');fs.renameSync(tool,tool+'.saved');try{const r=runButton('',true);assert.equal(r.status,1);assert.equal(r.report.ok,false);assert(r.report.message.includes('ยังไม่พบชุดเครื่องมือ'));}finally{fs.renameSync(tool+'.saved',tool);}
  });
 }
 // Exercise the real orchestration/ZIP/hash logic with a boundary stub that
 // never opens a key and never creates a cryptographic signature.
 const selected=path.join(temp,'selected-file-placeholder');write(selected,'not a key; never read');
 write(path.join(app,'update-public-key.pem'),'public verification placeholder');
 const files=['package.json','lib/schema-version.js','public/app.js'];
 let dirty=false,mode='ok',builds=0;
 const builder={collectReleasePaths:()=>files,buildUpdatePackage(options){
  builds++;if(mode==='builder-error')throw new Error('arbitrary sensitive-looking exception MUST-NOT-LEAK');
  const filename=`ClinicApp-${options.version}-${options.variant}-${options.channel}.zip`,zipfile=path.join(options.out,filename);
  const inventory=files.map(p=>{const b=fs.readFileSync(path.join(app,p));return {path:p,bytes:b.length,sha256:sha(b)};});
  zip.writeZip(zipfile,files.map(p=>({name:p,source:path.join(app,p)})));
  const bytes=fs.readFileSync(zipfile),manifest={version:options.version,variant:options.variant,expected_schema:15,package:{file:filename,url:options.baseUrl+'/'+filename,bytes:bytes.length,sha256:sha(bytes)},files:inventory};
  if(mode==='stale-url')manifest.package.url='https://example.invalid/old';
  const name='latest-'+options.variant+'-'+options.channel+'.json';write(path.join(options.out,name),JSON.stringify(manifest));write(path.join(options.out,name+'.sig'),'verification boundary stub');
  if(mode==='tamper')fs.appendFileSync(zipfile,'corruption');
  if(mode==='source-change'&&options.variant==='trial')write(path.join(app,'public/app.js'),'// changed during build');
 }};
 const moduleStub={exports:{}};
 const guardedFs={...fs,readFileSync(file,...args){assert.notEqual(path.resolve(String(file)),selected,'test must never read selected file');return fs.readFileSync(file,...args);}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'tools/owner-release.cjs'),'utf8'),{module:moduleStub,exports:moduleStub.exports,__dirname:path.join(app,'tools'),Buffer,URL,process:{env:{CLINIC_OWNER_SIGN_CONFIRM:'1'}},require(name){
  if(name==='node:fs')return guardedFs;
  if(name==='node:child_process')return {execFileSync(_cmd,args){if(args[0]==='status')return dirty?' M app/public/app.js':'';if(args[0]==='rev-parse')return 'a'.repeat(40);return '{"version":"1.0.7"}';}};
  if(name==='./build-update-package')return builder;
  if(name==='../lib/runtime')return {pinned:()=>path.join(app,'synthetic-runtime.exe'),RELATIVE:'synthetic-runtime.exe'};
  if(name==='../lib/zip')return zip;
  if(name==='../lib/update-manifest')return {verifyAndParseManifest(bytes,sig){assert.equal(sig.toString(),'verification boundary stub');return JSON.parse(bytes);}};
  return require(name);
 }},{filename:'owner-release-orchestration-test.cjs'});
 const harness=moduleStub.exports;
 test('dirty app refuses before any builder or key access',()=>{dirty=true;assert.throws(()=>harness.prepare({root,keyFile:selected}),e=>e.safeCode==='source');assert.equal(builds,0);dirty=false;});
 test('both variants verified against ZIP+source, with six ready filenames and no key path',()=>{
  const result=harness.prepare({root,keyFile:selected});assert.equal(builds,2);assert.equal(result.outputs.length,2);assert.equal(result.outputs.flatMap(x=>x.files).length,6);
  const report=fs.readFileSync(path.join(result.out,'พร้อมให้ผู้ดูแลตรวจ.json'),'utf8');assert(!report.includes(selected));assert(!report.includes('selected-file-placeholder'));assert(!fs.existsSync(path.join(result.out,'ยังไม่พร้อม.txt')));
 });
 test('corrupt ZIP/stale URL/changed source never leave a ready marker',()=>{
  for(const failureMode of ['tamper','stale-url','source-change']){
   mode=failureMode;const base=path.join(root,'dist/updates/v1.0.7'),before=new Set(fs.readdirSync(base));
   assert.throws(()=>harness.prepare({root,keyFile:selected}),e=>e.safeCode==='verify'||e.safeCode==='source');
   const added=fs.readdirSync(base).filter(x=>!before.has(x));assert.equal(added.length,1);assert(fs.existsSync(path.join(base,added[0],'ยังไม่พร้อม.txt')));assert(!fs.existsSync(path.join(base,added[0],'พร้อมให้ผู้ดูแลตรวจ.json')));
  }mode='ok';
 });
 test('builder exceptions are sanitized without leaking selected content/path',()=>{mode='builder-error';assert.throws(()=>harness.prepare({root,keyFile:selected}),e=>e.safeCode==='build'&&!e.message.includes('MUST-NOT-LEAK'));});
 console.log(`OWNER RELEASE PASS: ${passed}/${passed} (no key reads or signing; orchestration boundary stub)`);
}finally{
 const target=path.resolve(temp);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep));assert(path.basename(target).startsWith('clinic-owner-button-'));fs.rmSync(target,{recursive:true,force:true});
}
