'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
module.exports=async function({page,front,base,hostBase,receiptNo,viewport,first,evaluate,waitExpression,clickControl,ApiSession}){
 const admin=new ApiSession(hostBase);await admin.request('POST','/api/login',{username:'admin',password:'admin1234'});
 await admin.request('POST','/api/settings',{drug_label_enabled:'1',drug_label_layout:'a4-2x5',drug_label_width:'80',drug_label_height:'50'});
 for(const [tab,origin,username,password]of [[front,hostBase,'front','front123'],[page,base,'doctor','doctor123']]){
  await tab.send('Page.navigate',{url:origin+'/login.html'});
  await waitExpression(tab,"document.readyState==='complete' && document.querySelector('#go')",'label login');
  await evaluate(tab,`document.querySelector('#u').value='${username}';document.querySelector('#p').value='${password}';document.querySelector('#go').click();true`,true);
  await waitExpression(tab,"typeof ME!=='undefined' && !!ME",'label session');
  await tab.send('Page.navigate',{url:origin+'/print/receipt/'+receiptNo});
  await waitExpression(tab,"document.readyState==='complete' && document.querySelector('#drugLabelLink')",'receipt label link');
  await clickControl(tab,'#drugLabelLink');
  await waitExpression(tab,"window.drugLabelsReady===true",'label layout');
  const literal=await evaluate(tab,"[...document.querySelectorAll('#labelPages .instructions')].every((e,i)=>e.textContent===document.querySelectorAll('#labelSource .instructions')[i].textContent)");assert(literal);
  if(username==='doctor'){
   assert(await evaluate(tab,"document.querySelector('#printLabels').disabled && document.body.dataset.canPrint==='0'"));
  }else{
   // Select the first (shorter) real receipt item; other long instructions may legitimately overflow.
   await evaluate(tab,"document.querySelectorAll('.label-choice')[1].click();true",true);
   await waitExpression(tab,"!document.querySelector('#printLabels').disabled",'selected label printable');
   assert.equal(await evaluate(tab,"document.querySelectorAll('#labelPages .drug-label[data-item]').length"),1);
   await evaluate(tab,"window.__printCount=0;window.print=()=>window.__printCount++;window.__savedFetch=window.fetch;window.fetch=()=>Promise.reject(new TypeError('synthetic offline'));true");
   await clickControl(tab,'#printLabels');
   await waitExpression(tab,"document.querySelector('#printError').textContent.includes('ติดต่อเครื่องหลักไม่ได้')",'label error visible');assert.equal(await evaluate(tab,'window.__printCount'),0);
   await evaluate(tab,"window.fetch=window.__savedFetch;true");await clickControl(tab,'#printLabels');await waitExpression(tab,'window.__printCount===1','label print retry');
   await admin.request('POST','/api/settings',{drug_label_enabled:'0'});await clickControl(tab,'#printLabels');
   await waitExpression(tab,"document.querySelector('#printError').textContent.includes('เปิดใหม่')",'open labels disabled by master switch');assert.equal(await evaluate(tab,'window.__printCount'),1);
   await admin.request('POST','/api/settings',{drug_label_enabled:'1'});
  }
 }
 for(const layout of ['a4-2x5','a4-3x8','roll']){
  await front.send('Page.navigate',{url:hostBase+'/print/sample/labels?layout='+layout});
  await waitExpression(front,"window.drugLabelsReady===true",'label sample '+layout);
  assert(await evaluate(front,"getComputedStyle(document.body).backgroundColor==='rgb(255, 255, 255)' && getComputedStyle(document.body).color==='rgb(0, 0, 0)'"));
  if(layout==='a4-2x5'){
   for(const start of [1,6,10]){
    await evaluate(front,`document.querySelectorAll('.label-choice')[1].checked=false;document.querySelector('#labelStart').value=${start};layoutLabels();true`);
    assert.equal(await evaluate(front,"document.querySelectorAll('#labelPages .empty').length"),start-1);
    assert(await evaluate(front,'labelReady'));
    const measured=await evaluate(front,"(()=>{const p=document.querySelector('.label-page').getBoundingClientRect(),l=document.querySelector('#labelPages [data-item]').getBoundingClientRect();return {x:(l.left-p.left)*25.4/96,y:(l.top-p.top)*25.4/96,width:l.width*25.4/96,height:l.height*25.4/96};})()");
    assert(Math.abs(measured.x-((start-1)%2)*105)<1);assert(Math.abs(measured.y-Math.floor((start-1)/2)*59.4)<1);assert(Math.abs(measured.width-105)<1);
    if(first&&process.env.CLINIC_LABEL_EVIDENCE){const dir=path.resolve(process.env.CLINIC_LABEL_EVIDENCE);fs.mkdirSync(dir,{recursive:true});const pdf=await front.send('Page.printToPDF',{preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});fs.writeFileSync(path.join(dir,'labels-2x5-slot-'+start+'.pdf'),Buffer.from(pdf.data,'base64'));}
   }
  }
  if(layout==='a4-3x8'){
   await evaluate(front,"document.querySelector('#labelSource .instructions').textContent='ข้อความยาวเต็มบรรทัดที่ต้องคงไว้ '.repeat(40)+'\\nบรรทัดที่สอง\\nบรรทัดที่สาม';layoutLabels();true");
   assert(await evaluate(front,"document.querySelector('#labelWarnings').textContent.includes('ข้อความยาวเกินฉลาก') && document.querySelector('#printLabels').disabled && document.querySelector('#labelPages .instructions').textContent===document.querySelector('#labelSource .instructions').textContent"));
  }
 }
 await admin.request('POST','/api/settings',{drug_label_enabled:'0'});
 console.log('PASS drug labels browser '+viewport.screenWidth+'@'+viewport.dpr+': receipt link, role, literal text, selection, error/retry/master-off, 1/6/10 geometry, 3x8 overflow, roll');
};
