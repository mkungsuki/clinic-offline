'use strict';
// Only invoked by npm run test:http. Two synthetic servers + one real browser profile.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const free=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
module.exports=async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-coexistence-')),children=[],clients=[];
 async function eventually(fn){for(let i=0;i<160;i++){try{if(await fn())return;}catch{}await pause(100);}throw Error('coexistence browser timeout');}
 // callNotices is static HTML; front-with-calls appears only after initPage has
 // loaded the signed-in user/doctors and rendered the live/trial banners.
 const frontReady=tab=>tab.eval('location.pathname==="/" && document.body.classList.contains("front-with-calls") && !!document.getElementById("callNotices")');
 async function cdp(url){const socket=new WebSocket(url),pending=new Map();let id=0;await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});const api={close:()=>socket.close(),call:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject,timer:setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},12000)});socket.send(JSON.stringify({id:n,method,params}));})};api.eval=async expression=>{const r=await api.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};clients.push(api);return api;}
 try{
  let app=__dirname;
  if(process.env.CLINIC_COEXIST_BASELINE==='1'){
   app=path.join(root,'baseline-app');fs.mkdirSync(app);
   for(const file of require('./tools/build-update-package').collectReleasePaths(__dirname,'production')){const dest=path.join(app,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(__dirname,file),dest);}
   const before=spawnSync('git',['show','f72ec60:app/server.js'],{cwd:__dirname,encoding:'utf8',windowsHide:true});assert.equal(before.status,0);fs.writeFileSync(path.join(app,'server.js'),before.stdout);
  }
  const bases=[];
  for(const trial of [false,true]){
   const data=path.join(root,trial?'trial':'live');fs.mkdirSync(data);const port=await free(),token=crypto.randomUUID();
   const env={...process.env,CLINIC_DATA_DIR:data,CLINIC_PORT:String(port),CLINIC_HTTPS_PORT:'0',CLINIC_TEST_INSTANCE_TOKEN:token};
   const seed=spawnSync(process.execPath,['--no-warnings','seed.js','--demo'],{cwd:app,env,encoding:'utf8',windowsHide:true});assert.equal(seed.status,0,'synthetic seed');
   const prep=spawnSync(process.execPath,['--no-warnings','-e',`const {db,setSetting}=require('./lib/db');setSetting('demo_mode','${trial?'1':'0'}');db.close();`],{cwd:app,env,encoding:'utf8',windowsHide:true});assert.equal(prep.status,0);
   const server=spawn(process.execPath,['--no-warnings','server.js'],{cwd:app,env,stdio:'ignore',windowsHide:true});children.push(server);const base='http://127.0.0.1:'+port;bases.push(base);
   await eventually(async()=> (await fetch(base+'/api/test-instance',{headers:{'X-Clinic-Test-Token':token}})).status===200);
  }
  const edge=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles].filter(Boolean).map(p=>path.join(p,'Microsoft/Edge/Application/msedge.exe')).find(p=>fs.existsSync(p));assert(edge,'Edge required');
  const port=await free();children.push(spawn(edge,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-allow-origins=*','--remote-debugging-port='+port,'--user-data-dir='+path.join(root,'profile'),'about:blank'],{stdio:'ignore',windowsHide:true}));
  const dev='http://127.0.0.1:'+port;await eventually(async()=> (await fetch(dev+'/json/version')).ok);
  const tabs=[];
  for(const base of bases){const target=await (await fetch(dev+'/json/new?'+encodeURIComponent(base+'/login.html'),{method:'PUT'})).json();const tab=await cdp(target.webSocketDebuggerUrl);tabs.push(tab);
   // Opt-in latency reproduces the old static-HTML readiness race without
   // changing either synthetic server or weakening the banner assertions.
   if(process.env.CLINIC_COEXISTENCE_SLOW_INIT==='1'){
    await tab.call('Page.enable');
    await tab.call('Page.addScriptToEvaluateOnNewDocument',{source:'{ const originalFetch=window.fetch.bind(window); window.fetch=async(...args)=>{if(String(args[0])==="/api/doctors")await new Promise(r=>setTimeout(r,1000));return originalFetch(...args);}; }'});
   }
   await eventually(()=>tab.eval('!!document.getElementById("go")'));await tab.eval('document.getElementById("u").value="front";document.getElementById("p").value="front123";document.getElementById("go").click();true');await eventually(()=>frontReady(tab));}
  assert.equal(await tabs[0].eval('document.body.innerText.includes("ชุดทดลองสำหรับฝึกใช้งาน")'),false);
  assert.equal(await tabs[1].eval('document.body.innerText.includes("ชุดทดลองสำหรับฝึกใช้งาน")'),true);
  const status=tab=>tab.eval('fetch("/api/me").then(r=>r.status)');
  assert.equal(await status(tabs[0]),200,'live session must survive trial login in same browser profile');assert.equal(await status(tabs[1]),200);console.log('COEXISTENCE PASS: real login buttons in one Edge profile keep both sessions');
  for(const tab of tabs){const loadedAt=await tab.eval('performance.timeOrigin');await tab.call('Page.reload');await eventually(async()=>await tab.eval('performance.timeOrigin')!==loadedAt && await frontReady(tab));assert.equal(await status(tab),200);}console.log('COEXISTENCE PASS: both tabs survive reload with separate data');
  await tabs[1].eval('fetch("/api/logout",{method:"POST"}).then(r=>r.status)');assert.equal(await status(tabs[0]),200);assert.equal(await status(tabs[1]),401);console.log('COEXISTENCE PASS: trial logout leaves live signed in');
  await tabs[1].call('Page.navigate',{url:bases[1]+'/login.html'});await eventually(()=>tabs[1].eval('!!document.getElementById("go")'));await tabs[1].eval('document.getElementById("u").value="front";document.getElementById("p").value="front123";document.getElementById("go").click();true');await eventually(()=>frontReady(tabs[1]));
  await tabs[0].eval('fetch("/api/logout",{method:"POST"}).then(r=>r.status)');assert.equal(await status(tabs[1]),200);assert.equal(await status(tabs[0]),401);console.log('COEXISTENCE PASS: live logout leaves trial signed in');
  console.log('COEXISTENCE HTTP/BROWSER PASS: 4 (isolated servers, one fresh Edge profile)');
 }finally{for(const c of clients)c.close();for(const child of children.reverse()){if(child.exitCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(3000)]);}}}
};
