'use strict';
// Real UI/LAN/scaling; helper dispatch is explicitly mocked here. Destructive engine + API use test:http temp installs.
const fs=require('node:fs'),path=require('node:path');
module.exports=async function({tab,origins,viewport,evaluate,waitExpression,clickControl}){
 for(const [index,origin] of origins.entries()){
  await tab.send('Page.navigate',{url:origin+'/login.html'});await waitExpression(tab,"!!document.querySelector('#go')",'trial login');
  await evaluate(tab,"document.querySelector('#u').value='admin';document.querySelector('#p').value='admin1234';true");await clickControl(tab,'#go');await waitExpression(tab,"typeof ME!=='undefined'&&ME?.role==='admin'",'trial admin');
  const injected=await tab.send('Page.addScriptToEvaluateOnNewDocument',{source:`{
   const original=window.fetch.bind(window);
   window.fetch=async function(url,options){
    if(url==='/api/admin/trial-tools'){
     if(options?.method==='POST'){window.trialDispatch=JSON.parse(options.body);throw Error('synthetic lost response');}
     return new Response(JSON.stringify({available:true,host:${index===0},resultHome:'C:/synthetic-trial-results'}),{status:200,headers:{'Content-Type':'application/json'}});
    }return original(url,options);
   }}`});
  try{
   await tab.send('Page.navigate',{url:origin+'/admin.html?section=system'});
   await waitExpression(tab,"document.querySelector('#trialToolsLink')&&!document.querySelector('#trialToolsLink').hidden",'visible settings entry');
   await clickControl(tab,'#trialToolsLink a');await waitExpression(tab,"!!document.querySelector('#availability')&&!document.querySelector('#availability').textContent.includes('กำลังตรวจ')",'trial tools ready');
   if(index===0){
    await evaluate(tab,"localStorage.removeItem('clinic-trial-maintenance-operation');true");await tab.send('Page.reload');await waitExpression(tab,"!document.querySelector('#choices').hidden",'two choices');
    for(const selector of ['#resetTrial','#uninstallTrial']){
     await evaluate(tab,`document.querySelector('${selector}').scrollIntoView({block:'center'});true`);
     await evaluate(tab,`(()=>{const el=document.querySelector('${selector}'),r=el.getBoundingClientRect();if(r.height<44||r.width===0||!el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('trial button obscured');if(document.documentElement.scrollWidth>innerWidth+2)throw Error('trial overflow');return true;})()`);
    }
    await clickControl(tab,'#resetTrial');await waitExpression(tab,"document.querySelector('#trialResult').textContent.includes('ยังยืนยันผลคำสั่งไม่ได้')",'lost reply visible');
    const id=await evaluate(tab,'window.trialDispatch.op_id');
    await tab.send('Page.reload');await waitExpression(tab,"!document.querySelector('#retryTrial').hidden",'pending survives reload');await clickControl(tab,'#retryTrial');await waitExpression(tab,"!!window.trialDispatch",'same operation resent');
    if(await evaluate(tab,'window.trialDispatch.op_id')!==id)throw Error('trial replay changed identity');
    if(!await evaluate(tab,"document.querySelector('#uninstallTrial').disabled"))throw Error('other destructive action enabled while pending');
    await evaluate(tab,"document.querySelector('#trialResult').scrollIntoView({block:'center'});true");
    const out=path.join(__dirname,'../output/trial-tools-evidence');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,`${viewport.screenWidth}-${viewport.dpr}.png`),Buffer.from((await tab.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate(tab,"localStorage.removeItem('clinic-trial-maintenance-operation');true");
   }else if(!await evaluate(tab,"document.querySelector('#choices').hidden&&document.querySelector('#availability').textContent.includes('เครื่องหลัก')"))throw Error('LAN controls should not act on host');
  }finally{await tab.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:injected.identifier});}
 }
 console.log('TRIAL UI PASS: two actions, durable lost-reply/reload, stable operation id, LAN instructions; helper boundary mocked');
};
