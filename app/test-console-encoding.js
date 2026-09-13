'use strict';
// Real cmd.exe -> Windows PowerShell, synthetic code-page drift only. No clinic/DB/network writes.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {consoleUtf8Ps1}=require('./tools/build-installer');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-console-test-'));
try {
 const script=path.join(root,'ตรวจ console ภาษาไทย.ps1'),wrapper=path.join(root,'wrapper.cmd');
 const sample='ส่วนสิทธิ์ผู้ดูแลเสร็จแล้ว — กำลังรีสตาร์ทโปรแกรม';
 const body=['\uFEFF'+"$ErrorActionPreference='Stop'",...consoleUtf8Ps1(),
   '& cmd.exe /d /c "chcp 437 >nul"',
   "if ((& chcp.com) -notmatch '437') { throw 'fault injection failed' }",
   "if ([Console]::OutputEncoding.CodePage -ne 65001) { throw 'cached writer precondition missing' }",
   'Reset-ClinicConsole',
   "if ((& chcp.com) -notmatch '65001') { throw 'console code page not restored' }",
   "if ([Console]::OutputEncoding.CodePage -ne 65001 -or $OutputEncoding.CodePage -ne 65001) { throw 'writer encoding not restored' }",
   `Write-Host '${sample}'`,
   "Write-Output 'ENCODING_PASS'"].join('\r\n');
 fs.writeFileSync(script,body);
 fs.writeFileSync(wrapper,'@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CLINIC_CONSOLE_TEST_SCRIPT%"\r\nexit /b %errorlevel%\r\n');
 const env={...process.env,CLINIC_CONSOLE_TEST_SCRIPT:script};
 // Cross-shell tooling can inject PowerShell 7 modules into Windows PowerShell 5.1.
 for(const k of Object.keys(env)) if(k.toLowerCase()==='psmodulepath') delete env[k];
 const output=execFileSync('cmd.exe',['/d','/c',wrapper],{env,encoding:'utf8',windowsHide:true,timeout:15000});
 assert(output.includes(sample),output);assert(output.includes('ENCODING_PASS'),output);
 console.log('Console encoding: 1 test passed (real cmd/PowerShell, Thai+space path, code-page fault injection)');
} finally {fs.rmSync(root,{recursive:true,force:true});}
