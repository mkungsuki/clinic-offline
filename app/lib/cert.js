'use strict';
// ใบรับรอง HTTPS สำหรับ LAN (security round 1, S2 A-refined)
//  - สร้าง self-signed cert ด้วย PowerShell New-SelfSignedCertificate (มีใน Windows ทุกเครื่อง — zero-dep)
//  - SAN = localhost + ชื่อเครื่อง + IP ทุกใบ ณ ตอนสร้าง · อายุ 10 ปี · RSA 2048
//  - ส่งออก PFX (private key + รหัสสุ่ม) เก็บที่ <install>/cert/ **บนเครื่อง host เท่านั้น**
//    และ .cer (public) สำหรับเครื่องหมอ — ห้ามส่ง PFX/รหัสไปเครื่องอื่น
//  - export ด้วย AES256_SHA256 (PBES2) เพราะ OpenSSL 3 ใน Node ไม่รับ RC2/3DES ค่า default ของ Windows
//  - ไม่ทิ้ง cert ค้างใน store ของ Windows: สร้างใน CurrentUser\My → export → ลบออกทันที
//  - argument-safe: ทุกค่าส่งผ่าน environment variable (Windows เก็บ UTF-16) ไม่ส่ง path ไทยผ่าน argv (กติกา .cmd/.ps1)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PFX_NAME = 'clinic.pfx';
const PASS_NAME = 'clinic.pfx.pass';
const CER_NAME = 'clinic.cer';
const INFO_NAME = 'clinic-cert.json';

function localIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni && ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

// PowerShell script — อ่านค่าจาก env เท่านั้น (BOM เพื่อ PowerShell 5.1)
function makeCertPs1() {
  return '﻿' + [
    '# สร้างใบรับรอง HTTPS ของระบบคลินิก — ค่าทั้งหมดมาจาก environment (ห้ามส่ง path ผ่าน argument)',
    "$ErrorActionPreference = 'Stop'",
    "$out = ($env:CLINIC_CERT_OUT -replace '\"','').TrimEnd('\\')",
    "$name = if ($env:CLINIC_CERT_NAME) { $env:CLINIC_CERT_NAME } else { 'ClinicApp' }",
    "$dns = @('localhost') + (($env:CLINIC_CERT_DNS -split ',') | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim().ToLower() })",
    "$ips = @(($env:CLINIC_CERT_IPS -split ',') | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })",
    "# ไม่ระบุ IP (ตัวติดตั้งเรียก) → ใส่ IPv4 ทุกใบของเครื่องนี้ ยกเว้น loopback/APIPA",
    "if ($ips.Count -eq 0) { $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress }) }",
    "$ips = @($ips + '127.0.0.1')",
    "$years = if ($env:CLINIC_CERT_YEARS) { [int]$env:CLINIC_CERT_YEARS } else { 10 }",
    "if (-not $out) { throw 'CLINIC_CERT_OUT ว่าง' }",
    "New-Item -ItemType Directory -Force -Path $out | Out-Null",
    "$san = @(); foreach ($d in ($dns | Select-Object -Unique)) { $san += ('DNS=' + $d) }; foreach ($ip in ($ips | Select-Object -Unique)) { $san += ('IPAddress=' + $ip) }",
    "$ext = '2.5.29.17={text}' + ($san -join '&')",
    "$cert = New-SelfSignedCertificate -Subject ('CN=' + $name) -FriendlyName $name -CertStoreLocation 'Cert:\\CurrentUser\\My' " +
      "-KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment " +
      "-Type SSLServerAuthentication -TextExtension @($ext) -NotAfter (Get-Date).AddYears($years)",
    "try {",
    "  $pass = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])",
    "  $secure = ConvertTo-SecureString -String $pass -AsPlainText -Force",
    "  Export-PfxCertificate -Cert $cert -FilePath (Join-Path $out 'clinic.pfx') -Password $secure -CryptoAlgorithmOption AES256_SHA256 | Out-Null",
    "  Export-Certificate -Cert $cert -FilePath (Join-Path $out 'clinic.cer') -Type CERT | Out-Null",
    "  $utf8 = New-Object System.Text.UTF8Encoding($false)",
    "  [IO.File]::WriteAllText((Join-Path $out 'clinic.pfx.pass'), $pass, $utf8)",
    "  $info = @{ subject = $cert.Subject; thumbprint = $cert.Thumbprint; not_after = $cert.NotAfter.ToString('o'); san = $san; created_at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress",
    "  [IO.File]::WriteAllText((Join-Path $out 'clinic-cert.json'), $info, $utf8)",
    "} finally {",
    "  Remove-Item -LiteralPath $cert.PSPath -Force -ErrorAction SilentlyContinue",
    "}",
    "Write-Output ('CERT_OK ' + $cert.Thumbprint)",
    '',
  ].join('\r\n');
}

// สร้าง cert ลง outDir (สำหรับ helper ตอนติดตั้ง และ test) — คืน info; โยน error ภาษาคนถ้าไม่สำเร็จ
function generateCert({ outDir, dnsNames = [], ips = null, name = 'ClinicApp', years = 10, timeoutMs = 90000 } = {}) {
  if (!outDir) throw new Error('ต้องระบุโฟลเดอร์ปลายทางของใบรับรอง');
  const dir = path.resolve(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(os.tmpdir(), `clinic-make-cert-${process.pid}-${crypto.randomBytes(4).toString('hex')}.ps1`);
  fs.writeFileSync(script, makeCertPs1(), 'utf8');
  const host = (() => { try { return os.hostname(); } catch { return ''; } })();
  const dns = [...new Set([host, host ? `${host}.local` : '', ...dnsNames].filter(Boolean).map(s => s.toLowerCase()))];
  const ipList = ips || localIPv4s();
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      env: { ...process.env, CLINIC_CERT_OUT: dir, CLINIC_CERT_NAME: name, CLINIC_CERT_DNS: dns.join(','), CLINIC_CERT_IPS: ipList.join(','), CLINIC_CERT_YEARS: String(years) },
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!/CERT_OK/.test(out)) throw new Error(out.trim() || 'PowerShell ไม่ตอบ CERT_OK');
  } catch (e) {
    const detail = String(e.stderr || e.message || '').split('\n').filter(Boolean).slice(0, 3).join(' | ');
    throw new Error(`สร้างใบรับรอง HTTPS ไม่สำเร็จ: ${detail}`);
  } finally { try { fs.unlinkSync(script); } catch {} }
  for (const f of [PFX_NAME, PASS_NAME, CER_NAME, INFO_NAME]) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`สร้างใบรับรองไม่ครบ: ไม่พบ ${f}`);
  }
  return readCertInfo(dir);
}

function readCertInfo(certDir) {
  try { return JSON.parse(fs.readFileSync(path.join(certDir, INFO_NAME), 'utf8')); } catch { return null; }
}
function certPaths(certDir) {
  return { pfx: path.join(certDir, PFX_NAME), pass: path.join(certDir, PASS_NAME), cer: path.join(certDir, CER_NAME), info: path.join(certDir, INFO_NAME) };
}
// วันหมดอายุเหลือกี่วัน (สำหรับหน้าสุขภาพระบบ) — null ถ้าไม่มี cert
function daysUntilExpiry(certDir) {
  const info = readCertInfo(certDir);
  if (!info || !info.not_after) return null;
  return Math.floor((new Date(info.not_after).getTime() - Date.now()) / 86400000);
}

module.exports = { makeCertPs1, generateCert, readCertInfo, certPaths, daysUntilExpiry, localIPv4s, PFX_NAME, PASS_NAME, CER_NAME, INFO_NAME };
