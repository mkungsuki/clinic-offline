'use strict';
// Only dispatches a local Windows helper. No data or encryption key is read here.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
function noLinks(p){for(let q=path.resolve(p);;q=path.dirname(q)){if(fs.existsSync(q)&&fs.lstatSync(q).isSymbolicLink())throw fail('ตำแหน่งชุดทดลองไม่ถูกต้อง กรุณาแจ้งผู้ดูแล');if(path.dirname(q)===q)break;}}
function context(root){
 root=path.resolve(root);noLinks(root);
 const sandbox=process.env.CLINIC_TRIAL_TOOLS_TEST_ROOT;
 const test=!!(sandbox&&process.env.CLINIC_INSTALL_TEST==='1'&&process.env.CLINIC_TEST_INSTANCE_TOKEN);
 if(test){
  noLinks(sandbox);
  if(!path.resolve(sandbox).toLowerCase().startsWith(os.tmpdir().toLowerCase()+path.sep)||fs.readFileSync(path.join(sandbox,'trial-tools-test.marker'),'utf8')!=='synthetic-trial-tools-only'||root!==path.join(sandbox,'ชุดทดลอง'))throw fail('พื้นที่ทดสอบไม่ถูกต้อง');
 }else if(root.toLowerCase()!=='c:\\clinic-trial')throw fail('เปิดจากชุดทดลองที่ติดตั้งแล้วบนเครื่องหลักเท่านั้น');
 const home=test?path.join(sandbox,'เครื่องมือ'):path.join(process.env.LOCALAPPDATA,'ClinicOffline','TrialMaintenance');noLinks(home);
 return {root,home,test,sandbox};
}
function checkInstalled(root){
 noLinks(root);for(const p of ['update/installed.marker','update/install-profile.json','app/data','runtime/node.exe'])noLinks(path.join(root,p));
 if(!fs.statSync(path.join(root,'update/installed.marker')).isFile())throw fail('ไม่พบชุดทดลองที่ติดตั้งแล้ว');
 const profile=JSON.parse(fs.readFileSync(path.join(root,'update/install-profile.json'),'utf8'));
 if(profile.product!=='clinic-offline'||profile.variant!=='trial')throw fail('คำสั่งนี้ใช้ได้เฉพาะชุดทดลอง');
}
function status(root){try{const c=context(root);checkInstalled(root);return {available:true,resultHome:c.home};}catch{return {available:false};}}
async function launch(root,action,id){
 if(!['reset','uninstall'].includes(action)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))throw fail('คำขอไม่ถูกต้อง กรุณาเปิดหน้าใหม่',400);
 const c=context(root);checkInstalled(root);
 const dir=path.join(c.home,id);noLinks(dir);fs.mkdirSync(dir,{recursive:true});
 const request=path.join(dir,'request.json');
 for(const name of ['request.json','state.json','trial-maintenance.ps1','windows-shortcuts.ps1','ทำต่อ.cmd'])noLinks(path.join(dir,name));
 if(fs.existsSync(request)){
  const old=JSON.parse(fs.readFileSync(request,'utf8'));if(old.action!==action||old.root!==c.root)throw fail('คำขอเดิมเป็นอีกคำสั่งหนึ่ง');
 }else{
  for(const name of ['trial-maintenance.ps1','windows-shortcuts.ps1'])fs.copyFileSync(path.join(root,'app/scripts',name),path.join(dir,name));
  fs.writeFileSync(path.join(dir,'ทำต่อ.cmd'),'@echo off\r\nset "CLINIC_TRIAL_HELPER=%~dp0trial-maintenance.ps1"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if ($env:CLINIC_INSTALL_TEST -eq \'1\') { & $env:CLINIC_TRIAL_HELPER -TestMode } else { & $env:CLINIC_TRIAL_HELPER }; exit $LASTEXITCODE"\r\nexit /b %errorlevel%\r\n','utf8');
  // Request is published last so an interrupted stage can safely be reconstructed on retry.
  fs.writeFileSync(request,JSON.stringify({root:c.root,action,id}),{flag:'wx'});
 }
 // Replays have the same operation journal, including after a reset invalidates sessions.
 const nonce=crypto.randomUUID(),ready=path.join(dir,'started-'+nonce+'.txt');
 // Start-Process owns the independent Windows launch; paths travel through the environment.
 const bootstrap="$q=[char]34; $a='-NoProfile -ExecutionPolicy Bypass -File '+$q+$env:CLINIC_TRIAL_SCRIPT+$q; if($env:CLINIC_TRIAL_HEADLESS -eq '1'){$a+=' -TestMode'}; Start-Process -FilePath powershell.exe -ArgumentList $a -WorkingDirectory $env:CLINIC_TRIAL_STAGE -WindowStyle Hidden -ErrorAction Stop";
 const launched=spawnSync('powershell.exe',['-NoProfile','-Command',bootstrap],{env:{...process.env,CLINIC_TRIAL_SCRIPT:path.join(dir,'trial-maintenance.ps1'),CLINIC_TRIAL_STAGE:dir,CLINIC_TRIAL_HEADLESS:c.test?'1':'0',CLINIC_TRIAL_LAUNCH_NONCE:nonce},windowsHide:true,stdio:'ignore',timeout:15000});
 if(launched.status!==0)throw fail('เปิดตัวช่วย Windows ไม่ได้ กรุณาเปิด ทำต่อ.cmd ในโฟลเดอร์ผล: '+dir);
 for(let i=0;i<100&&!fs.existsSync(ready);i++){
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(!fs.existsSync(ready))throw fail('ยังยืนยันการเปิดตัวช่วยไม่ได้ ตรวจกล่อง Windows หรือเปิด ทำต่อ.cmd ในโฟลเดอร์ผล: '+dir);
 fs.unlinkSync(ready);
 return {started:true,operation:id,message:'ตรวจกล่องยืนยันบนเครื่องนี้ แล้วรอหน้าต่างแสดงสถานะจนแจ้งเสร็จ หากติดขัดให้กด ลองอีกครั้ง ในหน้าต่างนั้น ไม่ต้องกดถอนซ้ำจากเว็บ หากปิดหน้าต่างไปแล้วใช้ ทำต่อ.cmd ในโฟลเดอร์ผลเดิมได้',resultFolder:dir};
}
module.exports={context,checkInstalled,status,launch};
