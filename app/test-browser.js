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
  await evaluate(page, `(() => { const a = [...document.querySelectorAll('.topbar nav a')].find(a => /เกี่ยวกับโปรแกรม|ตั้งค่า/.test(a.textContent)); if (!a) throw new Error('ไม่พบทางไปเกี่ยวกับโปรแกรม'); a.click(); return true; })()`, true);
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

async function runViewport({ edge, base, hostBase, cdpPort, viewport, checkHostDoctor, profileDir, crashRestart }) {
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
        const res = await fetch('/api/patients', { method: 'POST',
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
      await waitExpression(adminTab, `location.pathname === '/' && typeof toast === 'function'`, 'ผู้ดูแล login ไม่สำเร็จ');
      await adminTab.send('Page.navigate', { url: `${hostBase}/admin.html` });
      await waitExpression(adminTab, `location.pathname === '/admin.html' && typeof watchUpdateProgress === 'function' && ME && ME.role === 'admin' && !!document.querySelector('#updateSummary')`, 'หน้าตั้งค่าไม่พร้อม');
      stage = 'ผู้ดูแล: เริ่มเฝ้าอัปเดตแล้ว session หาย';
      await verifyAbout(adminTab, `${hostBase}/admin.html`, true);
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
      });
    }
    console.log(`\nBROWSER PASS: ${VIEWPORTS.length}/${VIEWPORTS.length} viewports — ห้องตรวจไม่เด้งแท็บ, หน้าร้านพิมพ์ได้จริงและป้ายหาย, ฟอร์มไม่ซ้อน`);
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
