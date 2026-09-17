'use strict';

// Browser outcome test: isolated synthetic DB + real LAN address + fresh Edge
// profile. Zero npm dependencies; CDP uses Node's global WebSocket.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

// ตารางจอที่ต้องรองรับ (เจ้าของเคาะ 2026-08-17): ไม่ออกแบบให้เครื่องใดเครื่องหนึ่ง — ทุกช่องต้องผ่าน
// frontCols = จำนวนคอลัมน์หน้าร้านที่คาดหวัง (3 = ค้นหา | คิว | จ่ายเงิน) · 1280@150% (853px) ยอมพับเป็นคอลัมน์เดียว
const VIEWPORTS = [
  { screenWidth: 1920, screenHeight: 1080, dpr: 1, frontCols: 3 },
  { screenWidth: 1366, screenHeight: 768, dpr: 1.25, frontCols: 3 },
  { screenWidth: 1366, screenHeight: 768, dpr: 1.5, frontCols: 3 },
  { screenWidth: 1280, screenHeight: 720, dpr: 1.5, frontCols: 1 },
];

function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES_X86 && path.join(process.env.PROGRAMFILES_X86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) throw new Error('ไม่พบ Microsoft Edge สำหรับทดสอบ browser');
  return found;
}

function findLanIPv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) return address.address;
    }
  }
  throw new Error('ไม่พบ LAN IPv4 จริง จึงไม่ยอมลดระดับไปทดสอบผ่าน 127.0.0.1');
}

function randomPort(min, span) {
  return min + crypto.randomInt(0, span);
}

async function waitFor(check, message, timeout = 15000, interval = 100) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`${message}${lastError ? ` (${lastError.message})` : ''}`);
}

async function verifyAbout(page, returnUrl, isAdmin = false) {
  await waitExpression(page, `[...document.querySelectorAll('.topbar nav a')].some(a => /เกี่ยวกับโปรแกรม|ตั้งค่า/.test(a.textContent))`, 'เมนูเกี่ยวกับโปรแกรมยังโหลดไม่ครบ');
  await evaluate(page, `(() => { const a = [...document.querySelectorAll('.topbar nav a')].find(a => /เกี่ยวกับโปรแกรม|ตั้งค่า/.test(a.textContent)); if (!a) throw new Error('ไม่พบทางไปเกี่ยวกับโปรแกรม'); a.click(); return true; })()`, true);
  if (isAdmin) {
    await waitExpression(page, `typeof adminReady !== 'undefined' && adminReady`, 'admin menu not ready');
    await clickAppointmentControl(page, '#adminNav a[href="/admin.html?section=system"]');
  }
  await waitExpression(page, `location.pathname === '/admin.html' && !!document.querySelector('#aboutCard') && !document.querySelector('#aboutCard').classList.contains('hidden') && document.querySelector('#aboutVersion').textContent === ${JSON.stringify(require('./package.json').version)}`, 'ไม่เห็นชื่อรุ่นในการ์ดเกี่ยวกับโปรแกรม');
  await waitExpression(page, `document.querySelector('#donateQr').complete && document.querySelector('#donateQr').naturalWidth > 0`, 'QR โหลดไม่สำเร็จ');
  const state = await evaluate(page, `(() => {
    const card = document.querySelector('#aboutCard'), qr = document.querySelector('#donateQr');
    qr.scrollIntoView({ block: 'center' });
    const r = qr.getBoundingClientRect();
    return { controlsHidden: getComputedStyle(document.querySelector('#adminControls')).display === 'none',
      withinWidth: r.left >= 0 && r.right <= innerWidth, fullRatio: Math.abs(r.width / r.height - qr.naturalWidth / qr.naturalHeight) < 0.01,
      message: card.innerText.includes('ไม่บังคับ') && card.innerText.includes('AGPL-3.0'),
      onlyOne: document.querySelectorAll('img[src="/donate-qr.png"]').length === 1 };
  })()`);
  if (state.controlsHidden === isAdmin || !state.withinWidth || !state.fullRatio || !state.message || !state.onlyOne) throw new Error('เกี่ยวกับโปรแกรมผิดเงื่อนไข: ' + JSON.stringify(state));
  await page.send('Page.navigate', { url: returnUrl });
  await waitExpression(page, `document.readyState === 'complete' && typeof ME !== 'undefined' && !!ME`, 'กลับหน้าทำงานหลังอ่านเกี่ยวกับโปรแกรมไม่ได้');
}

async function verifyAdminPages(tab, origins, viewport, cdpPort) {
  for (const origin of origins) {
    await tab.send('Page.navigate', {url:origin+'/login.html'});
    await waitExpression(tab, `document.readyState==='complete' && !!document.querySelector('#go')`, 'admin login page');
    await evaluate(tab, `document.querySelector('#u').value='admin';document.querySelector('#p').value='admin1234';document.querySelector('#go').click();true`, true);
    await waitExpression(tab, `location.pathname==='/admin.html' && typeof adminReady!=='undefined' && adminReady`, 'admin must land in settings');
    const sections=['clinic','printing','users','connections','backup','system','advanced'];
    for (const section of sections) {
      await clickAppointmentControl(tab, `#adminNav a[href="/admin.html?section=${section}"]`);
      await waitExpression(tab, `typeof adminReady!=='undefined' && adminReady && adminSection===${JSON.stringify(section)}`, 'admin category '+section);
      const state=await evaluate(tab, `(() => {
        const cards=[...document.querySelectorAll('#adminPage > [data-admin-section]')];
        const ids=[...document.querySelectorAll('[id]')].map(x=>x.id);
        return {only:cards.length>0&&cards.every(c=>c.dataset.adminSection===adminSection),
          duplicates:ids.length!==new Set(ids).size, overflow:document.documentElement.scrollWidth>innerWidth+2,
          menu:document.querySelector('#adminNav [aria-current]').textContent,
          title:document.querySelector('#adminPageTitle').textContent};
      })()`);
      if(!state.only||state.duplicates||state.overflow||state.menu!==state.title)throw Error('admin page layout '+section+': '+JSON.stringify(state));
      if(viewport.screenWidth===1920 && origin===origins[0]) {
        const output=path.join(__dirname,'../output/admin-navigation-evidence');fs.mkdirSync(output,{recursive:true});
        await evaluate(tab, `Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))`, true);
        const shot=await tab.send('Page.captureScreenshot',{format:'png'});
        fs.writeFileSync(path.join(output,section+'.png'),Buffer.from(shot.data,'base64'));
      }
    }
    const navigationHistory=await tab.send('Page.getNavigationHistory');
    await tab.send('Page.navigateToHistoryEntry',{entryId:navigationHistory.entries[navigationHistory.currentIndex-1].id});
    await waitExpression(tab, `typeof adminReady!=='undefined'&&adminReady&&adminSection==='system'`, 'browser Back must restore previous admin category');
    await clickAppointmentControl(tab, '#adminNav a[href="/admin.html?section=printing"]');
    await waitExpression(tab, `typeof adminReady!=='undefined'&&adminReady&&adminSection==='printing'`, 'printing ready');
    // Click the actual admin preview link: checking href or a separate HTTP
    // request did not catch a demo process still serving the previous routes.
    const oldPreview=await evaluate(tab, `({paper:document.querySelector('#s_medication_sheet_paper').value,font:document.querySelector('#s_medication_sheet_font').value})`);
    await evaluate(tab, `document.querySelector('#s_medication_sheet_paper').value='A5';document.querySelector('#s_medication_sheet_font').value='24';document.querySelector('#s_medication_sheet_font').dispatchEvent(new Event('change',{bubbles:true}));true`);
    const oldTargets=new Set((await cdpTargets(cdpPort)).map(t=>t.id));
    await clickAppointmentControl(tab,'#previewMedication');
    const previewTarget=await waitFor(async()=> (await cdpTargets(cdpPort)).find(t=>!oldTargets.has(t.id)&&t.url.includes('/print/sample/medication?paper=A5&font=24')), 'admin preview tab missing');
    const previewClient=await new CdpClient(previewTarget.webSocketDebuggerUrl).connect();
    try {
      await waitExpression(previewClient, `window.medicationPaginationReady===true && document.querySelector('#medicationPages').textContent.includes('ยาตัวอย่าง') && document.querySelector('#medicationPages').textContent.includes('ข้อมูลสมมติ')`, 'admin preview must show sample medicines, not 404');
    } finally { await previewClient.send('Page.close'); previewClient.socket.close(); }
    await evaluate(tab, `document.querySelector('#s_medication_sheet_paper').value=${JSON.stringify(oldPreview.paper)};document.querySelector('#s_medication_sheet_font').value=${JSON.stringify(oldPreview.font)};document.querySelector('#s_medication_sheet_font').dispatchEvent(new Event('change',{bubbles:true}));true`);
    const choiceKeys=['receipt_show_doctor','appt_slip_show_doctor','appt_slip_show_note'];
    for(const value of ['0','1']) {
      await clickAppointmentControl(tab,'#documentDisplayOptions > summary');
      for(const key of choiceKeys) {
        const selector='.document-choice[data-setting="s_'+key+'"] button[data-value="'+value+'"]';
        await clickAppointmentControl(tab,selector);
        const state=await evaluate(tab, `(()=>{const g=document.querySelector('.document-choice[data-setting="s_${key}"]'),b=g.querySelector('[data-value="${value}"]');return {pressed:b.getAttribute('aria-pressed'),count:g.querySelectorAll('[aria-pressed="true"]').length,value:document.querySelector('#s_${key}').value,color:getComputedStyle(b).backgroundColor,hidden:document.querySelector('#s_${key}').hidden};})()`);
        if(state.pressed!=='true'||state.count!==1||state.value!==value||!state.hidden||state.color!==(value==='1'?'rgb(36, 94, 234)':'rgb(180, 35, 24)'))throw Error('document choice state/color incorrect '+JSON.stringify(state));
      }
      await clickAppointmentControl(tab,'#adminSave');
      await waitExpression(tab,`!adminSaving&&!adminIsDirty()`,'document choices save');
      const previousDocument=await evaluate(tab,'performance.timeOrigin');
      await tab.send('Page.reload');
      await waitExpression(tab,`performance.timeOrigin!==${previousDocument}&&typeof adminReady!=='undefined'&&adminReady&&${JSON.stringify(choiceKeys)}.every(k=>document.querySelector('#s_'+k).value==='${value}'&&document.querySelector('.document-choice[data-setting="s_'+k+'"] [data-value="${value}"]').getAttribute('aria-pressed')==='true')`,'document choices persist after reload');
    }
    // DOM edits and clicks exercise the real scoped save. Simulate an actual
    // successful response being lost; read-back must confirm it, not post twice.
    await evaluate(tab, `(() => {
      window.adminTestFetch=window.fetch;window.adminTestPosts=[];window.adminConfirmCount=0;
      window.fetch=async(url,opt={})=>{
        if(url==='/api/settings'&&opt.method==='POST') {
          adminTestPosts.push(JSON.parse(opt.body));const res=await adminTestFetch(url,opt);await res.clone().text();if(!res.ok)return res;
          throw Error('synthetic reply lost after commit');
        }return adminTestFetch(url,opt);
      };
      window.confirm=()=>{adminConfirmCount++;return false;};
      const f=document.querySelector('#s_medication_sheet_font');f.value=f.value==='20'?'24':'20';f.dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#s_backup_time').value='01:23';
      return true;
    })()`);
    await clickAppointmentControl(tab, '#adminNav a[href="/admin.html?section=users"]');
    if(!await evaluate(tab, `adminSection==='printing'&&adminConfirmCount===1&&adminIsDirty()`))throw Error('unsaved cancel did not preserve page');
    await clickAppointmentControl(tab,'#adminSave');
    try {
      await waitExpression(tab, `!adminSaving&&!adminIsDirty()&&document.querySelector('#adminSaveState').textContent.includes('ไม่มีข้อมูลค้าง')`, 'lost response must resolve to saved state');
    } catch(error) {
      throw Error(error.message+' '+JSON.stringify(await evaluate(tab, `({error:document.querySelector('#adminSaveError').textContent,posts:adminTestPosts,state:document.querySelector('#adminSaveState').textContent})`)));
    }
    const scope=await evaluate(tab, `({posts:adminTestPosts.length,keys:Object.keys(adminTestPosts[0]),error:document.querySelector('#adminSaveError').textContent})`);
    if(scope.posts!==1||scope.keys.some(k=>k.startsWith('backup_')||k.startsWith('clinic_'))||scope.error)throw Error('wrong save scope/retry: '+JSON.stringify(scope));
    // Failure before commit: persistent error, retained input, then confirmed
    // discard through the actual navigation handler.
    await evaluate(tab, `window.fetch=async(url,opt={})=>{if(url==='/api/settings')throw Error('synthetic offline');return adminTestFetch(url,opt);};document.querySelector('#s_medication_sheet_font').value='18';true`);
    await clickAppointmentControl(tab,'#adminSave');
    await waitExpression(tab, `!adminSaving&&adminIsDirty()&&document.querySelector('#adminSaveError').textContent.includes('ยังยืนยันการบันทึกไม่ได้')`, 'failed save must retain input and visible error');
    await evaluate(tab, `window.fetch=adminTestFetch;window.confirm=()=>true;true`);
    await clickAppointmentControl(tab,'#adminNav a[href="/admin.html?section=clinic"]');
    await waitExpression(tab, `typeof adminReady!=='undefined'&&adminReady&&adminSection==='clinic'`, 'confirmed discard navigation');
    for(const route of ['/','/index.html','/exam.html','/calendar.html','/stock.html','/reports.html']) {
      await tab.send('Page.navigate',{url:origin+route});
      await waitExpression(tab, `location.pathname==='/admin.html'&&typeof adminReady!=='undefined'&&adminReady`, 'admin direct URL '+route);
      if(!await evaluate(tab, `!document.documentElement.classList.contains('role-routing')&&!document.querySelector('#regCard')`))throw Error('clinical UI leaked on admin route');
    }
    // Actual self-reset buttons: successful write must lead to a visible login explanation.
    const accountName='auth-ui-'+Date.now()+'-'+Math.floor(Math.random()*10000);
    await evaluate(tab, `api('POST','/api/users',{username:${JSON.stringify(accountName)},display_name:'Synthetic UI admin',role:'admin',password:'Synthetic-ui-old-123'})`,true);
    await tab.send('Page.navigate',{url:origin+'/login.html'});
    await waitExpression(tab,`!!document.querySelector('#go')`,'synthetic login');
    await evaluate(tab,`document.querySelector('#u').value=${JSON.stringify(accountName)};document.querySelector('#p').value='Synthetic-ui-old-123';document.querySelector('#go').click();true`,true);
    await waitExpression(tab,`typeof adminReady!=='undefined'&&adminReady`,'synthetic admin ready');
    await clickAppointmentControl(tab,'#adminNav a[href="/admin.html?section=users"]');
    await waitExpression(tab,`typeof adminReady!=='undefined'&&adminReady&&adminSection==='users'`,'users category');
    if(!await evaluate(tab,`!!document.querySelector('#accountChangeHelp a[href="/login.html"]')`))throw Error('persistent credential fallback missing');
    await evaluate(tab,`resetPw(ME.user_id);true`,true);
    await waitExpression(tab,`!!document.querySelector('#mPw1')`,'password modal');
    await evaluate(tab,`document.querySelector('#mPw1').value='Synthetic-ui-new-123';document.querySelector('#mPw2').value='Synthetic-ui-new-123';true`);
    await evaluate(tab,`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='ตั้งรหัสผ่านใหม่');if(!b)throw Error('missing submit');b.click();return true;})()`,true);
    await waitExpression(tab,`location.pathname==='/login.html'&&document.querySelector('#restartNote')?.textContent.includes('บันทึกการเปลี่ยนบัญชีแล้ว')&&!document.querySelector('#restartNote').classList.contains('hidden')`,'self reset visible outcome');
    await evaluate(tab,`document.querySelector('#u').value=${JSON.stringify(accountName)};document.querySelector('#p').value='Synthetic-ui-new-123';document.querySelector('#go').click();true`,true);
    await waitExpression(tab,`typeof adminReady!=='undefined'&&adminReady`,'new password works');
    console.log('  PASS account reset: actual submit → visible reauthentication → new login @'+viewport.dpr+' '+new URL(origin).hostname);
    console.log('  PASS admin pages '+new URL(origin).hostname+' @'+viewport.dpr+': 7 categories, scoped save, lost reply, unsaved cancel/discard, 6 direct URLs');
  }
}

