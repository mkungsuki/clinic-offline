'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
module.exports=async function(packageRoot){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clinic recovery launch ไทย (ทดสอบ) -'));
 try{
  const app=path.join(root,'app'),launch=path.join(app,'launch');fs.mkdirSync(launch,{recursive:true});
  fs.copyFileSync(path.join(__dirname,'launch/recovery.js'),path.join(launch,'recovery.js'));fs.writeFileSync(path.join(app,'recovery-assistant.js'),'synthetic');
  const run=()=>spawnSync(process.execPath,[path.join(launch,'recovery.js')],{env:{...process.env,CLINIC_INSTALL_TEST:'1'},encoding:'utf8',windowsHide:true});
  assert.equal(run().status,1);assert(!fs.existsSync(path.join(app,'data')));console.log('RECOVERY LAUNCH PASS: uninstalled package refused without data creation');
  fs.mkdirSync(path.join(root,'update'));fs.writeFileSync(path.join(root,'update/installed.marker'),'synthetic');
  assert.equal(run().status,0);console.log('RECOVERY LAUNCH PASS: installed Thai/space/parentheses path accepted headlessly');
  const builder=fs.readFileSync(path.join(__dirname,'tools/build-installer.js'),'utf8');assert(builder.includes('app\\\\launch\\\\recovery.js'));assert(builder.includes('กู้ข้อมูลคลินิก (ทดลอง)'));console.log('RECOVERY LAUNCH PASS: both installer variants create independent recovery shortcut');
  if(packageRoot){
    fs.mkdirSync(path.join(app,'scripts'),{recursive:true});fs.copyFileSync(path.join(__dirname,'scripts/windows-shortcuts.ps1'),path.join(app,'scripts/windows-shortcuts.ps1'));
    fs.writeFileSync(path.join(root,'เปิดระบบคลินิก.cmd'),'@echo off\r\nexit /b 0\r\n');fs.writeFileSync(path.join(root,'transition-test.marker'),'synthetic-transition-only');
    const wrapper=path.join(root,'shortcut-test.cmd');fs.writeFileSync(wrapper,'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& $env:CLINIC_RECOVERY_SHORTCUT_SCRIPT -Target $env:CLINIC_RECOVERY_INSTALL_ROOT -TestMode"\r\nexit /b %errorlevel%\r\n','ascii');
    const result=spawnSync('cmd.exe',['/d','/c',wrapper],{env:{...process.env,CLINIC_INSTALL_TEST:'1',CLINIC_SHORTCUT_TEST_ROOT:root,CLINIC_RECOVERY_INSTALL_ROOT:root,CLINIC_RECOVERY_SHORTCUT_SCRIPT:path.join(packageRoot,'scripts/make-shortcuts.ps1')},encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);assert(fs.readdirSync(path.join(root,'Desktop')).some(n=>n.startsWith('กู้ข้อมูลคลินิก')&&n.endsWith('.lnk')));console.log('RECOVERY LAUNCH PASS: real cmd to PowerShell creates recovery shortcut on Thai/space path');
  }
  return packageRoot?4:3;
 }finally{fs.rmSync(root,{recursive:true,force:true})}
};
