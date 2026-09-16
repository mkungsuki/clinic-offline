'use strict';
// สถานะ "เครื่องห้องตรวจ" (คอมเครื่องที่สอง) สำหรับหน้า Admin — อ่านอย่างเดียว ไม่แก้อะไรในเครื่อง
// เหตุผล (2026-08-16 เจ้าของกดหน้างานเอง): ตัวช่วย "ตั้งค่าใช้สองเครื่อง" มีแต่ตอนติดตั้ง/ไฟล์ใน C:\clinic* ที่ไม่มีใครเข้าไปหา
// และไม่มีที่ไหนบอกว่า "ตอนนี้เชื่อมอยู่ไหม / ทำไมเครื่องหมอเข้าไม่ได้" → การ์ดนี้บอกสถานะ 4 ขั้น + ปุ่มเรียกตัวช่วยเดิม
//
// แหล่งข้อมูล (ทั้งหมดอยู่ในเครื่องนี้):
//   <cert>/clinic-cert.json  — SAN/วันหมดอายุของใบรับรอง (lib/cert.js)
//   <cert>/lan-setup.json    — ตัวช่วยเขียนตอนตั้งค่าสำเร็จ: url, ip, https_port, output_dir, rule_name, at
//   os.networkInterfaces()   — IP วง LAN ปัจจุบัน (เทียบกับ SAN → รู้ว่า IP เปลี่ยนแล้วต้องส่งใบรับรองใหม่)
//   PowerShell Get-NetFirewallRule — rule เปิดอยู่ไหมและชี้ node.exe ตัวที่รันอยู่หรือเปล่า (async + cache 60 วิ ไม่ค้าง event loop)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const cert = require('./cert');

const SETUP_INFO_NAME = 'lan-setup.json';
const FIREWALL_CACHE_MS = 60 * 1000;

function localLanIPv4s() {
  const out = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

function readSetupInfo(certDir) {
  try { return JSON.parse(fs.readFileSync(path.join(certDir, SETUP_INFO_NAME), 'utf8')); } catch { return null; }
}

// ตัวช่วยสองเครื่องอยู่ที่ root ของโฟลเดอร์ติดตั้ง ชื่อ "ตั้งค่าใช้สองเครื่อง.cmd" หรือ "… (ทดลอง).cmd"
// CLINIC_LAN_HELPER = override สำหรับ test (harness ชี้ไปสคริปต์ปลอมใน temp) — ห้ามใส่ใน launcher จริง
function findHelper(installRoot) {
  if (process.env.CLINIC_LAN_HELPER) return fs.existsSync(process.env.CLINIC_LAN_HELPER) ? process.env.CLINIC_LAN_HELPER : null;
  try {
    const name = fs.readdirSync(installRoot).find(f => /^ตั้งค่าใช้สองเครื่อง.*\.cmd$/.test(f));
    return name ? path.join(installRoot, name) : null;
  } catch { return null; }
}

// ---- firewall probe (Windows เท่านั้น; ที่อื่นตอบ unsupported = "ตรวจไม่ได้" ไม่ใช่ "ไม่มี") ----
let firewallCache = { at: 0, ruleName: null, value: null, pending: null };
function probeFirewall(ruleName) {
  if (process.platform !== 'win32' || !ruleName) return Promise.resolve({ state: 'unsupported' });
  const fresh = firewallCache.value && firewallCache.ruleName === ruleName && Date.now() - firewallCache.at < FIREWALL_CACHE_MS;
  if (fresh) return Promise.resolve(firewallCache.value);
  if (firewallCache.pending && firewallCache.ruleName === ruleName) return firewallCache.pending;
  // ชื่อ rule ส่งผ่าน env ไม่ฝังในคำสั่ง (กติกาสคริปต์ข้อ 6)
  const script = "$r = Get-NetFirewallRule -DisplayName $env:CLINIC_FW_RULE -ErrorAction SilentlyContinue | Select-Object -First 1; " +
    "if (-not $r) { '{\"found\":false}' } else { $p = ($r | Get-NetFirewallApplicationFilter).Program; " +
    "@{ found = $true; enabled = [bool]$r.Enabled; program = [string]$p; profile = [string]$r.Profile } | ConvertTo-Json -Compress }";
  const pending = new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, CLINIC_FW_RULE: ruleName }, timeout: 8000, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        let value;
        if (error) value = { state: 'unknown', detail: error.code === 'ETIMEDOUT' ? 'timeout' : String(error.message).slice(0, 200) };
        else {
          try {
            const parsed = JSON.parse(String(stdout).trim() || '{}');
            value = parsed.found ? { state: 'found', enabled: !!parsed.enabled, program: parsed.program || '', profile: parsed.profile || '' } : { state: 'missing' };
          } catch { value = { state: 'unknown', detail: 'parse' }; }
        }
        firewallCache = { at: Date.now(), ruleName, value, pending: null };
        resolve(value);
      });
  });
  firewallCache = { ...firewallCache, ruleName, pending };
  return pending;
}
function resetFirewallCache() { firewallCache = { at: 0, ruleName: null, value: null, pending: null }; }

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
}

