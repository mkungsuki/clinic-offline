'use strict';
// Official Node LTS, pinned for both new installations and signed in-place updates.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const VERSION='24.21.0';
const RELATIVE='vendor/node-v'+VERSION+'-win-x64.exe';
const SHA256='ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32';
const URL='https://nodejs.org/dist/v'+VERSION+'/win-x64/node.exe';
function verify(file){
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==SHA256)
  throw new Error('ไฟล์ส่วนประกอบโปรแกรมไม่ครบหรือเสีย กรุณาให้ผู้ดูแลตรวจชุดติดตั้ง');
 return file;
}
function pinned(appRoot=path.resolve(__dirname,'..')){
 if(fs.lstatSync(path.join(appRoot,'vendor')).isSymbolicLink())throw new Error('ตำแหน่งส่วนประกอบโปรแกรมไม่ถูกต้อง');
 return verify(path.join(appRoot,RELATIVE));
}
module.exports={VERSION,RELATIVE,SHA256,URL,verify,pinned};
