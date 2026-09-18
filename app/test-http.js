'use strict';
// Safe HTTP harness: creates an isolated DB, proves the test token, and cleans
// it up. This is the only supported way to run test-smoke.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const cert = require('./lib/cert');

// ใบรับรอง HTTPS สังเคราะห์สำหรับ LAN leg (A-refined: HTTP เฉพาะ loopback, LAN ต้อง HTTPS) — สร้างครั้งเดียวต่อรอบ harness
let testCertDir = null;
function ensureTestCert(lanIp) {
  if (testCertDir) return testCertDir;
  testCertDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-http-cert-'));
  cert.generateCert({ outDir: testCertDir, ips: ['127.0.0.1', lanIp], name: 'ClinicApp-HttpTest', years: 1 });
  return testCertDir;
}

function waitReady(url, token, milliseconds = 10000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const response = await fetch(url + '/api/test-instance', { headers: { 'X-Clinic-Test-Token': token } });
        if (response.status === 200) return resolve();
      } catch {}
      if (Date.now() - started > milliseconds) return reject(new Error('isolated server did not start'));
      setTimeout(check, 100);
    };
    check();
  });
}

async function runIsolated({ idleLockMs, smokeEnv }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-http-smoke-'));
  const token = crypto.randomBytes(24).toString('hex');
  const port = 18000 + crypto.randomInt(0, 20000);
  const httpsPort = port + 363;
  const lanIp = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))?.address;
  if (!lanIp) throw new Error('ไม่พบ LAN IPv4 จริงสำหรับทดสอบ HTTPS LAN/host gate');
  const certDir = ensureTestCert(lanIp);
  // ตัวช่วย "ตั้งค่าใช้สองเครื่อง" ปลอมสำหรับพิสูจน์ว่าปุ่มในหน้า Admin เรียกสคริปต์จริงได้ (ของจริงอยู่ในโฟลเดอร์ติดตั้งเท่านั้น)
  // ไฟล์/marker อยู่ใน temp ASCII — CLINIC_LAN_HELPER เป็นช่อง override สำหรับ test เท่านั้น ห้ามใส่ใน launcher
  const fakeHelper = path.join(dataDir, 'fake-lan-helper.cmd');
  const helperMarker = path.join(dataDir, 'lan-helper-started.txt');
  fs.writeFileSync(fakeHelper, '@echo off\r\necho started > "%SMOKE_LAN_HELPER_MARKER%"\r\nexit /b 0\r\n', 'ascii');
  const env = { ...process.env, CLINIC_DATA_DIR: dataDir, CLINIC_PORT: String(port), CLINIC_HTTPS_PORT: String(httpsPort),
    CLINIC_CERT_DIR: certDir, CLINIC_TEST_INSTANCE_TOKEN: token, CLINIC_IDLE_LOCK_MS: String(idleLockMs),
    CLINIC_LAN_HELPER: fakeHelper, SMOKE_LAN_HELPER_MARKER: helperMarker };
  let server = null;
  try {
    const seeded = spawnSync(process.execPath, ['--no-warnings', 'seed.js', '--demo'], { cwd: __dirname, env, encoding: 'utf8' });
  if (seeded.status !== 0) throw new Error(seeded.stderr || 'seed failed');
    server = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const base = `http://127.0.0.1:${port}`;
    await waitReady(base, token);
    // smoke child ยิง LAN leg ผ่าน HTTPS self-signed → ปิดการตรวจ CA เฉพาะ process ทดสอบนี้ (ไม่ใช่ server)
    const smoke = spawnSync(process.execPath, ['--no-warnings', 'test-smoke.js', base], {
      cwd: __dirname, env: { ...env, ...smokeEnv, NODE_TLS_REJECT_UNAUTHORIZED: '0',
        SMOKE_LAN_BASE: `https://${lanIp}:${httpsPort}`, SMOKE_LAN_HTTP_BASE: `http://${lanIp}:${port}`, SMOKE_LAN_IP: lanIp }, encoding: 'utf8', timeout: 180000,
    });
    process.stdout.write(smoke.stdout || '');
    process.stderr.write(smoke.stderr || '');
    if (smoke.status !== 0) throw new Error(`isolated smoke exited ${smoke.status}`);
  } finally {
    if (server) { try { server.kill(); } catch {} }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  if(process.env.CLINIC_TEST_AUDIT_ONLY==='1'){await require('./test-audit-http')();return;}
  if(process.env.CLINIC_TEST_PASSWORD_ONLY==='1'){await require('./test-password-recovery-http')();return;}
  if(process.env.CLINIC_TEST_TRIAL_TOOLS_ONLY==='1'){await require('./test-trial-maintenance-http')();return;}
  if(process.env.CLINIC_TEST_DOSE_ONLY==='1'){await require('./test-dose-defaults-http')();return;}
  if(process.env.CLINIC_TEST_RUNTIME_ONLY==='1'){await require('./test-runtime-http')();return;}
  if(process.env.CLINIC_TEST_COEXISTENCE_ONLY==='1'){await require('./test-coexistence-http')();return;}
  if(process.env.CLINIC_TEST_SOLO_ONLY==='1'){await require('./test-solo-doctor-http')();return;}
  // เวลาครึ่งวินาทีใช้เฉพาะพิสูจน์ idle lock แล้วทิ้ง instance นี้ทันที
  await runIsolated({ idleLockMs: 500, smokeEnv: { SMOKE_FAST_IDLE: '1', SMOKE_IDLE_ONLY: '1' } });
  // flow เต็มใช้เวลาจริง เพื่อไม่ให้เงื่อนไขทดสอบ idle มารบกวน role อื่น
  await runIsolated({ idleLockMs: 10 * 60 * 1000, smokeEnv: { SMOKE_FAST_IDLE: '0' } });
  await require('./test-appointments-http')();
  await require('./test-coexistence-http')();
  await require('./test-auth-http')();
  await require('./test-audit-http')();
  await require('./test-service-cost-http')();
  await require('./test-solo-doctor-http')();
  await require('./test-dose-defaults-http')();
  await require('./test-password-recovery-http')();
  await require('./test-trial-maintenance-http')();
  if(process.env.CLINIC_TEST_RUNTIME==='1')await require('./test-runtime-http')();
  if(process.env.CLINIC_TEST_RECORDING_KIT==='1')await require('../tools/recording/test-http.cjs')();
})().catch(error => {
  console.error(`HTTP HARNESS FAIL: ${error.message}`);
  process.exitCode = 1;
}).finally(() => { if (testCertDir) { try { fs.rmSync(testCertDir, { recursive: true, force: true }); } catch {} } });