// สถานะรวมสำหรับการ์ด — ทุกฟิลด์เป็นข้อเท็จจริง การตีความเป็นภาษาคนทำที่ฝั่ง UI (มี hint ให้)
async function collect({ certDir, installRoot, httpsPort, httpsListening, host }) {
  const info = cert.readCertInfo(certDir);
  const setup = readSetupInfo(certDir);
  const ips = localLanIPv4s();
  const san = Array.isArray(info?.san) ? info.san : [];
  const sanIps = san.filter(s => s.startsWith('IPAddress=')).map(s => s.slice('IPAddress='.length));
  const coveredIps = ips.filter(ip => sanIps.includes(ip));
  const daysLeft = cert.daysUntilExpiry(certDir);
  const helper = findHelper(installRoot);
  const outputDir = setup?.output_dir && fs.existsSync(setup.output_dir) ? setup.output_dir : null;
  const firewall = await probeFirewall(setup?.rule_name || null);
  const firewallOk = firewall.state === 'found' && firewall.enabled && samePath(firewall.program, process.execPath);

  // ขั้นที่ 1 (ตั้งค่าที่เครื่องนี้) ถือว่าเรียบร้อยเมื่อ: เคยตั้งค่า + HTTPS เปิด + ใบรับรองครอบ IP ปัจจุบัน + firewall ชี้ถูกตัว (หรือตรวจไม่ได้)
  const certCoversCurrent = coveredIps.length > 0;
  const firewallAcceptable = firewallOk || firewall.state === 'unsupported' || firewall.state === 'unknown';
  const step1Done = !!setup && httpsListening && certCoversCurrent && firewallAcceptable;
  let headline;
  if (!setup && !info) headline = 'not_setup';
  else if (!httpsListening) headline = 'https_down';
  else if (!certCoversCurrent) headline = 'ip_changed';
  else if (firewall.state === 'found' && !firewallOk) headline = 'firewall_wrong';
  else if (firewall.state === 'missing') headline = 'firewall_missing';
  else if (!setup) headline = 'cert_only';
  else headline = 'ready';

  return {
    host,
    helper_available: !!helper,
    https_port: httpsPort,
    https_listening: !!httpsListening,
    current_ips: ips,
    cert: info ? { san_ips: sanIps, days_left: daysLeft, not_after: info.not_after || null, thumbprint: info.thumbprint || null } : null,
    cert_covers_current_ip: certCoversCurrent,
    covered_ips: coveredIps,
    setup: setup ? { at: setup.at || null, ip: setup.ip || null, url: setup.url || null, output_dir: outputDir, shortcut_name: setup.shortcut_name || null, output_dir_missing: !!setup.output_dir && !outputDir, rule_name: setup.rule_name || null } : null,
    firewall: { ...firewall, ok: firewallOk, expected_program: process.execPath },
    step1_done: step1Done,
    headline,
    url: setup?.url || (coveredIps[0] ? `https://${coveredIps[0]}:${httpsPort}/` : null),
  };
}

// เรียกตัวช่วยเดิม (ไฟล์ .cmd) แบบแยก process — หน้าต่าง/UAC/กล่องจะเด้งบนจอเครื่องหน้าร้าน
// ตัวช่วยจะรีสตาร์ท server นี้เอง จึงต้อง detached + unref ให้รอดหลัง server ตาย
function launchHelper(installRoot) {
  const helper = findHelper(installRoot);
  if (!helper) throw Object.assign(new Error('ไม่พบตัวช่วย "ตั้งค่าใช้สองเครื่อง" ในโฟลเดอร์ที่ติดตั้ง — ใช้ได้เฉพาะเครื่องที่ติดตั้งจากชุดติดตั้ง'), { status: 404 });
  // start <batch> ตรง ๆ จะเปิดด้วย cmd /K (หน้าต่างค้างตลอด) → ห่อด้วย cmd /c ให้ปิดเองหลัง pause ของ .cmd
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '', '/D', path.dirname(helper), 'cmd.exe', '/c', helper],
    { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  resetFirewallCache();
  return helper;
}

function openFolder(dir) {
  if (!dir || !fs.existsSync(dir)) throw Object.assign(new Error('ยังไม่มีโฟลเดอร์สำหรับส่งไปเครื่องหมอ — กดตั้งค่าเครื่องห้องตรวจก่อน'), { status: 404 });
  const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return dir;
}

module.exports = { collect, launchHelper, openFolder, findHelper, readSetupInfo, localLanIPv4s, resetFirewallCache, SETUP_INFO_NAME };
