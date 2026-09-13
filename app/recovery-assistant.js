'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const recovery = require('./lib/recovery-core');
const discovery = require('./lib/recovery-discovery');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : null;
}

const kitRoot = argument('--kit-root');
const descriptorFile = kitRoot ? path.join(kitRoot, 'clinic-recovery-kit.json') : null;
let descriptor = null;
try { if (descriptorFile) descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8')); } catch {}
const sessionToken = crypto.randomBytes(24).toString('hex');
let challenge = String(crypto.randomInt(1000, 10000));
let cachedSources = new Map();

function defaultInstallation() {
  const appRoot = __dirname;
  return { appRoot, liveDataDir: path.join(appRoot, 'data'), port: 8080,
    executable: process.execPath, args: ['--no-warnings', 'server.js'] };
}

function installation() {
  const raw = descriptor && descriptor.installation || defaultInstallation();
  return {
    appRoot: path.resolve(String(raw.appRoot || __dirname)),
    liveDataDir: path.resolve(String(raw.liveDataDir || path.join(raw.appRoot || __dirname, 'data'))),
    port: Number(raw.port) || 8080,
    executable: path.resolve(String(raw.executable || process.execPath)),
    args: Array.isArray(raw.args) ? raw.args.map(String) : ['--no-warnings', 'server.js'],
  };
}

function keyFileFor(profile) {
  const kitKey = kitRoot && path.join(kitRoot, 'Recovery Key.txt');
  if (kitKey && fs.existsSync(kitKey)) return kitKey;
  const localKey = path.join(profile.liveDataDir, 'cloud-backup.key');
  return fs.existsSync(localKey) ? localKey : null;
}

function sourceId(directory) {
  return crypto.createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 16);
}

