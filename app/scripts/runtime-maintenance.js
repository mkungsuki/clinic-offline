'use strict';
// Runs with the signed, pinned side-by-side runtime so runtime/node.exe can be replaced safely.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,spawnSync}=require('node:child_process');
const runtime=require('../lib/runtime'),core=require('../lib/update-core'),updater=require('../update-assistant');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function checkRoot(root,testMode){
 root=fs.realpathSync(root);
 if(testMode&&(!root.toLowerCase().startsWith(require('node:os').tmpdir().toLowerCase()+path.sep)||!fs.existsSync(path.join(root,'synthetic-runtime.marker'))))throw Error('Unsafe test root');
 if(!fs.existsSync(path.join(root,'update','installed.marker')))throw Error('กรุณาเปิดตัวช่วยจากระบบคลินิกที่ติดตั้งแล้ว');
 for(const part of ['app','runtime','update','app/data'])if(fs.lstatSync(path.join(root,part)).isSymbolicLink())throw Error('ตำแหน่งติดตั้งไม่ถูกต้อง');
 return root;
}
function status(root,current=process.versions.node){
 let outcome=null;try{outcome=JSON.parse(fs.readFileSync(path.join(root,'update','runtime-outcome.json'),'utf8'));}catch{}
 return {current,required:runtime.VERSION,needed:current!==runtime.VERSION,installed:fs.existsSync(path.join(root,'update','installed.marker')),outcome};
}
function show(message,confirm=false){
 if(process.env.CLINIC_RUNTIME_TEST==='1')return true;
 const r=spawnSync('powershell.exe',['-NoProfile','-STA','-Command',"Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show($env:CLINIC_RUNTIME_MESSAGE,'ระบบคลินิก',"+(confirm?"[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Question,[System.Windows.Forms.MessageBoxDefaultButton]::Button2":"[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Information")+"); if ($r -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 }; exit 1"],{env:{...process.env,CLINIC_RUNTIME_MESSAGE:message},windowsHide:true,stdio:'ignore'});
 return r.status===0;
}
function start(root,port){
 const elevated=process.env.CLINIC_RUNTIME_ELEVATED==='1';
 const child=spawn(elevated?'explorer.exe':path.join(root,'runtime','node.exe'),elevated?[path.join(root,'เปิดระบบคลินิก.cmd')]:['--no-warnings',path.join(root,'app','launch','supervisor.js')],{cwd:path.join(root,'app'),env:{...process.env,CLINIC_PORT:String(port)},detached:true,stdio:'ignore',windowsHide:true});child.unref();
}
async function run(root,port,{testMode=false,failAt=''}={}){
 root=checkRoot(root,testMode);const app=path.join(root,'app'),target=path.join(root,'runtime','node.exe'),pinned=runtime.pinned(app),out=path.join(root,'update','runtime-outcome.json');
 if(fs.lstatSync(target).isSymbolicLink())throw Error('ตำแหน่งส่วนประกอบเดิมไม่ถูกต้อง');
 const release=core.acquireApplyLock(root);let stopped=false,swapped=false,backup,snapshot;
 const outcome=(state,message)=>core.atomicWriteJson(out,{state,message,at:new Date().toISOString(),version:runtime.VERSION});
 const hook=name=>{if(testMode&&failAt===name)throw Error('synthetic '+name);if(testMode&&process.env.CLINIC_RUNTIME_KILL_AT===name)process.exit(87);};
 try{
  for(const name of ['active-journal.json','active-journal.json.previous'])if(fs.existsSync(path.join(root,'update',name))){const j=JSON.parse(fs.readFileSync(path.join(root,'update',name),'utf8'));if(!['committed','rolled-back'].includes(j.state))throw Error('มีการอัปเดตค้าง กรุณากู้การอัปเดตก่อน');}
  if(hash(target)===runtime.SHA256){
   // A crash after the swap may leave the server stopped (or an older process still alive).
   // Verify a fresh snapshot and the restarted service before reporting success on retry.
   await updater.stopClinic(app,port);await updater.ensurePortFree(port);stopped=true;
   snapshot=core.createVerifiedSnapshot({appRoot:app,databaseFile:path.join(app,'data','clinic.db'),updateId:'runtime-retry-'+crypto.randomUUID(),executable:pinned});
   start(root,port);await updater.waitHealthy(root,port,snapshot.receipt,Number(snapshot.receipt.user_version));
   outcome('complete','ส่วนประกอบโปรแกรมเป็นรุ่นที่เตรียมไว้แล้ว และตรวจการเปิดระบบสำเร็จ');return {ok:true,changed:false};
  }
  // Write probe before stopping the clinic; permissions/elevation failure leaves it running.
  const probe=path.join(root,'runtime','write-probe-'+crypto.randomUUID());fs.writeFileSync(probe,'',{flag:'wx'});fs.unlinkSync(probe);
  outcome('working','กำลังอัปเดตส่วนประกอบ กรุณารอและอย่าปิดเครื่อง');
  await updater.stopClinic(app,port);await updater.ensurePortFree(port);stopped=true;
  snapshot=core.createVerifiedSnapshot({appRoot:app,databaseFile:path.join(app,'data','clinic.db'),updateId:'runtime-'+crypto.randomUUID(),executable:pinned});
  backup=path.join(path.dirname(snapshot.snapshotFile),'node-before.exe');fs.copyFileSync(target,backup,fs.constants.COPYFILE_EXCL);if(hash(backup)!==hash(target))throw Error('Backup runtime mismatch');
  const next=path.join(root,'runtime','node-next-'+crypto.randomUUID()+'.exe');fs.copyFileSync(pinned,next,fs.constants.COPYFILE_EXCL);runtime.verify(next);hook('before-swap');
  // Atomic replacement: the original path always contains an executable, even after a power loss.
  core.retryRenameSync(next,target);swapped=true;hook('after-swap');runtime.verify(target);
  const version=spawnSync(target,['--version'],{encoding:'utf8',windowsHide:true});if(version.status!==0||version.stdout.trim()!=='v'+runtime.VERSION)throw Error('Runtime launch failed');
  start(root,port);hook('after-start');await updater.waitHealthy(root,port,snapshot.receipt,Number(snapshot.receipt.user_version));
  outcome('complete','อัปเดตส่วนประกอบเรียบร้อยแล้ว เปิดระบบคลินิกใช้งานต่อได้');return {ok:true,changed:true,snapshot:snapshot.snapshotFile};
 }catch(error){
  let restored=!swapped;
  if(swapped){try{await updater.stopClinic(app,port);await updater.ensurePortFree(port);const back=path.join(root,'runtime','node-restore-'+crypto.randomUUID()+'.exe');fs.copyFileSync(backup,back,fs.constants.COPYFILE_EXCL);core.retryRenameSync(back,target);restored=true;}catch{}}
  if(stopped)start(root,port);
  outcome('error',restored?(swapped?'อัปเดตส่วนประกอบไม่สำเร็จ คืนส่วนประกอบเดิมไว้แล้ว กรุณาแจ้งผู้ดูแล':'อัปเดตส่วนประกอบไม่สำเร็จ ยังไม่ได้เปลี่ยนส่วนประกอบในรอบนี้ กรุณาแจ้งผู้ดูแล'):'อัปเดตส่วนประกอบไม่สำเร็จ กรุณาแจ้งผู้ดูแลก่อนใช้งานต่อ');throw error;
 }finally{release();}
}
function launch(root,port){
 root=checkRoot(root,false);const executable=runtime.pinned(path.join(root,'app'));
 const child=spawn(executable,['--no-warnings',path.join(root,'app','scripts','runtime-maintenance.js'),String(port)],{cwd:path.join(root,'app'),stdio:'ignore',detached:true,windowsHide:true});child.unref();return {started:true};
}
async function main(){
 const root=path.resolve(__dirname,'../..'),port=Number(process.argv[2]);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');checkRoot(root,false);
 if(process.env.CLINIC_RUNTIME_ELEVATED!=='1'&&!show('จะหยุดระบบคลินิกชั่วครู่ สร้างและตรวจสำเนาข้อมูล แล้วอัปเดตส่วนประกอบโปรแกรม โดยไม่ลบข้อมูลคนไข้ กรุณาให้ทุกเครื่องหยุดใช้งานก่อน ต้องการดำเนินการหรือไม่?',true))return;
 try{await run(root,port);show('อัปเดตส่วนประกอบเรียบร้อยแล้ว กรุณาเปิดระบบคลินิกและตรวจการเชื่อมต่อเครื่องห้องตรวจ');}
 catch(error){
  if(['EACCES','EPERM'].includes(error.code)&&process.env.CLINIC_RUNTIME_ELEVATED!=='1'){
   // Paths passed through environment; no credentials or patient data in arguments.
   const script="$q=[char]34; $a='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File '+$q+$env:CLINIC_RUNTIME_SCRIPT+$q; Start-Process -FilePath powershell.exe -ArgumentList $a -Verb RunAs -WindowStyle Hidden";
   const r=spawnSync('powershell.exe',['-NoProfile','-Command',script],{env:{...process.env,CLINIC_RUNTIME_SCRIPT:path.join(__dirname,'runtime-elevated.ps1'),CLINIC_RUNTIME_EXE:runtime.pinned(path.join(root,'app')),CLINIC_RUNTIME_SHA:runtime.SHA256,CLINIC_RUNTIME_PORT:String(port)},windowsHide:true,stdio:'ignore'});
   if(r.status===0)return;
  }
  show('อัปเดตส่วนประกอบไม่สำเร็จ กรุณาเปิดหน้าผู้ดูแลดูสถานะและแจ้งผู้ดูแล ไม่ต้องลบโปรแกรมหรือติดตั้งใหม่');
 }
}
if(require.main===module)main().catch(()=>show('เปิดตัวช่วยอัปเดตส่วนประกอบไม่ได้ กรุณาแจ้งผู้ดูแล'));
module.exports={run,status,launch,checkRoot};