async function waitReady(base, token) {
  return waitFor(async () => {
    const response = await fetch(`${base}/api/test-instance`, { headers: { 'X-Clinic-Test-Token': token } });
    return response.ok;
  }, 'isolated browser server did not start');
}

class ApiSession {
  constructor(base) { this.base = base; this.cookie = ''; }

  async request(method, route, body) {
    const response = await fetch(this.base + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';', 1)[0];
    const text = await response.text();
    const value = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${value?.error || text}`);
    return value;
  }
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.closeDetail = '';
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('เปิด CDP WebSocket ไม่สำเร็จ')), { once: true });
    });
    this.socket.onmessage = async event => {
      try {
        let raw = event.data;
        if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString('utf8');
        else if (ArrayBuffer.isView(raw)) raw = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
        else if (typeof Blob === 'function' && raw instanceof Blob) raw = await raw.text();
        const message = JSON.parse(String(raw));
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } catch (error) {
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`ถอดคำตอบ CDP ไม่สำเร็จ: ${error.message}`));
          this.pending.delete(id);
        }
      }
    };
    this.socket.onclose = event => {
      this.closeDetail = `code=${event.code} reason=${event.reason || '-'}`;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP WebSocket ปิดก่อนตอบ (${this.closeDetail})`));
        this.pending.delete(id);
      }
    };
    return this;
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} ไม่ตอบภายใน 10 วินาที`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

async function cdpTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`อ่าน CDP targets ไม่สำเร็จ (${response.status})`);
  return response.json();
}

async function cdpVersion(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error(`อ่าน CDP version ไม่สำเร็จ (${response.status})`);
  return response.json();
}

async function evaluate(client, expression, userGesture = false) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser expression failed');
  }
  return result.result?.value;
}

async function waitExpression(client, expression, message, timeout = 15000) {
  return waitFor(() => evaluate(client, expression), message, timeout);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

// ออกใบรับรองจากจอหมอด้วยการคลิกเมาส์จริง
// expectTab=false คือสภาพจริงของห้องตรวจ: ห้ามมีแท็บพิมพ์เด้ง ต้องมีข้อความค้างบอกว่าหน้าร้านพิมพ์ให้
async function issueCertificate(page, cdpPort, expectTab) {
  await evaluate(page, `(() => {
    const button = Array.from(document.querySelectorAll('#actionCard button')).find(b => b.textContent.includes('ออกใบรับรองแพทย์'));
    if (!button) throw new Error('ไม่พบปุ่มออกใบรับรองแพทย์');
    button.click(); return true;
  })()`, true);
  await waitExpression(page, `!document.querySelector('#certOverlay').classList.contains('hidden')`, 'ฟอร์มใบรับรองไม่เปิด');
  const before = new Set((await cdpTargets(cdpPort)).map(item => item.id));
  const submitPoint = await evaluate(page, `(async () => {
    window.__certToasts = [];
    if (!window.__toastHooked) {
      const original = window.toast;
      window.toast = function(message) { window.__certToasts.push(String(message)); return original.apply(this, arguments); };
      window.__toastHooked = true;
    }
    window.__certToasts = [];
    document.querySelector('#certDx').value = 'การวินิจฉัยสังเคราะห์สำหรับทดสอบ';
    document.querySelector('#certDoctorConfirmed').checked = true;
    const button = document.querySelector('#certSubmit');
    button.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise(resolve => { const done = () => resolve(); setTimeout(done, 300); requestAnimationFrame(() => requestAnimationFrame(done)); });
    const r = button.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit?.id || hit?.tagName || '', label: button.textContent.trim() };
  })()`);
  if (submitPoint.hit !== 'certSubmit') throw new Error(`พิกัดปุ่ม submit ถูกบัง: ${JSON.stringify(submitPoint)}`);
  const expectedLabel = expectTab ? 'ออกเอกสารและเปิดพิมพ์' : 'ออกเอกสาร (พิมพ์ที่หน้าร้าน)';
  if (submitPoint.label !== expectedLabel) {
    throw new Error(`ปุ่มต้องบอกผู้ใช้ว่าพิมพ์ที่ไหน — คาด "${expectedLabel}" ได้ "${submitPoint.label}"`);
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: submitPoint.x, y: submitPoint.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: submitPoint.x, y: submitPoint.y, button: 'left', clickCount: 1 });

  if (expectTab) {
    const target = await waitFor(async () => {
      const targets = await cdpTargets(cdpPort);
      return targets.find(item => !before.has(item.id) && /\/print\/medcert\//.test(item.url));
    }, 'โหมดมีเครื่องพิมพ์: กดออกเอกสารแล้วไม่พบแท็บ /print/medcert/', 20000);
    return decodeURIComponent(new URL(target.url).pathname.split('/').pop());
  }

  const notice = await waitFor(() => evaluate(page,
    `(document.querySelector('#frontPrintNotice')?.textContent || '').match(/MC\\d{4}-\\d{4}/)?.[0] || null`),
    'ออกใบรับรองจากห้องตรวจแล้วไม่มีข้อความค้างบอกว่าหน้าร้านพิมพ์ให้', 20000);
  const certToasts = await evaluate(page, `window.__certToasts || []`);
  if (!certToasts.some(item => item.includes('หน้าร้านพิมพ์ให้'))) {
    throw new Error(`ห้องตรวจต้องบอกว่าหน้าร้านพิมพ์ให้: ${JSON.stringify(certToasts)}`);
  }
  // ต้องไม่มีแท็บพิมพ์หรือแท็บเปล่าเด้งบนเครื่องที่ไม่มีเครื่องพิมพ์
  await new Promise(resolve => setTimeout(resolve, 2500));
  const after = await cdpTargets(cdpPort);
  // นับเฉพาะแท็บของโปรแกรมเรา — Edge เปิดหน้าต่างของตัวเอง (เช่น edge://sync-confirmation-dialog) ได้เอง
  const opened = after.filter(item => !before.has(item.id) && item.type === 'page'
    && (item.url === 'about:blank' || /^https?:/i.test(item.url)));
  if (opened.length) throw new Error(`เครื่องห้องตรวจไม่ควรเปิดแท็บใด ๆ แต่เปิด: ${opened.map(t => t.url).join(', ')}`);
  return notice;
}

async function clickAppointmentControl(page, selector) {
  await page.send('Page.bringToFront');
  const point = await evaluate(page, `(async () => { let el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('missing control'); el.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,260)); el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('control disappeared during refresh'); el.scrollIntoView({block:'center'}); const b=el.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2; if(!el.contains(document.elementFromPoint(x,y))) throw Error('appointment control covered: '+${JSON.stringify(selector)}+' hit='+document.elementFromPoint(x,y)?.outerHTML.slice(0,240)+' xy='+x+','+y); return {x,y}; })()`);
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
}
async function verifyAppointmentFollowup({page,front,base,hostBase,id,crashRestart,viewport,cdpPort}) {
  // The admin scenario may have replaced the loopback cookie. Login front again explicitly.
  await evaluate(front, `api('POST','/api/login',{username:'front',password:'front123'})`);
  if (crashRestart) {
    // Existing exam creation/cancellation share the same retry class as the new follow-up writes.
    await waitExpression(page, `!!document.querySelector('#apptQ7')`, 'exam appointment button missing');
    await evaluate(page, `(() => { const original=window.fetch; window.fetch=(url,options={})=>{if(String(url).endsWith('/appointment')) {window.fetch=original;options={...options,headers:{...options.headers,'X-Clinic-Test-Token':${JSON.stringify(crashRestart.token)},'X-Clinic-Test-Crash':'after-commit'}};}return original(url,options);};})()`);
    await clickAppointmentControl(page,'#apptQ7'); await crashRestart.waitDown();
    await waitExpression(page, `pendingExamAppointment && !pendingExamAppointment.sending && document.querySelector('#apptWriteResult button')`, 'exam unknown result must keep retry visible');
    await crashRestart.start();
    // Clicking a different date while result is unknown must resend the frozen original body.
    await clickAppointmentControl(page,'#apptQ14');
    await waitExpression(page, `!pendingExamAppointment && cur.appointment && cur.appointment.days===7 && document.querySelector('#apptWriteResult').textContent.includes('นัดแล้ว')`, 'exam must recover original appointment/date after crash');
    const createdId=await evaluate(page,'cur.appointment.id');
    const createdHistory=await evaluate(page,`api('GET','/api/appointments/${createdId}/history')`);
    if(createdHistory.events.length!==1)throw Error('exam retry created duplicate appointment history');
    await evaluate(page, 'window.confirm=()=>true');
    await clickAppointmentControl(page,'#apptBody button[onclick^="cancelAppt"]');
    await waitExpression(page, `!pendingExamAppointment && !cur.appointment && document.querySelector('#apptWriteResult').textContent.includes('ยกเลิกนัดแล้ว')`, 'exam cancellation result missing');
  }
  for(const [tab,url] of [[front,hostBase],[page,base]]) {
    await tab.send('Page.navigate',{url:url+'/calendar.html'});
    await waitExpression(tab,`typeof followAppts !== 'undefined' && followAppts.some(a=>a.id===${id})`,'follow-up list did not load');
    await clickAppointmentControl(tab,'#followupTab');
  }
  const row='#pastFollowList [data-appointment-id="'+id+'"]';
  const initial=await evaluate(front,`document.querySelector(${JSON.stringify(row)}).textContent`);
  if(!initial.includes('ยังไม่ยืนยันการมา')||!initial.includes('0800000000'))throw Error('phone/unconfirmed status not visible');
  if(await evaluate(front,'document.documentElement.scrollWidth > innerWidth+1'))throw Error('follow-up overflows horizontally');
  await clickAppointmentControl(front,row+' button[onclick^="openAttendance"]');
  await waitExpression(front,`!!document.querySelector('#attendanceStatus')`,'attendance dialog missing');
  await evaluate(front,`document.querySelector('#attendanceStatus').value='no_show'`);
  await clickAppointmentControl(front,'#appointmentSaveBtn');
  await waitExpression(front,`!pendingAppointment && document.querySelector('#appointmentResult').textContent.includes('บันทึกสถานะการมาแล้ว')`,'attendance result not visible');
  await clickAppointmentControl(front,row+' button[onclick^="openContact"]');
  await waitExpression(front,`!!document.querySelector('#contactOutcome')`,'contact dialog missing');
  await evaluate(front,`document.querySelector('#contactOutcome').value='not_answered';document.querySelector('#contactNote').value='<img src=x onerror=alert(1)> หมายเหตุสังเคราะห์'`);
  if(crashRestart)await evaluate(front,`(() => { const original=window.fetch; window.fetch=(url,options={})=>{ if(String(url).endsWith('/${id}/contact')) {window.fetch=original;options={...options,headers:{...options.headers,'X-Clinic-Test-Token':${JSON.stringify(crashRestart.token)},'X-Clinic-Test-Crash':'after-commit'}};} return original(url,options); }; })()`);
  await clickAppointmentControl(front,'#appointmentSaveBtn');
  if(crashRestart){
    await crashRestart.waitDown();
    const disconnectStarted=Date.now();
    try {
      // A real disconnected HTTP POST can take longer than the 15s DOM wait to
      // reject in Edge (observed twice, then confirmed by an extended probe).
      // Keep every outcome assertion; allow up to 60s for transport failure.
      await waitExpression(front,`pendingAppointment && !pendingAppointment.sending && document.querySelector('#appointmentRetryBtn') && document.querySelector('#appointmentFields').disabled`,'unknown result must freeze fields and keep retry visible',60000);
      console.log(`  contact crash: retry visible after ${Date.now()-disconnectStarted} ms; fields remain frozen`);
    } catch(error) {
      const state=await evaluate(front,`({pending:!!pendingAppointment,sending:pendingAppointment?.sending,retry:!!document.querySelector('#appointmentRetryBtn'),disabled:document.querySelector('#appointmentFields')?.disabled,error:document.querySelector('#appointmentError')?.textContent})`);
      throw Error(error.message+' '+JSON.stringify(state));
    }
    await crashRestart.start();
    await clickAppointmentControl(front,'#appointmentSaveBtn');
  }
  await waitExpression(front,`!pendingAppointment && document.querySelector('#appointmentResult').textContent.includes('บันทึกผลโทรแล้ว')`,'contact success must remain visible');
  const bannerVisible=await evaluate(front,`(() => {const r=document.querySelector('#appointmentResult').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()`);if(!bannerVisible)throw Error('persistent appointment result is outside viewport');
  await clickAppointmentControl(front,'#appointmentResult button');
  await waitExpression(front,`!!document.querySelector('#appointmentHistory')`,'history not visible');
  const history=await evaluate(front,`({text:document.querySelector('#appointmentHistory').textContent,count:document.querySelectorAll('#appointmentHistory .history-event').length,images:document.querySelectorAll('#appointmentHistory img').length})`);
  if(history.count!==2||history.images!==0||!history.text.includes('<img src=x onerror=alert(1)>'))throw Error('retry duplicated history or note did not escape');
  // Browser refresh retains the history on the server; the second station sees the same state.
  await page.send('Page.reload');
  await waitExpression(page,`typeof followAppts!=='undefined' && followAppts.some(a=>a.id===${id} && a.attendance==='no_show' && a.contact_outcome==='not_answered')`,'second station did not see contact/no-show');
  await clickAppointmentControl(page,'#followupTab');
  await clickAppointmentControl(page,row+' button[onclick^="openContact"]');
  await waitExpression(page,`!!document.querySelector('#contactOutcome')`,'rebook dialog missing');
  await evaluate(page,`document.querySelector('#contactOutcome').value='rebooked';document.querySelector('#contactOutcome').dispatchEvent(new Event('change'))`);
  await clickAppointmentControl(page,'#rebookFields button[onclick*="1,true"]');
  const future=await evaluate(page,`document.querySelector('#contactDate').value`);
  if(!future||future<=new Date().toISOString().slice(0,10))throw Error('relative month did not set visible future date');
  await clickAppointmentControl(page,'#rebookFields button[onclick^="showDatePicker"]');
  await waitExpression(page,`document.querySelectorAll('#appointmentMiniCalendar .mini-days button').length>27`,'mini calendar not visible');
  const over=await evaluate(page,`document.querySelector('.modal-box').scrollWidth>document.querySelector('.modal-box').clientWidth+1`);
  if(over)throw Error('rebooking dialog overflows horizontally');
  // Screenshot artifacts are synthetic and remain local, for visual review.
  const out=path.join(__dirname,'..','tmp','appointment-browser');fs.mkdirSync(out,{recursive:true});

  await clickAppointmentControl(page,'#appointmentSaveBtn');
  await waitExpression(page,`!pendingAppointment && document.querySelector('#appointmentResult').textContent.includes('บันทึกผลโทรแล้ว')`,'rebook result missing');
  await clickAppointmentControl(page,'#appointmentResult button');
  await waitExpression(page,`document.querySelectorAll('#appointmentHistory .history-event').length===4`,'atomic rebook/contact history missing or duplicated');
  const result=await evaluate(page,`api('GET','/api/appointments/${id}/history')`);
  if(result.appointment.appt_date!==future||result.appointment.attendance!=='unconfirmed')throw Error('rebook must move same appointment and reset attendance for new date');
  await clickAppointmentControl(page,'#modalBack button[onclick^="openPrintWindow"]');
  await waitFor(async()=> (await cdpTargets(cdpPort)).some(t=>t.url.includes('/print/appointment/'+id)) || await evaluate(page,`!!document.querySelector('#printFallbacks a')`),'appointment slip tab/fallback missing');
  console.log(`  PASS appointment browser ${viewport.screenWidth}@${viewport.dpr}: explicit no-show, contact/history, shared stations, rebook/date picker, print${crashRestart?', real crash after commit + same-request retry':''}`);
}
async function verifyMonthlyDrugs(tab, origin, viewport) {
  await tab.send('Page.navigate', { url: origin + '/reports.html' });
  await waitExpression(tab, `!!document.querySelector('#drugMonthDetails') && ME`, 'รายงานยายังไม่พร้อม');
  await evaluate(tab, `(() => { document.querySelector('#drugMonthDetails summary').click(); return true; })()`, true);
  await waitExpression(tab, `document.querySelector('#drugMonthTable tbody tr') && document.querySelector('#drugMonthStatus').textContent.includes('ข้อมูล ณ')`, 'เปิดรายงานแล้วต้องเห็นตารางและเวลาข้อมูล');
  await waitExpression(tab, `document.querySelector('#drugCostNote')?.textContent.trim() && document.querySelector('#dailyCostNote')?.textContent.trim() && document.querySelector('#cards .cost-unavailable') && document.querySelector('#drugMonthCostNote')?.textContent.trim()`, 'รายงานต้องอธิบายทุนที่ขาดหนึ่งครั้งและไม่เดาส่วนต่างเป็นศูนย์');
  const values = await evaluate(tab, `(() => {
    const rows=[...document.querySelectorAll('#drugMonthTable tbody tr')];
    const known=rows.find(r=>r.innerText.includes('ยาสังเคราะห์รายงาน A'));
    const unknown=rows.find(r=>r.innerText.includes('ยาสังเคราะห์รายงาน B'));
    return { known:known?[...known.cells].slice(1,7).map(c=>c.textContent):null,
      unknown:unknown&&unknown.cells[5].textContent==='—'&&unknown.cells[6].textContent==='—'&&[...unknown.querySelectorAll('.cost-unavailable')].every(n=>n.getAttribute('aria-label')),
      noSpam:!document.querySelector('#drugMonthTable').innerText.match(/ข้อมูลต้นทุนไม่ครบ|ทุนไม่ครบ|ยังคำนวณไม่ได้/),
      note:document.querySelector('#drugMonthCostNote').innerText,
      links:[...document.querySelectorAll('#drugMonthCostNote a')].map(a=>a.getAttribute('href')) };
  })()`);
  if (JSON.stringify(values.known)!==JSON.stringify(['10','100.00','10.00','90.00','20.00','70.00']) || !values.unknown || !values.noSpam) throw new Error('ยอดยา/ส่วนลด/ต้นทุน/ส่วนต่างหรือเครื่องหมายทุนขาดบนจอไม่ตรงบิลสังเคราะห์');
  if (!/ยา\s*1(?:\s|รายการ)/.test(values.note) || values.links.length!==1 || !['/stock.html','/stock.html#drugTable'].includes(values.links[0])) throw new Error('คำอธิบายทุนยาต้องบอกจำนวนและพาไปตั้งทุนยาโดยไม่พาไปค่าบริการ');
  const layout = await evaluate(tab, `(() => {
    const c=document.querySelector('#drugMonthCard'); c.scrollIntoView({block:'start'});
    const r=c.getBoundingClientRect();
    const controls=['drugMonth','drugMonthSort','drugMonthRetry'].map(id=>document.getElementById(id).getBoundingClientRect());
    return { fits:r.left>=0&&r.right<=innerWidth+1, noOverlap:controls.every((a,i)=>controls.slice(i+1).every(b=>a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top)), note:c.innerText.includes('ไม่ใช่ยอดสิ้นเดือน') };
  })()`);
  if (!layout.fits || !layout.noOverlap || !layout.note) throw new Error('รายงานยาล้น/ช่องซ้อน/ไม่บอกว่าสต็อกเป็นปัจจุบัน');
  if (process.env.CLINIC_DRUG_REPORT_EVIDENCE) {
    const output = path.resolve(process.env.CLINIC_DRUG_REPORT_EVIDENCE);
    fs.mkdirSync(output, { recursive: true });
    const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `drugs-${viewport.screenWidth}-${viewport.dpr}-${new URL(origin).hostname}.png`), Buffer.from(shot.data, 'base64'));
  }
  await evaluate(tab, `(() => { const m=document.querySelector('#drugMonth'); m.value='2020-02'; m.dispatchEvent(new Event('change')); return true; })()`, true);
  await waitExpression(tab, `document.querySelector('#drugMonthStatus').textContent.includes('เดือน 2020-02') && document.querySelector('#drugMonthTable tbody tr')`, 'เปลี่ยนเดือนแล้วต้องเห็นผลเดือนใหม่');
  if (await evaluate(tab, `!!document.querySelector('#drugMonthCostNote').textContent.trim()`)) throw new Error('เดือนที่ไม่มีทุนขาดต้องล้างคำอธิบายของเดือนเก่า');
  await evaluate(tab, `(() => { document.querySelector('#drugMonthSort').value='profit'; document.querySelector('#drugMonthSort').dispatchEvent(new Event('change')); window.__drugApi=window.api; window.api=(method,url,...args)=>url.includes('/reports/drugs-monthly')?Promise.reject(new Error('ทดสอบเครือข่ายขัดข้อง')):window.__drugApi(method,url,...args); document.querySelector('#drugMonthRetry').click(); return true; })()`, true);
  await waitExpression(tab, `document.querySelector('#drugMonthStatus').textContent.includes('โหลดรายงานไม่สำเร็จ') && !document.querySelector('#drugMonthTable tr')`, 'โหลดไม่สำเร็จต้องแจ้งค้างไว้และไม่โชว์ข้อมูลเก่า');
  if (await evaluate(tab, `!!document.querySelector('#drugMonthCostNote').textContent.trim()`)) throw new Error('โหลดเดือนใหม่ไม่สำเร็จต้องไม่เหลือคำอธิบายทุนของเดือนเก่า');
  await evaluate(tab, `(() => { window.api=window.__drugApi; document.querySelector('#drugMonthRetry').click(); return true; })()`, true);
  await waitExpression(tab, `document.querySelector('#drugMonthStatus').textContent.includes('ข้อมูล ณ') && document.querySelector('#drugMonthTable tbody tr')`, 'กดลองใหม่แล้วตารางต้องกลับมา');
  // Exercise out-of-order reads without writing anything to the isolated server.
  await evaluate(tab, `(() => { const original=window.api; window.api=async(method,url,...args)=>{const result=await original(method,url,...args); if(url.includes('month=2020-01')) await new Promise(r=>setTimeout(r,600)); return result;}; const m=document.querySelector('#drugMonth');m.value='2020-01';m.dispatchEvent(new Event('change'));m.value='2020-02';m.dispatchEvent(new Event('change'));return true; })()`, true);
  await waitExpression(tab, `document.querySelector('#drugMonthStatus').textContent.includes('เดือน 2020-02')`, 'คำตอบเดือนล่าสุดไม่ปรากฏ');
  await new Promise(resolve => setTimeout(resolve, 850));
  if (!await evaluate(tab, `document.querySelector('#drugMonthStatus').textContent.includes('เดือน 2020-02')`)) throw new Error('คำตอบช้าของเดือนเก่าทับเดือนใหม่');
  console.log('  PASS monthly drug report: ' + new URL(origin).hostname + ' visible table, responsive controls, month/sort, error/retry, stale response');
}

async function verifyMedicationSheet({page,front,base,hostBase,receiptNo,viewport,first}) {
  // Set through the real admin form; save remains the existing idempotent settings operation.
  await evaluate(front, `api('POST','/api/login',{username:'admin',password:'admin1234'})`);
  await front.send('Page.navigate',{url:hostBase+'/admin.html?section=printing'});
  await waitExpression(front, `typeof adminReady!=='undefined' && adminReady`, 'admin settings not loaded');
  for (const value of ['0','1']) {
    await evaluate(front, `document.querySelector('#s_medication_sheet_enabled').value=${JSON.stringify(value)};true`);
    await clickAppointmentControl(front, '#adminSave');
    await waitFor(()=>evaluate(front, `(async()=> (await api('GET','/api/settings')).medication_sheet_enabled===${JSON.stringify(value)})()`),'medication enable switch not saved');
    const hasLink=await evaluate(front, `(async()=> (await (await fetch('/print/receipt/'+${JSON.stringify(receiptNo)})).text()).includes('id="medicationSheetLink"'))()`);
    if(hasLink!==(value==='1'))throw Error('receipt button ignores medication setting');
  }
  await evaluate(front, `api('POST','/api/login',{username:'front',password:'front123'})`);
  for(const [tab,origin,station] of [[page,base,'lan'],[front,hostBase,'front']]) {
    await tab.send('Page.navigate',{url:origin+'/print/receipt/'+encodeURIComponent(receiptNo)});
    await waitExpression(tab,`!!document.querySelector('#medicationSheetLink')`,'medicine link missing');
    await clickAppointmentControl(tab,'#medicationSheetLink');
    await waitExpression(tab,`!!document.querySelector('#printMedication')`,'medicine click did not show sheet');
    await waitExpression(tab,`window.medicationPaginationReady===true`,'medicine pagination failed');
    const content=await evaluate(tab,`document.querySelector('#medicationPages').innerText`);
    if(!content.includes('ยาสังเคราะห์รายงาน A')||!content.includes('คำสั่งสังเคราะห์'))throw Error('medicine snapshot instructions missing');
    await evaluate(tab,`window.__printCount=0;window.print=()=>window.__printCount++`);
    await clickAppointmentControl(tab,'#printMedication');
    await waitExpression(tab,`window.__printCount===1`,'explicit print not reached');
    // Lost GET response is safely retryable; error must stay visible and no print issued.
    await evaluate(tab,`window.__savedFetch=window.fetch;window.fetch=async()=>{throw new TypeError('synthetic lost response')};true`);
    await clickAppointmentControl(tab,'#printMedication');
    await waitExpression(tab,`document.querySelector('#printError').textContent.includes('ติดต่อเครื่องหลักไม่ได้') && window.__printCount===1 && !document.querySelector('#printMedication').disabled`,'print failure must show persistent retryable error');
    await evaluate(tab,`window.fetch=window.__savedFetch;true`);
    await clickAppointmentControl(tab,'#printMedication');
    await waitExpression(tab,`window.__printCount===2`,'print retry failed');
    for(const paper of ['A4','A5'])for(const font of ['18','20','24']) {
      await evaluate(tab,`document.querySelector('[name=paper]').value='${paper}';document.querySelector('[name=font]').value='${font}';true`);
      await clickAppointmentControl(tab,'button[type=submit]');
      await waitExpression(tab,`location.search.includes('paper=${paper}') && location.search.includes('font=${font}') && window.medicationPaginationReady===true`,'paper/font selection did not navigate');
      const layout=await evaluate(tab,`(()=>{const body=getComputedStyle(document.body),e=document.querySelector('#medicationPages .instructions'),r=e.getBoundingClientRect();return {size:parseFloat(body.fontSize),overflow:document.documentElement.scrollWidth>innerWidth+1,visible:r.width>0};})()`);
      if(layout.size<23.99||layout.overflow||!layout.visible)throw Error('medicine layout unreadable '+JSON.stringify(layout));
      const integrity=await evaluate(tab,`(()=>{const pages=[...document.querySelectorAll('.print-page')],source=[...document.querySelectorAll('#medicationSource .instructions')];return pages.every(p=>p.querySelector('.identity')&&p.querySelector('.medicine')&&[...p.querySelectorAll('.medicine')].every(m=>m.getBoundingClientRect().bottom<=p.querySelector('.page-content').getBoundingClientRect().bottom)) && source.every((s,i)=>[...document.querySelectorAll('#medicationPages [data-medicine-index="'+i+'"] .instructions')].map(e=>e.textContent).join('')===s.textContent);})()`);
      if(!integrity)throw Error('pagination lost instructions, identity, or overflowed a physical page');
      const visual=await evaluate(tab,`(()=>{const grid=document.querySelector('#medicationPages .dose-grid');return {cells:grid?.children.length,columns:grid?getComputedStyle(grid).gridTemplateColumns.split(' ').length:0,fallback:!!document.querySelector('#medicationPages [data-medicine-index="1"] .text-dose-label'),icons:grid?.querySelectorAll('svg').length};})()`);
      if(visual.cells!==4||visual.columns!==(paper==='A5'?2:4)||!visual.fallback||visual.icons!==4)throw Error('proven dose graphic missing or unsafe fallback '+paper+'/'+font+' '+JSON.stringify(visual));
      if(first && station==='front' && process.env.CLINIC_MEDICATION_EVIDENCE) {
        const out=path.resolve(process.env.CLINIC_MEDICATION_EVIDENCE); fs.mkdirSync(out,{recursive:true});
        const pdf=await tab.send('Page.printToPDF',{preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
        fs.writeFileSync(path.join(out,`medication-${paper}-${font}.pdf`),Buffer.from(pdf.data,'base64'));
      }
    }
    const longPass=await evaluate(tab,`(()=>{const s=document.querySelector('#medicationSource .instructions'),original=s.textContent;s.textContent=original.repeat(40);paginateMedication();const text=[...document.querySelectorAll('#medicationPages [data-medicine-index="0"] .instructions')].map(e=>e.textContent).join('');const pages=[...document.querySelectorAll('.print-page')];return text===s.textContent && pages.length>2 && !document.querySelector('#medicationPages [data-medicine-index="0"] .dose-visual') && !!document.querySelector('.continuation-notice') && pages.every(p=>p.querySelector('.identity')&&p.querySelector('.medicine')&&[...p.querySelectorAll('.medicine')].every(m=>m.getBoundingClientRect().bottom<=p.querySelector('.page-content').getBoundingClientRect().bottom));})()`);
    if(!longPass)throw Error('long literal instructions lost or overflowed across pages');
    for(const style of ['text','visual']) {
      await evaluate(tab,`document.querySelector('[name=style]').value='${style}';true`);
      await clickAppointmentControl(tab,'button[type=submit]');
      await waitExpression(tab,`location.search.includes('style=${style}') && window.medicationPaginationReady===true`,'style selector did not show result');
      const graphic=await evaluate(tab,`!!document.querySelector('#medicationPages .dose-visual')`);
      if(graphic!==(style==='visual'))throw Error('visual/text choice ignored');
    }
    console.log(`  medication ${station}: link + explicit print + failed response/retry + six paper/font choices + long instructions`);
  }
  // An already-open document must not print after the master switch is turned off.
  const admin=new ApiSession(hostBase);await admin.request('POST','/api/login',{username:'admin',password:'admin1234'});
  await admin.request('POST','/api/settings',{medication_sheet_enabled:'0'});
  await evaluate(front,`window.__printCount=0;window.print=()=>window.__printCount++`);
  await clickAppointmentControl(front,'#printMedication');
  await waitExpression(front,`document.querySelector('#printError').textContent.includes('ปิดใช้') && window.__printCount===0`,'stale medicine page printed after disable');
}

async function runViewport({ edge, base, hostBase, cdpPort, viewport, checkHostDoctor, profileDir, crashRestart, appointmentId, medicationReceipt, backupCloudDir }) {
  const cssWidth = Math.floor(viewport.screenWidth / viewport.dpr);
  const cssHeight = Math.floor(viewport.screenHeight / viewport.dpr);
  const edgeProcess = spawn(edge, [
    '--headless=new',
    // สถานีห้องตรวจวิ่ง HTTPS self-signed (A-refined) — ใน test ข้ามการตรวจ CA เท่านั้น
    // (การพิสูจน์ trust flow จริงคือ manual UAT ติดตั้ง .cer บน Windows user สด — ไม่ใช่ flag นี้)
    '--ignore-certificate-errors',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-search-engine-choice-screen',
    '--disable-features=EdgeSyncPromo,ImplicitSignInOnStartup',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--remote-allow-origins=*',
    `--window-size=${viewport.screenWidth},${viewport.screenHeight}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let edgeLogs = '';
  edgeProcess.stdout.on('data', chunk => { edgeLogs += chunk.toString(); });
  edgeProcess.stderr.on('data', chunk => { edgeLogs += chunk.toString(); });

  let client = null;
  let stage = 'เปิด Edge';
  try {
    const version = await waitFor(async () => {
      const value = await cdpVersion(cdpPort);
      return value.webSocketDebuggerUrl ? value : null;
    }, 'Edge CDP page target ไม่พร้อม');
    const websocketUrl = version.webSocketDebuggerUrl.replace('://localhost:', '://127.0.0.1:');
    client = await new CdpClient(websocketUrl).connect();
    const created = await client.send('Target.createTarget', { url: 'about:blank' });
    const attached = await client.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const page = { send: (method, params = {}) => client.send(method, params, attached.sessionId) };
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: cssWidth,
      height: cssHeight,
      deviceScaleFactor: viewport.dpr,
      mobile: false,
      screenWidth: viewport.screenWidth,
      screenHeight: viewport.screenHeight,
    });

    if (process.env.CLINIC_BROWSER_STOCK_ONLY === '1') {
      await require('./test-stock-warnings-browser')({tab:page,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
      return;
    }
    if (process.env.CLINIC_BROWSER_VITALS_ONLY === '1') {
      await require('./test-vitals-browser')({tab:page,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
      return;
    }
    if (process.env.CLINIC_BROWSER_DOSE_UNITS_ONLY === '1') {
      await require('./test-dispensing-dose-units-browser')({tab:page,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
      return;
    }
    if (process.env.CLINIC_BROWSER_RECORDING_ONLY === '1') {
      await require('./test-stock-warnings-browser')({tab:page,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
      await require('./test-recording-browser')({tab:page,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
      return;
    }
    if (process.env.CLINIC_BROWSER_TRIAL_TOOLS_ONLY === '1') {
      await require('./test-trial-tools-browser')({tab:page,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
      return;
    }
    if (process.env.CLINIC_BROWSER_PASSWORD_ONLY === '1') {
      await require('./test-password-recovery-browser')({tab:page,origins:[hostBase,base],viewport,cloudDir:backupCloudDir,evaluate,waitExpression,clickControl:clickAppointmentControl});
      return;
    }
    if (process.env.CLINIC_BROWSER_BACKUP_ONLY === '1') {
      await require('./test-backup-status-browser')({tab:page,origins:[hostBase,base],viewport,cloudDir:backupCloudDir,evaluate,waitExpression,clickControl:clickAppointmentControl});
      return;
    }
    if (process.env.CLINIC_BROWSER_DOSE_ONLY === '1') {
      await require('./test-dose-defaults-browser')({tab:page,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
      return;
    }
    if (process.env.CLINIC_BROWSER_SOLO_ONLY === '1') {
      await require('./test-solo-doctor-browser')({tab:page,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
      return;
    }
    if (process.env.CLINIC_BROWSER_SERVICE_COST_ONLY === '1') {
      await require('./test-service-cost-browser')({tab:page,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
      return;
    }
    if (process.env.CLINIC_BROWSER_MULTI_DOCTOR_ONLY === '1' || process.env.CLINIC_BROWSER_LABELS_ONLY === '1') {
      const other=await client.send('Target.createTarget',{url:'about:blank'});
      const a=await client.send('Target.attachToTarget',{targetId:other.targetId,flatten:true});
      const admin={send:(method,params={})=>client.send(method,params,a.sessionId)};
      await admin.send('Page.enable');await admin.send('Runtime.enable');
      await admin.send('Emulation.setDeviceMetricsOverride',{width:cssWidth,height:cssHeight,deviceScaleFactor:viewport.dpr,mobile:false});
      if(process.env.CLINIC_BROWSER_LABELS_ONLY==='1'){
        await require('./test-drug-labels-browser')({page,front:admin,base,hostBase,receiptNo:medicationReceipt,viewport,first:checkHostDoctor,evaluate,waitExpression,clickControl:clickAppointmentControl,ApiSession});
        return;
      }
      await require('./test-multi-doctor-browser')({client,page,admin,base,hostBase,viewport,evaluate,waitExpression});
      return;
    }
    if (process.env.CLINIC_BROWSER_ADMIN_ONLY === '1') {
      stage = 'admin targeted diagnostic';
      await verifyAdminPages(page, [hostBase, base], viewport, cdpPort);
      return;
    }
    // ---------- สถานีที่ 1: เครื่องห้องตรวจ เข้าผ่าน LAN IP (ไม่มีเครื่องพิมพ์) ----------
    stage = 'ห้องตรวจ: login';
    await page.send('Page.navigate', { url: `${base}/login.html` });
    await waitExpression(page, `document.readyState === 'complete' && !!document.querySelector('#go')`, 'หน้า login ไม่พร้อม');
    await evaluate(page, `(() => {
      document.querySelector('#u').value = 'doctor';
      document.querySelector('#p').value = 'doctor123';
      document.querySelector('#go').click();
      return true;
    })()`, true);
    await waitExpression(page, `location.pathname === '/exam.html' && document.readyState === 'complete'`, 'browser login ไม่สำเร็จ');
    await waitExpression(page, `ME && ME.is_host === false`, 'เข้าผ่าน LAN แล้ว server ต้องบอกว่าไม่ใช่เครื่องที่ต่อเครื่องพิมพ์');
    await verifyAbout(page, `${base}/exam.html`);
    await waitExpression(page, `!!document.querySelector('#stationPrinter') && document.querySelector('#stationPrinter').checked === false`,
      'เครื่องห้องตรวจต้องตั้งเป็นโหมดพิมพ์ที่หน้าร้านให้เอง ไม่ต้องมีใครไปตั้ง');
    await waitExpression(page, `Array.from(document.querySelectorAll('#examQueue button')).some(b => b.textContent.includes('เรียกตรวจ'))`, 'ไม่พบคิวสังเคราะห์สำหรับเรียกตรวจ');
    await evaluate(page, `(() => {
      const button = Array.from(document.querySelectorAll('#examQueue button')).find(b => b.textContent.includes('เรียกตรวจ'));
      button.click(); return true;
    })()`, true);
    await waitExpression(page, `!document.querySelector('#viewExam').classList.contains('hidden') && !document.querySelector('#actionCard').classList.contains('hidden')`, 'เปิดหน้าตรวจไม่สำเร็จ');
    stage = 'ห้องตรวจ: อ่านเลขคิว';
    const queueNo = await evaluate(page, `cur.queue_no`);

    stage = 'ห้องตรวจ: ออกใบรับรอง (ไม่ควรเด้งแท็บ)';
    const certNo = await issueCertificate(page, cdpPort, false);

    // ---------- สถานีที่ 2: เครื่องหน้าร้าน เข้าผ่าน loopback (เป็นเครื่องที่ต่อเครื่องพิมพ์) ----------
    stage = 'หน้าร้าน: เปิดแท็บ + login';
    const frontCreated = await client.send('Target.createTarget', { url: 'about:blank' });
    const frontAttached = await client.send('Target.attachToTarget', { targetId: frontCreated.targetId, flatten: true });
    const front = { send: (method, params = {}) => client.send(method, params, frontAttached.sessionId) };
    await front.send('Page.enable');
    await front.send('Runtime.enable');
    await front.send('Emulation.setDeviceMetricsOverride', {
      width: cssWidth, height: cssHeight, deviceScaleFactor: viewport.dpr, mobile: false,
      screenWidth: viewport.screenWidth, screenHeight: viewport.screenHeight,
    });
    // ต้องดัก toast ให้ได้แน่นอน: ติดตั้ง observer ก่อน script ของหน้าจะรัน
    // (ถ้าไปดักหลังโหลด อาจแพ้ poll รอบแรกและจับข้อความไม่ทัน เพราะ toast อยู่บนจอแค่ 2.5 วิ)
    await front.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__toasts = [];
      document.addEventListener('DOMContentLoaded', () => {
        const collect = node => {
          if (!node || node.nodeType !== 1) return;
          if (node.id === 'toast') for (const child of node.children) window.__toasts.push(child.textContent);
          else if (node.classList && node.classList.contains('m')) window.__toasts.push(node.textContent);
        };
        new MutationObserver(records => {
          for (const record of records) for (const node of record.addedNodes) collect(node);
        }).observe(document.body, { childList: true, subtree: true });
      });
    ` });
    await front.send('Page.navigate', { url: `${hostBase}/login.html` });
    await waitExpression(front, `document.readyState === 'complete' && !!document.querySelector('#go')`, 'หน้า login ของหน้าร้านไม่พร้อม');
    await evaluate(front, `(() => {
      document.querySelector('#u').value = 'front';
      document.querySelector('#p').value = 'front123';
      document.querySelector('#go').click();
      return true;
    })()`, true);
    await waitExpression(front, `location.pathname === '/' && typeof toast === 'function'`, 'หน้าร้าน login ไม่สำเร็จ');
    await verifyAbout(front, `${hostBase}/`);
    await waitExpression(front, `ME && ME.is_host === true`, 'เครื่องหน้าร้านผ่าน loopback ต้องเป็นเครื่องที่ต่อเครื่องพิมพ์');

    // ป้าย "รอพิมพ์" ต้องมาถึงหน้าร้านเองภายในรอบ poll พร้อม toast บอกว่าหมอออกใบให้คิวไหน
    stage = 'หน้าร้าน: รอป้ายรอพิมพ์ + toast';
    const certLiteral = JSON.stringify(certNo);
    await waitFor(() => evaluate(front,
      `Array.from(document.querySelectorAll('.printwait')).some(b => b.textContent.includes(${certLiteral})) || null`),
      `หน้าร้านไม่เห็นป้ายรอพิมพ์ของ ${certNo}`, 20000);
    await waitFor(async () => {
      const seen = await evaluate(front, `window.__toasts || []`);
      return seen.some(item => item.includes('รอพิมพ์') || item.includes('ออกใบรับรองให้คิวที่')) ? seen : null;
    }, 'หน้าร้านไม่ได้แจ้งเตือนว่ามีใบรอพิมพ์', 20000);

    // กดป้ายด้วยเมาส์จริง → ต้องเปิดแท็บพิมพ์บนเครื่องหน้าร้าน
    stage = 'หน้าร้าน: กดพิมพ์';
    const beforePrint = new Set((await cdpTargets(cdpPort)).map(item => item.id));
    const badgePoint = await evaluate(front, `(async () => {
      const badge = Array.from(document.querySelectorAll('.printwait')).find(b => b.textContent.includes(${certLiteral}));
      badge.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise(resolve => { const done = () => resolve(); setTimeout(done, 300); requestAnimationFrame(() => requestAnimationFrame(done)); });
      const r = badge.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, ok: hit === badge || badge.contains(hit), hit: hit ? (hit.id || hit.className || hit.tagName) : '' };
    })()`);
    if (!badgePoint.ok) throw new Error(`ป้ายรอพิมพ์ถูกบัง: ${JSON.stringify(badgePoint)}`);
    await front.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: badgePoint.x, y: badgePoint.y, button: 'left', clickCount: 1 });
    await front.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: badgePoint.x, y: badgePoint.y, button: 'left', clickCount: 1 });
    const printTarget = await waitFor(async () => {
      const targets = await cdpTargets(cdpPort);
      return targets.find(item => !beforePrint.has(item.id) && item.url.includes(`/print/medcert/${certNo}`));
    }, `หน้าร้านกดพิมพ์แล้วไม่พบแท็บ /print/medcert/${certNo} จริง`, 20000);

    // ป้ายต้องหายเองในรอบ poll ถัดไป เพราะมี print event station=host แล้ว
    await waitExpression(front,
      `!Array.from(document.querySelectorAll('.printwait')).some(b => b.textContent.includes(${certLiteral}))`,
      'พิมพ์ที่หน้าร้านแล้วป้ายรอพิมพ์ยังไม่หาย', 20000);

    // ---------- ฟอร์มลงทะเบียนต้องไม่ซ้อนกันที่ scaling นี้ ----------
    stage = 'หน้าร้าน: ตรวจ layout ฟอร์มลงทะเบียน';
    await evaluate(front, `document.querySelector('#btnNewPat').click(); true`, true);
    const layout = await waitFor(async () => {
      const result = await evaluate(front, `(() => {
        const card = document.querySelector('#regCard');
        if (!card || card.classList.contains('hidden')) return null;
        // กรอบที่ "มองเห็นจริง" = rect ตัดกับทุก ancestor ที่ overflow ไม่ใช่ visible (ฟอร์มเป็น modal ที่ฟิลด์เลื่อนในกรอบตั้งแต่เฟส 3 —
        // ช่องที่ถูกเลื่อนพ้นกรอบไปแล้วไม่นับว่าซ้อนกับปุ่มบันทึกด้านล่าง) · จอเตี้ย 1280@150% (สูง 480px) ฟอร์มต้องเลื่อนแน่นอน
        const visibleRect = (el) => {
          let r = el.getBoundingClientRect(); let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            const o = getComputedStyle(a); if (o.overflow === 'visible' && o.overflowY === 'visible' && o.overflowX === 'visible') continue;
            const ar = a.getBoundingClientRect();
            box = { left: Math.max(box.left, ar.left), top: Math.max(box.top, ar.top), right: Math.min(box.right, ar.right), bottom: Math.min(box.bottom, ar.bottom) };
          }
          return box;
        };
        const scroller = card.querySelector('.stack');
        const collect = () => Array.from(card.querySelectorAll('input, select, button')).filter(el => {
          const r = el.getBoundingClientRect(), s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        }).map((el, i) => {
          const r = visibleRect(el);
          return { name: el.id || el.name || el.textContent.trim().slice(0, 30) || ('control-' + i), left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        }).filter(c => c.right - c.left > 1 && c.bottom - c.top > 1);
        // ตรวจสองตำแหน่ง: บนสุดและล่างสุดของกรอบเลื่อน (ให้ครอบทุกช่อง)
        const overlaps = []; let controlsSeen = 0;
        for (const pos of ['top', 'bottom']) {
          if (scroller) scroller.scrollTop = pos === 'top' ? 0 : scroller.scrollHeight;
          const controls = collect(); controlsSeen = Math.max(controlsSeen, controls.length);
          for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
            const a = controls[i], b = controls[j];
            const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (width > 1 && height > 1) overlaps.push(pos + ': ' + a.name + ' <> ' + b.name);
          }
        }
        if (scroller) scroller.scrollTop = 0;
        return { overlaps, scrollWidth: card.scrollWidth, clientWidth: card.clientWidth, controls: controlsSeen };
      })()`);
      return result && result.controls ? result : null;
    }, 'ฟอร์มลงทะเบียนไม่พร้อมตรวจ layout');
    if (layout.overlaps.length) throw new Error(`element ซ้อนกัน: ${layout.overlaps.join(', ')}`);
    if (layout.scrollWidth > layout.clientWidth + 1) throw new Error(`ฟอร์มล้นแนวนอน ${layout.scrollWidth}px > ${layout.clientWidth}px`);
    await evaluate(front, `hideReg(); true`, true);

    // ---------- จำนวนคอลัมน์หน้าร้านต้องตรงตารางจอ (เฟส 4: grid fr — 1366@125%/150% ต้อง 3 คอลัมน์ ไม่พับ) ----------
    stage = 'หน้าร้าน: นับคอลัมน์';
    const frontCols = await evaluate(front, `getComputedStyle(document.querySelector('.cols')).gridTemplateColumns.split(' ').length`);
    if (frontCols !== viewport.frontCols) throw new Error(`หน้าร้านมี ${frontCols} คอลัมน์ (คาดหวัง ${viewport.frontCols}) ที่ CSS ${cssWidth}px`);
    const pageOverflow = await evaluate(front, `document.documentElement.scrollWidth > window.innerWidth + 1`);
    if (pageOverflow) throw new Error('หน้าร้านล้นแนวนอน (มี scrollbar ซ้าย-ขวา)');

    // ---------- คิดเงิน: บิลกางใต้รายชื่อในการ์ดเดียว (F2) รายการเป็น 3 บรรทัด (F3) ไม่ล้นคอลัมน์แคบ ----------
    stage = 'หน้าร้าน: เปิดบิลคนแรกที่รอจ่าย';
    const billInfo = await evaluate(front, `(async () => {
      const b = [...document.querySelectorAll('#payQueue button')].find(x => x.textContent.includes('คิดเงิน'));
      if (!b) return { skipped: 'ไม่มีคิวรอจ่าย' };
      b.click();
      for (let i = 0; i < 40 && document.querySelector('#billBody').classList.contains('hidden'); i++) await new Promise(r => setTimeout(r, 100));
      const body = document.querySelector('#billBody'), card = document.querySelector('#payCard');
      const pay = [...body.querySelectorAll('button')].find(x => x.textContent.includes('รับเงิน'));
      const sel = document.querySelector('#payQueue .qrow.sel');
      return { hidden: body.classList.contains('hidden'), sameCard: card.contains(body), lines: body.querySelectorAll('.bline').length,
        overflow: body.scrollWidth > body.clientWidth + 1, hasPay: !!pay, selChip: !!(sel && sel.textContent.includes('กำลังคิดเงิน')) };
    })()`, true);
    if (!billInfo.skipped) {
      if (billInfo.hidden || !billInfo.sameCard) throw new Error('บิลไม่กางในการ์ดรอจ่ายเงิน');
      if (billInfo.overflow) throw new Error('บิลล้นแนวนอนในคอลัมน์ขวา');
      if (!billInfo.hasPay || !billInfo.selChip) throw new Error('บิลไม่มีปุ่มรับเงิน หรือแถวที่เลือกไม่ขึ้น "กำลังคิดเงิน"');
    }

    let crashNote = '';
    // ---------- สถานีที่ 4 (viewport แรก): ลงทะเบียนทน server ตายจริงหลัง commit — ผู้ใช้ต้อง "เห็น" HN เดิม ----------
    // incident + codex NO-GO 2026-08-24: บันทึกสำเร็จแต่คำตอบไม่ถึงจอ แล้วผู้ใช้แก้ช่อง/สลับปุ่มก่อนกดซ้ำ
    // เกตนี้ฆ่า server จริง (crash hook หลัง commit) → เปิดกลับ → กดปุ่มจริงบนฟอร์มเดิม → จอต้องพาไปหน้าคนไข้ HN เดิม
    if (crashRestart) {
      stage = 'ทน server ตาย: กรอกฟอร์ม + บันทึกแล้ว server ตายก่อนตอบ';
      // ฟอร์มลงทะเบียนเปิดค้างจากขั้นตรวจ layout แล้ว (btnNewPat ถูกกด → regOpId ถูกสร้างแล้ว)
      await evaluate(front, `(() => { const set = (id, v) => { document.getElementById(id).value = v; };
        set('r_first', 'คนไข้ทนตาย'); set('r_last', 'บราวเซอร์เกต'); document.getElementById('r_sex').value = 'M';
        set('r_cc', 'ทดสอบ server ตายหลัง commit'); return true; })()`);
      // ยิงคำขอแบบเดียวกับปุ่ม "บันทึก + เข้าคิวเลย" ด้วย op_id จริงของหน้า + สั่ง server ตายหลัง commit ก่อนตอบ
      const crashShot = await evaluate(front, `(async () => { try {
        const res = await fetch('/api/patients', { method: 'POST', signal: AbortSignal.timeout(4000),
          headers: { 'Content-Type': 'application/json',
            'X-Clinic-Test-Token': ${JSON.stringify(crashRestart.token)}, 'X-Clinic-Test-Crash': 'after-commit' },
          body: JSON.stringify({ first_name: document.getElementById('r_first').value,
            last_name: document.getElementById('r_last').value, sex: 'M', op_id: regOpId, queue: true,
            cc: document.getElementById('r_cc').value }) });
        return { answered: res.status, body: (await res.text()).slice(0, 200) }; // server ตอบได้ = crash hook ไม่ทำงาน
      } catch (e) { return { died: String(e.message || e).slice(0, 100) }; } })()`, true);
      await crashRestart.waitDown().catch(error => {
        throw new Error(`${error.message} — คำขอ crash ได้: ${JSON.stringify(crashShot)}`);
      });
      stage = 'ทน server ตาย: เปิด server กลับ';
      await crashRestart.start();
      stage = 'ทน server ตาย: แก้ช่อง + สลับปุ่ม แล้วกดซ้ำ — ต้องเห็น HN เดิม';
      await evaluate(front, `(() => { const el = document.getElementById('r_first'); el.value = el.value + 'แก้'; return true; })()`);
      await evaluate(front, `(() => {
        const button = [...document.querySelectorAll('#regCard button')].find(b => b.textContent.includes('บันทึกอย่างเดียว'));
        button.click(); return true; })()`, true);
      // ผลที่ตาผู้ใช้ต้องเห็น (P4): ฟอร์มปิด+ถูกล้าง, การ์ดคนไข้ HN เดิมเปิด, toast บอกว่าบันทึกไปแล้ว
      await waitExpression(front, `document.querySelector('#regCard').classList.contains('hidden')
        && !document.querySelector('#patCard').classList.contains('hidden')
        && document.querySelector('#patCard').textContent.includes('คนไข้ทนตาย')
        && /HN \\d{2}-\\d{4}/.test(document.querySelector('#patCard').textContent)
        && document.getElementById('r_first').value === ''`,
      'กดซ้ำหลัง server ตายแล้วต้องพาไปหน้าคนไข้ HN เดิม (ฟอร์มปิด+ล้าง) ไม่ใช่ลงทะเบียนซ้ำ', 20000);
      await waitFor(async () => {
        const seen = await evaluate(front, `window.__toasts || []`);
        return seen.some(item => item.includes('ไม่ต้องลงทะเบียนซ้ำ')) ? seen : null;
      }, 'ต้องมีข้อความบอกว่าข้อมูลถูกบันทึกไปแล้ว ไม่ต้องลงทะเบียนซ้ำ', 10000);
      const crashOutcome = await evaluate(front, `(async () => {
        const found = await api('GET', '/api/patients/search?q=' + encodeURIComponent('คนไข้ทนตาย'));
        const q = await api('GET', '/api/queue');
        const hn = found.length === 1 ? found[0].hn : null;
        return { patients: found.length, visits: q.queue.filter(v => v.hn === hn).length, hn }; })()`);
      if (crashOutcome.patients !== 1 || crashOutcome.visits !== 1) {
        throw new Error(`server ตายหลัง commit แล้วกดซ้ำ ต้องได้คนไข้ 1 คิว 1 — ได้ ${JSON.stringify(crashOutcome)}`);
      }
      crashNote = `; server ตายหลัง commit→กดซ้ำ(แก้ช่อง+สลับปุ่ม)→เห็น HN เดิม ${crashOutcome.hn} คนไข้ 1 คิว 1`;
    }


    // ---------- เครื่องที่ "มีเครื่องพิมพ์" ต้องทำงานแบบเดิมทุกอย่าง (ของเดิมห้าม regress) ----------
    let hostDoctorNote = '';
    if (checkHostDoctor) {
      stage = 'ห้องตรวจ: สลับเป็นโหมดมีเครื่องพิมพ์';
      await evaluate(page, `(() => {
        const box = document.querySelector('#stationPrinter');
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        return true;
      })()`, true);
      await waitExpression(page, `stationHasPrinter() === true`, 'สลับเป็นโหมดมีเครื่องพิมพ์ไม่สำเร็จ');
      const overrideCert = await issueCertificate(page, cdpPort, true);
      hostDoctorNote = `; โหมดมีเครื่องพิมพ์เปิดแท็บ ${overrideCert} เอง`;

      // ---------- สถานีที่ 3: ผู้ดูแลบนเครื่องหลัก กด "อัปเดตตอนนี้" แล้ว server เปิดใหม่ (session หาย) ----------
      // บั๊กจริง 2026-08-19: อัปเดตเสร็จใน 6 วิ แต่หน้าค้าง "กำลังอัปเดต" 5 นาที จนเจ้าของกด F5 เอง
      // จำลอง "server ใหม่ขึ้นแล้ว session เดิมใช้ไม่ได้" ด้วยการ logout ใต้หน้าจอ → ตัวเฝ้าต้องพาไป login พร้อมบอกว่าเป็นเรื่องปกติ
      // → login กลับมาแล้วต้องเห็นแถบผลค้าง (เขียว) ไม่ใช่แค่ toast — ใช้รุ่นปัจจุบันเป็น "รุ่นที่อัปเดต" ให้เส้นทางสำเร็จตรวจได้โดยไม่ต้องสลับไฟล์จริง
      stage = 'ผู้ดูแล: login + เปิดหน้าตั้งค่า';
      const adminCreated = await client.send('Target.createTarget', { url: 'about:blank' });
      const adminAttached = await client.send('Target.attachToTarget', { targetId: adminCreated.targetId, flatten: true });
      const adminTab = { send: (method, params = {}) => client.send(method, params, adminAttached.sessionId) };
      await adminTab.send('Page.enable');
      await adminTab.send('Runtime.enable');
      await adminTab.send('Emulation.setDeviceMetricsOverride', { width: cssWidth, height: cssHeight, deviceScaleFactor: viewport.dpr, mobile: false, screenWidth: viewport.screenWidth, screenHeight: viewport.screenHeight });
      await adminTab.send('Page.navigate', { url: `${hostBase}/login.html` });
      await waitExpression(adminTab, `document.readyState === 'complete' && !!document.querySelector('#go')`, 'หน้า login ผู้ดูแลไม่พร้อม');
      await evaluate(adminTab, `(() => { document.querySelector('#u').value = 'admin'; document.querySelector('#p').value = 'admin1234'; document.querySelector('#go').click(); return true; })()`, true);
      await waitExpression(adminTab, `location.pathname === '/admin.html' && typeof adminReady !== 'undefined' && adminReady`, 'ผู้ดูแลต้องเข้าพื้นที่ตั้งค่าโดยไม่ผ่านหน้าร้าน');
      await adminTab.send('Page.navigate', { url: `${hostBase}/admin.html?section=system` });
      await waitExpression(adminTab, `location.pathname === '/admin.html' && typeof watchUpdateProgress === 'function' && ME && ME.role === 'admin' && !!document.querySelector('#updateSummary')`, 'หน้าตั้งค่าไม่พร้อม');
      stage = 'ผู้ดูแล: เริ่มเฝ้าอัปเดตแล้ว session หาย';
      await verifyAbout(adminTab, `${hostBase}/admin.html?section=system`, true);
      const currentVersion = await evaluate(adminTab, `api('GET', '/api/update/status').then(st => st.current_version)`);
      if (!currentVersion) throw new Error('อ่านรุ่นปัจจุบันจาก /api/update/status ไม่ได้');
      await evaluate(adminTab, `(() => {
        watchUpdateProgress(document.querySelector('#updateSummary'), ${JSON.stringify(currentVersion)});
        return fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => true);
      })()`, true);
      const summaryText = await evaluate(adminTab, `document.querySelector('#updateSummary') ? document.querySelector('#updateSummary').textContent : ''`);
      if (!/กำลังอัปเดต/.test(summaryText)) throw new Error(`กดอัปเดตแล้วต้องบอกว่ากำลังอัปเดตทันที: ${JSON.stringify(summaryText)}`);
      await waitExpression(adminTab, `location.pathname === '/login.html' && document.readyState === 'complete'
        && !document.querySelector('#restartNote').classList.contains('hidden') && /อัปเดต/.test(document.querySelector('#restartNote').textContent)`,
        'session หายหลังอัปเดตแล้วต้องพาไปหน้า login พร้อมข้อความบอกว่าเป็นเรื่องปกติของการอัปเดต', 20000);
      stage = 'ผู้ดูแล: login กลับมาต้องเห็นผลอัปเดต';
      await evaluate(adminTab, `(() => { document.querySelector('#u').value = 'admin'; document.querySelector('#p').value = 'admin1234'; document.querySelector('#go').click(); return true; })()`, true);
      await waitExpression(adminTab, `location.pathname === '/admin.html' && !!document.querySelector('#updateResultBanner')
        && document.querySelector('#updateResultBanner').classList.contains('green') && /เรียบร้อย/.test(document.querySelector('#updateResultBanner').textContent)`,
        'กลับจาก login แล้วต้องเห็นแถบเขียวบอกว่าอัปเดตเรียบร้อย (ไม่ใช่แค่ toast)', 20000);
      const bannerSeen = await evaluate(adminTab, `(() => { const r = document.querySelector('#updateResultBanner').getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight; })()`);
      if (!bannerSeen) throw new Error('แถบผลอัปเดตต้องอยู่ในจอที่มองเห็นได้ทันที');
      if (await evaluate(adminTab, `localStorage.getItem('clinic_update_started')`)) throw new Error('ธง clinic_update_started ต้องถูกลบหลังแสดงผลแล้ว');
      hostDoctorNote += `; ผู้ดูแลกดอัปเดต→session หาย→login→เห็นแถบเขียวรุ่น ${currentVersion}`;
    }

    stage = 'นัดหมาย: ติดตาม/โทร/นัดใหม่/ผลบนจอ';
    await verifyAppointmentFollowup({page,front,base,hostBase,id:appointmentId,crashRestart,viewport,cdpPort});
    stage = 'รายงานยารายเดือน: สองสถานี';
    await verifyMonthlyDrugs(page, base, viewport);
    await verifyMonthlyDrugs(front, hostBase, viewport);
    stage = 'ใบยาอ่านง่าย: ตั้งค่า/พิมพ์/ขนาดจริง/ตอบกลับหาย';
    await verifyMedicationSheet({page,front,base,hostBase,receiptNo:medicationReceipt,viewport,first:checkHostDoctor});
    stage = 'ฉลากยา: เลือกรายการ / ข้อความล้น / พิมพ์ซ้ำ / ช่องกระดาษจริง';
    await require('./test-drug-labels-browser')({page,front,base,hostBase,receiptNo:medicationReceipt,viewport,first:checkHostDoctor,evaluate,waitExpression,clickControl:clickAppointmentControl,ApiSession});
    stage = 'admin: หมวด/บันทึกเฉพาะหน้า/ตอบกลับหาย/ลิงก์ตรง';
    await verifyAdminPages(front, [hostBase,base], viewport, cdpPort);
    stage = 'หมอหลายคน: profile แยก / นัดกลับหมอเดิม / ซ่อนเมื่อหมอคนเดียว';
    await require('./test-multi-doctor-browser')({client,page,admin:front,base,hostBase,viewport,evaluate,waitExpression});
    stage = 'ต้นทุนหัตถการ: เพิ่ม/แก้/คำตอบหาย/รายงาน';
    await require('./test-service-cost-browser')({tab:front,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
    await require('./test-solo-doctor-browser')({tab:front,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
    stage = 'ตารางวิธีใช้เริ่มต้น: คลังยาไปห้องตรวจ / คำตอบหาย / ข้อความเก่า';
    await require('./test-dose-defaults-browser')({tab:front,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
    await require('./test-stock-warnings-browser')({tab:front,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
    await require('./test-recording-browser')({tab:front,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
    await require('./test-backup-status-browser')({tab:front,origins:[hostBase,base],viewport,cloudDir:backupCloudDir,evaluate,waitExpression,clickControl:clickAppointmentControl});
    await require('./test-password-recovery-browser')({tab:front,origins:[hostBase,base],viewport,cloudDir:backupCloudDir,evaluate,waitExpression,clickControl:clickAppointmentControl});
    await require('./test-trial-tools-browser')({tab:front,origins:[hostBase,base],viewport,evaluate,waitExpression,clickControl:clickAppointmentControl});
    console.log(`  PASS ${viewport.screenWidth}x${viewport.screenHeight}@${viewport.dpr} (CSS ${cssWidth}x${cssHeight})`
      + ` → หมอออก ${certNo} ที่คิว ${queueNo} โดยไม่เด้งแท็บ, หน้าร้านพิมพ์ ${new URL(printTarget.url).pathname}`
      + `; registration ${layout.controls} controls ไม่ซ้อน; หน้าร้าน ${frontCols} คอลัมน์${billInfo.skipped ? '' : `, บิล ${billInfo.lines} รายการไม่ล้น`}${crashNote}${hostDoctorNote}`);
  } catch (error) {
    const useful = edgeLogs.trim().split(/\r?\n/).slice(-5).join(' | ');
    throw new Error(`[${stage}] ${error.message}${useful ? `; Edge: ${useful}` : ''}`);
  } finally {
    if (client) client.close();
    await stopChild(edgeProcess);
  }
}

(async () => {
  if (typeof WebSocket !== 'function') throw new Error('Node รุ่นนี้ไม่มี global WebSocket (ต้องใช้ Node.js >= 22.5)');
  const edge = findEdge();
  const lanIp = findLanIPv4();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-browser-data-'));
  const backupCloudDir = path.join(dataDir, 'cloud-status-synthetic');
  fs.mkdirSync(backupCloudDir);
  fs.writeFileSync(path.join(backupCloudDir, 'not-a-directory'), 'synthetic fixture');
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-edge-profile-'));
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-browser-cert-'));
  const token = crypto.randomBytes(24).toString('hex');
  const serverPort = randomPort(20000, 15000);
  const httpsPort = serverPort + 363;
  // A-refined: LAN ต้อง HTTPS → สร้าง cert สังเคราะห์ให้ server; process ทดสอบนี้ข้ามการตรวจ CA (self-signed) เฉพาะที่นี่
  require('./lib/cert').generateCert({ outDir: certDir, ips: ['127.0.0.1', lanIp], name: 'ClinicApp-BrowserTest', years: 1 });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const env = {
    ...process.env,
    CLINIC_DATA_DIR: dataDir,
    CLINIC_PORT: String(serverPort),
    CLINIC_HTTPS_PORT: String(httpsPort),
    CLINIC_CERT_DIR: certDir,
    CLINIC_TEST_INSTANCE_TOKEN: token,
    CLINIC_IDLE_LOCK_MS: String(10 * 60 * 1000),
  };
  let server = null;
  try {
    const seeded = spawnSync(process.execPath, ['--no-warnings', 'seed.js', '--demo'], { cwd: __dirname, env, encoding: 'utf8' });
    if (seeded.status !== 0) throw new Error(seeded.stderr || seeded.stdout || 'seed failed');
    const trainingSeed=spawnSync(process.execPath,['--no-warnings','-e',"require('./seed-trial-lots').ensureTrialLots({freshSeed:true}); require('./seed-trial-dose-defaults').ensureTrialDoseDefaults({freshSeed:true}); require('./lib/db').db.close();"],{cwd:__dirname,env,encoding:'utf8',windowsHide:true});
    if(trainingSeed.status!==0)throw Error(trainingSeed.stderr||'training fixture failed');
    const serviceSeed=spawnSync(process.execPath,['--no-warnings','-e',`const {db,today}=require('./lib/db');
db.exec("INSERT INTO patients(hn,first_name,sex,created_at) VALUES('SERVICE-SYNTH','สังเคราะห์ต้นทุน','F','2020-03-15'); INSERT INTO visits(hn,visit_date,queue_no,state,created_by,created_at) VALUES('SERVICE-SYNTH','2020-03-15',1,'COMPLETED',1,'2020-03-15 12:00:00')");
const v=db.prepare("SELECT id FROM visits WHERE hn='SERVICE-SYNTH'").get().id;
const ov=Number(db.prepare("INSERT INTO order_versions(visit_id,version,lines_json,created_by,created_at) VALUES(?,1,'[]',1,'2020-03-15 12:00:00')").run(v).lastInsertRowid);
db.prepare("INSERT INTO receipts(receipt_no,visit_id,hn,patient_name,order_version_id,subtotal,discount,total,pay_method,status,created_by,created_at) VALUES('SERVICE-SYNTH',?,'SERVICE-SYNTH','สมมติ',?,300,0,300,'cash','ISSUED',1,'2020-03-15 12:00:00')").run(v,ov);
db.exec("INSERT INTO receipt_lines(receipt_no,line_type,name,qty,unit,price_each,amount,cost_each) VALUES('SERVICE-SYNTH','service','หัตถการสังเคราะห์',1,'ครั้ง',300,300,120)");
// Real immutable historical snapshots with unknown service costs in two months.
// Keep them off today's date so other browser flows keep their daily fixtures.
const year=today().slice(0,4),day=today().endsWith('-01')?'02':'01';
for(const month of ['01','02']){
 const date=year+'-'+month+'-'+day,stamp=date+' 12:00:00',receipt='SERVICE-UNKNOWN-SYNTH-'+month;
 const queue=db.prepare('SELECT COALESCE(MAX(queue_no),0)+1 AS next FROM visits WHERE visit_date=?').get(date).next;
 const visit=Number(db.prepare("INSERT INTO visits(hn,visit_date,queue_no,state,created_by,created_at) VALUES('SERVICE-SYNTH',?,?,'COMPLETED',1,?)").run(date,queue,stamp).lastInsertRowid);
 const order=Number(db.prepare("INSERT INTO order_versions(visit_id,version,lines_json,created_by,created_at) VALUES(?,1,'[]',1,?)").run(visit,stamp).lastInsertRowid);
 db.prepare("INSERT INTO receipts(receipt_no,visit_id,hn,patient_name,order_version_id,subtotal,discount,total,pay_method,status,created_by,created_at) VALUES(?,?,'SERVICE-SYNTH','สมมติต้นทุนบริการ',?,300,0,300,'cash','ISSUED',1,?)").run(receipt,visit,order,stamp);
 db.prepare("INSERT INTO receipt_lines(receipt_no,line_type,name,qty,unit,price_each,amount,cost_each) VALUES(?,'service','หัตถการสังเคราะห์ไม่ระบุทุน',1,'ครั้ง',300,300,NULL)").run(receipt);
}
db.close();`],{cwd:__dirname,env,encoding:'utf8',windowsHide:true});
    if(serviceSeed.status!==0)throw Error(serviceSeed.stderr);
    const apptSeed = spawnSync(process.execPath,['--no-warnings','-e',`const {db,now,today}=require('./lib/db');const p=require('./lib/patients');const user=db.prepare("SELECT id FROM users WHERE username='front'").get().id;const d=new Date(today()+'T00:00:00');d.setDate(d.getDate()-2);const past=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');const ids=[];for(let i=0;i<4;i++){const hn=p.register({first_name:'ติดตามสังเคราะห์'+i,last_name:'ทดสอบชื่อและนามสกุลภาษาไทยยาว',phone:'0800000000',sex:'F'},user);ids.push(Number(db.prepare('INSERT INTO appointments (hn,appt_date,days,created_by,created_at) VALUES (?,?,?,?,?)').run(hn,past,0,user,now()).lastInsertRowid));}console.log(JSON.stringify(ids));db.close();`],{cwd:__dirname,env,encoding:'utf8',windowsHide:true});
    if(apptSeed.status!==0)throw Error(apptSeed.stderr);
    const appointmentIds=JSON.parse(apptSeed.stdout.trim());

    server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
      cwd: __dirname,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let serverError = '';
    server.stderr.on('data', chunk => { serverError += chunk; });
    const base = `https://${lanIp}:${httpsPort}`;
    await waitReady(base, token).catch(error => { throw new Error(`${error.message}${serverError ? `: ${serverError}` : ''}`); });

    const admin = new ApiSession(base);
    await admin.request('POST', '/api/login', { username: 'admin', password: 'admin1234' });
    const users = await admin.request('GET', '/api/users');
    const doctor = users.find(user => user.username === 'doctor');
    if (!doctor) throw new Error('seed ไม่มีบัญชีแพทย์สังเคราะห์');
    await admin.request('PATCH', `/api/users/${doctor.id}`, { medical_license: 'ว.ทดสอบ-0001' });

    const front = new ApiSession(base);
    await front.request('POST', '/api/login', { username: 'front', password: 'front123' });
    for (let i = 0; i < VIEWPORTS.length; i++) {
      const suffix = `${Date.now()}-${i}`;
      const patient = await front.request('POST', '/api/patients', {
        prefix: 'นางสาว', first_name: `คนไข้ทดสอบ${i + 1}`, last_name: 'สังเคราะห์', sex: 'F',
        phone: `08000000${i}`, note: `browser synthetic ${suffix}`,
      });
      await front.request('POST', '/api/visits', { hn: patient.hn, cc: `ทดสอบ browser ${suffix}`, vitals: {} });
    }
    // คิวรอจ่ายเงิน 1 คน (หมอตรวจเสร็จ สั่งค่าตรวจ+ยา 1 ตัว) — ให้ทุก viewport ทดสอบบิลกางในการ์ดรอจ่าย/รายการ 3 บรรทัดได้ (เฟส 4)
    {
      const doc = new ApiSession(base);
      await doc.request('POST', '/api/login', { username: 'doctor', password: 'doctor123' });
      const payPatient = await front.request('POST', '/api/patients', { prefix: 'นาย', first_name: 'คนไข้รอจ่าย', last_name: 'สังเคราะห์', sex: 'M', phone: '0800000099' });
      const payVisit = await front.request('POST', '/api/visits', { hn: payPatient.hn, cc: 'ทดสอบบิล', vitals: {} });
      const items = await doc.request('GET', '/api/items/search?q=');
      const service = items.find(x => x.type === 'service'), drug = items.find(x => x.type === 'drug');
      const lines = [service, drug].filter(Boolean).map(it => ({ type: it.type, ref_id: it.id, name: it.name, qty: 1, unit: it.unit, price_each: it.price, instructions: it.type === 'drug' ? '1 เม็ด วันละ 3 ครั้ง หลังอาหาร' : '' }));
      await doc.request('POST', `/api/visits/${payVisit.id}/call`, {});
      await doc.request('POST', `/api/visits/${payVisit.id}/finish-exam`, { note: { cc: 'ทดสอบบิล', dx_text: 'ตรวจสุขภาพ' }, lines, base_version_id: null });
    }

    let medicationReceipt;
    // A paid synthetic bill specifically proves visible report arithmetic, not only an empty table.
    {
      const doc = new ApiSession(base);
      await doc.request('POST','/api/login',{username:'doctor',password:'doctor123'});
      const known = await front.request('POST','/api/drugs',{name:'ยาสังเคราะห์รายงาน A',unit:'เม็ด',price:10,cost:2});
      const unknown = await front.request('POST','/api/drugs',{name:'ยาสังเคราะห์รายงาน B',unit:'เม็ด',price:10,cost:null});
      for(const item of [known,unknown]) await front.request('POST',`/api/drugs/${item.id}/receive`,{qty:100,reason:'ข้อมูลสังเคราะห์',expiry_date:'2027-12-31',op_id:crypto.randomUUID()});
      const patient = await front.request('POST','/api/patients',{first_name:'รายงานยา',last_name:'สังเคราะห์',sex:'F'});
      const visit = await front.request('POST','/api/visits',{hn:patient.hn});
      await doc.request('POST',`/api/visits/${visit.id}/call`,{});
      const order = await doc.request('POST',`/api/visits/${visit.id}/finish-exam`,{note:{cc:'สังเคราะห์',dx_text:'ทดสอบรายงาน'},lines:[{type:'drug',ref_id:known.id,qty:10,dose:{mode:'standard',m:1,e:1,timing:'หลังอาหาร',days:5}},{type:'drug',ref_id:unknown.id,qty:10,instructions:'คำสั่งสังเคราะห์แบบเมื่อมีอาการ\nคงข้อความเดิมที่แพทย์บันทึก ไม่แปลงเป็นมื้ออาหาร\nตัวอย่างเพิ่มเติมสำหรับตรวจการขึ้นหน้าถัดไปเมื่อใช้ A5 ตัวใหญ่พิเศษ'}],base_version_id:null});
      const paid=await front.request('POST',`/api/visits/${visit.id}/pay`,{order_version_id:order.order.id,discount:20,discount_reason:'สังเคราะห์',pay_method:'cash',op_id:crypto.randomUUID()});
      medicationReceipt=paid.receiptNo;
    }
    console.log(`BROWSER OUTCOME TEST — ห้องตรวจผ่าน HTTPS LAN ${lanIp}:${httpsPort}, หน้าร้านผ่าน HTTP 127.0.0.1, fresh profile, synthetic temp DB`);
    // สถานีที่ 4 (viewport แรก) ฆ่า server จริงแล้วเปิดกลับ — helper นี้คุม lifecycle ของ server ที่ viewport ใช้ร่วมกัน
    const crashRestart = {
      token,
      waitDown: () => waitFor(async () => {
        try { await fetch(`${base}/api/test-instance`, { headers: { 'X-Clinic-Test-Token': token } }); return null; }
        catch { return true; }
      }, 'server ไม่ตายตาม crash hook', 10000),
      start: async () => {
        server = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: __dirname, env, stdio: 'ignore', windowsHide: true });
        await waitReady(base, token);
      },
    };
    for (let i = 0; i < VIEWPORTS.length; i++) {
      const profileDir = path.join(profileRoot, `viewport-${i + 1}`);
      fs.mkdirSync(profileDir, { recursive: true });
      await runViewport({
        edge,
        base,
        hostBase: `http://127.0.0.1:${serverPort}`,
        cdpPort: randomPort(36000, 15000),
        viewport: VIEWPORTS[i],
        checkHostDoctor: i === 0,
        profileDir,
        crashRestart: i === 0 ? crashRestart : null,
        appointmentId: appointmentIds[i],
        medicationReceipt,
        backupCloudDir,
      });
    }
    if (process.env.CLINIC_BROWSER_STOCK_ONLY === '1') {
      console.log(`STOCK WARNINGS BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} focused, NOT the full browser gate`);
    } else if (process.env.CLINIC_BROWSER_VITALS_ONLY === '1') {
      console.log(`VITALS BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} focused, NOT the full browser gate`);
    } else if (process.env.CLINIC_BROWSER_DOSE_UNITS_ONLY === '1') {
      console.log(`DOSE UNITS BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} focused, NOT the full browser gate`);
    } else if (process.env.CLINIC_BROWSER_RECORDING_ONLY === '1') {
      console.log(`RECORDING BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} focused, NOT the full browser gate`);
    } else if (process.env.CLINIC_BROWSER_TRIAL_TOOLS_ONLY === '1') {
      console.log(`TRIAL UI BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} focused; helper boundary mocked`);
    } else if (process.env.CLINIC_BROWSER_PASSWORD_ONLY === '1') {
      console.log(`PASSWORD BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} focused, NOT the full browser gate`);
    } else if (process.env.CLINIC_BROWSER_BACKUP_ONLY === '1') {
      console.log(`BACKUP STATUS BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} targeted, NOT the full browser gate`);
    } else if (process.env.CLINIC_BROWSER_SOLO_ONLY === '1') {
      console.log('SOLO BROWSER PASS: 4/4 targeted, not full browser gate');
    } else if (process.env.CLINIC_BROWSER_SERVICE_COST_ONLY === '1') {
      console.log(`SERVICE COST BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} targeted, NOT the full browser gate`);
    } else if (process.env.CLINIC_BROWSER_LABELS_ONLY === '1') {
      console.log(`LABELS BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} targeted, NOT the full browser gate`);
    } else if (process.env.CLINIC_BROWSER_MULTI_DOCTOR_ONLY === '1') {
      console.log(`MULTI DOCTOR BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} targeted, NOT the full browser gate`);
    } else if (process.env.CLINIC_BROWSER_ADMIN_ONLY === '1') {
      console.log(`\nADMIN BROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} viewports × 2 origins — targeted admin only, NOT the full browser gate`);
    } else {
      console.log(`\nBROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} viewports — ห้องตรวจไม่เด้งแท็บ, หน้าร้านพิมพ์ได้จริงและป้ายหาย, ฟอร์มไม่ซ้อน`);
    }
  } finally {
    await stopChild(server);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(profileRoot, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(certDir, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(`BROWSER FAIL: ${error.message}`);
  process.exitCode = 1;
});
