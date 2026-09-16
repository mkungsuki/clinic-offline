'use strict';
// Transport inventory is separate from installed paths. Never opens a database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PAYLOAD_DIRECTORY='ชุดโปรแกรม (ไม่ต้องเปิด)';
function verifySetupPackage(root){
 root=path.resolve(root);const manifest=JSON.parse(fs.readFileSync(path.join(root,PAYLOAD_DIRECTORY,'setup-manifest.json'),'utf8'));
 if(!Array.isArray(manifest.packageFiles)||!manifest.packageFiles.length)throw Error('ชุดติดตั้งไม่มีรายการตรวจไฟล์ กรุณาแตก ZIP ใหม่ทั้งชุด');
 for(const item of manifest.packageFiles){
  if(typeof item.file!=='string'||item.file.includes('\\')||item.file.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(item.file))throw Error('รายการไฟล์ชุดติดตั้งไม่ถูกต้อง');
  const file=path.resolve(root,...item.file.split('/'));if(!file.startsWith(root+path.sep))throw Error('รายการไฟล์อยู่นอกชุดติดตั้ง');
  let cursor=root;for(const part of item.file.split('/')){cursor=path.join(cursor,part);if(fs.lstatSync(cursor).isSymbolicLink())throw Error('ชุดติดตั้งมีทางลัดที่ไม่อนุญาต');}
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size!==item.bytes||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==item.sha256)throw Error('ชุดติดตั้งไม่ครบหรือเสีย กรุณาดาวน์โหลดแล้วแตก ZIP ใหม่ทั้งชุด');
 }
 return true;
}
if(require.main===module){try{if(!process.argv[2])throw Error('กรุณาเปิดจากไฟล์ติดตั้งระบบคลินิก');verifySetupPackage(process.argv[2]);}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={verifySetupPackage,PAYLOAD_DIRECTORY};
