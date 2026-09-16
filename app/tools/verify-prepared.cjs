'use strict';
// Developer-only, read-only check of prepared installers. No production defaults.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {verifySetupPackage,PAYLOAD_DIRECTORY}=require('./verify-setup-package');
const {parseZip,crc32}=require('../lib/zip');
const root=path.resolve(__dirname,'../..');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function verifyPrepared(prepared){
 if(!prepared)throw Error('ระบุโฟลเดอร์ชุดติดตั้งที่ต้องการตรวจ');prepared=path.resolve(prepared);
 const version=JSON.parse(fs.readFileSync(path.join(root,'app/package.json'),'utf8')).version,result={version,packages:[],zips:[]};
 for(const folder of ['Clinic Setup','Clinic ทดลอง']){
  const distribution=path.join(prepared,folder),dir=path.join(distribution,PAYLOAD_DIRECTORY);
  assert.deepEqual(fs.readdirSync(distribution).sort(),[PAYLOAD_DIRECTORY,'ติดตั้งระบบคลินิก.cmd','อ่านก่อนติดตั้ง.txt'].sort());verifySetupPackage(distribution);
  const m=JSON.parse(fs.readFileSync(path.join(dir,'setup-manifest.json'),'utf8'));assert.equal(m.appVersion,version);
  for(const f of m.files){assert(!f.file.includes('..'));const p=path.join(dir,f.file);assert.equal(hash(p),f.sha256,f.file);assert.equal(fs.statSync(p).size,f.bytes);
   if(f.file.startsWith('app/'))assert.equal(hash(p),hash(path.join(root,f.file)),f.file+' differs from source');
  }
  assert(!fs.existsSync(path.join(dir,'app/data')));result.packages.push({folder,files:m.files.length,transportFiles:m.packageFiles.length,sourceDifferences:0});
 }
 for(const name of fs.readdirSync(prepared).filter(n=>/^Clinic(?:Setup|Trial)-.*\.zip$/.test(n))){
  const zip=parseZip(path.join(prepared,name));for(const e of zip.entries){const full=path.resolve(prepared,...e.name.split('/'));assert(full.startsWith(prepared+path.sep));const compressed=zip.buffer.subarray(e.dataStart,e.dataEnd),bytes=e.method===0?compressed:zlib.inflateRawSync(compressed,{maxOutputLength:e.bytes});assert.equal(crc32(bytes),e.expectedCrc);assert(bytes.equals(fs.readFileSync(full)),e.name);}
  result.zips.push({name,entries:zip.entries.length,sha256:hash(path.join(prepared,name))});
 }
 return result;
}
if(require.main===module){try{console.log(JSON.stringify(verifyPrepared(process.argv[2]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={verifyPrepared};