function refreshSources() {
  const profile = installation();
  const knownPaths = [path.join(profile.liveDataDir, 'backups')];
  const found = discovery.discover({ knownPaths, kitRoot });
  const keyFile = keyFileFor(profile);
  let key = null;
  if (keyFile) { try { key = recovery.readRecoveryKeyFile(keyFile); } catch {} }
  cachedSources = new Map();
  const sources = [];
  try {
    for (const item of found.sources) {
      const id = sourceId(item.directory);
      let points = [];
      try { points = recovery.listRestorePoints(item.directory, key); } catch {}
      const complete = points.filter(point => point.complete);
      if (!complete.length) continue;
      // เรียง encrypted (ผูกกับ Recovery Key) มาก่อนเสมอ แล้วค่อยเรียงตามเวลา — กัน plaintext
      // ที่ใหม่กว่าแต่ไม่ได้ยืนยันตัวตนมาแซง point ที่เข้ารหัสถูกต้องภายใน source เดียวกัน
      complete.sort((a, b) => (Number(b.encrypted) - Number(a.encrypted)) ||
        String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const source = { ...item, id, points: complete };
      cachedSources.set(id, source);
      sources.push({ id, kind: item.kind, label: item.label, latest: complete[0], points: complete,
        encrypted: !!complete[0].encrypted, technicianPath: item.directory });
    }
  } finally { if (key) key.fill(0); }
  sources.sort((a, b) => String(b.latest.createdAt || '').localeCompare(String(a.latest.createdAt || '')));
  return { profile, found, sources, keyAvailable: !!keyFile, kitAvailable: !!(kitRoot && descriptor) };
}

function sanitizeError(error) {
  return { code: error.code || 'RECOVERY_FAILED', message: error.message || 'ทำรายการไม่สำเร็จ' };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { reject(new Error('ข้อมูลคำสั่งใหญ่เกินไป')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('ข้อมูลคำสั่งไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

function requestJson(options, body = null, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, timeout }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function isClinicReady(profile) {
  try {
    const result = await requestJson({ hostname: '127.0.0.1', port: profile.port, path: '/api/recovery/ready', method: 'GET' });
    return result.status === 200;
  } catch { return false; }
}

async function stopClinic(profile) {
  if (!(await isClinicReady(profile))) return { stopped: true, wasRunning: false };
  const tokenFile = path.join(profile.liveDataDir, 'recovery-control.token');
  if (!fs.existsSync(tokenFile)) throw Object.assign(new Error('ระบบคลินิกยังหยุดอย่างปลอดภัยไม่ได้ กรุณาปิด ClinicApp แล้วลองอีกครั้ง'), { code: 'APP_STOP_FAILED' });
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw Object.assign(new Error('ระบบคลินิกยังหยุดอย่างปลอดภัยไม่ได้'), { code: 'APP_STOP_FAILED' });
  const result = await requestJson({ hostname: '127.0.0.1', port: profile.port, path: '/api/system/prepare-restore', method: 'POST',
    headers: { 'X-Recovery-Control': token, 'Content-Length': '0' } }, null, 5000);
  if (result.status !== 200) throw Object.assign(new Error('หยุด ClinicApp ไม่สำเร็จ ระบบยังไม่ได้แตะข้อมูลจริง'), { code: 'APP_STOP_FAILED' });
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (!(await isClinicReady(profile))) return { stopped: true, wasRunning: true };
  }
  throw Object.assign(new Error('ClinicApp ยังไม่หยุด ระบบยังไม่ได้แตะข้อมูลจริง'), { code: 'APP_STOP_FAILED' });
}

function startClinic(profile) {
  const child = spawn(profile.executable, profile.args, { cwd: profile.appRoot, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function waitClinicReady(profile, milliseconds = 15000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    if (await isClinicReady(profile)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

function ensureInstallation(profile) {
  if (fs.existsSync(path.join(profile.appRoot, 'server.js'))) return profile;
  if (!kitRoot || !fs.existsSync(path.join(kitRoot, 'ClinicApp', 'server.js'))) {
    throw Object.assign(new Error('ไม่พบชุดโปรแกรม ClinicApp ใน Recovery Kit'), { code: 'APP_MISSING' });
  }
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ClinicApp');
  const appRoot = path.join(base, 'app');
  const runtimeDir = path.join(base, 'runtime');
  if (fs.existsSync(base)) throw Object.assign(new Error('พบโฟลเดอร์ติดตั้งเดิมแต่ไม่สมบูรณ์ กรุณาเปิดรายละเอียดสำหรับช่าง'), { code: 'INSTALL_INCOMPLETE' });
  fs.mkdirSync(base, { recursive: false });
  try {
    fs.cpSync(path.join(kitRoot, 'ClinicApp'), appRoot, { recursive: true, errorOnExist: true });
    fs.cpSync(path.join(kitRoot, 'runtime'), runtimeDir, { recursive: true, errorOnExist: true });
  } catch (error) {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    throw error;
  }
  return { appRoot, liveDataDir: path.join(appRoot, 'data'), port: profile.port,
    executable: path.join(runtimeDir, 'node.exe'), args: ['--no-warnings', 'server.js'] };
}

async function runDrill(body) {
  const source = cachedSources.get(String(body.sourceId || ''));
  if (!source) throw Object.assign(new Error('กรุณาเลือกข้อมูลสำรองอีกครั้ง'), { code: 'SOURCE_CHANGED' });
  const point = source.points.find(item => item.id === body.manifestFile) || source.points[0];
  const profile = installation();
  const keyFile = keyFileFor(profile);
  const drillsRoot = path.join(path.dirname(profile.liveDataDir), 'recovery-drills');
  fs.mkdirSync(drillsRoot, { recursive: true });
  const outputDir = path.join(drillsRoot, `drill-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  const result = recovery.restoreToNewDirectory({ sourceDir: source.directory, outputDir,
    manifestFile: point.id, keyFile: point.encrypted ? keyFile : null });
  // A drill proves the restore, then removes the decrypted patient copy and keeps only a sanitized receipt.
  fs.rmSync(path.join(outputDir, 'data'), { recursive: true, force: true });
  return { ...result, outputDir: null };
}

async function runActualRestore(body) {
  if (!kitRoot || !descriptor) throw Object.assign(new Error('กรุณาเปิดตัวช่วยนี้จาก Recovery Kit USB'), { code: 'KIT_REQUIRED' });
  if (String(body.challenge || '') !== challenge) throw Object.assign(new Error('เลขยืนยันไม่ถูกต้อง ระบบยังไม่ได้แตะข้อมูลจริง'), { code: 'CONFIRMATION_FAILED' });
  const source = cachedSources.get(String(body.sourceId || ''));
  if (!source) throw Object.assign(new Error('กรุณาเลือกข้อมูลสำรองอีกครั้ง'), { code: 'SOURCE_CHANGED' });
  const point = source.points.find(item => item.id === body.manifestFile) || source.points[0];
  let profile = ensureInstallation(installation());
  const keyFile = keyFileFor(profile) || path.join(kitRoot, 'Recovery Key.txt');
  const stage = path.join(path.dirname(profile.liveDataDir), `.recovery-stage-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  let published = null;
  let stopResult = null;
  try {
    recovery.restoreToNewDirectory({ sourceDir: source.directory, outputDir: stage,
      manifestFile: point.id, keyFile: point.encrypted ? keyFile : null });
    stopResult = await stopClinic(profile);
    published = recovery.publishPreparedData({ preparedDataDir: path.join(stage, 'data'), liveDataDir: profile.liveDataDir });
    startClinic(profile);
    if (!(await waitClinicReady(profile))) {
      recovery.rollbackPublishedData({ liveDataDir: profile.liveDataDir, rollbackDir: published.rollbackDir });
      startClinic(profile);
      throw Object.assign(new Error('ข้อมูลชุดใหม่เปิดไม่ได้ ระบบนำข้อมูลเดิมกลับให้แล้ว'), { code: 'START_FAILED_ROLLED_BACK' });
    }
    challenge = String(crypto.randomInt(1000, 10000));
    return { ok: true, backupCreatedAt: point.createdAt, appReady: true };
  } catch (error) {
    if (stopResult && stopResult.wasRunning && !published) { try { startClinic(profile); } catch {} }
    throw error;
  } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} }
}

function renderHtml() {
  const candidates = [path.join(__dirname, 'public', 'recovery.html'), path.join(__dirname, 'ClinicApp', 'public', 'recovery.html')];
  const file = candidates.find(candidate => fs.existsSync(candidate));
  if (!file) return '<!doctype html><meta charset="utf-8"><h1>ไม่พบหน้าตัวช่วยกู้ข้อมูล</h1>';
  return fs.readFileSync(file, 'utf8').replaceAll('__RECOVERY_TOKEN__', sessionToken);
}

const server = http.createServer(async (req, res) => {
  const remote = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return sendJson(res, 403, { error: 'local only' });
  // ตรวจ Host header ด้วย ไม่ใช่แค่ IP ปลายทาง — กันเว็บภายนอกที่ชี้โดเมนมาที่ 127.0.0.1 (DNS rebinding)
  // มาอ่าน token ในหน้านี้แล้วสั่งกู้ข้อมูล เปิดจากไอคอน Recovery Kit จริงจะเป็น 127.0.0.1/localhost เสมอ
  // รับเฉพาะ loopback Host ทั้งสตริง + optional port ที่ถูกช่วง
  // ไม่ตัด prefix จากวงเล็บ เพราะรูปอย่าง [::1].evil.example ต้องถูกปฏิเสธ
  const rawHost = String(req.headers.host || '');
  const hostMatch = rawHost.match(/^(?:(127\.0\.0\.1|localhost)|\[(::1)\])(?::([0-9]{1,5}))?$/i);
  const hostPort = hostMatch && hostMatch[3] ? Number(hostMatch[3]) : null;
  if (!hostMatch || (hostPort != null && (hostPort < 1 || hostPort > 65535))) {
    return sendJson(res, 403, { error: 'local only' });
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' && req.method === 'GET') {
    const html = renderHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff' });
    return res.end(html);
  }
  if (req.headers['x-recovery-token'] !== sessionToken) return sendJson(res, 403, { error: 'หน้าตัวช่วยหมดอายุ กรุณาเปิดใหม่' });
  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const state = refreshSources();
      // แนะนำชุดที่เข้ารหัส (ผูกกับ Recovery Key ของคลินิกนี้) ก่อนเสมอ — กันการวางไฟล์สำรองปลอมแบบไม่เข้ารหัส
      // ที่ "ใหม่กว่า" มาหลอกให้กู้ ถ้าไม่มีชุดเข้ารหัสเลยจึงค่อยแนะนำชุดที่ใหม่ที่สุดตามเวลา
      const recommended = state.sources.find(s => s.encrypted) || state.sources[0] || null;
      return sendJson(res, 200, { ok: true, kitAvailable: state.kitAvailable, keyAvailable: state.keyAvailable,
        sources: state.sources, recommendedSourceId: recommended && recommended.id, challenge,
        message: recommended ? 'พบข้อมูลสำรองที่พร้อมตรวจ' : 'ยังไม่พบข้อมูลสำรอง กรุณาเสียบ USB หรือเปิด Google Drive' });
    }
    if (url.pathname === '/api/drill' && req.method === 'POST') return sendJson(res, 200, await runDrill(await readJson(req)));
    if (url.pathname === '/api/restore' && req.method === 'POST') return sendJson(res, 200, await runActualRestore(await readJson(req)));
    return sendJson(res, 404, { error: 'not found' });
  } catch (error) { return sendJson(res, 400, { error: sanitizeError(error) }); }
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  if (process.platform === 'win32') {
    try { const child = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); } catch {}
  }
  console.log(`ตัวช่วยกู้ข้อมูลพร้อมใช้งานที่ ${url}`);
});
