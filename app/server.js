'use strict';
// Must run before loading db.js: a half-finished reset must never seed an empty DB.
if(require('./lib/trial-start-guard')(__dirname))process.exit(12);
// ระบบบริหารคลินิก offline — zero dependency: node:http + node:sqlite
// เครื่องหน้าคลินิกเป็น host, เครื่องห้องตรวจเปิด browser มาที่ http://<ip>:8080
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// log ถาวร + crash handler ต้องติดก่อน require ตัวอื่นทั้งหมด — lib/db โยน SCHEMA_TOO_NEW ตอน require ได้
// (incident 2026-08-24: server หายกลางงานโดยไม่เหลือหลักฐานใดๆ เพราะไม่มี log/handler)
const applog = require('./lib/applog');
applog.install(applog.makeLogger('server'));

require('./lib/recovery-core').recoverInterruptedPublications(process.env.CLINIC_DATA_DIR || path.join(__dirname, 'data'));
const { db, now, txn, getSetting, setSetting, DATA_DIR, ATTACH_DIR, ASSET_DIR } = require('./lib/db');
const clientOps = require('./lib/client-ops');
clientOps.prune(); // registry กัน retry เก็บ 7 วันพอ — เก็บกวาดตอนบูต
const auth = require('./lib/auth');
const patients = require('./lib/patients');
const visits = require('./lib/visits');
const notes = require('./lib/notes');
const stock = require('./lib/stock');
const billing = require('./lib/billing');
const backup = require('./lib/backup');
const recoveryService = require('./lib/recovery-service');
const reports = require('./lib/reports');
const print = require('./lib/print');
const appts = require('./lib/appointments');
const doctors = require('./lib/doctors');
const printEvents = require('./lib/print-events');
const { UpdateService, entitlementAllowsUpdate } = require('./lib/update-service');
const security = require('./lib/security');
const lanStatus = require('./lib/lan-status');

const PORT = Number(process.env.CLINIC_PORT || getSetting('port', '8080'));
// Browsers share cookies across ports. Keep trial and live logins separate on one host/profile.
const SESSION_COOKIE = getSetting('demo_mode', '0') === '1' ? 'csid_trial' : 'csid_live';
const PUBLIC_DIR = path.join(__dirname, 'public');
// สร้าง token ใหม่ทุกครั้งที่เปิดเซิร์ฟเวอร์ — token เก่าที่อาจหลุดจะใช้สั่งหยุดระบบไม่ได้อีก
// เขียนลงดิสก์เฉพาะหลัง bind พอร์ตสำเร็จ (ดูใน server.listen) — กัน process ที่เปิดซ้ำแล้ว
// bind ไม่ได้ มาเขียนทับ token ของ server ตัวที่กำลังรันอยู่จนสั่งหยุดอย่างปลอดภัยไม่ได้
const RECOVERY_CONTROL_FILE = path.join(DATA_DIR, 'recovery-control.token');
const RECOVERY_CONTROL_TOKEN = crypto.randomBytes(32).toString('hex');
const TEST_INSTANCE_TOKEN = process.env.CLINIC_TEST_INSTANCE_TOKEN || '';
const updateService = new UpdateService({ appRoot: __dirname, installRoot: path.join(__dirname, '..'), dataDir: DATA_DIR });

const isLoopbackAddress = security.isLoopbackAddress;

function requireHostLoopback(ctx) {
  if (!isLoopbackAddress(ctx.req.socket.remoteAddress)) {
    throw Object.assign(new Error('อัปเดตได้เฉพาะเครื่องหลักที่เปิดระบบคลินิกอยู่เท่านั้น'), { status: 403 });
  }
}

// ---- clock sanity (plan §3 + security round 1 S7): นาฬิกา host ย้อนหลังกว่าข้อมูลใน DB → บล็อกการเขียนทั้งหมด ----
// ตรวจตอนบูต + ทุก 10 นาที + เมื่อกดขอตรวจ; ตั้งเวลาถูกแล้วปลดเองไม่ต้อง restart
let clockError = null;
function checkClock() {
  const q = t => { try { return db.prepare(`SELECT MAX(created_at) m FROM ${t}`).get().m; } catch { return null; } };
  const maxTs = [q('visits'), q('receipts'), q('note_versions'), q('stock_movements'), q('med_certs')]
    .filter(Boolean).sort().pop();
  const behind = !!(maxTs && now() < maxTs.slice(0, 16)); // เทียบถึงระดับนาที เผื่อ clock drift เล็กน้อย
  if (behind && !clockError) {
    clockError = `นาฬิกาเครื่องนี้ (${now()}) ย้อนหลังกว่าข้อมูลล่าสุดในระบบ (${maxTs}) — ` +
      'กรุณาตั้งเวลาเครื่องให้ถูกต้อง (Settings > Time) ระบบจะกลับมารับข้อมูลเองภายใน 10 นาที หรือกด "ตรวจนาฬิกาอีกครั้ง" ระหว่างนี้ระบบไม่รับบันทึกข้อมูลใหม่';
    console.error('CLOCK ERROR:', clockError);
  } else if (!behind && clockError) {
    console.error('CLOCK OK: นาฬิกาถูกต้องแล้ว กลับมารับข้อมูลตามปกติ');
    clockError = null;
  }
  return clockError;
}
checkClock();
setInterval(checkClock, 10 * 60 * 1000).unref();

// Trial-only fixtures are absent from production packages. Each helper independently
// checks install profile, exact data directory and demo_mode before writing once.
if (!clockError) {
  for (const [file, entry] of [['seed-trial-lots.js', 'ensureTrialLots'], ['seed-trial-dose-defaults.js', 'ensureTrialDoseDefaults']]) {
    if (fs.existsSync(path.join(__dirname, file))) require('./' + file)[entry]();
  }
}

// ---- ชุดทดลอง: เปิดวันใหม่ให้เอง (demo_mode เท่านั้น — ดู lib/demo-day.js) บูต + ทุก 10 นาที (จับข้ามเที่ยงคืน) ----
// ห้ามเขียนตอน clock error (เหตุผลเดียวกับที่บล็อก HTTP write): จะสร้าง visit ที่เวลาย้อนหลังกว่าข้อมูลเดิม
const demoDay = require('./lib/demo-day');
function demoRollover() { if (!clockError) demoDay.runSafely(); }
demoRollover();
setInterval(demoRollover, 10 * 60 * 1000).unref();

