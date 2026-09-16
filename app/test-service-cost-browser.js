'use strict';
module.exports=async function({tab,origins,viewport,evaluate,waitExpression,clickControl}){
 const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
 for(const origin of origins){
  await tab.send('Page.navigate',{url:origin+'/login.html'});
  await waitExpression(tab,"document.readyState==='complete' && document.querySelector('#go')",'service login ready');
  await evaluate(tab,"document.querySelector('#u').value='front';document.querySelector('#p').value='front123';document.querySelector('#go').click();true",true);
  await waitExpression(tab,"typeof ME!=='undefined' && ME?.role==='front'",'service front login');
  await tab.send('Page.navigate',{url:origin+'/stock.html'});
  await waitExpression(tab,"typeof services!=='undefined' && services.length>0",'service catalog ready');
  const name='หัตถการสังเคราะห์ '+viewport.screenWidth+' '+viewport.dpr+' '+new URL(origin).hostname;
  await evaluate(tab,`document.querySelector('#svcName').value=${JSON.stringify(name)};document.querySelector('#svcPrice').value='300';document.querySelector('#svcCost').value='120';true`);
  await clickControl(tab,'#addServiceBtn');
  await waitExpression(tab,`services.some(s=>s.name===${JSON.stringify(name)}&&s.cost===120)&&document.querySelector('#serviceSaveStatus').textContent.includes('บันทึก')`,'visible service saved');
  const id=await evaluate(tab,`services.find(s=>s.name===${JSON.stringify(name)}).id`);
  await clickControl(tab,`#svcTable tr[data-service-id="${id}"] button`);
  await waitExpression(tab,"!!document.querySelector('#mCost')",'edit cost dialog');
  assert.equal(await evaluate(tab,"document.querySelector('#mCost').value"),'120');
  await evaluate(tab,"document.querySelector('#mCost').value='';true");await clickControl(tab,'#mAskOk');
  await waitExpression(tab,`document.querySelector('#svcTable tr[data-service-id="${id}"]').textContent.includes('ยังไม่ใส่ทุน')`,'blank cost must visibly be unknown');
  await clickControl(tab,`#svcTable tr[data-service-id="${id}"] button`);
  await evaluate(tab,"document.querySelector('#mCost').value='0';true");await clickControl(tab,'#mAskOk');
  await waitExpression(tab,`services.find(s=>s.id===${id}).cost===0&&!document.querySelector('#mCost')`,'explicit zero saved');
  // Lose the HTTP response AFTER the server committed, then reload before retry.
  const lost=name+' ตอบกลับหาย';
  await evaluate(tab,`window.__realApi=api;window.api=async(method,url,body)=>{const result=await __realApi(method,url,body);if(method==='POST'&&url==='/api/services')throw new Error('สังเคราะห์ตอบกลับหาย');return result;};document.querySelector('#svcName').value=${JSON.stringify(lost)};document.querySelector('#svcPrice').value='300';document.querySelector('#svcCost').value='120';true`);
  await clickControl(tab,'#addServiceBtn');
  await waitExpression(tab,"!document.querySelector('#retryServiceSave').classList.contains('hidden')",'persistent lost-response recovery');
  await tab.send('Page.reload',{});
  await waitExpression(tab,"typeof services!=='undefined' && services.length>0 && !document.querySelector('#retryServiceSave').classList.contains('hidden')",'pending save survives reload');
  await clickControl(tab,'#retryServiceSave');
  await waitExpression(tab,`!pendingServiceSave&&services.filter(s=>s.name===${JSON.stringify(lost)}).length===1&&document.querySelector('#serviceSaveStatus').textContent.includes('บันทึก')`,'retry shows one saved item');
  const layout=await evaluate(tab,`(()=>{const ids=['svcName','svcPrice','svcCost','addServiceBtn'];const rects=ids.map(id=>document.getElementById(id).getBoundingClientRect());return {fits:rects.every(r=>r.left>=0&&r.right<=innerWidth),noOverlap:rects.every((r,i)=>rects.slice(i+1).every(b=>r.right<=b.left||b.right<=r.left||r.bottom<=b.top||b.bottom<=r.top))};})()`);
  assert(layout.fits&&layout.noOverlap,'service inputs overlap/overflow');
  if(process.env.CLINIC_SERVICE_COST_EVIDENCE){const dir=path.resolve(process.env.CLINIC_SERVICE_COST_EVIDENCE);fs.mkdirSync(dir,{recursive:true});await evaluate(tab,"document.querySelector('#serviceCard').scrollIntoView({block:'start'});true");const shot=await tab.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,`service-${viewport.screenWidth}-${viewport.dpr}-${new URL(origin).hostname}.png`),Buffer.from(shot.data,'base64'));}
  await tab.send('Page.navigate',{url:origin+'/reports.html'});
  await waitExpression(tab,"document.querySelector('#cards')?.innerText.includes('เหลือหลังต้นทุนตรง')",'direct-cost report card');
  assert(await evaluate(tab,"document.querySelector('#cards').innerText.includes('ต้นทุนบริการ / หัตถการ')&&document.querySelector('#cards').innerText.includes('ยังคำนวณไม่ได้')&&document.querySelector('#cards').innerText.includes('ไม่ใช่กำไรสุทธิ')"));
  await evaluate(tab,"document.querySelector('#rptDate').value='2020-03-15';document.querySelector('#rptDate').dispatchEvent(new Event('change'));true",true);
  await waitExpression(tab,"[...document.querySelectorAll('#cards .card')].some(c=>c.innerText.includes('เหลือหลังต้นทุนตรง')&&c.querySelector('.big-num')?.textContent==='180.00')",'300 minus 120 must visibly equal 180');
  const cardFits=await evaluate(tab,"(()=>{const c=[...document.querySelectorAll('#cards .card')].find(c=>c.innerText.includes('เหลือหลังต้นทุนตรง'));c.scrollIntoView({block:'center'});const r=c.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height>0;})()");assert(cardFits);
  if(process.env.CLINIC_SERVICE_COST_EVIDENCE){const dir=path.resolve(process.env.CLINIC_SERVICE_COST_EVIDENCE);const shot=await tab.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,`report-${viewport.screenWidth}-${viewport.dpr}-${new URL(origin).hostname}.png`),Buffer.from(shot.data,'base64'));}
  console.log('  PASS service cost browser: '+new URL(origin).hostname+' add/edit/blank/zero/lost response+reload/retry/report/layout');
 }
};
