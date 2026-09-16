'use strict';
// Build-time download only; never accesses clinic data or keys.
const fs=require('node:fs'),path=require('node:path');
const runtime=require('../lib/runtime');
async function main(){
 const target=path.join(__dirname,'..',runtime.RELATIVE);
 const license=path.join(__dirname,'../vendor/NODE-LICENSE.txt');
 const licenseHash='5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';
 const hash=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
 if(!fs.existsSync(license)){
  const response=await fetch('https://raw.githubusercontent.com/nodejs/node/v'+runtime.VERSION+'/LICENSE');if(!response.ok)throw Error('Node license download failed');
  const bytes=Buffer.from(await response.arrayBuffer());if(hash(bytes)!==licenseHash)throw Error('Node license hash mismatch');fs.mkdirSync(path.dirname(license),{recursive:true});fs.writeFileSync(license,bytes,{flag:'wx'});
 }
 if(hash(fs.readFileSync(license))!==licenseHash)throw Error('Node license hash mismatch');
 if(fs.existsSync(target)){runtime.verify(target);console.log('Pinned Node LTS already verified: '+runtime.VERSION);return;}
 const response=await fetch(runtime.URL);if(!response.ok)throw Error('Official runtime download failed: '+response.status);
 const bytes=Buffer.from(await response.arrayBuffer());
 const sha=require('node:crypto').createHash('sha256').update(bytes).digest('hex');if(sha!==runtime.SHA256)throw Error('Official runtime SHA-256 mismatch');
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});runtime.verify(target);
 console.log(JSON.stringify({version:runtime.VERSION,sha256:sha,bytes:bytes.length}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
