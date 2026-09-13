'use strict';
// supervisor: เปิด server.js แล้วเฝ้า — server ตายโดยไม่ตั้งใจ = เปิดกลับให้เองใน ~2 วิ + จด log
// เกิดจาก incident 2026-08-24: server หายกลางงานหมอแล้วไม่มีทั้งคนเปิดกลับและหลักฐาน
// exit code จาก server (ตกลงใน lib/applog.js): 0 = ตั้งใจปิด (recovery/update) · 10 = พอร์ตถูกใช้
// (มีระบบเปิดอยู่แล้ว) · 11 = ฐานข้อมูลรุ่นใหม่กว่าโปรแกรม · อื่นๆ = crash → เปิดกลับ
// เปิดกลับแล้วตายเร็ว (<15 วิ) ติดกัน 3 ครั้ง = ปัญหาถาวร → หยุด + กล่องบอกผู้ใช้ (กติกาสคริปต์ข้อ 6)
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const applog = require('../lib/applog');

const APP_ROOT = path.join(__dirname, '..');
const LOG = applog.makeLogger('supervisor');
const RETRY_MS = Number(process.env.CLINIC_SUPERVISOR_RETRY_MS || 2000);
const FAST_CRASH_MS = Number(process.env.CLINIC_SUPERVISOR_FASTCRASH_MS || 15000);
const HEADLESS = process.env.CLINIC_INSTALL_TEST === '1' || process.env.CLINIC_SUPERVISOR_TEST === '1';

// ข้อความที่ผู้ใช้ต้องเห็นผล = กล่อง Windows ไม่ใช่หน้าต่างดำ (ไทยแตกใน conhost) — ส่งผ่าน env ห้ามฝังใน argument
function messageBox(text) {
  LOG.error(`messageBox: ${text}`);
  if (HEADLESS) return;
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:CLINIC_SUP_MSG, $env:CLINIC_SUP_TITLE) | Out-Null'],
    { env: { ...process.env, CLINIC_SUP_MSG: text, CLINIC_SUP_TITLE: 'ระบบคลินิก' }, timeout: 120000, windowsHide: false });
  } catch {}
}

let fastCrashes = 0;
function startServer() {
  const startedAt = Date.now();
  // stdio ignore ได้เพราะ server เขียน log ของตัวเองผ่าน lib/applog แล้ว
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: APP_ROOT, stdio: 'ignore', windowsHide: true, env: process.env,
  });
  LOG.info(`start server.js pid=${child.pid} port=${process.env.CLINIC_PORT || '(default)'}`);
  child.on('exit', (code, signal) => {
    const uptimeMs = Date.now() - startedAt;
    LOG.info(`server exited code=${code} signal=${signal || '-'} uptime=${Math.round(uptimeMs / 1000)}s`);
    if (code === 0) process.exit(0); // ตั้งใจปิด (prepare-restore/update) — ห้ามเปิดกลับ ไม่งั้นชนกับ update-assistant
    if (code === 10) { LOG.info('พอร์ตถูกใช้อยู่ — มีระบบคลินิกเปิดอยู่แล้ว ไม่เปิดซ้อน'); process.exit(0); }
    if (code === 11) {
      messageBox('เปิดระบบคลินิกไม่ได้: ฐานข้อมูลถูกปรับโดยโปรแกรมรุ่นใหม่กว่า กรุณาแจ้งผู้ดูแลก่อนใช้งาน (รายละเอียดอยู่ในโฟลเดอร์ logs)');
      process.exit(1);
    }
    fastCrashes = uptimeMs < FAST_CRASH_MS ? fastCrashes + 1 : 0;
    if (fastCrashes >= 3) {
      messageBox('เปิดระบบคลินิกไม่สำเร็จ 3 ครั้งติดกัน — กรุณาแจ้งผู้ดูแล และถ้าเข้าโปรแกรมได้ให้กดปุ่ม "🆘 แจ้งปัญหา" ส่งไฟล์รายงานให้ผู้ดูแลด้วย');
      process.exit(1);
    }
    LOG.error(`server ตายโดยไม่ตั้งใจ (code=${code}) — เปิดกลับใน ${RETRY_MS} ms (ครั้งที่ตายเร็วติดกัน: ${fastCrashes})`);
    setTimeout(startServer, RETRY_MS);
  });
  child.on('error', error => {
    LOG.error(`spawn server ไม่ได้: ${error.message}`);
    messageBox('เปิดระบบคลินิกไม่ได้ (เรียกโปรแกรมหลักไม่สำเร็จ) กรุณาแจ้งผู้ดูแล');
    process.exit(1);
  });
}

LOG.info(`supervisor start pid=${process.pid} node=${process.version}`);
startServer();