// ---- tiny router ----
const routes = [];
function route(method, pattern, handler, opts = {}) {
  routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, opts });
}
function matchRoute(method, urlPath) {
  const segs = urlPath.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (r.parts[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { ...r, params };
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.webp': 'image/webp',
};

// security headers ทั่วระบบ (S5): กันฝังใน iframe เว็บอื่น, กัน MIME sniff, ไม่ส่ง referrer ออกไป
// CSP หน้าแอปยังต้องมี 'unsafe-inline' เพราะ UI ใช้ onclick= ทั่วทั้งระบบ — ค่อยย้ายรอบถัดไป
const BASE_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'; form-action 'self'",
};
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  const extra = isObj ? { 'Cache-Control': 'no-store' } : {};
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...BASE_HEADERS, ...extra, ...headers });
  res.end(data);
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      // ห้าม destroy ตรงนี้ — ตัด socket ก่อนคำตอบ 413 ถึง browser จะกลายเป็น "ติดต่อเครื่องหลักไม่ได้"
      // (ผู้ใช้ไม่มีทางรู้ว่าไฟล์ใหญ่เกิน) → pause แล้วให้ handleRequest ตอบ 413 ก่อน ค่อยปิด socket
      if (size > limit) { reject(Object.assign(new Error('ไฟล์ใหญ่เกินไป (เกิน 30 MB) — ย่อไฟล์แล้วลองใหม่'), { status: 413 })); req.pause(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const kv of (req.headers.cookie || '').split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

// role guard แบบ least privilege: ไม่ให้ admin กลายเป็นแพทย์/หน้าคลินิกโดยปริยาย
// เรียกโดยไม่ระบุ role = admin-only
function requireRole(ctx, ...roles) {
  if ((roles.length === 0 && ctx.session.role === 'admin') || roles.includes(ctx.session.role) || (roles.includes('front') && ctx.session.canFrontDesk === true)) return;
  throw Object.assign(new Error('สิทธิ์ไม่พอสำหรับการทำรายการนี้'), { status: 403 });
}

function requireVisitDoctor(ctx, visitId) {
  requireRole(ctx, 'doctor');
  const v = visits.get(Number(visitId));
  if (!v) throw Object.assign(new Error('ไม่พบ visit'), { status: 404 });
  if (!v.doctor_id) throw Object.assign(new Error('visit ยังไม่ถูกเรียกตรวจ'), { status: 409 });
  if (v.doctor_id !== ctx.session.userId) {
    throw Object.assign(new Error('รายการนี้เป็น visit ของแพทย์ท่านอื่น'), { status: 403 });
  }
  return v;
}

// ==================== auth ====================
if (TEST_INSTANCE_TOKEN) route('GET', '/api/test-instance', ctx => {
  const supplied = Buffer.from(String(ctx.req.headers['x-clinic-test-token'] || ''));
  const expected = Buffer.from(TEST_INSTANCE_TOKEN);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(ctx.res, 403, { error: 'test guard failed' });
  send(ctx.res, 200, { ok: true, isolated: true });
}, { public: true });

// cookie ติด Secure เมื่อวิ่งบน HTTPS (LAN) — บน HTTP loopback ไม่ติด ไม่งั้น localhost ใช้ไม่ได้
function sessionCookie(req, value, maxAge) {
  const secure = req.socket.encrypted ? '; Secure' : '';
  return maxAge === 0 ? `${SESSION_COOKIE}=; Max-Age=0; Path=/${secure}` : `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/${secure}`;
}

route('POST', '/api/login', async ctx => {
  const { username, password } = ctx.body;
  const remote = ctx.req.socket.remoteAddress;
  const gate = security.precheck('login', remote, username);
  if (!gate.ok) return send(ctx.res, 429, { error: gate.message, retry_after: gate.retryAfterSec }, { 'Retry-After': String(gate.retryAfterSec) });
  const user = auth.login(username, password);
  if (!user) {
    security.recordAuthEvent('login_fail', { remoteAddress: remote, username });
    if (security.noteFailure('login', remote, username)) security.recordAuthEvent('locked_out', { remoteAddress: remote, username });
    return send(ctx.res, 401, { error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  security.noteSuccess('login', remote, username);
  security.recordAuthEvent('login_ok', { remoteAddress: remote, username: user.username, userId: user.id });
  const cookie = auth.createSession(user, remote);
  send(ctx.res, 200, { ok: true, role: user.role, display_name: user.display_name },
    { 'Set-Cookie': sessionCookie(ctx.req, cookie) });
}, { public: true });

route('POST', '/api/logout', ctx => {
  if (ctx.session) {
    security.recordAuthEvent('logout', { remoteAddress: ctx.req.socket.remoteAddress, userId: ctx.session.userId });
    auth.destroySession(ctx.session.sid);
  }
  send(ctx.res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(ctx.req, '', 0) });
}, { public: true });

// test-only: ล้างตัวนับ limiter ระหว่างชุดทดสอบ (guard ด้วย test token เดียวกับ /api/test-instance)
if (TEST_INSTANCE_TOKEN) route('POST', '/api/test-limiter-reset', ctx => {
  const supplied = Buffer.from(String(ctx.req.headers['x-clinic-test-token'] || ''));
  const expected = Buffer.from(TEST_INSTANCE_TOKEN);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(ctx.res, 403, { error: 'test guard failed' });
  security.resetLimiter();
  send(ctx.res, 200, { ok: true });
}, { public: true });

// ผู้ใช้กดขอตรวจนาฬิกาใหม่หลังตั้งเวลา — ไม่ต้อง restart (S7)
route('POST', '/api/system/clock-recheck', ctx => {
  if (!ctx.session) return send(ctx.res, 401, { error: 'ยังไม่ได้ login' });
  send(ctx.res, 200, { ok: true, clock_error: checkClock() });
}, { public: true, allowLocked: true });

// ---- 🆘 รายงานปัญหา: ไฟล์ .txt สำหรับตรวจในคลินิกก่อนเปิด GitHub Issue ----
// เข้าได้เมื่อ login แล้ว (ทุก role ทุกเครื่อง) หรือจากเครื่องหลักโดยไม่ต้อง login (กรณีเข้าระบบไม่ได้)
// เนื้อหาไม่มีข้อมูลคนไข้ — ดู lib/support-report.js · จำกัด 1 ครั้ง/5 วิ กัน spam จาก LAN
const supportReport = require('./lib/support-report');
// กดรัว/ดับเบิลคลิก = พฤติกรรมผู้ใช้ปกติ — เสิร์ฟ cache 5 วิ (ทุกคลิกได้ไฟล์ดี + จำกัด wevtutil ไปในตัว)
// blind test 2026-08-24: แบบ 429 เดิมทำให้คลิกที่ชน limit "เงียบ" ผู้ใช้ไม่ได้อะไรเลย
let supportReportCache = { at: 0, text: '' };
route('GET', '/api/support-report', async ctx => {
  const remote = ctx.req.socket.remoteAddress;
  if (!ctx.session && !isLoopbackAddress(remote)) {
    return send(ctx.res, 401, 'ยังไม่ได้เข้าสู่ระบบ — เข้าสู่ระบบก่อนแล้วกดปุ่ม 🆘 อีกครั้ง หรือกดจากเครื่องหลัก (เครื่องที่เปิดระบบคลินิก)');
  }
  if (Date.now() - supportReportCache.at > 5000) {
    supportReportCache = { at: Date.now(), text: await supportReport.buildReport({
      uptimeSeconds: process.uptime(), port: PORT, httpsPort: HTTPS_PORT,
      httpsListening: !!(httpsServer && httpsServer.listening), clockError,
    }) };
  }
  const text = supportReportCache.text;
  send(ctx.res, 200, '﻿' + text, { // BOM ให้ Notepad เปิดไทยไม่เพี้ยน
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="clinic-report.txt"; filename*=UTF-8''${encodeURIComponent(supportReport.reportFilename())}`,
  });
}, { public: true, allowLocked: true });

// admin: สรุปความปลอดภัยการเข้าใช้ + ค้นว่าใครเปิดดูข้อมูลคนไข้ (ไม่มีรหัส/PIN/cookie ในผลลัพธ์)
route('GET', '/api/admin/auth-summary', ctx => {
  requireRole(ctx, 'admin');
  send(ctx.res, 200, security.authSummary({ hours: Number(ctx.query.hours) || 24 }));
});
route('GET', '/api/admin/access-log', ctx => {
  requireRole(ctx, 'admin');
  send(ctx.res, 200, security.accessSearch({ ref: ctx.query.ref, userId: ctx.query.user_id, dateFrom: ctx.query.from, dateTo: ctx.query.to, limit: ctx.query.limit }));
});

// ==================== เครื่องห้องตรวจ (คอมเครื่องที่สอง) — การ์ดใน Admin ====================
// สถานะอ่านได้ทุกที่ที่เป็น admin; การกระทำ (เรียกตัวช่วย/เปิดโฟลเดอร์) ทำได้เฉพาะ admin บนเครื่องหน้าร้าน (loopback)
// เพราะตัวช่วยเปิดหน้าต่าง/UAC/กล่องบนจอเครื่องที่ server รันอยู่ และจะรีสตาร์ท server เอง
route('GET', '/api/admin/runtime-status', ctx => {
  requireRole(ctx, 'admin');
  send(ctx.res, 200, { ...require('./scripts/runtime-maintenance').status(path.join(__dirname, '..')), host: isLoopbackAddress(ctx.req.socket.remoteAddress) });
});
route('GET', '/api/admin/trial-tools', ctx => {
  requireRole(ctx, 'admin');
  send(ctx.res,200,{...require('./lib/trial-maintenance').status(path.join(__dirname,'..')),host:isLoopbackAddress(ctx.req.socket.remoteAddress)});
});
route('POST', '/api/admin/trial-tools', async ctx => {
  requireRole(ctx,'admin');
  if(!isLoopbackAddress(ctx.req.socket.remoteAddress))throw Object.assign(new Error('ให้ผู้ดูแลกดจากชุดทดลองบนเครื่องหลักเท่านั้น'),{status:403});
  const body=ctx.body;
  const launched=await require('./lib/trial-maintenance').launch(path.join(__dirname,'..'),body.action,body.op_id);
  if(TEST_INSTANCE_TOKEN && ctx.req.headers['x-clinic-test-token']===TEST_INSTANCE_TOKEN && ctx.req.headers['x-clinic-test-crash']==='after-trial-dispatch')process.exit(88);
  send(ctx.res,202,launched);
});
route('POST', '/api/admin/runtime-update', ctx => {
  requireRole(ctx, 'admin');
  if (!isLoopbackAddress(ctx.req.socket.remoteAddress)) throw Object.assign(new Error('อัปเดตส่วนประกอบได้จากเครื่องหน้าร้านเท่านั้น'), {status:403});
  send(ctx.res, 202, require('./scripts/runtime-maintenance').launch(path.join(__dirname, '..'), PORT));
});
route('GET', '/api/admin/lan-status', async ctx => {
  requireRole(ctx, 'admin');
  const status = await lanStatus.collect({
    certDir: CERT_DIR, installRoot: path.join(__dirname, '..'), httpsPort: HTTPS_PORT,
    httpsListening: !!(httpsServer && httpsServer.listening), host: isLoopbackAddress(ctx.req.socket.remoteAddress),
  });
  // ขั้นที่ 4 (เครื่องห้องตรวจเปิดเข้าได้จริง) พิสูจน์จากการ login ผ่าน LAN ครั้งล่าสุดใน auth_events — ไม่มีรหัสในผลลัพธ์
  let lastLan = null;
  try { lastLan = db.prepare("SELECT created_at, remote FROM auth_events WHERE event = 'login_ok' AND station = 'lan' ORDER BY id DESC LIMIT 1").get() || null; } catch { lastLan = null; }
  send(ctx.res, 200, { ...status, last_lan_login: lastLan });
});
route('POST', '/api/admin/lan-setup', ctx => {
  requireRole(ctx, 'admin');
  if (!isLoopbackAddress(ctx.req.socket.remoteAddress)) {
    throw Object.assign(new Error('ตั้งค่าเครื่องห้องตรวจได้จากเครื่องหน้าร้าน (เครื่องที่เปิดระบบคลินิกอยู่) เท่านั้น'), { status: 403 });
  }
  const helper = lanStatus.launchHelper(path.join(__dirname, '..'));
  console.log(`admin #${ctx.session.userId} เรียกตัวช่วยเครื่องห้องตรวจ: ${helper}`);
  send(ctx.res, 200, { ok: true, helper: path.basename(helper), message: 'เปิดตัวช่วยแล้ว — ทำตามกล่องที่ขึ้นบนหน้าจอ โปรแกรมจะรีสตาร์ทเอง หน้านี้จะกลับมาเองเมื่อเสร็จ' });
});
route('POST', '/api/admin/lan-open-folder', ctx => {
  requireRole(ctx, 'admin');
  if (!isLoopbackAddress(ctx.req.socket.remoteAddress)) {
    throw Object.assign(new Error('เปิดโฟลเดอร์ได้จากเครื่องหน้าร้านเท่านั้น'), { status: 403 });
  }
  const setup = lanStatus.readSetupInfo(CERT_DIR);
  send(ctx.res, 200, { ok: true, dir: lanStatus.openFolder(setup?.output_dir) });
});

route('GET', '/api/me', ctx => {
  if (!ctx.session) return send(ctx.res, 401, { error: 'ยังไม่ได้ login' });
  send(ctx.res, 200, {
    user_id: ctx.session.userId, role: ctx.session.role, display_name: ctx.session.displayName,
    can_front_desk: ctx.session.canFrontDesk === true,
    locked: ctx.session.locked, clock_error: clockError,
    app_version: require('./package.json').version,
    setup_required: getSetting('setup_required', '1') === '1',
    demo_mode: getSetting('demo_mode', '0') === '1',
    // เครื่องนี้คือเครื่องที่ต่อเครื่องพิมพ์หรือไม่ — จอห้องตรวจ (LAN) ใช้ตั้งค่าเริ่มต้นโหมด "ไม่มีเครื่องพิมพ์"
    is_host: isLoopbackAddress(ctx.req.socket.remoteAddress),
  });
}, { public: true, allowLocked: true });

// ==================== automatic update (admin + host only for mutations) ====================
route('GET', '/api/update/status', ctx => {
  send(ctx.res, 200, updateService.publicStatus({ host: isLoopbackAddress(ctx.req.socket.remoteAddress) }));
});
route('POST', '/api/update/check', async ctx => {
  requireRole(ctx); requireHostLoopback(ctx);
  send(ctx.res, 200, await updateService.check());
});
route('POST', '/api/update/stage', async ctx => {
  requireRole(ctx); requireHostLoopback(ctx);
  send(ctx.res, 200, await updateService.stage());
});
route('POST', '/api/update/apply', async ctx => {
  requireRole(ctx); requireHostLoopback(ctx);
  const entitlement = entitlementAllowsUpdate();
  if (!entitlement.allowed) throw Object.assign(new Error(entitlement.reason || 'รุ่นสิทธิ์นี้ยังอัปเดตไม่ได้'), { status: 403 });
  const active = auth.activeSessionSummary({ excludeSid: ctx.session.sid });
  if (active.total > 0) throw Object.assign(new Error(`ยังมีผู้ใช้งานอีก ${active.total} หน้าจอ กรุณาให้บันทึกงานและหยุดใช้งานก่อนอัปเดต`), { status: 409 });
  send(ctx.res, 202, await updateService.apply());
});

route('POST', '/api/unlock', ctx => {
  if (!ctx.session) return send(ctx.res, 401, { error: 'ยังไม่ได้ login' });
  const remote = ctx.req.socket.remoteAddress;
  const subject = `uid:${ctx.session.userId}`;
  const gate = security.precheck('unlock', remote, subject);
  if (!gate.ok) return send(ctx.res, 429, { error: gate.message, retry_after: gate.retryAfterSec }, { 'Retry-After': String(gate.retryAfterSec) });
  const ok = auth.unlockSession(ctx.session.sid, ctx.body.pin);
  if (ok) {
    security.noteSuccess('unlock', remote, subject);
    security.recordAuthEvent('unlock_ok', { remoteAddress: remote, userId: ctx.session.userId });
  } else {
    security.recordAuthEvent('unlock_fail', { remoteAddress: remote, userId: ctx.session.userId });
    if (security.noteFailure('unlock', remote, subject)) security.recordAuthEvent('locked_out', { remoteAddress: remote, userId: ctx.session.userId });
  }
  send(ctx.res, ok ? 200 : 401, ok ? { ok: true } : { error: 'PIN ไม่ถูกต้อง' });
}, { public: true, allowLocked: true });

// browser ส่งเฉพาะเมื่อมี mouse/keyboard/touch จริง; polling GET จะไม่ต่ออายุ session
route('POST', '/api/session/activity', ctx => send(ctx.res, 200, { ok: true }));

// Standalone Recovery Assistant uses this loopback-only handshake to stop the
// app after it has prepared and verified a replacement. The token is local,
// is not stored in a backup, and is never returned to a browser.
route('GET', '/api/recovery/ready', ctx => send(ctx.res, 200, {
  ok: true, schema: db.prepare('PRAGMA user_version').get().user_version,
}), { public: true, allowLocked: true });

route('POST', '/api/system/prepare-restore', ctx => {
  const remote = ctx.req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    return send(ctx.res, 403, { error: 'คำสั่งนี้ใช้ได้จากเครื่องคลินิกเท่านั้น' });
  }
  const supplied = Buffer.from(String(ctx.req.headers['x-recovery-control'] || ''));
  const expected = Buffer.from(RECOVERY_CONTROL_TOKEN);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return send(ctx.res, 403, { error: 'ตัวช่วยกู้ข้อมูลไม่ได้รับอนุญาต' });
  }
  send(ctx.res, 200, { ok: true, message: 'ClinicApp กำลังหยุดอย่างปลอดภัย' });
  console.log('ได้รับคำสั่งปิดอย่างปลอดภัย (prepare-restore: recovery/update/restart) — กำลังหยุด server (exit 0)');
  try { auth.saveSessionsNow(); } catch {} // flush ก่อนปิด — restart ธรรมดา session ต้องรอด (จะถูกลบเฉพาะรอบอัปเดตรุ่นโดย assistant)
  setTimeout(() => {
    let remaining = servers.length;
    const done = () => { if (--remaining <= 0) { try { db.close(); } catch {} process.exit(0); } };
    for (const s of servers) s.close(done);
    setTimeout(() => { for (const s of servers) { try { s.closeAllConnections(); } catch {} } }, 250).unref();
    setTimeout(() => process.exit(0), 5000).unref();
  }, 100).unref();
}, { public: true, allowLocked: true });

// ==================== patients ====================
route('GET', '/api/patients/search', ctx => send(ctx.res, 200, patients.search(ctx.query.q)));
route('GET', '/api/patients/:hn', ctx => {
  const p = patients.get(ctx.params.hn);
  if (!p) return send(ctx.res, 404, { error: 'ไม่พบคนไข้' });
  security.recordAccess('view_patient', { session: ctx.session, remoteAddress: ctx.req.socket.remoteAddress, ref: ctx.params.hn });
  send(ctx.res, 200, p);
});
// ---------- exactly-once wrapper (กติกา resilience ข้อ 1 — ยกจากเคสลงทะเบียน incident 2026-08-24) ----------
// flow เขียนข้อมูลที่ browser อาจส่งซ้ำหลัง connection ขาด: แนบ op_id ต่อการเปิดฟอร์ม/กล่อง 1 ครั้ง
// - retry เดิม (payload เดิม) → คืนผลเดิมเป๊ะ ไม่เกิดข้อมูลซ้ำ
// - op เดิมแต่ payload เปลี่ยน (ผู้ใช้แก้ช่อง/สลับปุ่มก่อนกดซ้ำ — codex NO-GO รอบ 2) → 409 + ผลเดิมใน
//   conflictField ให้ UI พาไปดูของที่เกิดไปแล้ว ห้ามแนะนำให้เปิดฟอร์มใหม่ (= ทางไปข้อมูลซ้ำ)
// - crash hook จำลองไฟดับสำหรับ harness เท่านั้น (ต้องมี test token ตรง — pattern เดียวกับ /api/test-limiter-reset)
function exactlyOnce(ctx, kind, { status = 201, scope, conflictField, conflictMessage }, work) {
  const opId = clientOps.normalizeOpId(ctx.body.op_id);
  // scope = ตัวตนใน URL (visit/drug id) — body หน้าตาเดิมกับคนละ id ต้องไม่ replay ข้ามตัวกัน
  const payloadHash = clientOps.hashPayload(scope === undefined ? ctx.body : { ...ctx.body, __scope: String(scope) });
  if (opId) {
    const previous = clientOps.lookup(kind, opId);
    if (previous) {
      const prevResult = JSON.parse(previous.result_json);
      if (previous.payload_hash !== payloadHash) {
        return send(ctx.res, 409, { error: conflictMessage(prevResult), [conflictField]: prevResult });
      }
      return send(ctx.res, status, prevResult); // retry หลัง connection ขาด — ผลเดิมเป๊ะ
    }
  }
  const crashAt = TEST_INSTANCE_TOKEN && ctx.req.headers['x-clinic-test-token'] === TEST_INSTANCE_TOKEN
    ? ctx.req.headers['x-clinic-test-crash'] : null;
  const result = txn(() => {
    const out = work();
    if (opId) clientOps.record(kind, opId, payloadHash, out);
    if (crashAt === 'before-commit') process.exit(1); // ตายก่อน COMMIT — WAL ต้องทิ้งทั้งก้อน
    return out;
  });
  if (crashAt === 'after-commit') process.exit(1); // ตายหลัง commit ก่อนคำตอบถึง browser — เคสหน้างานตัวจริง
  send(ctx.res, status, result);
}

// ลงทะเบียน (exactly-once — codex NO-GO 2026-08-24): queue=true = สร้าง visit ใน txn เดียวกัน
// (เดิมแยก POST /api/patients + /api/visits สองรายการ — ตายกลางทางแล้วได้คนไข้ไม่มีคิว หรือกดซ้ำแล้ว HN เบิ้ล)
route('POST', '/api/patients', ctx => {
  requireRole(ctx, 'front', 'doctor');
  const { first_name, sex } = ctx.body;
  if (!first_name || !first_name.trim() || !sex) throw Object.assign(new Error('ต้องมีอย่างน้อย ชื่อ + เพศ'), { status: 400 });
  exactlyOnce(ctx, 'register', {
    conflictField: 'already_registered',
    conflictMessage: prev => `ข้อมูลชุดนี้ถูกบันทึกไปแล้วเป็น HN ${prev.hn} — ระบบเปิดหน้าคนไข้ให้แล้ว แก้ไขข้อมูลหรือกดเข้าคิวจากตรงนั้นได้เลย ไม่ต้องลงทะเบียนซ้ำ`,
  }, () => {
    const hn = patients.register(ctx.body, ctx.session.userId);
    let visit = null;
    if (ctx.body.queue === true) visit = visits.create(hn, ctx.session.userId, {}, ctx.body.cc || '');
    return { hn, visit_id: visit ? visit.id : null, queue_no: visit ? visit.queue_no : null };
  });
});
route('PATCH', '/api/patients/:hn', ctx => {
  requireRole(ctx, 'front', 'doctor');
  patients.update(ctx.params.hn, ctx.body, ctx.session.userId);
  send(ctx.res, 200, { ok: true });
});
route('GET', '/api/patients/:hn/history', ctx => {
  security.recordAccess('view_history', { session: ctx.session, remoteAddress: ctx.req.socket.remoteAddress, ref: ctx.params.hn });
  send(ctx.res, 200, visits.history(ctx.params.hn));
});
route('GET', '/api/patients/:hn/last-vitals', ctx =>
  send(ctx.res, 200, { last: visits.lastVitals(ctx.params.hn, Number(ctx.query.exclude) || 0) }));
route('POST', '/api/patients/:hn/allergies', ctx => {
  requireRole(ctx, 'front', 'doctor');
  patients.addAllergy(ctx.params.hn, ctx.body.substance, ctx.body.reaction, ctx.session.userId);
  send(ctx.res, 201, { ok: true });
});
route('POST', '/api/patients/:hn/allergies/:id/remove', ctx => {
  requireRole(ctx, 'front', 'doctor');
  patients.removeAllergy(ctx.params.hn, Number(ctx.params.id), ctx.body.reason, ctx.session.userId);
  send(ctx.res, 200, { ok: true });
});
route('POST', '/api/patients/:hn/mark-duplicate', ctx => {
  requireRole(ctx); // admin only
  patients.markDuplicate(ctx.params.hn, ctx.body.primary_hn, ctx.session.userId);
  send(ctx.res, 200, { ok: true });
});

// ==================== queue & visits ====================
// payload เดียวสำหรับ poll 3 วิ ของทั้งสองจอ
route('GET', '/api/doctors', ctx => send(ctx.res, 200, doctors.active()));
route('GET', '/api/queue', ctx => {
  send(ctx.res, 200, {
    // pending_docs = ใบรับรองที่หมอออกไว้แต่หน้าร้านยังไม่ได้พิมพ์ (เครื่องพิมพ์อยู่ที่หน้าร้านเครื่องเดียว)
    queue: printEvents.attachPendingDocs(visits.todayQueue()),
    stale: visits.stale(),
    doctors: doctors.active(),
    backup: backup.status(),
    pending_acks: notes.pendingAcks().length,
    low_stock: stock.lowStock().length,
    server_time: now(),
  });
});
route('POST', '/api/visits', ctx => {
  requireRole(ctx, 'front', 'doctor');
  exactlyOnce(ctx, 'enqueue', {status:201,scope:ctx.session.userId+':'+ctx.body.hn,
    conflictField:'already_queued',conflictMessage:()=> 'รับเข้าคิวแล้ว กรุณาดูคิววันนี้ก่อนรับซ้ำ'},
    () => visits.create(ctx.body.hn, ctx.session.userId, ctx.body.vitals || {}, ctx.body.cc, ctx.body.preferred_doctor_id));
});
route('GET', '/api/visits/:id', ctx => {
  const v = visits.get(Number(ctx.params.id));
  if (!v) return send(ctx.res, 404, { error: 'ไม่พบ visit' });
  v.patient = patients.get(v.hn);
  v.order = notes.latestOrderVersion(v.id);
  v.draft = notes.getDraft(v.id);
  v.note_versions = notes.noteVersions(v.id);
  v.receipts = billing.receiptsForVisit(v.id);
  v.med_certs = billing.medCertsForVisit(v.id);
  v.pending_docs = printEvents.pendingForVisits([v.id]).get(v.id) || [];
  v.print_events = printEvents.eventsForVisit(v.id);
  // ค่าบริการ default ใส่บิลอัตโนมัติตอนเริ่มตรวจ (UAT A4) — เปลี่ยนชื่อได้ที่ตั้งค่า default_service_name
  if (v.state === 'IN_EXAM') {
    const defaultServiceName = getSetting('default_service_name', 'ค่าตรวจรักษา');
    if (defaultServiceName) {
      v.default_service = db.prepare('SELECT id, name, price FROM services WHERE name = ? AND active = 1')
        .get(defaultServiceName) || null;
    }
  }
  v.appointment = appts.upcomingForPatient(v.hn);
  send(ctx.res, 200, v);
});
route('POST', '/api/visits/:id/call', ctx => {
  requireRole(ctx, 'doctor');
  exactlyOnce(ctx,'call',{status:200,scope:ctx.session.userId+':'+ctx.params.id,
    conflictField:'previous_call',conflictMessage:()=> 'รายการเรียกนี้ถูกใช้แล้ว กรุณาดูคิวล่าสุดก่อนเลือกคนไข้'},
    ()=>visits.transition(Number(ctx.params.id),'call',ctx.session.userId));
});
route('POST', '/api/visits/:id/requeue', ctx => {
  requireVisitDoctor(ctx, ctx.params.id);
  exactlyOnce(ctx,'requeue',{status:200,scope:ctx.session.userId+':'+ctx.params.id,
    conflictField:'previous_requeue',conflictMessage:()=> 'รายการคืนคิวนี้ถูกใช้แล้ว กรุณาดูคิวล่าสุด'},
    ()=>visits.transition(Number(ctx.params.id),'requeue',ctx.session.userId));
});
route('POST', '/api/visits/:id/finish-exam', ctx => {
  requireVisitDoctor(ctx, ctx.params.id);
  exactlyOnce(ctx, 'finish-exam', { status: 200, scope: ctx.params.id, conflictField: 'already_finished',
    conflictMessage: () => 'คิวนี้จบตรวจแล้ว เปิดหน้าคลินิกเพื่อตรวจรายการเดิมก่อนทำต่อ' }, () => visits.finishExam(Number(ctx.params.id), {
    note: ctx.body.note,
    lines: ctx.body.lines,
    baseVersionId: ctx.body.base_version_id,
    allergyAck: ctx.body.allergy_ack === true,
  }, ctx.session.userId));
});
route('POST', '/api/visits/:id/cancel', ctx => {
  requireRole(ctx, 'front', 'doctor');
  send(ctx.res, 200, visits.transition(Number(ctx.params.id), 'cancel', ctx.session.userId, { reason: ctx.body.reason }));
});
route('PATCH', '/api/visits/:id/vitals', ctx => {
  requireRole(ctx, 'front', 'doctor');
  visits.updateVitals(Number(ctx.params.id), ctx.body, ctx.session.userId);
  send(ctx.res, 200, { ok: true });
});

// ==================== notes & orders ====================
route('PUT', '/api/visits/:id/draft', ctx => {
  requireVisitDoctor(ctx, ctx.params.id);
  notes.saveDraft(Number(ctx.params.id), ctx.body, ctx.session.userId);
  send(ctx.res, 200, { ok: true, at: now() });
});
route('POST', '/api/visits/:id/amend-note', ctx => {
  requireRole(ctx, 'doctor');
  send(ctx.res, 201, { version: notes.amendNote(Number(ctx.params.id), ctx.body, ctx.session.userId) });
});
route('POST', '/api/visits/:id/orders', ctx => {
  const visitId = Number(ctx.params.id);
  const v = visits.get(visitId);
  if (!v) return send(ctx.res, 404, { error: 'ไม่พบ visit' });
  const isDoctor = ctx.session.role === 'doctor';
  if (isDoctor) {
    requireVisitDoctor(ctx, visitId);
    if (['COMPLETED', 'CANCELLED'].includes(v.state)) {
      throw Object.assign(new Error('visit ปิดแล้ว — แก้บิลผ่านเมนู void/ออกใหม่'), { status: 409 });
    }
  } else {
    // front แก้ได้เฉพาะช่วงจ่ายยา และต้องมีเหตุผล → เข้าคิว ack ของหมอ (plan A5)
    requireRole(ctx, 'front');
    if (v.state !== 'DISPENSING') throw Object.assign(new Error('แก้รายการได้เฉพาะช่วงจ่ายยา'), { status: 409 });
    if (!ctx.body.edit_reason) throw Object.assign(new Error('ต้องระบุเหตุผลการแก้รายการ'), { status: 400 });
    const latest = notes.latestOrderVersion(visitId);
    if (!latest || ctx.body.base_version_id == null) {
      throw Object.assign(new Error('ไม่พบรายการต้นฉบับ กรุณาโหลด visit ใหม่'), { status: 409 });
    }
    notes.validateFrontOrderEdit(latest.lines, ctx.body.lines);
  }
  // ด่านแพ้ยา (S1) ครอบทางแก้ order ทุกทาง (หมอแก้ระหว่าง DISPENSING / front แก้ตอนจ่ายยา)
  const conflicts = patients.allergyConflicts(v.hn, ctx.body.lines || []);
  if (conflicts.length && ctx.body.allergy_ack !== true) {
    const detail = conflicts.map(c => `แพ้ ${c.substance} แต่รายการมี ${c.drug}`).join(' · ');
    throw Object.assign(new Error(`คนไข้มีประวัติแพ้ยาชนกับรายการ: ${detail} — ต้องยืนยันบนหน้าจอก่อนบันทึก`), { status: 409 });
  }
  const r = notes.saveOrderVersion(visitId, ctx.body.lines,
    isDoctor ? null : ctx.body.edit_reason, ctx.session.userId, ctx.body.base_version_id);
  send(ctx.res, 201, r);
});
route('POST', '/api/orders/:id/ack', ctx => {
  requireRole(ctx, 'doctor');
  notes.ackOrder(Number(ctx.params.id), ctx.session.userId);
  send(ctx.res, 200, { ok: true });
});
route('GET', '/api/pending-acks', ctx => send(ctx.res, 200, notes.pendingAcks()));

// ==================== billing ====================
route('POST', '/api/visits/:id/pay', ctx => {
  requireRole(ctx, 'front');
  exactlyOnce(ctx, 'pay', {
    scope: ctx.params.id,
    conflictField: 'already_paid',
    conflictMessage: prev => `เก็บเงินของคิวนี้ไปแล้ว — ใบเสร็จ ${prev.receiptNo} ยอด ${prev.total} บาท พิมพ์สำเนาหรือแก้บิลได้จากการ์ดใบเสร็จ ไม่ต้องเก็บเงินซ้ำ`,
  }, () => billing.pay(Number(ctx.params.id), {
    orderVersionId: ctx.body.order_version_id, discount: ctx.body.discount,
    discountReason: ctx.body.discount_reason, payMethod: ctx.body.pay_method,
    payer: ctx.body.payer, paymentDetails: { cash_received: ctx.body.cash_received, transfer_ref: ctx.body.transfer_ref },
    userId: ctx.session.userId,
  }));
});
route('POST', '/api/receipts/:no/void-reissue', ctx => {
  requireRole(ctx, 'front');
  send(ctx.res, 201, billing.voidAndReissue(ctx.params.no, {
    newLines: ctx.body.new_lines, returnedStock: !!ctx.body.returned_stock,
    discount: ctx.body.discount, discountReason: ctx.body.discount_reason,
    payMethod: ctx.body.pay_method, payer: ctx.body.payer,
    paymentDetails: { cash_received: ctx.body.cash_received, transfer_ref: ctx.body.transfer_ref },
    voidReason: ctx.body.void_reason, userId: ctx.session.userId,
  }));
});
route('POST', '/api/receipts/:no/refund', ctx => {
  requireRole(ctx, 'front');
  send(ctx.res, 200, billing.refund(ctx.params.no, {
    reason: ctx.body.reason, returnedStock: !!ctx.body.returned_stock, userId: ctx.session.userId,
  }));
});
route('GET', '/api/receipts/:no', ctx => {
  const r = billing.getReceipt(ctx.params.no);
  if (!r) return send(ctx.res, 404, { error: 'ไม่พบใบเสร็จ' });
  send(ctx.res, 200, r);
});
// ใบรับรองแพทย์: visit เดียวออกหลายใบได้โดยชอบธรรม (เช่นออกใบใหม่แทน) — server แยก "กดซ้ำ" ออกเอง
// ไม่ได้ ต้องพึ่ง op_id (failure-injection 2026-08-25: retry หลัง crash = ใบซ้ำ 2 ใบ ซึ่ง append-only ต้อง void)
route('POST', '/api/visits/:id/medcert', ctx => {
  requireVisitDoctor(ctx, ctx.params.id);
  exactlyOnce(ctx, 'medcert', {
    scope: ctx.params.id,
    conflictField: 'already_issued',
    conflictMessage: prev => `ใบรับรองจากฟอร์มนี้ออกไปแล้วเป็นเลขที่ ${prev.cert_no} — ดู/พิมพ์ได้จากรายการใบรับรองของ visit นี้ ถ้าเนื้อหาไม่ถูกต้องให้กด "ออกใบใหม่แทน" ไม่ต้องออกซ้ำ`,
  }, () => ({ cert_no: billing.issueMedCert(Number(ctx.params.id), ctx.body, ctx.session.userId) }));
});
// บันทึกการสั่งพิมพ์ — best-effort: ถ้าล้มเหลวห้ามขวางการพิมพ์ ฝั่ง UI จึงแค่ toast เตือน
route('POST', '/api/documents/print-event', ctx => {
  security.recordAccess('print', { session: ctx.session, remoteAddress: ctx.req.socket.remoteAddress, ref: `${ctx.body.doc_type}:${ctx.body.doc_ref}` });
  send(ctx.res, 201, printEvents.record({
    docType: ctx.body.doc_type, docRef: ctx.body.doc_ref, visitId: ctx.body.visit_id,
    userId: ctx.session.userId, role: ctx.session.role,
    station: printEvents.stationOf(isLoopbackAddress(ctx.req.socket.remoteAddress)),
  }));
});
route('POST', '/api/medcerts/:no/void', ctx => {
  requireRole(ctx, 'doctor');
  send(ctx.res, 200, billing.voidMedCert(ctx.params.no, ctx.body.reason, ctx.session.userId));
});

// ==================== stock & master data ====================
route('GET', '/api/items/search', ctx => send(ctx.res, 200, stock.searchItems(ctx.query.q)));
route('GET', '/api/drugs', ctx => send(ctx.res, 200, stock.listDrugs(ctx.query.all === '1')));
function saveDrugMaster(ctx, id = null) {
  requireRole(ctx, 'front');
  exactlyOnce(ctx, 'drug-save', { status: id == null ? 201 : 200, scope: id ?? 'new',
    conflictField: 'saved_drug', conflictMessage: () => 'รายการยาก่อนหน้าบันทึกแล้ว กรุณาตรวจในคลังก่อนแก้ไขต่อ' },
    () => ({ id: stock.upsertDrug(ctx.body, id), ok: true }));
}
route('POST', '/api/drugs', ctx => saveDrugMaster(ctx));
route('PATCH', '/api/drugs/:id', ctx => saveDrugMaster(ctx, Number(ctx.params.id)));
// รับยาเข้า: รับซ้ำสองรอบเป็นเรื่องปกติของชีวิตจริง — server แยก "กดซ้ำ" ออกเองไม่ได้ ต้องพึ่ง op_id
// (failure-injection 2026-08-25: retry หลัง crash = รับเบิ้ล; และเดิม move/setCost คนละ txn — ตอนนี้อะตอมมิก)
route('POST', '/api/drugs/:id/receive', ctx => {
  requireRole(ctx, 'front');
  const id = Number(ctx.params.id);
  exactlyOnce(ctx, 'stock_receive', {
    status: 200,
    scope: id,
    conflictField: 'already_received',
    conflictMessage: prev => `รับเข้ารอบนี้บันทึกไปแล้ว ${prev.received} หน่วย — ถ้าต้องการรับเพิ่มอีกรอบ ปิดกล่องแล้วกด "+รับเข้า" ใหม่อีกครั้ง`,
  }, () => {
    const qty = Math.abs(Number(ctx.body.qty));
    // ฝังข้อมูล lot ลงประวัติ (stock_movements append-only) ด้วย — ย้อนดูได้เสมอว่ารอบไหนกรอกอะไร
    const reason = [ctx.body.reason || 'รับยาเข้า',
      ctx.body.lot_label ? `lot ${ctx.body.lot_label}` : null,
      ctx.body.expiry_date ? `หมดอายุ ${ctx.body.expiry_date}` : null].filter(Boolean).join(' · ');
    stock.move(id, 'receive', qty, { reason, userId: ctx.session.userId });
    if (ctx.body.cost != null && ctx.body.cost !== '') stock.setCost(id, ctx.body.cost);
    // v13: รับเข้า 1 รอบที่กรอกวันหมดอายุ = drug_lots 1 แถว — txn เดียวกับยอด (ตายกลางคันต้องไม่เหลือสถานะครึ่งๆ)
    // ระบบจะเลือก lot ที่ใกล้หมดสุดมาเตือนเอง (หมอไม่ต้องจำว่า lot ถัดไปวันไหน)
    if (ctx.body.expiry_date != null && ctx.body.expiry_date !== '') {
      stock.addLot(id, { expiry_date: ctx.body.expiry_date, lot_label: ctx.body.lot_label, qty, userId: ctx.session.userId });
    }
    if (ctx.body.expiry_warn_days != null && ctx.body.expiry_warn_days !== '') stock.setExpiryWarnDays(id, ctx.body.expiry_warn_days);
    return { ok: true, received: qty };
  });
});
// ---- lot ยา (v13): ดู/ปิด/แก้ — ปิด lot ไม่แตะยอดสต็อก (ยอดใช้ปุ่ม "ปรับยอด" ตามเดิม) ----
route('GET', '/api/drugs/:id/lots', ctx =>
  send(ctx.res, 200, stock.listLots(Number(ctx.params.id), ctx.query.all === '1')));
route('POST', '/api/drugs/:id/lots', ctx => { // เพิ่ม lot ย้อนหลังโดยไม่รับยอด (ของที่อยู่ในตู้ก่อนเริ่มใช้ระบบ lot)
  requireRole(ctx, 'front', 'doctor', 'admin');
  const lotId = stock.addLot(Number(ctx.params.id), { expiry_date: ctx.body.expiry_date,
    lot_label: ctx.body.lot_label, qty: ctx.body.qty, userId: ctx.session.userId });
  send(ctx.res, 201, { id: lotId });
});
route('POST', '/api/lots/:id/clear', ctx => {
  requireRole(ctx, 'front', 'doctor', 'admin');
  stock.clearLot(Number(ctx.params.id), { reason: ctx.body.reason, userId: ctx.session.userId });
  send(ctx.res, 200, { ok: true });
});
route('PATCH', '/api/lots/:id', ctx => {
  requireRole(ctx, 'front', 'doctor', 'admin');
  stock.updateLot(Number(ctx.params.id), { expiry_date: ctx.body.expiry_date, lot_label: ctx.body.lot_label });
  send(ctx.res, 200, { ok: true });
});
// เกณฑ์เตือนยาใกล้หมดอายุ — หมอ/หน้าร้านปรับเองจากหน้า stock (เจ้าของ 2026-08-31: ห้าม fix ค่า
// เพราะรอบสั่งยาของแต่ละคลินิก/supplier ไม่เท่ากัน) — ไม่ใช่ settings ตัวตนคลินิก จึงไม่จำกัดสิทธิ์ admin
route('POST', '/api/stock/expiry-warning', ctx => {
  requireRole(ctx, 'front', 'doctor', 'admin');
  const days = Number(ctx.body.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw Object.assign(new Error('จำนวนวันเตือนล่วงหน้าต้องเป็นตัวเลข 1–3650 วัน'), { status: 400 });
  }
  setSetting('stock_expiry_warn_days', String(days));
  send(ctx.res, 200, { ok: true, days });
});
route('POST', '/api/drugs/:id/adjust', ctx => {
  requireRole(ctx, 'front');
  const d = db.prepare('SELECT qty_on_hand FROM drugs WHERE id = ?').get(Number(ctx.params.id));
  if (!d) return send(ctx.res, 404, { error: 'ไม่พบยา' });
  const diff = Number(ctx.body.new_qty) - d.qty_on_hand;
  if (!ctx.body.reason) throw Object.assign(new Error('ต้องระบุเหตุผลการปรับยอด'), { status: 400 });
  if (Math.abs(diff) > 0.0001) {
    stock.move(Number(ctx.params.id), 'adjust', diff, { reason: ctx.body.reason, userId: ctx.session.userId });
  }
  send(ctx.res, 200, { ok: true, diff });
});
route('GET', '/api/drugs/:id/movements', ctx => send(ctx.res, 200, stock.movements(Number(ctx.params.id))));
route('GET', '/api/stock/reconcile', ctx => send(ctx.res, 200, stock.reconcile()));
route('GET', '/api/stock/low', ctx => send(ctx.res, 200, stock.lowStock()));
route('GET', '/api/services', ctx => send(ctx.res, 200, stock.listServices(ctx.query.all === '1')));
function saveService(ctx, id = null) {
  requireRole(ctx, 'front');
  exactlyOnce(ctx, 'service-save', { status: id == null ? 201 : 200, scope: id ?? 'new',
    conflictField: 'saved_service', conflictMessage: () => 'รายการก่อนหน้าบันทึกแล้ว กรุณาตรวจรายการในตารางก่อนแก้ไขต่อ' },
    () => ({ id: stock.upsertService(ctx.body, id), ok: true }));
}
route('POST', '/api/services', ctx => saveService(ctx));
route('PATCH', '/api/services/:id', ctx => saveService(ctx, Number(ctx.params.id)));

// import ยาจาก CSV: name,unit,price,qty,reorder_level (seed ข้อมูลวันแรก brief §7.4)
route('POST', '/api/drugs/import-csv', ctx => {
  requireRole(ctx); // admin
  const linesArr = String(ctx.body.csv || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  const errors = [];
  const { txn } = require('./lib/db');
  txn(() => {
    for (const [i, line] of linesArr.entries()) {
      const [name, unit, price, qty, reorder, cost] = line.split(',').map(s => (s || '').trim());
      if (!name || name === 'name' || name === 'ชื่อยา') continue;
      try {
        const id = stock.upsertDrug({ name, unit: unit || 'เม็ด', price: Number(price) || 0,
          reorder_level: Number(reorder) || 0, cost: cost === '' ? null : cost });
        if (Number(qty) > 0) stock.move(id, 'receive', Number(qty), { reason: 'ยอดตั้งต้น (import)', userId: ctx.session.userId });
        added++;
      } catch (e) { errors.push(`บรรทัด ${i + 1}: ${e.message}`); }
    }
  });
  send(ctx.res, 200, { added, errors });
});

// ==================== fav sets (ยาชุด — หัวใจความเร็ว brief §3.2) ====================
route('GET', '/api/favsets', ctx => {
  const rows = db.prepare('SELECT * FROM fav_sets WHERE active = 1 ORDER BY name').all();
  for (const r of rows) { r.lines = JSON.parse(r.lines_json); r.note = r.note_json ? JSON.parse(r.note_json) : null; }
  send(ctx.res, 200, rows);
});
route('POST', '/api/favsets', ctx => {
  requireRole(ctx, 'doctor');
  const b = ctx.body;
  if (!b.name || !b.name.trim()) throw Object.assign(new Error('ต้องตั้งชื่อชุด'), { status: 400 });
  const lines = notes.buildLines(b.lines || []);
  const r = db.prepare(`INSERT INTO fav_sets (name, cc, dx_text, icd10, note_json, lines_json, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(b.name.trim(), b.cc || null, b.dx_text || null, b.icd10 || null,
      b.note ? JSON.stringify(b.note) : null, JSON.stringify(lines), ctx.session.userId);
  send(ctx.res, 201, { id: Number(r.lastInsertRowid) });
});
route('PATCH', '/api/favsets/:id', ctx => {
  requireRole(ctx, 'doctor');
  db.prepare('UPDATE fav_sets SET active = ? WHERE id = ?').run(ctx.body.active === 0 ? 0 : 1, Number(ctx.params.id));
  send(ctx.res, 200, { ok: true });
});

// ==================== appointments (นัด) ====================
route('POST', '/api/visits/:id/appointment', ctx => {
  requireRole(ctx, 'doctor', 'front');
  appointmentWrite(ctx, 'create', () => appts.create(Number(ctx.params.id), ctx.body, ctx.session.userId), 201);
});
function appointmentWrite(ctx, kind, work, status = 200, required = false) {
  requireRole(ctx, 'doctor', 'front');
  if (required && (!clientOps.normalizeOpId(ctx.body.op_id) || !Number.isInteger(ctx.body.expected_event_id) || !appts.validDate(ctx.body.expected_date)))
    throw Object.assign(new Error('กรุณาเปิดรายการนัดใหม่ก่อนบันทึก'), { status: 400 });
  const opId = clientOps.normalizeOpId(ctx.body.op_id);
  const previous = opId && db.prepare('SELECT kind,result_json FROM client_ops WHERE op_id=?').get(opId);
  if (previous && (previous.kind !== 'appointment-' + kind || JSON.parse(previous.result_json).actor_id !== ctx.session.userId))
    throw Object.assign(new Error('รายการบันทึกนี้ใช้ไปแล้ว กรุณาเปิดประวัตินัดล่าสุด'), { status: 409 });
  exactlyOnce(ctx, 'appointment-' + kind, { status, scope: ctx.session.userId + ':' + ctx.params.id,
    conflictField: 'already_saved', conflictMessage: () => 'บันทึกครั้งนี้สำเร็จไปแล้ว กรุณาเปิดประวัตินัดเพื่อดูผลก่อนทำรายการต่อ'
  }, () => ({ ...work(), actor_id: ctx.session.userId }));
}
route('GET', '/api/appointment-operations/:id', ctx => {
  requireRole(ctx, 'doctor', 'front');
  const opId = clientOps.normalizeOpId(ctx.params.id);
  const row = opId && db.prepare("SELECT result_json FROM client_ops WHERE op_id=? AND kind LIKE 'appointment-%'").get(opId);
  const result = row && JSON.parse(row.result_json);
  send(ctx.res, 200, result && result.actor_id === ctx.session.userId ? { known: true, result } : { known: false });
});
route('GET', '/api/appointments/followup', ctx => {
  security.recordAccess('view_appointment_followup', { session: ctx.session, remoteAddress: ctx.req.socket.remoteAddress });
  send(ctx.res, 200, appts.followup(ctx.query.days || 30));
});
route('GET', '/api/appointments/:id/history', ctx => {
  security.recordAccess('view_appointment_history', { session: ctx.session, remoteAddress: ctx.req.socket.remoteAddress, ref: String(ctx.params.id) });
  send(ctx.res, 200, appts.history(Number(ctx.params.id)));
});
route('POST', '/api/appointments/:id/attendance', ctx => appointmentWrite(ctx, 'attendance', () => appts.attendance(Number(ctx.params.id), ctx.body, ctx.session.userId), 200, true));
route('POST', '/api/appointments/:id/contact', ctx => appointmentWrite(ctx, 'contact', () => appts.contact(Number(ctx.params.id), ctx.body, ctx.session.userId), 200, true));

route('POST', '/api/appointments/:id/cancel', ctx => {
  requireRole(ctx, 'doctor', 'front');
  appointmentWrite(ctx, 'cancel', () => ({ ...appts.cancel(Number(ctx.params.id), ctx.session.userId, ctx.body), ok: true }));
});
// เลื่อนนัดจบในปุ่มเดียว ไม่ต้อง cancel แล้วไปตั้งใหม่ที่คนไข้ (UAT D2)
route('PATCH', '/api/appointments/:id', ctx => {
  requireRole(ctx, 'doctor', 'front');
  appointmentWrite(ctx, 'reschedule', () => appts.reschedule(Number(ctx.params.id), ctx.body, ctx.session.userId));
});
route('GET', '/api/appointments', ctx => send(ctx.res, 200, appts.forMonth(ctx.query.month || now().slice(0, 7))));

// คลังยามาตรฐาน GP (อ้างอิง — ไม่เข้าคลังจริงจนกว่าคลินิกจะเลือก+ใส่ราคา+บันทึกเอง) (UAT รอบ 2)
let commonDrugsCache = null;
route('GET', '/api/common-drugs', ctx => {
  if (!commonDrugsCache) {
    commonDrugsCache = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'lib', 'common-drugs.json'), 'utf8'));
  }
  send(ctx.res, 200, commonDrugsCache);
});

// เอกสารย้อนหลังของคนไข้: ใบเสร็จ + ใบรับรองแพทย์ ทุกใบ พร้อมลิงก์พิมพ์ (UAT B5/D1)
route('GET', '/api/patients/:hn/documents', ctx => {
  const hn = ctx.params.hn;
  if (!db.prepare('SELECT 1 FROM patients WHERE hn = ?').get(hn)) return send(ctx.res, 404, { error: 'ไม่พบคนไข้' });
  security.recordAccess('view_documents', { session: ctx.session, remoteAddress: ctx.req.socket.remoteAddress, ref: hn });
  const receipts = db.prepare(`SELECT receipt_no, visit_id, total, pay_method, status, void_reason, created_at
    FROM receipts WHERE hn = ? ORDER BY created_at DESC LIMIT 200`).all(hn);
  const certs = db.prepare(`SELECT m.cert_no, m.visit_id, m.template_key, m.language, m.created_at, m.doctor_name,
      e.action AS event_action, e.reason AS event_reason, e.replacement_cert_no
    FROM med_certs m LEFT JOIN med_cert_events e ON e.cert_no = m.cert_no
    WHERE m.hn = ? ORDER BY m.created_at DESC LIMIT 200`).all(hn);
  send(ctx.res, 200, { receipts, med_certs: certs });
});

// ==================== text presets (PE ฯลฯ) ====================
route('GET', '/api/presets', ctx =>
  send(ctx.res, 200, db.prepare('SELECT * FROM text_presets WHERE active = 1 AND field = ? ORDER BY id').all(ctx.query.field || 'pe')));
route('POST', '/api/presets', ctx => {
  requireRole(ctx, 'doctor');
  const { field, name, content } = ctx.body;
  if (!name || !name.trim() || !content || !content.trim()) throw Object.assign(new Error('ต้องมีชื่อและเนื้อหา'), { status: 400 });
  const r = db.prepare('INSERT INTO text_presets (field, name, content, created_by) VALUES (?, ?, ?, ?)')
    .run(field || 'pe', name.trim(), content, ctx.session.userId);
  send(ctx.res, 201, { id: Number(r.lastInsertRowid) });
});
route('PATCH', '/api/presets/:id', ctx => {
  requireRole(ctx, 'doctor');
  db.prepare('UPDATE text_presets SET active = ? WHERE id = ?').run(ctx.body.active === 0 ? 0 : 1, Number(ctx.params.id));
  send(ctx.res, 200, { ok: true });
});

// ==================== icd10 ====================
route('GET', '/api/icd10/search', ctx => {
  const like = `%${String(ctx.query.q || '').trim()}%`;
  send(ctx.res, 200, db.prepare(`SELECT * FROM icd10 WHERE code LIKE ? OR term_en LIKE ? OR term_th LIKE ? LIMIT 15`)
    .all(like, like, like));
});

// ==================== attachments (ผล lab: JSON base64 — เลี่ยง multipart parser) ====================
route('POST', '/api/patients/:hn/attachments', ctx => {
  requireRole(ctx, 'front', 'doctor');
  const { filename, mime, data_base64, visit_id } = ctx.body;
  if (!filename || !data_base64) throw Object.assign(new Error('ข้อมูลไฟล์ไม่ครบ'), { status: 400 });
  const safeTypes = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'text/plain': '.txt' };
  if (!safeTypes[mime]) throw Object.assign(new Error('รองรับเฉพาะ PDF, PNG, JPG, WEBP และไฟล์ข้อความ'), { status: 400 });
  const buf = Buffer.from(data_base64, 'base64');
  if (buf.length > 25 * 1024 * 1024) throw Object.assign(new Error('ไฟล์ใหญ่เกิน 25MB'), { status: 413 });
  const stored = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${safeTypes[mime]}`;
  fs.writeFileSync(path.join(ATTACH_DIR, stored), buf);
  const r = db.prepare(`INSERT INTO attachments (hn, visit_id, filename, stored_name, mime, size, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ctx.params.hn, visit_id || null, filename, stored, mime, buf.length, ctx.session.userId, now());
  send(ctx.res, 201, { id: Number(r.lastInsertRowid) });
});
route('GET', '/api/patients/:hn/attachments', ctx => {
  send(ctx.res, 200, db.prepare('SELECT id, visit_id, filename, mime, size, created_at FROM attachments WHERE hn = ? ORDER BY id DESC').all(ctx.params.hn));
});
route('GET', '/api/attachments/:id/file', ctx => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(ctx.params.id));
  if (!a) return send(ctx.res, 404, { error: 'ไม่พบไฟล์' });
  const buf = fs.readFileSync(path.join(ATTACH_DIR, a.stored_name));
  ctx.res.writeHead(200, { 'Content-Type': a.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    'Content-Security-Policy': "sandbox", 'X-Content-Type-Options': 'nosniff' });
  ctx.res.end(buf);
});

// ==================== reports / backup / admin ====================
route('GET', '/api/reports/daily', ctx => send(ctx.res, 200, reports.daily(ctx.query.date)));
route('GET', '/api/reports/drugs-monthly', ctx =>
  send(ctx.res, 200, require('./lib/drug-report').monthlyDrugs(ctx.query.month)));
route('GET', '/api/reports/ledger', ctx =>
  send(ctx.res, 200, reports.monthlyLedger(Number(ctx.query.year) || new Date().getFullYear())));
route('GET', '/api/reports/ledger-csv', ctx => {
  const year = Number(ctx.query.year) || new Date().getFullYear();
  send(ctx.res, 200, reports.ledgerCSV(year), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename=income-register-${year}.csv`,
  });
});
route('GET', '/api/patients/:hn/trends', ctx => send(ctx.res, 200, visits.trends(ctx.params.hn)));
route('GET', '/api/export/:table', ctx => {
  requireRole(ctx, 'front');
  const csv = reports.exportCSV(ctx.params.table);
  security.recordAccess('export', { session: ctx.session, remoteAddress: ctx.req.socket.remoteAddress, ref: `table:${ctx.params.table}` });
  send(ctx.res, 200, csv, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename=${ctx.params.table}-${now().slice(0, 10)}.csv`,
  });
});
route('GET', '/api/backup/status', ctx => send(ctx.res, 200, backup.status()));
route('POST', '/api/backup/run', ctx => {
  // ทุกบทบาทที่ใช้งานระบบเห็นสถานะ backup และต้องกดช่วยกู้สถานการณ์ได้
  // (admin ใช้จากหน้าตั้งค่า, doctor/front ใช้จากหน้ารายงาน)
  requireRole(ctx, 'admin', 'doctor', 'front');
  send(ctx.res, 200, backup.runBackup());
});
route('GET', '/api/backup/recovery-key', ctx => {
  requireRole(ctx);
  send(ctx.res, 410, { error: 'เพื่อความปลอดภัย ระบบจะไม่แสดง Recovery Key บนหน้าเว็บ กรุณาสร้าง Recovery Kit ลง USB' });
});
route('GET', '/api/recovery/health', ctx => { requireRole(ctx); send(ctx.res, 200, recoveryService.health()); });
route('GET', '/api/recovery/setup-options', ctx => { requireRole(ctx); send(ctx.res, 200, recoveryService.setupOptions()); });
route('POST', '/api/recovery/configure', ctx => {
  requireRole(ctx);
  send(ctx.res, 200, recoveryService.configureDestinations(ctx.body));
});
route('POST', '/api/recovery/open', ctx => {
  requireRole(ctx); requireHostLoopback(ctx);
  if (!fs.existsSync(path.join(__dirname, '..', 'update', 'installed.marker'))) return send(ctx.res, 400, { error: 'กรุณาเปิดตัวช่วยกู้จากชุดโปรแกรมที่ติดตั้งแล้ว' });
  const launcher = path.join(__dirname, 'launch', 'recovery.js');
  const child = require('node:child_process').spawn(process.execPath, ['--no-warnings', launcher], { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref(); send(ctx.res, 200, { ok: true });
});
route('POST', '/api/recovery/create-kit', ctx => {
  requireRole(ctx);
  send(ctx.res, 200, recoveryService.createKit(ctx.body.target_id));
});
route('POST', '/api/recovery/password', async ctx => {
  requireRole(ctx);
  const remote = ctx.req.socket.remoteAddress, subject = `uid:${ctx.session.userId}`;
  const gate = security.precheck('unlock', remote, subject);
  if (!gate.ok) return send(ctx.res, 429, { error: gate.message });
  if (!auth.unlockSession(ctx.session.sid, ctx.body.pin)) {
    security.noteFailure('unlock', remote, subject);
    return send(ctx.res, 401, { error: 'PIN ผู้ดูแลไม่ถูกต้อง' });
  }
  security.noteSuccess('unlock', remote, subject);
  const saved = await recoveryService.setPassword(ctx.body);
  if (TEST_INSTANCE_TOKEN && ctx.req.headers['x-clinic-test-token'] === TEST_INSTANCE_TOKEN && ctx.req.headers['x-clinic-test-crash'] === 'after-password-save') process.exit(88);
  const result = backup.runBackup();
  send(ctx.res, 200, { ok: true, password: saved, backup: result, health: recoveryService.health() });
});
route('POST', '/api/recovery/drill', async ctx => {
  requireRole(ctx);
  const result = await recoveryService.runDrill(ctx.body);
  if (TEST_INSTANCE_TOKEN && ctx.req.headers['x-clinic-test-token'] === TEST_INSTANCE_TOKEN && ctx.req.headers['x-clinic-test-crash'] === 'after-password-drill') process.exit(88);
  send(ctx.res, 200, result);
});

route('GET', '/api/users', ctx => {
  requireRole(ctx);
  send(ctx.res, 200, db.prepare('SELECT id, username, display_name, display_name_en, role, active, created_at, medical_license, specialty FROM users').all().map(u => ({ ...u, front_desk: u.role === 'doctor' && auth.canFrontDesk(u) })));
});
route('POST', '/api/users', ctx => {
  requireRole(ctx);
  const b = ctx.body;
  if (!b.username || !b.password || !b.display_name || !b.role) throw Object.assign(new Error('ข้อมูลไม่ครบ'), { status: 400 });
  auth.createUser({ username: b.username, displayName: b.display_name, displayNameEn: b.display_name_en, role: b.role, password: b.password, pin: b.pin,
    medicalLicense: b.medical_license, specialty: b.specialty }, ctx.session.userId);
  send(ctx.res, 201, { ok: true });
});
route('PATCH', '/api/users/:id', ctx => {
  requireRole(ctx);
  const id = Number(ctx.params.id);
  if ('front_desk' in ctx.body) return exactlyOnce(ctx, 'front-permission', { status: 200, scope: id,
    conflictField: 'saved_permission', conflictMessage: () => 'คำขอนี้บันทึกสิทธิ์ไปแล้ว กรุณาดูสถานะปัจจุบันในตารางผู้ใช้งาน' }, () => auth.updateUser(id, ctx.body));
  const crashAt = TEST_INSTANCE_TOKEN && ctx.req.headers['x-clinic-test-token'] === TEST_INSTANCE_TOKEN
    ? ctx.req.headers['x-clinic-test-crash'] : null;
  const result = txn(() => {
    const changed = auth.updateUser(id, ctx.body);
    if (crashAt === 'before-commit') process.exit(1);
    return changed;
  });
  if (crashAt === 'after-commit') process.exit(1);
  send(ctx.res, 200, { ...result, reauthenticate: result.sessions_revoked && id === ctx.session.userId });
});

const medicationSheet = require('./lib/medication-sheet');
const drugLabels = require('./lib/drug-labels');
const SETTING_KEYS = [...Object.keys(medicationSheet.SETTINGS), ...Object.keys(drugLabels.SETTINGS), 'clinic_name', 'clinic_address', 'clinic_phone', 'clinic_license',
  'clinic_logo_file', 'document_footer', 'medcert_paper_size', 'medcert_font_scale', 'receipt_font_scale', 'appt_font_scale', 'stock_expiry_warn_days',
  'slip_paper', 'receipt_paper', 'appointment_paper',
  'clinic_name_en', 'clinic_address_en',
  'receipt_issuer_name', 'receipt_issuer_address', 'receipt_tax_id', 'receipt_branch', 'receipt_book_no', 'receipt_vat_note',
  'receipt_show_doctor', 'appt_slip_show_doctor', 'appt_slip_show_note', 'appt_slip_footer',
  'default_service_name',
  'backup_dest_1', 'backup_dest_2', 'backup_cloud_dest', 'backup_time', 'auto_print'];
route('GET', '/api/settings', ctx => {
  const out = {};
  // stock_expiry_warn_days: หน้า stock (front/doctor) ต้องอ่านได้เพื่อโชว์/แก้เกณฑ์เตือน — ไม่ใช่ข้อมูลลับ
  const visible = ctx.session.role === 'admin' ? SETTING_KEYS
    : ['clinic_name', 'clinic_address', 'clinic_phone', 'stock_expiry_warn_days'];
  for (const k of visible) out[k] = getSetting(k, '');
  send(ctx.res, 200, out);
});
route('POST', '/api/settings', ctx => {
  requireRole(ctx);
  medicationSheet.validateSettings(ctx.body);
  drugLabels.validateSettings(ctx.body);
  if ('receipt_tax_id' in ctx.body) {
    const digits = String(ctx.body.receipt_tax_id || '').replace(/[^0-9]/g, '');
    if (digits && digits.length !== 13) throw Object.assign(new Error('เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก'), { status: 400 });
    ctx.body.receipt_tax_id = digits;
  }
  for (const k of SETTING_KEYS) if (k in ctx.body) setSetting(k, ctx.body[k]);
  send(ctx.res, 200, { ok: true });
});
route('POST', '/api/settings/logo', ctx => {
  requireRole(ctx);
  const mime = String(ctx.body.mime || '');
  if (!['image/png', 'image/jpeg'].includes(mime)) throw Object.assign(new Error('โลโก้ต้องเป็น PNG หรือ JPG'), { status: 400 });
  const buf = Buffer.from(String(ctx.body.data_base64 || ''), 'base64');
  if (!buf.length || buf.length > 2 * 1024 * 1024) throw Object.assign(new Error('โลโก้ต้องมีขนาดไม่เกิน 2 MB'), { status: 400 });
  const ext = mime === 'image/png' ? '.png' : '.jpg';
  const name = `clinic-logo-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}${ext}`;
  fs.writeFileSync(path.join(ASSET_DIR, name), buf);
  setSetting('clinic_logo_file', name);
  send(ctx.res, 200, { ok: true, file: name });
});

// ==================== print pages ====================
route('GET', '/print/labels/:no', ctx => {
 const r=billing.getReceipt(ctx.params.no),message=drugLabels.problem(r);
 const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'};
 if(message)return send(ctx.res,!drugLabels.enabled()||!r?404:409,drugLabels.errorHTML(message),headers);
 send(ctx.res,200,drugLabels.render(r,{...ctx.query,canPrint:['front','admin'].includes(ctx.session.role)}),headers);
});
route('GET', '/print/medication/:no', ctx => {
  const r = billing.getReceipt(ctx.params.no);
  const message = medicationSheet.problem(r);
  if (message) return send(ctx.res, r ? 409 : 404, medicationSheet.errorHTML(message), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  send(ctx.res, 200, medicationSheet.render(r, { paper: ctx.query.paper, font: ctx.query.font, style: ctx.query.style }), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
});
route('GET', '/print/receipt/:no', ctx => {
  const r = billing.getReceipt(ctx.params.no);
  if (!r) return send(ctx.res, 404, 'ไม่พบใบเสร็จ');
  // ?paper=/?scale= = พิมพ์แบบอื่นเฉพาะครั้งนี้ (ค่าตั้งในหน้า Admin ยังเป็นหลัก) — ค่าที่ไม่รู้จักถูกเมิน
  const html = print.receiptHTML(r, { copy: ctx.query.copy === '1', paper: ctx.query.paper, scale: ctx.query.scale });
  send(ctx.res, 200, html.replace('<div class="noprint">', '<div class="noprint">' + medicationSheet.link(r) + drugLabels.link(r)), { 'Content-Type': 'text/html; charset=utf-8' });
});
// ตัวอย่างเอกสารข้อมูลสมมติ สำหรับลองกระดาษ/เครื่องพิมพ์จากหน้าตั้งค่า (ไม่แตะฐาน)
route('GET', '/print/sample/:kind', ctx => {
  const paper = ctx.query.paper;
  if (ctx.params.kind === 'labels') return send(ctx.res, 200, drugLabels.sample({...ctx.query,canPrint:['front','admin'].includes(ctx.session.role)}), {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  if (ctx.params.kind === 'medication') return send(ctx.res, 200, medicationSheet.sample({ paper, font: ctx.query.font, style: ctx.query.style }), { 'Content-Type': 'text/html; charset=utf-8' });
  if (ctx.params.kind === 'receipt') return send(ctx.res, 200, print.sampleReceiptHTML(paper, ctx.query.scale), { 'Content-Type': 'text/html; charset=utf-8' });
  if (ctx.params.kind === 'appointment') return send(ctx.res, 200, print.sampleAppointmentHTML(paper, ctx.query.scale), { 'Content-Type': 'text/html; charset=utf-8' });
  // ?scale= ลองขนาดตัวอักษรก่อนกดบันทึก (ค่าที่บันทึกแล้วเป็นหลักเมื่อไม่ส่ง) — ค่าที่ไม่รู้จักถูกเมิน
  if (ctx.params.kind === 'medcert') return send(ctx.res, 200, print.sampleMedCertHTML(paper, ctx.query.scale), { 'Content-Type': 'text/html; charset=utf-8' });
  return send(ctx.res, 404, 'ไม่มีตัวอย่างชนิดนี้');
});
route('GET', '/print/medcert/:no', ctx => {
  const c = billing.getMedCert(ctx.params.no);
  if (!c) return send(ctx.res, 404, 'ไม่พบใบรับรองแพทย์');
  send(ctx.res, 200, print.medCertHTML(c), { 'Content-Type': 'text/html; charset=utf-8' });
});
route('GET', '/print/appointment/:id', ctx => {
  const multipleDoctors = doctors.multiple();
  const a = db.prepare(`
    SELECT a.*, p.prefix, p.first_name, p.last_name, u.display_name doctor_name
    FROM appointments a
    JOIN patients p ON p.hn = a.hn
    LEFT JOIN visits v ON v.id = a.visit_id
    LEFT JOIN users u ON u.id = ${multipleDoctors ? 'COALESCE(a.doctor_id, v.doctor_id)' : 'v.doctor_id'}
    WHERE a.id = ?`).get(Number(ctx.params.id));
  if (!a || a.cancelled) return send(ctx.res, 404, 'ไม่พบนัด หรือนัดถูกยกเลิกแล้ว');
  send(ctx.res, 200, print.appointmentSlipHTML(a, { paper: ctx.query.paper, scale: ctx.query.scale, multipleDoctors }), { 'Content-Type': 'text/html; charset=utf-8' });
});

// ==================== server ====================
const handleRequest = async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const urlPath = u.pathname;

    // Host/Origin allowlist (security round 1): กัน DNS rebinding/CSRF จากเว็บอื่นในเบราว์เซอร์เครื่องหมอ
    // ยอมรับเฉพาะ localhost / IP ของเครื่องนี้ / ชื่อเครื่อง — ไม่สน port
    if (!security.hostAllowed(req.headers.host)) {
      return send(res, 403, { error: 'ที่อยู่ที่ใช้เปิดระบบไม่ตรงกับเครื่องคลินิก — เปิดจากทางลัดของระบบคลินิกเท่านั้น' });
    }
    if (!security.originAllowed(req.headers.origin)) {
      return send(res, 403, { error: 'คำขอนี้มาจากเว็บไซต์อื่น ระบบคลินิกไม่รับ' });
    }

    // static files
    if (req.method === 'GET' && !urlPath.startsWith('/api/') && !urlPath.startsWith('/print/')) {
      let fp = urlPath === '/' ? '/index.html' : urlPath;
      const full = path.normalize(path.join(PUBLIC_DIR, fp));
      if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', ...BASE_HEADERS });
        res.end(fs.readFileSync(full));
        return;
      }
      return send(res, 404, 'not found');
    }

    const m = matchRoute(req.method, urlPath);
    if (!m) return send(res, 404, { error: 'ไม่พบ endpoint' });

    const session = auth.getSession(parseCookies(req)[SESSION_COOKIE]);
    if (!m.opts.public) {
      if (!session) return send(res, 401, { error: 'กรุณา login' });
      if (session.locked && !m.opts.allowLocked) return send(res, 423, { error: 'หน้าจอถูกล็อก กรุณาปลดล็อกด้วย PIN' });
    }
    // clock error → รับเฉพาะ read (plan §3: บล็อกการเขียนทั้งหมด แต่จอยังเปิดดูข้อมูลได้)
    if (clockError && req.method !== 'GET' && !['/api/login', '/api/logout', '/api/unlock', '/api/system/clock-recheck'].includes(urlPath)) {
      return send(res, 503, { error: clockError });
    }

    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const raw = await readBody(req);
      if (raw.length) {
        try { body = JSON.parse(raw.toString('utf8')); }
        catch { return send(res, 400, { error: 'JSON ไม่ถูกต้อง' }); }
      }
    }
    // GET จาก poll/background ไม่ถือว่าเป็น activity ของคน ใช้ POST heartbeat จาก event จริงแทน
    if (session && !session.locked && req.method !== 'GET' && urlPath !== '/api/logout') auth.touchSession(session.sid);

    const ctx = { req, res, params: m.params, query: Object.fromEntries(u.searchParams), body, session };
    await m.handler(ctx);
  } catch (e) {
    const status = e.status || (String(e.message).includes('UNIQUE') ? 409 : 500);
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.status ? e.message : `เกิดข้อผิดพลาด: ${e.message}`, ...(e.replace_appointment ? {replace_appointment:e.replace_appointment} : {}) });
    // body ใหญ่เกิน: ตอบ 413 ให้ browser เห็นก่อน แล้วค่อยปิด socket ตัดการอัปโหลดที่เหลือ
    if (status === 413) res.on('finish', () => { try { req.destroy(); } catch {} });
  }
};

// ==================== listeners (security round 1, A-refined) ====================
// HTTP  : bind เฉพาะ 127.0.0.1 (หน้าร้าน/เครื่องมือภายใน/updater/recovery) — LAN ผ่าน HTTP ไม่ได้อีก
//         ยกเว้นตั้ง CLINIC_ALLOW_HTTP_LAN=1 (ช่างเทคนิค/ทดสอบ เท่านั้น — ห้ามใช้กับข้อมูลคนไข้จริง)
// HTTPS : ถ้ามี cert (CLINIC_TLS_PFX หรือ <install>/cert/clinic.pfx) เปิด 0.0.0.0:CLINIC_HTTPS_PORT ให้เครื่องห้องตรวจ
//         cert เป็น self-signed ที่ตัวติดตั้งสร้าง; เครื่องหมอติดตั้ง .cer (public) ครั้งเดียว — private key ไม่ออกจากเครื่อง host
const ALLOW_HTTP_LAN = process.env.CLINIC_ALLOW_HTTP_LAN === '1';
const HTTPS_PORT = Number(process.env.CLINIC_HTTPS_PORT || getSetting('https_port', String(PORT + 363)));
const CERT_DIR = process.env.CLINIC_CERT_DIR || path.join(__dirname, '..', 'cert');
const TLS_PFX = process.env.CLINIC_TLS_PFX || path.join(CERT_DIR, 'clinic.pfx');
const TLS_PASS_FILE = process.env.CLINIC_TLS_PASS_FILE || path.join(CERT_DIR, 'clinic.pfx.pass');
function loadTls() {
  if (!fs.existsSync(TLS_PFX)) return null;
  try {
    const passphrase = fs.existsSync(TLS_PASS_FILE) ? fs.readFileSync(TLS_PASS_FILE, 'utf8').trim() : '';
    return { pfx: fs.readFileSync(TLS_PFX), passphrase };
  } catch (e) { console.error(`อ่านใบรับรอง HTTPS ไม่ได้ (${TLS_PFX}): ${e.message} — เปิดเฉพาะเครื่องนี้`); return null; }
}

const servers = [];
const server = http.createServer(handleRequest); // ชื่อเดิมคงไว้ให้โค้ด/เอกสารที่อ้างถึง
servers.push(server);
const tls = loadTls();
const httpsServer = tls ? require('node:https').createServer(tls, handleRequest) : null;
if (httpsServer) servers.push(httpsServer);

// เปิดซ้ำบนพอร์ตเดิม → bind ไม่ได้ ให้แจ้งชัดแล้วออกโดยไม่แตะ token ของ server ตัวเดิม
function onListenError(port) {
  return err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`พอร์ต ${port} ถูกใช้อยู่แล้ว — ระบบคลินิกน่าจะเปิดอยู่ก่อนแล้ว ไม่ต้องเปิดซ้ำ`);
      process.exit(10); // 10 = ตกลงกับ launch/supervisor.js ว่า "มีระบบเปิดอยู่แล้ว ห้ามเปิดกลับ" (ดู lib/applog.js)
    }
    throw err;
  };
}
server.on('error', onListenError(PORT));
if (httpsServer) httpsServer.on('error', onListenError(HTTPS_PORT));
backup.schedule();
server.listen(PORT, ALLOW_HTTP_LAN ? '0.0.0.0' : '127.0.0.1', () => {
  // bind สำเร็จแล้วจึงเป็นเจ้าของ token — เขียนตอนนี้เท่านั้น
  fs.writeFileSync(RECOVERY_CONTROL_FILE, RECOVERY_CONTROL_TOKEN, { mode: 0o600 });
  try {
    const bootVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
    console.log(`boot: clinic ${bootVersion} · node ${process.version} · schema ${db.prepare('PRAGMA user_version').get().user_version} · pid ${process.pid}`);
  } catch {}
  console.log(`clinic system running: http://localhost:${PORT}` +
    (ALLOW_HTTP_LAN ? ` (LAN HTTP เปิดอยู่: http://<ip-เครื่องนี้>:${PORT} — โหมดช่าง/ทดสอบ)` : ' (HTTP เฉพาะเครื่องนี้)'));
  updateService.startScheduler();
  if (clockError) console.error('!! CLOCK ERROR MODE — ระบบไม่รับการเขียนจนกว่าจะตั้งเวลาถูก');
  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`LAN (เครื่องห้องตรวจ): https://<ip-เครื่องนี้>:${HTTPS_PORT}`);
    });
  } else {
    console.log('ยังไม่มีใบรับรอง HTTPS — เครื่องอื่นในวง LAN เข้าไม่ได้ (รัน "ตั้งค่าใช้สองเครื่อง" เพื่อสร้าง)');
  }
});
