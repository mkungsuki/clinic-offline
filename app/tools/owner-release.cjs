'use strict';
// Owner-only release preparation. Never uploads, commits, pushes, or opens a database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const ERRORS={source:'ยังมีงานที่ไม่ได้บันทึกเป็นรุ่น ให้ผู้ดูแลบันทึกงานและตรวจชุดทดสอบก่อนกดเซ็น',version:'เลขรุ่นไม่ถูกต้อง ให้ผู้ดูแลตรวจเลขรุ่นของโปรแกรม',key:'ไฟล์ที่เลือกไม่ตรงกับกุญแจสำหรับชุดอัปเดตนี้ กรุณาเลือกใหม่ ไม่ต้องส่งไฟล์หรือเนื้อหากุญแจให้ใคร',build:'สร้างชุดอัปเดตไม่สำเร็จ ไม่มีชุดที่ประกาศว่าพร้อม กรุณาให้ผู้ดูแลตรวจโค้ดและพื้นที่ว่าง',verify:'ตรวจชุดอัปเดตไม่ผ่าน ยังไม่พร้อมปล่อย กรุณาให้ผู้ดูแลตรวจงานก่อน',test:'โหมดทดสอบไม่อนุญาตให้เซ็นหรือเลือกกุญแจ'};
function failure(code){return Object.assign(new Error(ERRORS[code]||ERRORS.build),{safeCode:code});}
function makePlan(version,schema){
 if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)||!Number.isInteger(schema)||schema<1)throw failure('version');
 return {version,schema,channel:'pilot',minFrom:'1.0.0',baseUrl:'https://github.com/mkungsuki/mk-artifacts/releases/download/v'+version,variants:['production','trial']};
}
function sourceState(root=ROOT){
 const {collectReleasePaths}=require('./build-update-package');
 const app=path.join(root,'app'),files=[...new Set(['production','trial'].flatMap(v=>collectReleasePaths(app,v)))].sort();
 return hash(Buffer.from(JSON.stringify(files.map(file=>({file,sha256:hash(fs.readFileSync(path.join(app,file)))})))));
}
function preflight({root=ROOT,testMode=false}={}){
 if(!testMode && root===ROOT)require('../lib/runtime').pinned(path.join(root,'app'));
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'app/package.json'),'utf8'));
 const schema=require(path.join(root,'app/lib/schema-version.js')).SCHEMA_VERSION;
 const plan=makePlan(pkg.version,schema);
 if(testMode)return {...plan,testMode:true,message:'ตรวจปุ่มสำเร็จ (โหมดทดสอบ ไม่เลือกกุญแจ ไม่เซ็น ไม่ส่งขึ้นอินเทอร์เน็ต)'};
 let dirty,commit,committed;
 try{
  dirty=execFileSync('git',['status','--porcelain','--untracked-files=all','--','app'],{cwd:root,encoding:'utf8',windowsHide:true});
  commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
  committed=JSON.parse(execFileSync('git',['show','HEAD:app/package.json'],{cwd:root,encoding:'utf8',windowsHide:true})).version;
 }catch{throw failure('source');}
 if(dirty.trim()||committed!==plan.version)throw failure('source');
 return {...plan,commit,sourceHash:sourceState(root),runtimeFile:require('../lib/runtime').RELATIVE,testMode:false};
}
function buildOptions(plan,keyFile,out){return plan.variants.map(variant=>({variant,channel:plan.channel,minFrom:plan.minFrom,version:plan.version,baseUrl:plan.baseUrl,keyFile,out}));}
function launcherText(){return ['@echo off','setlocal EnableExtensions DisableDelayedExpansion','set "CLINIC_SIGN_ROOT=%~dp0"','if "%CLINIC_SIGN_ROOT:~-1%"=="\\" set "CLINIC_SIGN_ROOT=%CLINIC_SIGN_ROOT:~0,-1%"','powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%CLINIC_SIGN_ROOT%\\app\\tools\\sign-release.ps1" %*','exit /b %errorlevel%',''].join('\r\n');}
function uniqueOutput(root,version){
 // Each attempt gets a new folder, so a repeated click never overwrites a prior package.
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 return path.join(root,'dist','updates','v'+version,'prepared-'+stamp+'-'+crypto.randomUUID().slice(0,8));
}
function verifyOutputs(plan,out,root=ROOT){
 const {verifyAndParseManifest}=require('../lib/update-manifest'),{parseZip,crc32}=require('../lib/zip'),zlib=require('node:zlib');
 const publicKey=fs.readFileSync(path.join(root,'app/update-public-key.pem'));
 const outputs=[];
 for(const variant of plan.variants){
  const manifestFile='latest-'+variant+'-'+plan.channel+'.json',signatureFile=manifestFile+'.sig';
  const bytes=fs.readFileSync(path.join(out,manifestFile)),sig=fs.readFileSync(path.join(out,signatureFile));
  const m=verifyAndParseManifest(bytes,sig,publicKey);
  if(m.version!==plan.version||m.expected_schema!==plan.schema||m.variant!==variant||m.package.url!==plan.baseUrl+'/'+m.package.file)throw failure('verify');
  const zipPath=path.join(out,m.package.file),zipBytes=fs.readFileSync(zipPath);
  if(hash(zipBytes)!==m.package.sha256||zipBytes.length!==m.package.bytes)throw failure('verify');
  const zip=parseZip(zipPath),entries=new Map(zip.entries.map(e=>[e.name,e]));
  if(entries.size!==m.files.length)throw failure('verify');
  for(const item of m.files){
   const source=path.resolve(root,'app',...item.path.split('/'));
   if(!source.startsWith(path.join(root,'app')+path.sep))throw failure('verify');
   if(hash(fs.readFileSync(source))!==item.sha256)throw failure('verify');
   const e=entries.get(item.path);if(!e)throw failure('verify');const compressed=zip.buffer.subarray(e.dataStart,e.dataEnd),content=e.method===0?compressed:zlib.inflateRawSync(compressed,{maxOutputLength:e.bytes});
   if(content.length!==item.bytes||hash(content)!==item.sha256||crc32(content)!==e.expectedCrc)throw failure('verify');
  }
  outputs.push({variant,files:[m.package.file,manifestFile,signatureFile],fileCount:m.files.length});
 }
 return outputs;
}
function prepare({root=ROOT,keyFile,testMode=false}={}){
 if(testMode||process.env.CLINIC_INSTALL_TEST==='1')throw failure('test');
 if(process.env.CLINIC_OWNER_SIGN_CONFIRM!=='1')throw failure('key');
 const plan=preflight({root});
 // A selected secret must remain outside the repository; only the builder reads it in the owner's process.
 let resolved;try{resolved=fs.realpathSync(keyFile);}catch{throw failure('key');}
 if(resolved.toLowerCase().startsWith(root.toLowerCase()+path.sep))throw failure('key');
 const out=uniqueOutput(root,plan.version);fs.mkdirSync(out,{recursive:true});
 try{
  const {buildUpdatePackage}=require('./build-update-package');
  for(const options of buildOptions(plan,resolved,out))buildUpdatePackage(options);
  const outputs=verifyOutputs(plan,out,root);
  const after=preflight({root});if(after.commit!==plan.commit||after.sourceHash!==plan.sourceHash)throw failure('source');
  const result={ok:true,version:plan.version,schema:plan.schema,commit:plan.commit,sourceHash:plan.sourceHash,out,outputs,
   message:'เตรียมชุดที่เซ็นและตรวจไฟล์แล้ว ยังไม่ได้ส่งขึ้นอินเทอร์เน็ต ให้ผู้ดูแลตรวจชุดติดตั้งและผลทดสอบก่อนปล่อยรุ่น'};
  fs.writeFileSync(path.join(out,'พร้อมให้ผู้ดูแลตรวจ.json'),JSON.stringify(result,null,2),{flag:'wx'});
  fs.writeFileSync(path.join(out,'อ่านก่อนปล่อย.txt'),result.message+'\r\nรุ่น '+plan.version+'\r\nมีชุดใช้งานจริงและชุดทดลองครบ 6 ไฟล์สำหรับส่งรุ่น\r\n',{flag:'wx'});
  return result;
 }catch(e){
  // Do not serialize the underlying exception: crypto/tool errors might contain sensitive input.
  fs.writeFileSync(path.join(out,'ยังไม่พร้อม.txt'),'รอบนี้ยังไม่พร้อมปล่อย ห้ามนำไฟล์ในโฟลเดอร์นี้ไปเผยแพร่\r\n');
  throw e.safeCode?e:failure('build');
 }
}
if(require.main===module){
 try{
  const testMode=process.env.CLINIC_INSTALL_TEST==='1'||process.argv.includes('--test-mode');
  const action=process.argv.includes('--sign')?'sign':'plan';
  const result=action==='sign'?prepare({keyFile:process.env.CLINIC_OWNER_KEY_FILE,testMode}):preflight({testMode});
  process.stdout.write(JSON.stringify({ok:true,...result}));
 }catch(e){process.stdout.write(JSON.stringify({ok:false,code:e.safeCode||'build',message:e.safeCode?e.message:ERRORS.build}));process.exitCode=1;}
}
module.exports={makePlan,buildOptions,launcherText,preflight,uniqueOutput,verifyOutputs,prepare};
