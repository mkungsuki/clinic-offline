'use strict';
module.exports=async function({tab,origins,viewport,evaluate,waitExpression,clickControl:clickRaw}){
const clickControl=async(t,selector)=>{try{return await clickRaw(t,selector);}catch(e){throw Error(selector+': '+e.message);}};
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
async function login(origin,user,pass){await tab.send('Page.navigate',{url:origin+'/login.html'});await waitExpression(tab,"document.readyState==='complete'&&!!document.querySelector('#go')",'solo login');await evaluate(tab,`document.querySelector('#u').value=${JSON.stringify(user)};document.querySelector('#p').value=${JSON.stringify(pass)};true`);await clickControl(tab,'#go');await waitExpression(tab,"typeof ME!=='undefined'&&!!ME",'solo authenticated');}
for(const origin of origins){
 await login(origin,'admin','admin1234');await tab.send('Page.navigate',{url:origin+'/admin.html?section=users'});await waitExpression(tab,"typeof userRows!=='undefined'&&userRows.some(u=>u.username==='doctor')",'solo accounts');
 const id=await evaluate(tab,"userRows.find(u=>u.username==='doctor').id");await evaluate(tab,`api('PATCH','/api/users/${id}',{front_desk:false}).then(()=>load())`);
 await waitExpression(tab,`document.querySelector('[data-front-user="${id}"]')?.textContent.includes('ปิดอยู่')`,'solo off state');
 await clickControl(tab,`[data-front-user="${id}"]`);await waitExpression(tab,"!!document.querySelector('#confirmFrontPermission')",'permission confirmation');
 await evaluate(tab,"window.__soloApi=api;window.api=async(m,u,b)=>{const r=await __soloApi(m,u,b);if(m==='PATCH'&&b?.front_desk===true){window.api=__soloApi;throw new Error('สังเคราะห์คำตอบหาย');}return r;};true");
 await clickControl(tab,'#confirmFrontPermission');await waitExpression(tab,"!!document.querySelector('#retryFrontPermission')",'persistent permission retry');await clickControl(tab,'#retryFrontPermission');
 await waitExpression(tab,`document.querySelector('[data-front-user="${id}"]').textContent.includes('เปิดอยู่')&&document.querySelector('#frontPermissionResult').textContent.includes('บันทึกสิทธิ์แล้ว')`,'permission saved visible');
 await login(origin,'doctor','doctor123');await waitExpression(tab,"ME?.can_front_desk&&document.querySelector('.who').textContent.includes('หน้าคลินิก')",'combined role badge');assert(await evaluate(tab,"!!document.querySelector('nav a[href=\"/stock.html\"]')"));
 await clickControl(tab,'nav a[href="/stock.html"]');await waitExpression(tab,"typeof services!=='undefined'&&!!document.querySelector('#svcCost')",'doctor stock access');
 const serviceName='บริการคนเดียว'+Date.now();await evaluate(tab,`document.querySelector('#svcName').value=${JSON.stringify(serviceName)};document.querySelector('#svcPrice').value='300';document.querySelector('#svcCost').value='120';true`);await clickControl(tab,'#addServiceBtn');await waitExpression(tab,`services.some(s=>s.name===${JSON.stringify(serviceName)}&&s.cost===120)`,'doctor saves service cost');
 await clickControl(tab,'nav a[href="/"]');await waitExpression(tab,"!!document.querySelector('#btnNewPat')&&typeof queue!=='undefined'",'solo intake');
 const name='คนเดียวสังเคราะห์'+Date.now();await clickControl(tab,'#btnNewPat');await evaluate(tab,`document.querySelector('#r_first').value=${JSON.stringify(name)};document.querySelector('#r_sex').value='F';document.querySelector('#r_cc').value='ทดสอบหมอทำคนเดียว';true`);await clickControl(tab,'button[onclick="registerAndQueue()"]');
 await waitExpression(tab,`queue.some(v=>v.first_name===${JSON.stringify(name)})`,'registered and queued in doctor login');const vid=await evaluate(tab,`queue.find(v=>v.first_name===${JSON.stringify(name)}).id`);
 await clickControl(tab,'nav a[href="/exam.html"]');await waitExpression(tab,`!!document.querySelector('button[onclick="callPatient(${vid})"]')`,'solo waiting patient');await clickControl(tab,`button[onclick="callPatient(${vid})"]`);
 await waitExpression(tab,`typeof cur!=='undefined'&&cur?.id===${vid}&&document.querySelector('#btnFinish').textContent.includes('ไปเก็บเงิน')`,'solo exam ready');
 await evaluate(tab,"document.querySelector('#n_cc').value='ทดสอบหมอคนเดียว';document.querySelector('#n_cc').dispatchEvent(new Event('input'));true");
 await clickControl(tab,'#btnFinish');await waitExpression(tab,"!!document.querySelector('#btnConfirmFinish')",'finish summary');assert(await evaluate(tab,"document.querySelector('#btnConfirmFinish').textContent.includes('ไปเก็บเงิน')"));
 await evaluate(tab,"window.__soloApi=api;window.api=async(m,u,b)=>{const r=await __soloApi(m,u,b);if(u.endsWith('/finish-exam')){window.api=__soloApi;throw new Error('สังเคราะห์จบตรวจแล้วคำตอบหาย');}return r;};true");
 await clickControl(tab,'#btnConfirmFinish');await waitExpression(tab,"!!document.querySelector('#retryFinish')&&!!document.querySelector('#finishNext')",'finish durable visible fallback');
 await evaluate(tab,"window.__soloBeforeReload=true;true");await tab.send('Page.reload',{});await waitExpression(tab,"!window.__soloBeforeReload&&typeof ME!=='undefined'&&!!ME&&!!document.querySelector('#retryFinish')&&!finishBusy",'finish pending survives reload');await clickControl(tab,'#retryFinish');
 await waitExpression(tab,`location.search==='?checkout=${vid}'&&typeof billVisit!=='undefined'&&billVisit?.id===${vid}&&document.querySelector('#checkoutResult')?.textContent.includes('ตรวจชื่อคนไข้')`,'same patient checkout without login');
 assert(await evaluate(tab,`ME.role==='doctor'&&ME.can_front_desk&&document.querySelector('#billBody').textContent.includes(${JSON.stringify(name)})`));
 // Deliberately block print popup: paid result must remain visible with a receipt link.
 await evaluate(tab,"window.open=()=>null;document.querySelector('#b_cash_received').value='10000';true");await clickControl(tab,'button[onclick="doPay()"]');
 await waitExpression(tab,"billVisit?.state==='COMPLETED'&&document.querySelector('#printFallbacks a[href^=\"/print/receipt/\"]')",'visible receipt after paid with popup blocked');
 assert(await evaluate(tab,"billVisit.receipts.filter(r=>r.status==='ISSUED').length===1"));
 if(process.env.CLINIC_SOLO_EVIDENCE){const out=path.resolve(process.env.CLINIC_SOLO_EVIDENCE);fs.mkdirSync(out,{recursive:true});const shot=await tab.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,`solo-${viewport.screenWidth}-${viewport.dpr}-${new URL(origin).hostname}.png`),Buffer.from(shot.data,'base64'));}
 await clickControl(tab,'#printFallbacks button[aria-label="ปิดข้อความ"]');
 await clickControl(tab,'#checkoutResult a');await waitExpression(tab,"location.pathname==='/exam.html'&&!!document.querySelector('#qSummary')",'back to exam queue');
 await login(origin,'admin','admin1234');await evaluate(tab,`api('PATCH','/api/users/${id}',{front_desk:false})`);await login(origin,'doctor','doctor123');await waitExpression(tab,"ME?.role==='doctor'&&!ME.can_front_desk",'normal doctor restored');assert(await evaluate(tab,"!document.querySelector('nav a[href=\"/stock.html\"]')&&document.querySelector('#btnFinish').textContent.includes('ส่งจ่ายยา')"));
 console.log('SOLO BROWSER PASS '+origin+' '+viewport.screenWidth+'@'+viewport.dpr);
}
};
