'use strict';
// Runs inside the existing fresh-profile LAN gate, never against a user server.
module.exports=async function({client,page,b,context,base,hostBase,viewport,A,B,evaluate,waitExpression}){
  const assert=require('node:assert/strict');
  const target=await client.send('Target.createTarget',{url:'about:blank',browserContextId:context.browserContextId});
  const attached=await client.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  const front={send:(method,params={})=>client.send(method,params,attached.sessionId)};
  await front.send('Page.enable');await front.send('Runtime.enable');
  await front.send('Emulation.setDeviceMetricsOverride',{width:Math.floor(viewport.screenWidth/viewport.dpr),height:Math.floor(viewport.screenHeight/viewport.dpr),deviceScaleFactor:viewport.dpr,mobile:false});
  await front.send('Page.navigate',{url:hostBase+'/login.html'});
  await waitExpression(front,"document.readyState==='complete'&&document.querySelector('#go')",'call notice front login');
  await evaluate(front,"document.querySelector('#u').value='front';document.querySelector('#p').value='front123';document.querySelector('#go').click();true",true);
  await waitExpression(front,"typeof callNotices!=='undefined'&&callNotices&&typeof queue!=='undefined'&&queue.length>0",'front notices mounted');
  const ids=await evaluate(front,`(async()=>{const out=[];for(const pref of [${A},${B},null,null]){const p=await api('POST','/api/patients',{first_name:'แจ้งเรียกสังเคราะห์',sex:'F',op_id:crypto.randomUUID()});const v=await api('POST','/api/visits',{hn:p.hn,preferred_doctor_id:pref,op_id:crypto.randomUUID()});out.push(v);}return out;})()`,true);
  // A payment form is kept open while the two other patients are called.
  await evaluate(page,`(async()=>{await api('POST','/api/visits/${ids[3].id}/call',{op_id:crypto.randomUUID()});await api('POST','/api/visits/${ids[3].id}/finish-exam',{note:{cc:'ทดสอบแถบแจ้ง'},lines:[]});})()`,true);
  await evaluate(front,`(async()=>{await refresh();await selectBill(${ids[3].id});})()`,true);
  await evaluate(front,"while(document.querySelector('[data-ack-call]'))document.querySelector('[data-ack-call]').click();true",true);
  for(const p of [page,b]){await p.send('Page.navigate',{url:base+'/exam.html'});await waitExpression(p,"typeof ME!=='undefined'&&ME&&typeof refresh==='function'",'doctor queue loaded');await evaluate(p,'refresh()',true);}
  for(const [p,id]of [[page,A],[b,B]]){
    assert.equal(await evaluate(p,'ME.user_id'),id);
    assert(await evaluate(p,"!!document.querySelector('[data-queue-group=mine]')&&!!document.querySelector('[data-queue-group=shared]')&&!!document.querySelector('[data-queue-group=other]')"));
    // Existing shared-queue buttons remain available even for another doctor's preference.
    assert(await evaluate(p,"!!document.querySelector('.preferred-other button')"));
  }
  if(viewport.screenWidth===1920){
    const fs=require('node:fs'),path=require('node:path'),out=path.resolve(__dirname,'../output/queue-call-evidence');fs.mkdirSync(out,{recursive:true});
    for(const [p,name]of [[page,'doctor-a-groups'],[b,'doctor-b-groups']]){await p.send('Page.bringToFront');const shot=await p.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));}
  }

  // Use the actual cash field when present; selectBill's markup defines its ID.
  const cash=await evaluate(front,"document.querySelector('#b_cash_received')?.id || ''");
  assert(cash,'actual billing input exists');
  // renderBill intentionally scrolls smoothly to the selected bill. Establish
  // the baseline after that independent animation, before any call arrives.
  await front.send('Page.bringToFront');
  await evaluate(front,"(async()=>{let previous=scrollY,stable=0;for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,50));if(scrollY===previous)stable++;else stable=0;previous=scrollY;if(stable>=6)return true;}throw Error('billing scroll did not settle');})()",true);
  await evaluate(front,`(()=>{const x=document.getElementById(${JSON.stringify(cash)});x.value='700';x.focus();window.callNoticeBefore={top:x.getBoundingClientRect().top,left:x.getBoundingClientRect().left,scrollY,anc:['payCard','payQueue','billBody','callNotices'].map(id=>({id,rect:document.getElementById(id).getBoundingClientRect().toJSON()}))};return true;})()`);
  const click=(p,v)=>evaluate(p,`(()=>{const row=[...document.querySelectorAll('#examQueue .bigq')].find(r=>r.querySelector('.qno')?.textContent==='${v.queue_no}');row.querySelector('button').click();return true;})()`,true);
  await Promise.all([click(page,ids[0]),click(b,ids[1])]);
  await waitExpression(page,`typeof cur!=='undefined'&&cur?.id===${ids[0].id}`,'A sees called patient');
  await waitExpression(b,`typeof cur!=='undefined'&&cur?.id===${ids[1].id}`,'B sees called patient');
  await waitExpression(front,`[...document.querySelectorAll('[data-call-key]')].filter(el=>el.dataset.callKey.includes('|${ids[0].id}|')||el.dataset.callKey.includes('|${ids[1].id}|')).length===2`,'both named calls visible');
  const paymentGeometry=await evaluate(front,`(()=>{const x=document.getElementById(${JSON.stringify(cash)}),r=x.getBoundingClientRect();return {focus:document.activeElement===x,value:x.value,before:callNoticeBefore,after:{top:r.top,left:r.left},scrollY,anc:['payCard','payQueue','billBody','callNotices'].map(id=>({id,rect:document.getElementById(id).getBoundingClientRect().toJSON()}))};})()`);
  assert(paymentGeometry.focus&&paymentGeometry.value==='700'&&paymentGeometry.after.top===paymentGeometry.before.top&&paymentGeometry.after.left===paymentGeometry.before.left,JSON.stringify(paymentGeometry));
  const nameA=await evaluate(page,'ME.display_name'),nameB=await evaluate(b,'ME.display_name');
  assert(await evaluate(front,`document.getElementById('callNotices').innerText.includes(${JSON.stringify(nameA)})&&document.getElementById('callNotices').innerText.includes(${JSON.stringify(nameB)})`));
  // Modal remains below notices; no pointer/field obstruction during registration.
  await evaluate(front,"document.querySelector('#btnNewPat').click();true",true);
  await waitExpression(front,"!document.getElementById('regBack').classList.contains('hidden')",'registration open with calls');
  const geometry=await evaluate(front,"(()=>{const n=document.getElementById('callNotices').getBoundingClientRect(),r=document.querySelector('.reg-modal:not(.hidden)').getBoundingClientRect();return {notice:n.toJSON(),modal:r.toJSON(),top:getComputedStyle(document.getElementById('regBack')).top,body:document.body.className,viewport:innerHeight};})()");assert(geometry.notice.bottom<=geometry.modal.top&&geometry.notice.bottom<=geometry.viewport,JSON.stringify(geometry));
  await evaluate(front,"hideReg();true",true);
  const removeA=`[...document.querySelectorAll('[data-ack-call]')].find(x=>x.dataset.ackCall.includes('|${ids[0].id}|')).click();true`;
  await evaluate(front,removeA,true);
  assert.equal(await evaluate(front,`[...document.querySelectorAll('[data-call-key]')].filter(x=>x.dataset.callKey.includes('|${ids[1].id}|')).length`),1);
  await front.send('Page.reload');
  await waitExpression(front,`typeof callNotices!=='undefined'&&callNotices&&[...document.querySelectorAll('[data-call-key]')].some(x=>x.dataset.callKey.includes('|${ids[1].id}|'))`,'B call persists after reload');
  assert.equal(await evaluate(front,`[...document.querySelectorAll('[data-call-key]')].filter(x=>x.dataset.callKey.includes('|${ids[0].id}|')).length`),0);
  // Requeue/re-call while front is frozen (background/suspended browser).
  await front.send('Page.setWebLifecycleState',{state:'frozen'});
  await evaluate(page,`(async()=>{await api('POST','/api/visits/${ids[0].id}/requeue',{op_id:crypto.randomUUID()});await api('POST','/api/visits/${ids[0].id}/call',{op_id:crypto.randomUUID()});})()`,true);
  await front.send('Page.setWebLifecycleState',{state:'active'});
  await evaluate(front,'refresh()',true);
  await waitExpression(front,`[...document.querySelectorAll('[data-call-key]')].some(x=>x.dataset.callKey.includes('|${ids[0].id}|'))`,'fresh round catches up after suspension');
  if(viewport.screenWidth===1920){const fs=require('node:fs'),path=require('node:path'),out=path.resolve(__dirname,'../output/queue-call-evidence');fs.mkdirSync(out,{recursive:true});await front.send('Page.bringToFront');const shot=await front.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'front-two-calls.png'),Buffer.from(shot.data,'base64'));}
  // Lost successful reply: actual server commits; client must show persistent recovery.
  await evaluate(page,`(()=>{window.noticeRealApi=api;let drop=true;api=async(...args)=>{const out=await noticeRealApi(...args);if(drop&&args[0]==='POST'&&args[1]==='/api/visits/${ids[2].id}/call'){drop=false;throw new Error('synthetic reply loss');}return out;};return true;})()`);
  await evaluate(page,`callPatient(${ids[2].id})`,true);
  await waitExpression(page,"!!document.querySelector('#callRequestResult button')",'lost reply recovery is visible');
  await evaluate(page,"document.querySelector('#callRequestResult button').click();true",true);
  await waitExpression(page,`cur?.id===${ids[2].id}&&!document.querySelector('#callRequestResult')`,'retry shows the same called patient');
  await evaluate(page,'api=noticeRealApi;true');
  await evaluate(b,`callPatient(${ids[2].id})`,true);
  await waitExpression(b,`document.querySelector('#callRequestResult')?.innerText.includes(${JSON.stringify(nameA)})&&document.querySelector('#callRequestResult').offsetHeight>0`,'conflicting doctor sees named persistent explanation');
  await evaluate(page,`(()=>{let drop=true;api=async(...args)=>{const out=await noticeRealApi(...args);if(drop&&args[0]==='POST'&&args[1]==='/api/visits/${ids[2].id}/requeue'){drop=false;throw Error('synthetic requeue reply loss');}return out;};return true;})()`);
  await evaluate(page,'requeue()',true);
  await waitExpression(page,"!!document.querySelector('#callRequestResult button')&&document.querySelector('#callRequestResult').offsetHeight>0",'requeue lost reply visible on examination view');
  await evaluate(page,"document.querySelector('#callRequestResult button').click();true",true);
  await waitExpression(page,"pendingRequeue===null&&cur===null&&!document.querySelector('#callRequestResult')",'requeue replay returns to queue');
  await evaluate(page,'api=noticeRealApi;true');
  await evaluate(page,`api('POST','/api/visits/${ids[0].id}/cancel',{reason:'ปิดเคสสังเคราะห์'})`,true);
  await evaluate(b,`api('POST','/api/visits/${ids[1].id}/cancel',{reason:'ปิดเคสสังเคราะห์'})`,true);
  await evaluate(front,'refresh()',true);
  assert.equal(await evaluate(front,`[...document.querySelectorAll('[data-call-key]')].filter(x=>x.dataset.callKey.includes('|${ids[0].id}|')||x.dataset.callKey.includes('|${ids[1].id}|')).length`),0);
  await client.send('Target.closeTarget',{targetId:target.targetId});
  console.log('PASS queue notices browser: two named calls, groups, payment focus/layout, modal, per-item ack/reload, suspended recall, lost reply/retry, cancelled removal @'+viewport.dpr);
};
