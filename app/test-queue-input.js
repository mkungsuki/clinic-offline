'use strict';
// Execute the real enqueue handler with synthetic DOM/input and controlled replies.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8');
const code=source.slice(source.indexOf('let pendingEnqueue='),source.indexOf('// ---------- เอกสารย้อนหลัง',source.indexOf('let pendingEnqueue=')));
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS queue input: '+name);}
function fixture(){
 const field={value:'อาการสังเคราะห์',dataset:{hn:'SYNTH-A'}},result={innerHTML:'',remove(){this.removed=true;}};
 const ctx=vm.createContext({crypto,document:{getElementById:id=>id==='enqCC'?ctx.field:id==='enqueueResult'?result:null},api:async()=>({queue_no:1}),toast(){},refresh(){},esc:s=>String(s),field});vm.runInContext(code,ctx);return {ctx,field,result,run:hn=>vm.runInContext('enqueue('+JSON.stringify(hn)+')',ctx)};
}
(async()=>{
 await test('confirmed success clears the submitted complaint',async()=>{const f=fixture();await f.run('SYNTH-A');assert.equal(f.field.value,'');});
 await test('new typing during an in-flight request stays intact',async()=>{const f=fixture();let finish;f.ctx.api=()=>new Promise(r=>finish=r);const pending=f.run('SYNTH-A');f.field.value='ข้อความที่เพิ่งแก้';finish({queue_no:1});await pending;assert.equal(f.field.value,'ข้อความที่เพิ่งแก้');});
 await test('switching cards while request is in flight does not clear the new patient',async()=>{const f=fixture();let finish;f.ctx.api=()=>new Promise(r=>finish=r);const pending=f.run('SYNTH-A');const next={value:'อาการของรายใหม่',dataset:{hn:'SYNTH-B'}};f.ctx.field=next;finish({queue_no:1});await pending;assert.equal(next.value,'อาการของรายใหม่');});
 await test('lost reply retains complaint until the same operation is confirmed',async()=>{const f=fixture();let call=0,operation;f.ctx.api=async(_m,_u,b)=>{if(!call++){operation=b.op_id;throw Error('synthetic response lost');}assert.equal(b.op_id,operation);return {queue_no:1};};await f.run('SYNTH-A');assert.equal(f.field.value,'อาการสังเคราะห์');await f.run(undefined);assert.equal(f.field.value,'');});
 await test('retry for previous patient preserves current card even when complaint text matches',async()=>{const f=fixture();f.ctx.api=async()=>{throw Error('synthetic response lost');};await f.run('SYNTH-A');f.ctx.field={value:f.field.value,dataset:{hn:'SYNTH-B'}};f.ctx.api=async()=>({queue_no:1});await f.run(undefined);assert.equal(f.ctx.field.value,'อาการสังเคราะห์');});
 await test('known completed response clears matching complaint and stale retry notice',async()=>{const f=fixture();f.ctx.api=async()=>{throw {data:{already_queued:{id:1}},status:409};};await f.run('SYNTH-A');assert.equal(f.field.value,'');assert.equal(f.result.removed,true);});
 console.log('QUEUE INPUT PASS: '+count+'/'+count);
})().catch(e=>{console.error(e);process.exitCode=1;});
