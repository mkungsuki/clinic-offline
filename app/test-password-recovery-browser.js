'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
module.exports=async function({tab,origins,viewport,cloudDir,evaluate,waitExpression,clickControl}){
 const pass='browser synthetic recovery 123';
 for(const origin of origins){
  await tab.send('Page.navigate',{url:origin+'/login.html'});
  await waitExpression(tab,"!!document.querySelector('#go')",'password admin login');
  await evaluate(tab,"document.querySelector('#u').value='admin';document.querySelector('#p').value='admin1234';document.querySelector('#go').click();true",true);
  await waitExpression(tab,"location.pathname==='/admin.html' && typeof adminReady!=='undefined' && adminReady",'password admin ready');
  await tab.send('Page.navigate',{url:origin+'/admin.html?section=backup'});
  await waitExpression(tab,"typeof recoveryHealth!=='undefined' && recoveryHealth && adminReady",'backup panel ready');
  await evaluate(tab,`document.querySelector('#s_backup_cloud_dest').closest('details').open=true;document.querySelector('#s_backup_cloud_dest').value=${JSON.stringify(cloudDir)};document.querySelector('#s_backup_cloud_dest').dispatchEvent(new Event('input',{bubbles:true}));true`,true);
  await clickControl(tab,'#adminBackupBtn');await waitExpression(tab,"!document.querySelector('#adminBackupBtn').disabled && document.querySelector('#adminBackupResult').textContent.includes('คัดลอก')",'initial cloud copy');
  await clickControl(tab,'#passwordSetupBtn');
  await evaluate(tab,`document.querySelector('#recoveryPassword').value=${JSON.stringify(pass)};document.querySelector('#recoveryPasswordConfirm').value='different synthetic pass';document.querySelector('#recoveryAdminPin').value='9999';true`,true);
  await clickControl(tab,'#saveRecoveryPasswordBtn');await waitExpression(tab,"document.querySelector('#passwordResult').textContent.includes('ไม่ตรงกัน')",'confirmation error visible');
  await evaluate(tab,`document.querySelector('#recoveryPasswordConfirm').value=${JSON.stringify(pass)};true`,true);
  await clickControl(tab,'#saveRecoveryPasswordBtn');
  await waitExpression(tab,"!document.querySelector('#saveRecoveryPasswordBtn').disabled && document.querySelector('#passwordResult').textContent.includes('บันทึกรหัสแล้ว')",'password saved and outcome visible',20000);
  assert(await evaluate(tab,"['recoveryPassword','recoveryPasswordConfirm','recoveryAdminPin'].every(id=>document.getElementById(id).value==='')"));
  assert(await evaluate(tab,"recoveryHealth.password.ready && !recoveryHealth.kitReady && !document.querySelector('#recoveryHeadline').textContent.includes('ยังไม่มี USB')"));
  await clickControl(tab,'#drillBtn');
  await evaluate(tab,"document.querySelector('#drillPassword').value='wrong synthetic password';true",true);await clickControl(tab,'#passwordDrillBtn');
  await waitExpression(tab,"!document.querySelector('#passwordDrillBtn').disabled && document.querySelector('#adminBackupResult').textContent.includes('ซ้อมกู้ไม่สำเร็จ')",'wrong password visible');
  await evaluate(tab,`document.querySelector('#drillPassword').value=${JSON.stringify(pass)};true`,true);await clickControl(tab,'#passwordDrillBtn');
  await waitExpression(tab,"!document.querySelector('#passwordDrillBtn').disabled && document.querySelector('#adminBackupResult').textContent.includes('ซ้อมกู้สำเร็จ')",'password drill success',20000);
  const layout=await evaluate(tab,"(()=>{const ids=['passwordSetupBtn','saveRecoveryPasswordBtn','passwordDrillBtn'];return ids.every(id=>{const e=document.getElementById(id);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth+1})})()");assert(layout,'password controls fit viewport');
  console.log(`PASSWORD BROWSER admin ${viewport.screenWidth}@${viewport.dpr} ${new URL(origin).hostname}: mismatch/save/no-Kit/wrong-pass/drill/clear/layout`);
 }
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clinic password browser ไทย -')),source=path.join(root,'downloaded'),data=path.join(root,'fresh/data'),token=crypto.randomUUID(),port=45000+crypto.randomInt(4000),base='http://127.0.0.1:'+port;
 fs.cpSync(cloudDir,source,{recursive:true});
 assert(require('./lib/recovery-discovery').hasBackupManifest(source),'copied browser fixture must contain a backup manifest; files='+fs.readdirSync(source).filter(n=>n.includes('manifest')).join(','));
 const env={...process.env,CLINIC_DATA_DIR:data,CLINIC_PORT:String(port),CLINIC_HTTPS_PORT:'0',CLINIC_TEST_INSTANCE_TOKEN:token};let helper,output='';const pause=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  helper=spawn(process.execPath,['--no-warnings','recovery-assistant.js'],{cwd:__dirname,env,stdio:['ignore','pipe','pipe'],windowsHide:true});helper.stdout.on('data',b=>{output+=b.toString()});
  for(let i=0;i<100&&!/http:\/\/127\.0\.0\.1:\d+/.test(output);i++)await pause(50);
  const helperUrl=output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];assert(helperUrl);
  await tab.send('Page.navigate',{url:helperUrl});await waitExpression(tab,"typeof statusData!=='undefined' && statusData",'standalone ready');
  await evaluate(tab,`document.querySelector('#sourcePath').closest('details').open=true;document.querySelector('#sourcePath').value=${JSON.stringify(source)};true`,true);
  await clickControl(tab,'#addSourceBtn');
  try { await waitExpression(tab,"!document.querySelector('#unlockCard').classList.contains('hidden')",'fresh machine asks for password'); }
  catch(error) { throw Error(error.message+'; visible result: '+await evaluate(tab,"document.querySelector('#sourceResult').textContent")); }
  assert(await evaluate(tab,"!statusData.kitAvailable && !statusData.keyAvailable"));
  await evaluate(tab,`document.querySelector('#backupPassword').value=${JSON.stringify(pass)};true`,true);await clickControl(tab,'#unlockBtn');
  await waitExpression(tab,"!!current && current.source.passwordUnlocked && !document.querySelector('#actual').classList.contains('hidden')",'password exposes actual restore',20000);
  await clickControl(tab,'#drillBtn');await waitExpression(tab,"!document.querySelector('#drillBtn').disabled && document.querySelector('#result').textContent.includes('ซ้อมกู้สำเร็จ')",'standalone drill',20000);
  await evaluate(tab,"window.confirm=()=>true;document.querySelector('#challengeInput').value=current.challenge;true",true);await clickControl(tab,'#restoreBtn');
  await waitExpression(tab,"!document.querySelector('#restoreBtn').disabled && document.querySelector('#result').textContent.includes('กู้ข้อมูลสำเร็จ')",'actual restore visible',25000);
  assert(await evaluate(tab,"!!document.querySelector('#openRestoredApp') && document.querySelector('#openRestoredApp').offsetHeight>0"));
  assert(fs.existsSync(path.join(data,'clinic.db')));assert(fs.existsSync(path.join(data,'cloud-backup.key')));
  await evaluate(tab,"document.querySelector('#result').scrollIntoView({block:'center'});true",true);
  const evidence=path.join(__dirname,'../output/password-recovery-evidence');fs.mkdirSync(evidence,{recursive:true});
  fs.writeFileSync(path.join(evidence,`restore-${viewport.screenWidth}-${viewport.dpr}.png`),Buffer.from((await tab.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  console.log(`PASSWORD BROWSER clean ${viewport.screenWidth}@${viewport.dpr}: choose/unlock/no-local-key/drill/actual-start/visible-outcome`);
  // HTTP tests inject a missing source after publication. Here restore the
  // persisted result fixture and prove its warning survives a real page reload.
  const operationFile=path.join(path.dirname(data),'recovery-operation.json'),operation=JSON.parse(fs.readFileSync(operationFile,'utf8'));
  operation.result.sourceWarning='กู้ข้อมูลแล้ว แต่ยังบันทึกการย้ายเครื่องกลับไปยังโฟลเดอร์สำรองไม่ได้ กรุณาหยุดใช้เครื่องเก่า';
  fs.writeFileSync(operationFile,JSON.stringify(operation));await tab.send('Page.reload',{});
  await waitExpression(tab,"!!document.querySelector('#restoreSourceWarning') && document.querySelector('#restoreSourceWarning').textContent.includes('หยุดใช้เครื่องเก่า')",'persistent source warning after reload');
  assert(await evaluate(tab,"!!document.querySelector('#openRestoredApp')"));
  const ownerCount=fs.readdirSync(source).filter(n=>n.startsWith('clinic-owner-')).length;
  await evaluate(tab,`const originalRecoveryCall=call;call=(method,url,body)=>originalRecoveryCall(method,url,url==='/api/restore'?{...body,testFailStart:true,testToken:${JSON.stringify(token)}}:body);window.confirm=()=>true;document.querySelector('#challengeInput').value=current.challenge;true`,true);
  await clickControl(tab,'#restoreBtn');
  await waitExpression(tab,"!document.querySelector('#restoreBtn').disabled && document.querySelector('#result').textContent.includes('ข้อมูลเดิมกลับ')",'failed startup shows rollback result',25000);
  await evaluate(tab,"loadStatus();true",true);
  await waitExpression(tab,"statusData.lastOperation?.state==='rolled-back' && !sessionStorage.getItem('recovery-restore-op') && document.querySelector('#result').textContent.includes('ข้อมูลเดิมกลับ')",'rollback outcome persistent and safe new operation');
  assert.equal(fs.readdirSync(source).filter(n=>n.startsWith('clinic-owner-')).length,ownerCount);
  console.log(`PASSWORD BROWSER failure ${viewport.screenWidth}@${viewport.dpr}: stored-warning/reload/open-app; real-startup-failure/rollback/visible-result/no-owner-claim`);
 }finally{
  if(helper?.exitCode===null){const done=new Promise(r=>helper.once('exit',r));helper.kill();await done}
  try{const control=fs.readFileSync(path.join(data,'recovery-control.token'),'utf8').trim();await fetch(base+'/api/system/prepare-restore',{method:'POST',headers:{'X-Recovery-Control':control}});await pause(750)}catch{}
  fs.rmSync(root,{recursive:true,force:true});
 }
};
