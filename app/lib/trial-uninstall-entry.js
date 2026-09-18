'use strict';
const fs=require('node:fs'),path=require('node:path');
const filename='ถอนชุดทดลอง.cmd';
function content(){return ['@echo off','set "CLINIC_UNINSTALL_SCRIPT=%~dp0app\\scripts\\trial-uninstall.ps1"','cd /d "%TEMP%"','(','powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "if ($env:CLINIC_INSTALL_TEST -eq \'1\') { & $env:CLINIC_UNINSTALL_SCRIPT -TestMode } else { & $env:CLINIC_UNINSTALL_SCRIPT }; exit $LASTEXITCODE"','exit',')',''].join('\r\n');}
// Updater carries app/ only. Materialize the same launcher on the first start of an installed trial.
function ensure(root){
 if(!fs.existsSync(path.join(root,'update/installed.marker')))return;
 for(let p=path.resolve(root);;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('linked-install');if(path.dirname(p)===p)break;}
 const profile=JSON.parse(fs.readFileSync(path.join(root,'update/install-profile.json'),'utf8'));
 if(profile.product!=='clinic-offline'||profile.variant!=='trial')return;
 const target=path.join(root,filename);
 if(fs.existsSync(target)){if(fs.lstatSync(target).isSymbolicLink())throw Error('linked-launcher');if(fs.readFileSync(target,'utf8')===content())return;}
 fs.writeFileSync(target,content(),'utf8');
}
module.exports={filename,content,ensure};
