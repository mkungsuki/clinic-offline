'use strict';
// สร้างชุดติดตั้งพกพา "Clinic Setup" สำหรับเครื่องคลินิกจริง
// รันตัวจริง: node tools/build-installer.js [--out <dir>] [--no-zip]
// รันชุดทดลอง: node tools/build-installer.js --trial [--out <dir>] [--no-zip]
//
// ผลลัพธ์: <repoRoot>/dist/Clinic Setup/  (+ ZIP ถ้าเครื่องมี tar.exe)
//   runtime/node.exe            Node พกพา (ตัวเดียวกับที่ใช้ build — มีลายเซ็น OpenJS)
//   app/                        โปรแกรมทั้งหมดตาม allowlist — ไม่มี data/ ไม่มี test ไม่มี demo
//   ติดตั้งระบบคลินิก.cmd        ตัวติดตั้ง: copy ไป C:\clinic → seed (ไม่มี demo) → ทางลัด → เปิดหน้าตั้งค่า
//   เปิดระบบคลินิก.cmd / รีสตาร์ทระบบคลินิก.cmd   launcher ใช้ runtime พกพา
//   scripts/make-shortcuts.ps1  สร้างทางลัด Desktop/Startup (เรียกจากตัวติดตั้ง)
//   setup-manifest.json         รายการไฟล์ + sha256 ไว้ตรวจความครบถ้วนปลายทาง
//
// กติกาที่บังคับในตัว (ดู AGENTS.md):
//   - ห้ามมี app/data, *.db, *.enc, *.key, recovery-key, seed-mock, test-*, codex-* ติดไปเด็ดขาด
//   - seed ในตัวติดตั้งต้องไม่ใส่ --demo
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('../lib/recovery-core');
const { writeZip: writeZipEntries } = require('../lib/zip');
const { makeCertPs1 } = require('../lib/cert');
const { APP_FILES, APP_DIRECTORIES, TOOL_FILES, FORBIDDEN_BASENAME, TRIAL_SEED_FILES,
  ALLOWED_RELEASE_EXTENSION } = require('../lib/release-files');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const PACKAGE_NAME = 'Clinic Setup';
// Phase 6 updater (2026-08-18): แหล่งอัปเดต = GitHub Releases ของ repo public ชื่อไม่บ่งบอก (เจ้าของเคาะ 2026-08-16)
// ใช้ /releases/latest/download/<ไฟล์> → ชี้ release ล่าสุดเสมอ (ไม่นับ pre-release) · ตัว service ตาม redirect ได้ 3 ชั้น · manifest ต้องผ่านลายเซ็น Ed25519 ของ app/update-public-key.pem
const UPDATE_FEED_BASE = 'https://github.com/mkungsuki/mk-artifacts/releases/latest/download/';
function updateFeedUrl(variant) { return `${UPDATE_FEED_BASE}latest-${variant.trial ? 'trial' : 'production'}-pilot.json`; }
const TRIAL_PACKAGE_NAME = 'Clinic ทดลอง';
const { PAYLOAD_DIRECTORY, verifySetupPackage } = require('./verify-setup-package');

function makePackageEntryCmd() { return [
  '@echo off', 'chcp 65001 >nul', 'setlocal EnableExtensions DisableDelayedExpansion',
  'set "CLINIC_PACKAGE_ROOT=%~dp0"',
  'if "%CLINIC_PACKAGE_ROOT:~-1%"=="\\" set "CLINIC_PACKAGE_ROOT=%CLINIC_PACKAGE_ROOT:~0,-1%"',
  `set "CLINIC_PACKAGE_PAYLOAD=%CLINIC_PACKAGE_ROOT%\\${PAYLOAD_DIRECTORY}"`,
  `set "CLINIC_PACKAGE_DIRECTORY=${PAYLOAD_DIRECTORY}"`,
  'if not exist "%CLINIC_PACKAGE_PAYLOAD%\\runtime\\node.exe" goto :badzip',
  `"%CLINIC_PACKAGE_PAYLOAD%\\runtime\\node.exe" --no-warnings -e "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),PAYLOAD_DIRECTORY=process.env.CLINIC_PACKAGE_DIRECTORY;try{(${verifySetupPackage.toString().replace(/\s+/g,' ')})(process.env.CLINIC_PACKAGE_ROOT)}catch(e){process.exitCode=1}"`,
  'if errorlevel 1 goto :badzip',
  'call "%CLINIC_PACKAGE_PAYLOAD%\\ติดตั้งระบบคลินิก.cmd" %*',
  'exit /b %errorlevel%',
  ':badzip',
  'set "CLINIC_PACKAGE_ERROR=ชุดติดตั้งไม่ครบหรือเสีย กรุณากดแตกไฟล์ทั้งหมด (Extract All) จาก ZIP ใหม่ แล้วเปิดไฟล์ติดตั้งระบบคลินิกในโฟลเดอร์ที่แตกแล้ว"',
  'if "%CLINIC_INSTALL_TEST%"=="1" (',
  '  echo Extract All - package incomplete',
  '  exit /b 1',
  ')',
  'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:CLINIC_PACKAGE_ERROR,\'Clinic Offline\',\'OK\',\'Error\') | Out-Null"',
  'exit /b 1', '',
].join('\r\n'); }

const VARIANTS = {
  production: {
    trial: false,
    packageName: PACKAGE_NAME,
    zipPrefix: 'ClinicSetup',
    target: 'C:\\clinic',
    port: 8080,
    httpsPort: 8443,
    title: 'ระบบคลินิก',
    kind: 'clinic-setup',
    lanSetupCmd: 'ตั้งค่าใช้สองเครื่อง.cmd',
    lanRemoveCmd: 'ปิดการเชื่อมสองเครื่อง.cmd',
    ruleName: 'Clinic - Doctor computer (HTTPS 8443)',
  },
  trial: {
    trial: true,
    packageName: TRIAL_PACKAGE_NAME,
    zipPrefix: 'ClinicTrial',
    target: 'C:\\clinic-trial',
    port: 8081,
    httpsPort: 8444,
    title: 'ระบบคลินิก (ทดลอง)',
    kind: 'clinic-trial',
    lanSetupCmd: 'ตั้งค่าใช้สองเครื่อง (ทดลอง).cmd',
    lanRemoveCmd: 'ปิดการเชื่อมสองเครื่อง (ทดลอง).cmd',
    ruleName: 'Clinic Trial - Doctor computer (HTTPS 8444)',
  },
};

const DOCUMENT_FILES = [
  'คู่มือฉบับเต็ม-สำหรับหมอ.pdf',
  'คู่มือฉบับเต็ม-สำหรับหน้าร้านและผู้ดูแล.pdf',
  'แบบทดลองใช้-สำหรับหมอ.pdf',
];

// Node บางรุ่นบน Windows รายงานว่า rmSync({recursive:true}) สำเร็จ แต่ไม่ลบโฟลเดอร์ชื่อไทยจริง
// เดินลบทีละชั้นและไม่ตาม symlink เพื่อให้ build ซ้ำของ "Clinic ทดลอง" เชื่อถือได้
function removeTreeSync(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  for (const name of fs.readdirSync(target)) removeTreeSync(path.join(target, name));
  fs.rmdirSync(target);
}

function copyFileVerified(src, dst, inventory, label) {
  const stat = fs.lstatSync(src);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`ไฟล์ไม่ปลอดภัย: ${label}`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
  const sourceHash = sha256(src);
  if (sourceHash !== sha256(dst)) throw new Error(`ตรวจไฟล์หลังคัดลอกไม่ผ่าน: ${label}`);
  inventory.push({ file: label.replace(/\\/g, '/'), bytes: stat.size, sha256: sourceHash });
}

function copyDirectoryAllowlist(srcRoot, relativeDir, dstRoot, inventory) {
  const source = path.join(srcRoot, relativeDir);
  if (!fs.existsSync(source)) return;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) copyDirectoryAllowlist(srcRoot, relative, dstRoot, inventory);
    else if (entry.isFile() && ALLOWED_RELEASE_EXTENSION.test(entry.name)
      && !FORBIDDEN_BASENAME.test(entry.name)) {
      copyFileVerified(path.join(srcRoot, relative), path.join(dstRoot, relative), inventory, path.join('app', relative));
    }
  }
}

// ---------- เนื้อหาไฟล์ที่ generate ----------
const CRLF = '\r\n';

function makeInstallerCmd(variant) { return [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal EnableExtensions',
  'rem ================================================',
  `rem  ติดตั้ง${variant.title} — ดับเบิลคลิกหลังแตก ZIP เสร็จแล้ว`,
  'rem  ใช้ครั้งเดียวตอนติดตั้งเครื่องใหม่ ตามคู่มือที่ให้มาด้วย',
  'rem ================================================',
  'set "SRC=%~dp0"',
  `set "TARGET=${variant.target}"`,
  'if not "%~1"=="" set "TARGET=%~1"',
  'if "%TARGET:~-1%"=="\\" set "TARGET=%TARGET:~0,-1%"',
  'set "TESTMODE=0"',
  'if "%CLINIC_INSTALL_TEST%"=="1" set "TESTMODE=1"',
  'echo.',
  'echo ============================================',
  `echo    ติดตั้ง${variant.title}`,
  'echo ============================================',
  'echo.',
  'rem [1/4] ตรวจว่าแตก ZIP ครบ (กันเคสเปิดไฟล์จากในหน้าต่าง ZIP โดยตรง)',
  'if not exist "%SRC%runtime\\node.exe" goto :badzip',
  'if not exist "%SRC%app\\server.js" goto :badzip',
  'if not exist "%SRC%..\\อ่านก่อนติดตั้ง.txt" goto :badzip',
  'if exist "%SRC%app\\data\\clinic.db" (',
  '  echo ** พบฐานข้อมูลในโฟลเดอร์ชุดติดตั้ง เพราะเคยกดเปิดโปรแกรมก่อนติดตั้ง',
  '  echo    ตัวติดตั้งจะไม่คัดลอกฐานนี้ไปใช้ และจะสร้างข้อมูลเริ่มต้นใหม่ที่ปลายทาง',
  ')',
  'rem [2/4] คัดลอกโปรแกรมไปปลายทาง (ถ้ายังไม่ได้อยู่ที่นั่น)',
  'if exist "%TARGET%\\app\\data\\clinic.db" (',
  '  echo ** พบระบบคลินิกพร้อมฐานข้อมูลอยู่แล้วที่ "%TARGET%"',
  '  echo    ตัวติดตั้งนี้จะไม่เขียนทับข้อมูลเดิมเด็ดขาด — หยุดการติดตั้ง',
  '  echo    ถ้าต้องการอัปเดตโปรแกรม ให้ปรึกษาผู้ดูแลระบบ',
  '  if "%TESTMODE%"=="0" call :install_error',
  '  exit /b 1',
  ')',
  'echo กำลังคัดลอกโปรแกรมไปที่ %TARGET% ...',
  'if not exist "%TARGET%\\logs" mkdir "%TARGET%\\logs" 2>nul',
  '(type nul >> "%TARGET%\\logs\\install-copy.log") 2>nul || goto :need_admin',
  'if exist "%TARGET%\\app\\server.js" (type nul >> "%TARGET%\\app\\server.js") 2>nul || goto :need_admin',
  ...(!variant.trial ? [
    'set "CLINIC_TRANSITION_TARGET=%TARGET%"',
    'set "CLINIC_TRANSITION_SOURCE=%SRC%"',
    `set "CLINIC_PACKAGE_DIRECTORY=${PAYLOAD_DIRECTORY}"`,
    `"%SRC%runtime\\node.exe" --no-warnings -e "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),PAYLOAD_DIRECTORY=process.env.CLINIC_PACKAGE_DIRECTORY;try{(${verifySetupPackage.toString().replace(/\s+/g,' ')})(path.resolve(process.env.CLINIC_TRANSITION_SOURCE,'..'))}catch(e){process.exitCode=1}"`,
    'if errorlevel 1 goto :badzip',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%SRC%app\\scripts\\trial-to-production.ps1"',
    'if errorlevel 5 goto :need_admin',
    'if errorlevel 1 exit /b 1',
  ] : []),
  'if /i "%SRC%"=="%TARGET%\\" goto :inplace',
  'robocopy "%SRC%." "%TARGET%" /E /IS /IT /IM /R:2 /W:2 /XD "%SRC%app\\data" /NFL /NDL /NJH /NJS /TEE /LOG+:"%TARGET%\\logs\\install-copy.log"',
  'if errorlevel 8 (',
  '  echo ** คัดลอกไฟล์ไม่สำเร็จ — หยุดการติดตั้ง',
  '  if "%TESTMODE%"=="0" call :install_error',
  '  exit /b 1',
  ')',
  ':inplace',
  // The distribution has one readme at its root. Preserve its installed path.
  'set "CLINIC_INSTALL_README=%SRC%..\\อ่านก่อนติดตั้ง.txt"',
  'set "CLINIC_INSTALL_DIR=%TARGET%"',
  '"%TARGET%\\runtime\\node.exe" --no-warnings -e "const fs=require(\'node:fs\'),path=require(\'node:path\');const source=process.env.CLINIC_INSTALL_README,target=path.join(process.env.CLINIC_INSTALL_DIR,path.basename(source));fs.copyFileSync(source,target);if(!fs.readFileSync(source).equals(fs.readFileSync(target)))process.exit(1);"',
  'if errorlevel 1 (',
  '  call :install_error',
  '  exit /b 1',
  ')',
  '"%TARGET%\\runtime\\node.exe" --no-warnings "%TARGET%\\app\\scripts\\verify-install.js" "%TARGET%"',
  'if errorlevel 1 (',
  '  call :install_error',
  '  exit /b 1',
  ')',
  'if not exist "%TARGET%\\update" mkdir "%TARGET%\\update"',
  '>"%TARGET%\\update\\installed.marker" echo installed',
  `rem [3/4] สร้างฐานข้อมูลเริ่มต้น${variant.trial ? 'และข้อมูลสังเคราะห์สำหรับทดลอง' : ' (เฉพาะเมื่อยังไม่มี — ไม่มีข้อมูลตัวอย่างใดๆ)'}`,
  'if exist "%TARGET%\\app\\data\\clinic.db" (',
  '  echo มีฐานข้อมูลอยู่แล้ว — ข้ามขั้นตอนสร้างฐานข้อมูล',
  '  goto :seeded',
  ')',
  'echo กำลังสร้างฐานข้อมูลเริ่มต้น...',
  ...(variant.trial ? ['set "CLINIC_DATA_DIR=%TARGET%\\app\\data"'] : []),
  'pushd "%TARGET%\\app"',
  `"%TARGET%\\runtime\\node.exe" --no-warnings seed.js${variant.trial ? ' --demo' : ''}`,
  'if errorlevel 1 (',
  '  popd',
  '  echo ** สร้างฐานข้อมูลไม่สำเร็จ — หยุดการติดตั้ง',
  '  if "%TESTMODE%"=="0" call :install_error',
  '  exit /b 1',
  ')',
  ...(variant.trial ? [
    '"%TARGET%\\runtime\\node.exe" --no-warnings seed-mock-clinic.js',
    'if errorlevel 1 (',
    '  popd',
    '  echo ** สร้างข้อมูลทดลองไม่สำเร็จ — หยุดการติดตั้ง',
    '  if "%TESTMODE%"=="0" call :install_error',
    '  exit /b 1',
    ')',
  ] : []),
  'popd',
  ':seeded',
  'rem [3.5/4] ใบรับรอง HTTPS สำหรับเครื่องห้องตรวจ (self-signed อยู่ในเครื่องนี้เท่านั้น) — ล้มเหลวไม่หยุดติดตั้ง',
  'if not exist "%TARGET%\\cert\\clinic.pfx" (',
  '  set "CLINIC_CERT_OUT=%TARGET%\\cert"',
  '  set "CLINIC_CERT_DNS=%COMPUTERNAME%"',
  '  set "CLINIC_CERT_NAME=ClinicApp"',
  '  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%TARGET%\\scripts\\make-cert.ps1" >nul',
  '  if errorlevel 1 echo ** สร้างใบรับรอง HTTPS ไม่สำเร็จ — เครื่องอื่นจะยังเข้าไม่ได้ จนกว่าจะรัน "ตั้งค่าใช้สองเครื่อง"',
  ')',
  'if "%TESTMODE%"=="1" goto :donetest',
  'rem [4/4] ทางลัด + เปิดระบบครั้งแรก',
  'echo.',
  'set "CLINIC_INSTALL_ASK=ให้ระบบคลินิกเปิดเองทุกครั้งที่เปิดเครื่องหรือไม่"',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.MessageBox]::Show($env:CLINIC_INSTALL_ASK, \'Clinic Offline\', \'YesNo\', \'Question\') -eq \'Yes\') { exit 0 } else { exit 2 }"',
  'set "AUTOSTART=1"',
  'if errorlevel 2 set "AUTOSTART=0"',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%TARGET%\\scripts\\make-shortcuts.ps1" -Target "%TARGET%" -Autostart %AUTOSTART%',
  'if errorlevel 1 echo ** สร้างทางลัดไม่สำเร็จ (โปรแกรมติดตั้งแล้ว — เปิดได้จาก %TARGET%\\เปิดระบบคลินิก.cmd)',
  'echo กำลังเปิดระบบคลินิกครั้งแรก...',
  'if "%CLINIC_SETUP_ELEVATED%"=="1" (',
  '  explorer.exe "%TARGET%\\เปิดระบบคลินิก.cmd"',
  ') else (',
  '  call "%TARGET%\\เปิดระบบคลินิก.cmd"',
  ')',
  'echo.',
  'echo ============================================',
  'echo    ติดตั้งเสร็จแล้ว',
  'set "CLINIC_INSTALL_DONE=ติดตั้งเสร็จแล้ว โปรแกรมนี้แจกฟรีภายใต้สัญญาอนุญาต AGPL-3.0 ดูรายละเอียดใน LICENSE"',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:CLINIC_INSTALL_DONE, \'Clinic Offline\', \'OK\', \'Information\')"',
  'echo    หน้าตั้งค่าครั้งแรกกำลังเปิดในเบราว์เซอร์',
  ...(variant.trial ? [
    'echo    นี่คือชุดทดลอง ข้อมูลทั้งหมดเป็นข้อมูลสมมติ เล่นและลบทิ้งได้',
    'echo    เปิดจากไอคอน "ระบบคลินิก (ทดลอง)" เท่านั้น เพื่อไม่ปนกับตัวจริง',
  ] : [
    'echo    สิ่งแรกที่ต้องทำ: เข้าระบบด้วย admin แล้วเปลี่ยนรหัสผ่านทันที',
  ]),
  'echo.',
  'rem 2026-08-16: เลิกถามเรื่องเครื่องห้องตรวจตอนติดตั้ง — ผู้ใช้ยังไม่รู้จักโปรแกรมและตอบไม่ถูก',
  'rem ทำ "ทีหลัง" ได้ 2 ทาง: หน้า Admin → การ์ด "เครื่องห้องตรวจ" (ทางหลัก มีสถานะบอก) หรือไอคอน "ตั้งค่าเครื่องห้องตรวจ" บน Desktop',
  'echo    ถ้ามีคอมพิวเตอร์ห้องตรวจอีกเครื่อง: ทำทีหลังได้ที่หน้า "ตั้งค่า" (Admin) การ์ด "เครื่องห้องตรวจ"',
  'echo    หรือดับเบิลคลิกไอคอน "ตั้งค่าเครื่องห้องตรวจ" บน Desktop',
  'echo ============================================',
  'rem ผลสำเร็จแสดงในกล่อง Windows แล้ว ไม่ต้องรออ่านหน้าต่างดำ',
  'exit /b 0',
  ':badzip',
  'echo ** ไม่พบไฟล์โปรแกรมข้างๆ ตัวติดตั้ง',
  'echo    สาเหตุที่พบบ่อย: เปิดไฟล์จากในหน้าต่าง ZIP โดยตรง',
  'echo    วิธีแก้: คลิกขวาไฟล์ ZIP เลือก Extract All (แตกไฟล์ทั้งหมด) ให้เสร็จก่อน',
  'echo    แล้วค่อยดับเบิลคลิก "ติดตั้งระบบคลินิก" ในโฟลเดอร์ที่แตกออกมา',
  'if "%TESTMODE%"=="0" call :install_error',
  'exit /b 1',
  ':donetest',
  'echo [โหมดทดสอบ] ติดตั้งไฟล์และฐานข้อมูลเสร็จ — ข้ามทางลัด/การเปิดระบบ/กล่องข้อความ',
  'echo โปรแกรมนี้แจกฟรีภายใต้สัญญาอนุญาต AGPL-3.0 ดูรายละเอียดใน LICENSE',
  'exit /b 0',
  ':need_admin',
  'if "%TESTMODE%"=="1" exit /b 1',
  'if "%CLINIC_SETUP_ELEVATED%"=="1" (',
  '  call :install_error',
  '  exit /b 1',
  ')',
  'set "CLINIC_SETUP_CMD=%~f0"',
  'set "CLINIC_SETUP_TARGET=%TARGET%"',
  'set "CLINIC_SETUP_ELEVATOR=%SRC%app\\scripts\\install-elevated.ps1"',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $q=[char]34; $p=Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList (\'-NoProfile -ExecutionPolicy Bypass -File \'+$q+$env:CLINIC_SETUP_ELEVATOR+$q); exit $p.ExitCode } catch { exit 1 }"',
  'if errorlevel 1 (',
  '  call :install_error',
  '  exit /b 1',
  ')',
  'exit /b 0',
  ':install_error',
  'if "%TESTMODE%"=="1" exit /b 0',
  'set "CLINIC_INSTALL_ERROR=ติดตั้งไม่สำเร็จ กรุณาตรวจว่าแตก ZIP ครบและมีสิทธิ์เขียนโฟลเดอร์ติดตั้ง ห้ามลบฐานข้อมูลเดิม หากมีโปรแกรมเดิมอยู่ให้ใช้เมนูอัปเดต ดูรายละเอียดใน logs ของโฟลเดอร์ติดตั้ง"',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:CLINIC_INSTALL_ERROR, \'Clinic Offline\', \'OK\', \'Error\')"',
  'exit /b 0',
  '',
].join(CRLF); }

function makeLauncherCmd(variant) { return [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal EnableExtensions',
  'set "ROOT=%~dp0"',
  'if "%ROOT:~-1%"=="\\" set "ROOT=%ROOT:~0,-1%"',
  'if not exist "%ROOT%\\update\\installed.marker" (',
  '  echo ** ชุดนี้ยังไม่ได้ติดตั้ง จึงยังเปิดระบบจากโฟลเดอร์นี้ไม่ได้',
  '  echo    กรุณาดับเบิลคลิก "ติดตั้งระบบคลินิก" ก่อน แล้วเปิดจากไอคอนบนหน้าจอ',
  '  if not "%CLINIC_INSTALL_TEST%"=="1" pause',
  '  exit /b 1',
  ')',
  ...recoverUpdateBlock(':open_app'),
  ':open_app',
  `set "CLINIC_PORT=${variant.port}"`,
  'call "%ROOT%\\app\\launch\\open.cmd" %*',
  '',
].join(CRLF); }

// ทุกทางเข้าที่ "เริ่มโปรแกรม" ต้องกู้ journal ค้างก่อนเสมอ ไม่ใช่เฉพาะปุ่มเปิด
// (ผู้ใช้ที่เจอหน้าจอค้างมักกด "รีสตาร์ทระบบคลินิก" เป็นอย่างแรก)
// exit code 3 = กำลังอัปเดตอยู่จริง ห้ามถือเป็นความล้มเหลว และห้ามเปิดโปรแกรมทับ
function recoverUpdateBlock(continueLabel) { return [
  'if exist "%ROOT%\\update\\active-journal.json" goto :recover_update',
  'if exist "%ROOT%\\update\\active-journal.json.previous" goto :recover_update',
  `goto ${continueLabel}`,
  ':recover_update',
  '"%ROOT%\\runtime\\node.exe" --no-warnings "%ROOT%\\app\\update-assistant.js" --recover',
  'if errorlevel 4 goto :recover_failed',
  'if errorlevel 3 (',
  '  echo ** ระบบกำลังอัปเดตอยู่ กรุณารอประมาณ 1-2 นาที แล้วกดเปิดใหม่อีกครั้ง',
  '  echo    อย่าปิดเครื่องระหว่างนี้',
  '  if not "%CLINIC_INSTALL_TEST%"=="1" pause',
  '  exit /b 0',
  ')',
  `if not errorlevel 1 goto ${continueLabel}`,
  ':recover_failed',
  '  echo ** ระบบพบการอัปเดตที่ค้างและกู้กลับอัตโนมัติไม่สำเร็จ',
  '  echo    กรุณาติดต่อผู้ดูแลก่อนเปิดคลินิก เพื่อไม่ให้โปรแกรมอยู่คนละรุ่น',
  '  if not "%CLINIC_INSTALL_TEST%"=="1" pause',
  '  exit /b 1',
]; }

function makeRestartCmd(variant) { return [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal EnableExtensions',
  'set "ROOT=%~dp0"',
  'if "%ROOT:~-1%"=="\\" set "ROOT=%ROOT:~0,-1%"',
  'if not exist "%ROOT%\\update\\installed.marker" (',
  '  echo ** ชุดนี้ยังไม่ได้ติดตั้ง กรุณารันตัวติดตั้งก่อน',
  '  if not "%CLINIC_INSTALL_TEST%"=="1" pause',
  '  exit /b 1',
  ')',
  ...recoverUpdateBlock(':restart_app'),
  ':restart_app',
  `set "CLINIC_PORT=${variant.port}"`,
  'call "%ROOT%\\app\\launch\\restart.cmd" %*',
  '',
].join(CRLF); }

// PS1 ต้องมี BOM เพื่อให้ Windows PowerShell 5.1 อ่านภาษาไทยถูก
function makeShortcutsPs1(variant) { return '\uFEFF' + [
  'param(',
  '  [Parameter(Mandatory = $true)][string]$Target,',
  "  [string]$Autostart = '0',",
  '  [switch]$TestMode',
  ')',
  "$ErrorActionPreference = 'Stop'",
  "$launcher = Join-Path $Target 'เปิดระบบคลินิก.cmd'",
  'if (-not (Test-Path $launcher)) { throw "ไม่พบ $launcher" }',
  "if (-not (Test-Path -LiteralPath (Join-Path $Target 'update\\installed.marker'))) { throw 'ยังไม่ได้ติดตั้งโปรแกรม กรุณาเปิดตัวติดตั้งก่อน' }",
  'if ($TestMode) {',
  "  if ($env:CLINIC_INSTALL_TEST -ne '1') { throw 'Test mode requires environment guard' }",
  '  $testRoot = [IO.Path]::GetFullPath($env:CLINIC_SHORTCUT_TEST_ROOT)',
  '  if (-not $testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)) { throw "Test path outside temp" }',
  "  if ([IO.File]::ReadAllText((Join-Path $testRoot 'transition-test.marker')) -ne 'synthetic-transition-only') { throw 'Test marker missing' }",
  "  $desktop = Join-Path $testRoot 'Desktop'; $startup = Join-Path $testRoot 'Startup'",
  '  New-Item -ItemType Directory -Path $desktop,$startup -Force | Out-Null',
  '} else {',
  "  $desktop = [Environment]::GetFolderPath('Desktop'); $startup = [Environment]::GetFolderPath('Startup')",
  '}',
  ". (Join-Path $Target 'app\\scripts\\windows-shortcuts.ps1')",
  'function New-ClinicShortcut([string]$folder) {',
  `  [ClinicUnicodeShortcut]::Create((Join-Path $folder '${variant.title}.lnk'),$launcher,'',$Target)`,
  '}',
  'New-ClinicShortcut $desktop',
  `  [ClinicUnicodeShortcut]::Create((Join-Path $desktop '${variant.trial ? 'กู้ข้อมูลคลินิก (ทดลอง)' : 'กู้ข้อมูลคลินิก'}.lnk'),(Join-Path $Target 'runtime\\node.exe'),('--no-warnings ' + [char]34 + (Join-Path $Target 'app\\launch\\recovery.js') + [char]34),$Target)`,
  "if ($Autostart -eq '1') { New-ClinicShortcut $startup }",
  '# ทางลัดสำรองสำหรับตั้งค่าเครื่องห้องตรวจ "ทีหลัง" — ทางหลักคือปุ่มในหน้า Admin (การ์ด "เครื่องห้องตรวจ")',
  '# (2026-08-16: ตัวช่วยเคยมีแต่ตอนติดตั้ง/ไฟล์ใน C:\\clinic* ที่ผู้ใช้ไม่เข้าไปหา → เจ้าของกดตัวในโฟลเดอร์ ZIP แทน)',
  `[ClinicUnicodeShortcut]::Create((Join-Path $desktop '${variant.trial ? 'ตั้งค่าเครื่องห้องตรวจ (ทดลอง)' : 'ตั้งค่าเครื่องห้องตรวจ'}.lnk'),(Join-Path $Target '${variant.lanSetupCmd}'),'',$Target)`,
  '',
].join(CRLF); }

function makeLanCmd(variant, action) {
  const ps1 = action === 'setup' ? 'setup-lan.ps1' : 'remove-lan.ps1';
  return [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal EnableExtensions',
  'rem %~dp0 ลงท้ายด้วย \\ เสมอ — ถ้าส่งเข้า "..." ตรงๆ PowerShell จะตีความ \\" เป็น escape',
  'rem แล้ว path จะมี quote ปนจน Test-Path ล้ม (บั๊กจริงที่เครื่องคลินิก 2026-08-12) — ตัดทิ้งก่อนเสมอ',
  'set "PKG=%~dp0"',
  'if "%PKG:~-1%"=="\\" set "PKG=%PKG:~0,-1%"',
  ...(action === 'setup' ? [
    // บั๊กหน้างาน 2026-08-16 (เจ้าของเจอเอง): ดับเบิลคลิกไฟล์นี้จากโฟลเดอร์ที่แตก ZIP (ยังไม่ติดตั้ง) แล้ว helper วิ่งจนสุด
    // → สร้าง private key ผิดที่ + firewall ชี้ node.exe ผิดตัว + ส่งใบรับรองผิดใบไปเครื่องหมอ (ขึ้น "ไม่ปลอดภัย" ตลอด)
    // launcher/restart มี guard installed.marker อยู่แล้ว — ตัวช่วยสองเครื่องต้องมีเหมือนกัน และถ้ามีชุดที่ติดตั้งแล้วให้ไปทำที่นั่นแทน
    `set "INSTALLED=${variant.target}"`,
    'if exist "%PKG%\\update\\installed.marker" goto :run_helper',
    'if "%CLINIC_INSTALL_TEST%"=="1" goto :not_installed',
    'if exist "%INSTALLED%\\update\\installed.marker" (',
    '  echo ไฟล์นี้อยู่ในโฟลเดอร์ที่แตก ZIP ไม่ใช่โฟลเดอร์ที่ติดตั้ง — จะตั้งค่าให้ที่ชุดที่ติดตั้งแล้ว %INSTALLED% แทน',
    '  set "PKG=%INSTALLED%"',
    '  goto :run_helper',
    ')',
    ':not_installed',
    'echo ** ชุดนี้ยังไม่ได้ติดตั้ง จึงยังตั้งค่าสองเครื่องไม่ได้',
    'echo    กรุณาดับเบิลคลิก "ติดตั้งระบบคลินิก" ก่อน แล้วกดตัวช่วยนี้จากโฟลเดอร์ที่ติดตั้งแล้ว (%INSTALLED%)',
    'if "%CLINIC_INSTALL_TEST%"=="1" exit /b 1',
    'rem ข้อความสำคัญขึ้นเป็นกล่องของ Windows — หน้าต่างดำ (conhost) บางเครื่องแสดงภาษาไทยแตกจนอ่านไม่ออก (เจอจริง 2026-08-16)',
    'set "CLINIC_MSG_TITLE=ตั้งค่าใช้สองเครื่อง"',
    'set "CLINIC_MSG_TEXT=ชุดนี้ยังไม่ได้ติดตั้ง จึงยังตั้งค่าสองเครื่องไม่ได้ — กรุณาดับเบิลคลิก ติดตั้งระบบคลินิก ก่อน แล้วกดตัวช่วยนี้จากโฟลเดอร์ที่ติดตั้งแล้ว (%INSTALLED%)"',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:CLINIC_MSG_TEXT, $env:CLINIC_MSG_TITLE, \'OK\', \'Error\')"',
    'pause',
    'exit /b 1',
    ':run_helper',
  ] : []),
  action === 'setup'
    ? 'echo กำลังเตรียมการเชื่อมต่อแบบเข้ารหัส (HTTPS) ระหว่างเครื่องหน้าร้านกับเครื่องห้องตรวจ...'
    : 'echo กำลังปิดทางเข้าจากเครื่องห้องตรวจ...',
  'if "%CLINIC_INSTALL_TEST%"=="1" (',
  `  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PKG%\\scripts\\${ps1}" -Target "%PKG%" -TestMode${action === 'setup' ? ' -OutputDir "%CLINIC_LAN_TEST_OUT%"' : ''}`,
  ') else (',
  `  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PKG%\\scripts\\${ps1}" -Target "%PKG%"`,
  ')',
  'if errorlevel 1 (',
  '  echo.',
  action === 'setup'
    ? '  echo ** ทำรายการไม่สำเร็จ — เหตุผลอยู่ในกล่องข้อความที่ขึ้นมา และในไฟล์ logs\\setup-lan.log ของโฟลเดอร์ที่ติดตั้ง'
    : '  echo ** ทำรายการไม่สำเร็จ กรุณาอ่านข้อความด้านบน แล้วลองใหม่',
  '  if not "%CLINIC_INSTALL_TEST%"=="1" pause',
  '  exit /b 1',
  ')',
  'echo.',
  'if not "%CLINIC_INSTALL_TEST%"=="1" pause',
  '',
].join(CRLF); }

// ตัวช่วยสองเครื่อง (security round 1, A-refined): เครื่องห้องตรวจเข้าผ่าน HTTPS เท่านั้น
//  - firewall เปิดเฉพาะพอร์ต HTTPS ของ variant, Private + LocalSubnet + node.exe
//  - ใบรับรอง: ใช้ของเดิมถ้า SAN ครอบ IP ปัจจุบัน ไม่งั้นสร้างใหม่ (make-cert.ps1 ผ่าน env) — private key อยู่ <install>\cert เท่านั้น
//  - โฟลเดอร์ "ส่งไปเครื่องหมอ" มีแค่ .cer (public) + ตัวติดตั้งใบรับรอง + ทางลัด https — ห้ามมี pfx/รหัส
// PS1 มี BOM เพื่อให้ Windows PowerShell 5.1 แสดงภาษาไทยถูกต้อง
// A native child can change the shared console code page while PowerShell caches its writer.
// Reset BOTH sides after returning from the child, before displaying Thai status text.
function consoleUtf8Ps1() { return [
  'function Reset-ClinicConsole {',
  '  try {',
  '    & "$env:SystemRoot\\System32\\chcp.com" 65001 | Out-Null',
  '    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '    $script:OutputEncoding = [Console]::OutputEncoding',
  '  } catch { } # A non-console host must not turn successful setup into failure.',
  '}',
  'Reset-ClinicConsole',
]; }
function makeLanSetupPs1(variant) { return '﻿' + [
  'param(',
  `  [string]$Target = '${variant.target}',`,
  '  [switch]$TestMode,',
  "  [string]$TestIp = '192.168.50.10',",
  '  [string]$OutputDir = "",',
  '  [switch]$ElevatedPhase',
  ')',
  ...consoleUtf8Ps1(),
  "$ErrorActionPreference = 'Stop'",
  `$ruleName = '${variant.ruleName}'`,
  "$legacyRules = @('Clinic Trial - Doctor computer (TCP 8081)')",
  `$httpsPort = ${variant.httpsPort}`,
  `$port = ${variant.port}`,
  '# กันชั้นสอง: ตัด quote ที่อาจติดมาจากการส่ง path ลงท้าย \\ ผ่าน cmd (บั๊กจริง 2026-08-12)',
  '$Target = ($Target -replace \'"\', \'\').TrimEnd("\\")',
  "$serverFile = Join-Path $Target 'app\\server.js'",
  "$launcher = Join-Path $Target 'เปิดระบบคลินิก.cmd'",
  "$certDir = Join-Path $Target 'cert'",
  "$makeCert = Join-Path $Target 'scripts\\make-cert.ps1'",
  "$installedMarker = Join-Path $Target 'update\\installed.marker'",
  "$logFile = Join-Path $Target 'logs\\setup-lan.log'",
  "$boxTitle = 'ตั้งค่าใช้สองเครื่อง'",
  '',
  '# ข้อความที่ผู้ใช้ต้องตัดสินใจ/ต้องเห็น ขึ้นเป็นกล่องของ Windows (ฟอนต์ UI แสดงไทยถูกเสมอ)',
  '# — หน้าต่าง PowerShell/conhost บางเครื่องแสดงไทยแตกเป็นตัว ๆ จนอ่านไม่ออก และหน้าต่างที่ยกสิทธิ์ admin ปิดตัวเองพร้อมข้อความ error',
  '# (บั๊กหน้างานจริง 2026-08-16) · โหมดทดสอบไม่เปิดกล่อง (headless)',
  'function Show-ClinicBox([string]$text, [string]$kind) {',
  "  if ($TestMode) { Write-Host $text; return 'Yes' }",
  '  Add-Type -AssemblyName System.Windows.Forms',
  '  $owner = New-Object System.Windows.Forms.Form',
  '  $owner.TopMost = $true',
  "  $buttons = if ($kind -eq 'question') { 'YesNo' } else { 'OK' }",
  "  $icon = switch ($kind) { 'question' { 'Question' } 'error' { 'Error' } default { 'Information' } }",
  '  return [string][System.Windows.Forms.MessageBox]::Show($owner, $text, $boxTitle, $buttons, $icon)',
  '}',
  'function Fail-Early([string]$message) {',
  "  Write-Host ('** ' + $message) -ForegroundColor Red",
  "  if (-not $TestMode) { [void](Show-ClinicBox $message 'error') }",
  '  exit 1',
  '}',
  '',
  'if (-not (Test-Path -LiteralPath $serverFile) -or -not (Test-Path -LiteralPath $launcher)) {',
  `  Fail-Early 'ไม่พบโปรแกรมที่ติดตั้งแล้ว กรุณาติดตั้ง${variant.trial ? 'ชุดทดลอง' : 'ระบบคลินิก'}ที่เครื่องหน้าร้านก่อน'`,
  '}',
  '# ต้องเป็นโฟลเดอร์ที่ "ติดตั้งแล้ว" เท่านั้น — รันจากโฟลเดอร์ที่แตก ZIP จะสร้างใบรับรอง/firewall ผิดที่ (บั๊กหน้างาน 2026-08-16)',
  'if (-not (Test-Path -LiteralPath $installedMarker)) {',
  `  Fail-Early 'ชุดนี้ยังไม่ได้ติดตั้ง จึงยังตั้งค่าสองเครื่องไม่ได้ — กรุณาดับเบิลคลิก ติดตั้งระบบคลินิก ก่อน แล้วกดตัวช่วยนี้จากโฟลเดอร์ที่ติดตั้งแล้ว (${variant.target})'`,
  '}',
  '',
  '# เช็คพอร์ตด้วย TcpClient (เร็ว/แน่นอน) — เลิกใช้ Test-NetConnection ที่ช้าและค้างแถบ progress ในหน้าต่างยกสิทธิ์ (2026-08-16)',
  'function Test-ClinicPort([int]$p) {',
  '  try {',
  '    $c = New-Object System.Net.Sockets.TcpClient',
  "    $ar = $c.BeginConnect('127.0.0.1', $p, $null, $null)",
  '    $ok = $ar.AsyncWaitHandle.WaitOne(1500) -and $c.Connected',
  '    $c.Close(); return [bool]$ok',
  '  } catch { return $false }',
  '}',
  'function Wait-ClinicPort([int]$p, [bool]$up, [int]$seconds) {',
  '  $deadline = (Get-Date).AddSeconds($seconds)',
  '  while ((Get-Date) -lt $deadline) { if ((Test-ClinicPort $p) -eq $up) { return $true }; Start-Sleep -Milliseconds 700 }',
  '  return $false',
  '}',
  '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
  '$principal = New-Object Security.Principal.WindowsPrincipal($identity)',
  '$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  "$handoffFile = Join-Path $certDir 'lan-elevated.json'",
  '',
  '# โครงสร้าง 2 เฟส (2026-08-16 หลังเจ้าของกดจริงแล้ว helper ค้างเงียบในหน้าต่างยกสิทธิ์หลังรีสตาร์ท server):',
  '#   เฟส A (สิทธิ์ผู้ใช้ — หน้าต่างนี้): ตรวจ → เรียกเฟส B แบบยกสิทธิ์แล้วรอ → รีสตาร์ท server แบบ "ไม่ยกสิทธิ์" → เขียนโฟลเดอร์ส่งออก + lan-setup.json → กล่องสำเร็จ',
  '#   เฟส B (ยกสิทธิ์ — -ElevatedPhase): คำถาม Public/Private, IP, ใบรับรอง, icacls, firewall เท่านั้น แล้วเขียน lan-elevated.json ให้เฟส A อ่าน',
  '#   เหตุผล: (1) ส่วนยกสิทธิ์สั้นและไม่มี wait ยาว → ไม่ค้าง (2) server ต้องไม่ถูกเปิดจาก process ยกสิทธิ์ ไม่งั้นรันเป็น admin ต่อเนื่องและ helper รอบถัดไปยกสิทธิ์เงียบ',
  'if (-not $TestMode) {',
  "  if ($ElevatedPhase) { $logFile = Join-Path $Target 'logs\\setup-lan-admin.log' }",
  '  try {',
  '    New-Item -ItemType Directory -Force -Path (Split-Path $logFile) | Out-Null',
  '    Start-Transcript -Path $logFile -Force | Out-Null',
  '  } catch { }',
  '  if (-not $ElevatedPhase) {',
  "    Write-Host 'Windows จะถามว่าจะอนุญาตให้ตั้งค่าเครือข่ายหรือไม่ กรุณากด Yes' -ForegroundColor Yellow",
  '    if (Test-Path -LiteralPath $handoffFile) { Remove-Item -LiteralPath $handoffFile -Force }',
  "    $argumentLine = '-NoProfile -ExecutionPolicy Bypass -File \"' + $PSCommandPath + '\" -Target \"' + $Target + '\" -ElevatedPhase'",
  "    if ($isAdmin) { $process = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList $argumentLine -Wait -PassThru }",
  "    else { $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $argumentLine -Wait -PassThru }",
  '    Reset-ClinicConsole',
  '    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $handoffFile)) {',
  "      Write-Host ('** ส่วนตั้งค่าเครือข่าย/ใบรับรองไม่สำเร็จ — รายละเอียดอยู่ใน ' + (Join-Path $Target 'logs\\setup-lan-admin.log')) -ForegroundColor Red",
  '      try { Stop-Transcript | Out-Null } catch { }',
  '      exit 1',
  '    }',
  "    Write-Host 'ส่วนสิทธิ์ผู้ดูแลเสร็จแล้ว — กำลังรีสตาร์ทโปรแกรมและเตรียมโฟลเดอร์ส่งไปเครื่องหมอ...'",
  '  }',
  '}',
  '',
  '$exitCode = 0',
  'try {',
  'if (-not $TestMode -and $ElevatedPhase) {',
  "  Write-Host '[admin] ตรวจเครือข่าย...'",
  "  $profiles = @(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' })",
  '  if ($profiles.Count -eq 0) { throw "ไม่พบเครือข่ายที่กำลังเชื่อมต่อ กรุณาต่อ Wi-Fi หรือสาย LAN แล้วลองใหม่" }',
  "  $public = @($profiles | Where-Object { $_.NetworkCategory -eq 'Public' })",
  '  if ($public.Count -gt 0) {',
  "    Write-Host ''",
  "    Write-Host 'เครือข่ายเครื่องนี้ยังตั้งเป็น Public จึงยังไม่อนุญาตให้เครื่องห้องตรวจเข้า' -ForegroundColor Yellow",
  '    $question = @(',
  "      'เครือข่ายที่เครื่องนี้ต่ออยู่ (' + (($public | ForEach-Object { $_.Name }) -join ', ') + ') ยังตั้งเป็น Public',",
  "      'Windows จึงยังไม่อนุญาตให้เครื่องห้องตรวจเข้ามา',",
  "      '',",
  "      'ถ้านี่คือ Wi-Fi/สาย LAN ของคลินิกที่ไว้ใจ (คนไข้/คนทั่วไปไม่ได้รหัส) กด Yes เพื่อเปลี่ยนเป็น Private',",
  "      'ถ้าเป็น Wi-Fi สาธารณะ หรือไม่แน่ใจ กด No แล้วปรึกษาผู้ดูแลก่อน'",
  '    ) -join \"`r`n\"',
  "    $answer = Show-ClinicBox $question 'question'",
  "    if ($answer -ne 'Yes') { throw 'ยกเลิกแล้ว — ยังไม่ได้เปิดทางเข้าจากเครื่องอื่น (เครือข่ายยังเป็น Public)' }",
  '    foreach ($profile in $public) { Set-NetConnectionProfile -InterfaceIndex $profile.InterfaceIndex -NetworkCategory Private }',
  '  }',
  "  $privateProfiles = @(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' -and $_.NetworkCategory -eq 'Private' })",
  "  if ($privateProfiles.Count -eq 0) { throw 'ยังไม่มีเครือข่าย Private จึงไม่เปิดทางเข้าเพื่อความปลอดภัย' }",
  '',
  '  $ip = Get-NetIPConfiguration | Where-Object {',
  "    $_.NetAdapter.Status -eq 'Up' -and $_.NetProfile.NetworkCategory -eq 'Private' -and $_.IPv4Address",
  '  } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object {',
  "    $_ -and $_ -notlike '127.*' -and $_ -notlike '169.254.*'",
  '  } | Select-Object -First 1',
  "  if (-not $ip) { throw 'หาเลขที่อยู่ของเครื่องหน้าร้านไม่พบ กรุณาตรวจ Wi-Fi/สาย LAN แล้วลองใหม่' }",
  "  Write-Host ('[admin] เลขที่อยู่เครื่องนี้: ' + $ip)",
  '} elseif ($TestMode) {',
  '  $ip = $TestIp',
  '} else {',
  '  # เฟส A: อ่านผลจากเฟส B',
  '  $handoff = Get-Content -LiteralPath $handoffFile -Raw -Encoding UTF8 | ConvertFrom-Json',
  '  $ip = [string]$handoff.ip',
  "  if (-not $ip) { throw 'ไม่ได้รับเลขที่อยู่จากส่วนตั้งค่าเครือข่าย' }",
  '}',
  '',
  "$infoFile = Join-Path $certDir 'clinic-cert.json'",
  "$pfxFile = Join-Path $certDir 'clinic.pfx'",
  'if ($TestMode -or $ElevatedPhase) {',
  '  # ใบรับรอง HTTPS: ใช้ของเดิมถ้ายังครอบ IP นี้และยังไม่ใกล้หมดอายุ ไม่งั้นสร้างใหม่ (แล้วเครื่องห้องตรวจต้องติดตั้ง .cer ใหม่)',
  '  $needCert = $true',
  '  if ((Test-Path -LiteralPath $infoFile) -and (Test-Path -LiteralPath $pfxFile)) {',
  '    try {',
  '      $info = Get-Content -LiteralPath $infoFile -Raw -Encoding UTF8 | ConvertFrom-Json',
  "      if (@($info.san) -contains ('IPAddress=' + $ip) -and ([datetime]$info.not_after) -gt (Get-Date).AddDays(90)) { $needCert = $false }",
  '    } catch { $needCert = $true }',
  '  }',
  '  if ($needCert) {',
  "    Write-Host 'กำลังสร้างใบรับรองความปลอดภัย (HTTPS) ของเครื่องนี้...'",
  '    $env:CLINIC_CERT_OUT = $certDir',
  '    $env:CLINIC_CERT_DNS = $env:COMPUTERNAME',
  '    $env:CLINIC_CERT_IPS = $ip',
  "    $env:CLINIC_CERT_NAME = 'ClinicApp'",
  '    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $makeCert | Out-Null',
  '    $certExit = $LASTEXITCODE',
  '    Reset-ClinicConsole',
  "    if ($certExit -ne 0 -or -not (Test-Path -LiteralPath $pfxFile)) { throw 'สร้างใบรับรอง HTTPS ไม่สำเร็จ' }",
  "  } else { Write-Host 'ใบรับรอง HTTPS: ใช้ของเดิม (ครอบเลขที่อยู่นี้และยังไม่ใกล้หมดอายุ)' }",
  '}',
  'if (-not $TestMode -and $ElevatedPhase) {',
  '  # จำกัดสิทธิ์โฟลเดอร์ใบรับรอง (มี private key): เฉพาะบัญชีนี้ + SYSTEM + Administrators',
  "  & icacls $certDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ($env:USERNAME + ':(OI)(CI)F') | Out-Null",
  "  Write-Host '[admin] จำกัดสิทธิ์โฟลเดอร์ใบรับรองแล้ว'",
  '  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule',
  '  foreach ($legacy in $legacyRules) { Get-NetFirewallRule -DisplayName $legacy -ErrorAction SilentlyContinue | Remove-NetFirewallRule }',
  "  $node = Join-Path $Target 'runtime\\node.exe'",
  '  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $httpsPort -Profile Private -RemoteAddress LocalSubnet -Program $node | Out-Null',
  "  Write-Host ('[admin] ตั้งค่า Firewall แล้ว: ' + $ruleName)",
  "  $handoffBody = @{ format = 1; ip = $ip; rule_name = $ruleName; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress",
  '  [IO.File]::WriteAllText($handoffFile, $handoffBody, (New-Object System.Text.UTF8Encoding($false)))',
  "  Write-Host '[admin] เสร็จ — ส่งต่อให้ส่วนผู้ใช้รีสตาร์ทโปรแกรม'",
  '  return   # จบเฟส B ที่นี่ (finally ปิด transcript, exit code 0) — ส่วนที่เหลือเป็นของเฟส A/โหมดทดสอบ',
  '}',
  'if (-not $TestMode) {',
  '  # เฟส A: รีสตาร์ท server ให้โหลดใบรับรอง — ทำในสิทธิ์ผู้ใช้ ไม่ใช้ Test-NetConnection/Start-Process -Wait (เคยค้าง 2026-08-16)',
  "  Write-Host 'กำลังรีสตาร์ทโปรแกรมเพื่อโหลดใบรับรอง...'",
  '  if (Test-ClinicPort $port) {',
  "    $tokenFile = Join-Path $Target 'app\\data\\recovery-control.token'",
  "    $token = ''",
  "    if (Test-Path -LiteralPath $tokenFile) { $token = (Get-Content -LiteralPath $tokenFile -Raw).Trim() }",
  '    try {',
  "      Invoke-WebRequest -UseBasicParsing -Method Post -Uri ('http://127.0.0.1:' + $port + '/api/system/prepare-restore') -Headers @{ 'X-Recovery-Control' = $token } -TimeoutSec 10 | Out-Null",
  "    } catch { Write-Host ('สั่งหยุดโปรแกรมเดิม: ' + $_.Exception.Message) }",
  "    if (-not (Wait-ClinicPort $port $false 30)) { throw 'โปรแกรมเดิมไม่หยุดภายใน 30 วินาที — กรุณาปิดหน้าต่าง ClinicApp แล้วกดตั้งค่าใหม่' }",
  "    Write-Host 'โปรแกรมเดิมหยุดแล้ว'",
  '  }',
  '  # เปิดใหม่แบบไม่ยกสิทธิ์เสมอ: ถ้า process นี้เป็น admin ให้ explorer.exe (สิทธิ์ผู้ใช้) เป็นคนเปิดแทน',
  "  if ($isAdmin) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('\"' + $launcher + '\"') } else { Start-Process -FilePath $launcher -WorkingDirectory $Target }",
  "  if (-not (Wait-ClinicPort $port $true 90)) { throw 'โปรแกรมไม่กลับมาภายใน 90 วินาที — เปิดจากไอคอน ระบบคลินิก แล้วกดตั้งค่าใหม่' }",
  '  $httpsUp = Wait-ClinicPort $httpsPort $true 30',
  '  Reset-ClinicConsole',
  "  Write-Host ('โปรแกรมกลับมาแล้ว' + $(if ($httpsUp) { ' (ทางเข้า HTTPS เปิด)' } else { ' — แต่ทางเข้า HTTPS ยังไม่เปิด ตรวจหน้าต่าง ClinicApp' }))",
  '}',
  '',
  'if ([string]::IsNullOrWhiteSpace($OutputDir)) {',
  `  $OutputDir = Join-Path ([Environment]::GetFolderPath('Desktop')) '${variant.trial ? 'ส่งไปเครื่องหมอ (ทดลอง)' : 'ส่งไปเครื่องหมอ'}'`,
  '}',
  'New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null',
  '$url = "https://${ip}:${httpsPort}/"',
  "Copy-Item -LiteralPath (Join-Path $certDir 'clinic.cer') -Destination (Join-Path $OutputDir 'clinic.cer') -Force",
  "$installCert = Join-Path $OutputDir 'ติดตั้งใบรับรอง (เครื่องห้องตรวจ).cmd'",
  '$installCertBody = @(',
  "  '@echo off',",
  "  'chcp 65001 >nul',",
  "  'set \"PKG=%~dp0\"',",
  "  'if \"%PKG:~-1%\"==\"\\\" set \"PKG=%PKG:~0,-1%\"',",
  "  'set \"CLINIC_CER=%PKG%\\clinic.cer\"',",
  "  'set \"CLINIC_MSG_TITLE=ระบบคลินิก - ติดตั้งใบรับรอง\"',",
  `  'set "CLINIC_MSG_OK=ติดตั้งใบรับรองแล้ว - เปิดทางลัด เปิดระบบคลินิก (ห้องหมอ${variant.trial?' ทดลอง':''}) ได้เลย ที่อยู่ต้องขึ้นต้นด้วย https และไม่มีคำเตือน"',`,
  "  'set \"CLINIC_MSG_FAIL=ติดตั้งใบรับรองไม่สำเร็จ - ลองดับเบิลคลิกใหม่ แล้วกด Yes เมื่อ Windows ถามยืนยัน\"',",
  "  'echo กำลังติดตั้งใบรับรองความปลอดภัยของระบบคลินิกลงเครื่องนี้ (Windows จะถามยืนยัน กรุณากด Yes)',",
  "  'powershell -NoProfile -ExecutionPolicy Bypass -Command \"Import-Certificate -FilePath $env:CLINIC_CER -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null\"',",
  "  'if errorlevel 1 goto :fail',",
  `  'echo ติดตั้งใบรับรองแล้ว — เปิดทางลัด เปิดระบบคลินิก (ห้องหมอ${variant.trial?' ทดลอง':''}) ได้เลย',`,
  "  'rem ผลลัพธ์ขึ้นเป็นกล่องของ Windows ด้วย — หน้าต่างดำบางเครื่องแสดงไทยแตกจนอ่านไม่ออก (ข้อความส่งผ่าน env ไม่ฝังในคำสั่ง)',",
  "  'powershell -NoProfile -ExecutionPolicy Bypass -Command \"Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:CLINIC_MSG_OK, $env:CLINIC_MSG_TITLE, ''OK'', ''Information'')\"',",
  "  'exit /b 0',",
  "  ':fail',",
  "  'echo ** ติดตั้งใบรับรองไม่สำเร็จ ลองใหม่แล้วกด Yes เมื่อ Windows ถาม',",
  "  'powershell -NoProfile -ExecutionPolicy Bypass -Command \"Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:CLINIC_MSG_FAIL, $env:CLINIC_MSG_TITLE, ''OK'', ''Error'')\"',",
  "  'pause',",
  "  'exit /b 1'",
  ') -join \"`r`n\"',
  '[IO.File]::WriteAllText($installCert, $installCertBody + "`r`n", (New-Object System.Text.UTF8Encoding($false)))',
  `$shortcut = Join-Path $OutputDir '${variant.trial ? 'เปิดระบบคลินิก (ห้องหมอ ทดลอง).url' : 'เปิดระบบคลินิก (ห้องหมอ).url'}'`,
  "@('[InternetShortcut]', ('URL=' + $url), 'IconIndex=0') | Set-Content -LiteralPath $shortcut -Encoding ASCII",
  "$instructions = Join-Path $OutputDir 'อ่านก่อนเปิด.txt'",
  '@(',
  "  'สำหรับคอมพิวเตอร์ห้องตรวจ — ไม่ต้องติดตั้งโปรแกรม'",
  "  ''",
  "  '1. ดับเบิลคลิก ติดตั้งใบรับรอง (เครื่องห้องตรวจ) แล้วกด Yes เมื่อ Windows ถาม (ทำครั้งเดียว)'",
  "  '   ถ้าดาวน์โหลดโฟลเดอร์นี้จากอินเทอร์เน็ต แล้ว Windows ขึ้นกล่องสีฟ้า: กด More info ตรวจชื่อไฟล์ แล้วกด Run anyway (ทาง USB มักไม่ขึ้น)'",
  "  '2. ให้เครื่องหน้าร้านเปิดอยู่ และทั้งสองเครื่องต่อ Wi-Fi/สาย LAN วงเดียวกัน'",
  `  '3. ดับเบิลคลิก เปิดระบบคลินิก (ห้องหมอ${variant.trial?' ทดลอง':''}) — ที่อยู่ขึ้นต้นด้วย https การเชื่อมต่อเข้ารหัสแล้ว'`,
  `  '4. เข้าด้วยบัญชีแพทย์${variant.trial ? ' (ชุดทดลอง: doctor / doctor123)' : 'ที่ผู้ดูแลตั้งให้'}'`,
  "  ''",
  "  'ถ้าเบราว์เซอร์เตือนว่าไม่ปลอดภัย: ยังไม่ได้ทำข้อ 1 หรือเครื่องหน้าร้านเพิ่งเปลี่ยนเลขที่อยู่ — ให้รัน ตั้งค่าใช้สองเครื่อง ที่เครื่องหน้าร้านอีกครั้ง แล้วนำโฟลเดอร์นี้มาทำข้อ 1 ใหม่'",
  "  'ถ้าเปิดไม่ได้: ตรวจว่าไม่ได้ใช้ Guest Wi-Fi'",
  ...(variant.trial ? ["  'สำคัญ: นี่คือชุดทดลอง ใช้ข้อมูลสมมติเท่านั้น ห้ามกรอกข้อมูลคนไข้จริง'"] : []),
  "  ('ลิงก์สำรอง: ' + $url)",
  ') | Set-Content -LiteralPath $instructions -Encoding UTF8',
  '# ห้ามมี private key/รหัสในโฟลเดอร์ที่ส่งออก',
  "foreach ($forbidden in @('clinic.pfx', 'clinic.pfx.pass')) { if (Test-Path -LiteralPath (Join-Path $OutputDir $forbidden)) { throw ('พบไฟล์ลับในโฟลเดอร์ส่งออก: ' + $forbidden) } }",
  '# บันทึกผลการตั้งค่าให้หน้า Admin (การ์ด "เครื่องห้องตรวจ") อ่านสถานะได้ — ไม่มีความลับในไฟล์นี้',
  '$setupThumb = $null',
  "try { $setupThumb = (Get-Content -LiteralPath $infoFile -Raw -Encoding UTF8 | ConvertFrom-Json).thumbprint } catch { }",
  '$setupInfo = @{ format = 1; url = $url; ip = $ip; https_port = $httpsPort; output_dir = $OutputDir; shortcut_name = [IO.Path]::GetFileName($shortcut); rule_name = $ruleName; target = $Target;',
  "  thumbprint = $setupThumb; at = (Get-Date).ToString('o'); test_mode = [bool]$TestMode } | ConvertTo-Json -Compress",
  "[IO.File]::WriteAllText((Join-Path $certDir 'lan-setup.json'), $setupInfo, (New-Object System.Text.UTF8Encoding($false)))",
  '',
  "Write-Host ''",
  "Write-Host '============================================' -ForegroundColor Green",
  "Write-Host 'ตั้งค่าสองเครื่องสำเร็จแล้ว (เชื่อมต่อแบบเข้ารหัส HTTPS)' -ForegroundColor Green",
  "Write-Host ('ลิงก์เครื่องห้องตรวจ: ' + $url)",
  "Write-Host ('โฟลเดอร์ที่ต้องส่งไปเครื่องห้องตรวจ: ' + $OutputDir)",
  "Write-Host 'ที่เครื่องห้องตรวจ: ติดตั้งใบรับรองครั้งเดียว แล้วเปิดทางลัดได้เลย ไม่ต้องติดตั้งโปรแกรม'",
  "Write-Host '============================================' -ForegroundColor Green",
  'if (-not $TestMode) {',
  '  $done = @(',
  "    'ตั้งค่าสองเครื่องสำเร็จแล้ว (เชื่อมต่อแบบเข้ารหัส HTTPS)',",
  "    '',",
  "    'โปรแกรมที่ตั้งค่า: ' + $Target,",
  "    'ลิงก์เครื่องห้องตรวจ: ' + $url,",
  "    'โฟลเดอร์ที่ต้องส่งไปเครื่องห้องตรวจ: ' + $OutputDir,",
  "    '',",
  `    'ที่เครื่องห้องตรวจ: ดับเบิลคลิก ติดตั้งใบรับรอง (เครื่องห้องตรวจ) ครั้งเดียว แล้วเปิดทางลัด เปิดระบบคลินิก (ห้องหมอ${variant.trial?' ทดลอง':''}) — ไม่ต้องติดตั้งโปรแกรม'`,
  '  ) -join "`r`n"',
  "  [void](Show-ClinicBox $done 'info')",
  '}',
  '} catch {',
  '  $reason = $_.Exception.Message',
  "  Write-Host ('** ตั้งค่าไม่สำเร็จ: ' + $reason) -ForegroundColor Red",
  '  if (-not $TestMode) {',
  '    [void](Show-ClinicBox (@(',
  "      'ตั้งค่าสองเครื่องไม่สำเร็จ — ยังไม่ได้เปิดทางเข้าจากเครื่องอื่น',",
  "      '',",
  "      $reason,",
  "      '',",
  "      'รายละเอียดทั้งหมดอยู่ในไฟล์ ' + $logFile",
  '    ) -join "`r`n") \'error\')',
  '  }',
  '  $exitCode = 1',
  '} finally {',
  '  if (-not $TestMode) { try { Stop-Transcript | Out-Null } catch { } }',
  '}',
  'exit $exitCode',
  '',
].join(CRLF); }

function makeLanRemovePs1(variant) { return '﻿' + [
  'param(',
  `  [string]$Target = '${variant.target}',`,
  '  [switch]$TestMode',
  ')',
  ...consoleUtf8Ps1(),
  "$ErrorActionPreference = 'Stop'",
  `$ruleNames = @('${variant.ruleName}', 'Clinic Trial - Doctor computer (TCP 8081)')`,
  '$Target = ($Target -replace \'"\', \'\').TrimEnd("\\")',
  'if ($TestMode) {',
  "  Write-Host '[โหมดทดสอบ] ไม่ได้เปลี่ยน Firewall จริง'",
  '  exit 0',
  '}',
  '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
  '$principal = New-Object Security.Principal.WindowsPrincipal($identity)',
  '$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  'if (-not $isAdmin) {',
  "  Write-Host 'Windows จะถามว่าจะอนุญาตให้ปิดการเชื่อมต่อหรือไม่ กรุณากด Yes' -ForegroundColor Yellow",
  "  $argumentLine = '-NoProfile -ExecutionPolicy Bypass -File \"' + $PSCommandPath + '\" -Target \"' + $Target + '\"'",
  "  $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $argumentLine -Wait -PassThru",
  '  exit $process.ExitCode',
  '}',
  'foreach ($name in $ruleNames) { $rules = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue); if ($rules.Count -gt 0) { $rules | Remove-NetFirewallRule } }',
  "Write-Host 'ปิดทางเข้าจากเครื่องห้องตรวจแล้ว โปรแกรม ข้อมูล และใบรับรองยังอยู่ตามเดิม' -ForegroundColor Green",
  `Write-Host 'หากต้องการใช้อีกครั้ง ให้ดับเบิลคลิก ${variant.lanSetupCmd.replace(/\.cmd$/, '')}'`,
  '',
].join(CRLF); }

function makeReadmeTxt(variant) { return [
  `ชุดติดตั้ง${variant.title}`,
  '',
  'ก่อนแตกไฟล์ (สำคัญ — ทำครั้งเดียว):',
  '  ถ้าได้ไฟล์นี้มาทางอินเทอร์เน็ต ให้คลิกขวาที่ไฟล์ ZIP > Properties (คุณสมบัติ)',
  '  ถ้าเห็นช่อง "Unblock" (ยกเลิกการบล็อก) ด้านล่าง ให้ติ๊กแล้วกด OK ก่อนแตกไฟล์',
  '  ขั้นนี้ทำให้ติดตั้งได้โดยไม่มีกล่องเตือนสีฟ้าของ Windows',
  '',
  'วิธีติดตั้ง:',
  '  1. คลิกขวาไฟล์ ZIP > Extract All (แตกไฟล์ทั้งหมด)',
  '  2. เปิดโฟลเดอร์ที่แตกออกมา จะเห็น 3 รายการ: ติดตั้งระบบคลินิก.cmd, อ่านก่อนติดตั้ง.txt และโฟลเดอร์ชุดโปรแกรม',
  '     ดับเบิลคลิก ติดตั้งระบบคลินิก.cmd (ไฟล์เดียวที่ต้องกด) โฟลเดอร์ "ชุดโปรแกรม (ไม่ต้องเปิด)" ไม่ต้องเปิด',
  '  3. ทำตามข้อความบนจอจนขึ้นว่า "ติดตั้งเสร็จแล้ว"',
  `  โปรแกรมจะติดตั้งที่ ${variant.target} และเปิดหน้าโปรแกรมให้เอง`,
  '',
  'หลังติดตั้ง:',
  ...(variant.trial ? [
    '  - ใช้บัญชี doctor / doctor123 สำหรับจอหมอ',
    '  - ใช้บัญชี front / front123 สำหรับจอหน้าร้าน',
    '  - เปิดครั้งต่อไป: ดับเบิลคลิกไอคอน "ระบบคลินิก (ทดลอง)" บนหน้าจอ',
    '  - ถ้าจะทดลองสองเครื่อง (ทำทีหลังได้ทุกเมื่อ): ที่เครื่องหน้าร้าน เข้าระบบด้วย admin → หน้า "ตั้งค่า"',
    '    → การ์ด "เครื่องห้องตรวจ" → กด "ตั้งค่าเครื่องห้องตรวจ" (หรือไอคอน "ตั้งค่าเครื่องห้องตรวจ (ทดลอง)" บน Desktop)',
    '    ทำตามกล่องจนขึ้น "สำเร็จ" → นำโฟลเดอร์ "ส่งไปเครื่องหมอ (ทดลอง)" บน Desktop ไปที่เครื่องหมอ — เครื่องหมอไม่ต้องติดตั้งโปรแกรม',
    '    แค่ดับเบิลคลิก "ติดตั้งใบรับรอง (เครื่องห้องตรวจ)" กด Yes ครั้งเดียว แล้วเปิดทางลัด (การเชื่อมต่อเข้ารหัส https)',
    '    การ์ดในหน้าตั้งค่าจะบอกด้วยว่าตอนนี้เชื่อมอยู่ไหม และเมื่อไหร่ต้องส่งใบรับรองใหม่ (เช่น เปลี่ยน Wi-Fi/เราเตอร์)',
    '',
    'สิ่งสำคัญที่ควรรู้:',
    '  - เมื่อฝึกพร้อมแล้ว เปิดตัวติดตั้งชุดจริง จะถามยืนยันลบชุดทดลองและข้อมูลฝึกก่อนเริ่มฐานจริงใหม่ กด ไม่ใช่ เพื่อยกเลิกหากยังต้องเก็บข้อมูล',
    '  - ตัวทดลองเปิดที่เลขทางเข้า 8081 ส่วนตัวจริงใช้เลข 8080 คุณไม่ต้องจำเลขนี้ ใช้ไอคอนบนหน้าจอก็พอ',
    '  - แถบสีเหลืองด้านบนจะบอกเสมอว่านี่คือข้อมูลทดลอง ห้ามใช้รับคนไข้จริง',
    '  - เล่นผิดหรือลองจนข้อมูลเละได้ ลบชุดทดลองแล้วติดตั้งใหม่ก็เริ่มต้นได้อีกครั้ง',
  ] : [
    '  - ถ้าพบชุดทดลองเดิม จะถามยืนยันลบชุดทดลองและข้อมูลที่เคยกรอกทั้งหมด ไม่ย้ายข้อมูลฝึกเข้าตัวจริง กด ไม่ใช่ เพื่อยกเลิก',
    '  - เข้าระบบครั้งแรกด้วยชื่อผู้ใช้ admin (รหัสผ่านเริ่มต้นแสดงบนจอตอนติดตั้ง)',
    '  - สิ่งแรกที่ต้องทำคือเปลี่ยนรหัสผ่าน แล้วตั้งชื่อคลินิก',
    '  - เปิดโปรแกรมครั้งต่อไป: ดับเบิลคลิกไอคอน "ระบบคลินิก" บนหน้าจอ',
    '  - ถ้ามีคอมพิวเตอร์ห้องตรวจอีกเครื่อง (ทำทีหลังได้ทุกเมื่อ): ที่เครื่องหน้าร้าน เข้าระบบด้วย admin → หน้า "ตั้งค่า"',
    '    → การ์ด "เครื่องห้องตรวจ" → กด "ตั้งค่าเครื่องห้องตรวจ" (หรือไอคอน "ตั้งค่าเครื่องห้องตรวจ" บน Desktop)',
    '    ทำตามกล่องจนขึ้น "สำเร็จ" → นำโฟลเดอร์ "ส่งไปเครื่องหมอ" บน Desktop ไปที่เครื่องห้องตรวจ — ไม่ต้องติดตั้งโปรแกรม',
    '    แค่ดับเบิลคลิก "ติดตั้งใบรับรอง (เครื่องห้องตรวจ)" กด Yes ครั้งเดียว แล้วเปิดทางลัด (เชื่อมต่อเข้ารหัส https)',
    '    การ์ดในหน้าตั้งค่าจะบอกด้วยว่าตอนนี้เชื่อมอยู่ไหม และเมื่อไหร่ต้องส่งใบรับรองใหม่ (เช่น เปลี่ยน Wi-Fi/เราเตอร์)',
    '  - เครื่องอื่นเข้าได้เฉพาะทาง https ที่ตั้งค่าไว้เท่านั้น — ใช้ Wi-Fi/สาย LAN ของคลินิกที่คนไข้ไม่ได้รหัส',
  ]),
  '',
  variant.trial
    ? 'ชุดนี้มีเฉพาะข้อมูลสมมติประมาณ 100 คนสำหรับฝึกใช้ ห้ามกรอกข้อมูลคนไข้จริง'
    : 'ชุดนี้ไม่มีข้อมูลคนไข้ใดๆ ติดมา — ฐานข้อมูลถูกสร้างใหม่ว่างเปล่าที่เครื่องนี้ตอนติดตั้ง',
  '',
].join(CRLF); }

// ---------- ZIP writer (Node ล้วน; ใช้ primitive เดียวกับ updater) ----------
function writeZip(zipFile, rootDir, rootName) {
  const entries = [];
  (function walk(dir, relativeBase) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const relative = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) entries.push({ source: full, name: `${rootName}/${relative}` });
    }
  })(rootDir, '');
  writeZipEntries(zipFile, entries);
  return entries.length;
}

// ---------- build ----------
function assertPackageClean(packageRoot, variant) {
  const problems = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(packageRoot, full);
      if (entry.isDirectory()) {
        if (/^app[\\\/]data$/i.test(relative)) problems.push(`ห้ามมีโฟลเดอร์ข้อมูล: ${relative}`);
        else walk(full);
      } else if (FORBIDDEN_BASENAME.test(entry.name)
        && !(variant.trial && TRIAL_SEED_FILES.includes(entry.name))) {
        problems.push(`ไฟล์ต้องห้ามหลุดเข้า package: ${relative}`);
      }
    }
  })(packageRoot);
  const installer = fs.readFileSync(path.join(packageRoot, 'ติดตั้งระบบคลินิก.cmd'), 'utf8');
  if (!variant.trial && installer.includes('--demo')) problems.push('ตัวติดตั้งจริงมี --demo — ห้ามเด็ดขาด');
  if (!variant.trial && fs.existsSync(path.join(packageRoot, 'app', 'seed-mock-clinic.js'))) {
    problems.push('ตัวติดตั้งจริงมี seed ข้อมูลทดลอง — ห้ามเด็ดขาด');
  }
  // ตัวช่วยสองเครื่องต้องเป็น HTTPS เท่านั้น: firewall เปิดเฉพาะพอร์ต HTTPS ของ variant, ทางลัด https, ไม่มี http:// LAN
  const setupPs1 = path.join(packageRoot, 'scripts', 'setup-lan.ps1');
  if (!fs.existsSync(setupPs1) || !fs.existsSync(path.join(packageRoot, variant.lanSetupCmd))) {
    problems.push('ไม่มีตัวช่วยสองเครื่อง (HTTPS)');
  } else {
    const src = fs.readFileSync(setupPs1, 'utf8');
    if (!src.includes(`$httpsPort = ${variant.httpsPort}`) || !src.includes('-LocalPort $httpsPort')) problems.push('firewall ของตัวช่วยสองเครื่องไม่ได้ผูกกับพอร์ต HTTPS');
    if (src.includes(`-LocalPort ${variant.port}`) || src.includes('"http://${ip}')) problems.push('ตัวช่วยสองเครื่องยังเปิดทาง HTTP บน LAN — ห้ามเด็ดขาด');
    if (!src.includes('https://${ip}:${httpsPort}')) problems.push('ทางลัดเครื่องห้องตรวจไม่ใช่ https');
    if (/Copy-Item[^\n]*clinic\.pfx/.test(src)) problems.push('ตัวช่วยคัดลอก pfx ออกไป — ห้ามเด็ดขาด');
  }
  if (!fs.existsSync(path.join(packageRoot, 'scripts', 'make-cert.ps1'))) problems.push('ไม่มี make-cert.ps1');
  if (!variant.trial && fs.existsSync(path.join(packageRoot, 'ตั้งค่าใช้สองเครื่อง (ทดลอง).cmd'))) problems.push('ชุดจริงมีตัวช่วยของชุดทดลอง');
  if (variant.trial && (!installer.includes('--demo') || !installer.includes('seed-mock-clinic.js'))) {
    problems.push('ตัวติดตั้งทดลองไม่มีขั้นสร้างข้อมูลทดลอง');
  }
  if (problems.length) throw new Error('ชุดติดตั้งไม่ผ่านการตรวจ:\n  ' + problems.join('\n  '));
}

function buildInstaller(options = {}) {
  const variant = options.trial ? VARIANTS.trial : VARIANTS.production;
  const outDir = path.resolve(options.out || path.join(REPO_ROOT, 'dist'));
  const packageRoot = path.join(outDir, variant.packageName);
  if (packageRoot.toLowerCase().startsWith(APP_ROOT.toLowerCase() + path.sep)) {
    throw new Error('ปลายทาง build ต้องอยู่นอกโฟลเดอร์ app');
  }
  removeTreeSync(packageRoot);
  fs.mkdirSync(packageRoot, { recursive: true });

  const runtimePath = require('../lib/runtime').verify(path.resolve(options.runtimePath || require('../lib/runtime').pinned(APP_ROOT)));
  const inventory = [];
  copyFileVerified(runtimePath, path.join(packageRoot, 'runtime', 'node.exe'), inventory, 'runtime/node.exe');
  copyFileVerified(path.join(REPO_ROOT, 'LICENSE'), path.join(packageRoot, 'LICENSE'), inventory, 'LICENSE');

  const appDir = path.join(packageRoot, 'app');
  for (const file of APP_FILES) copyFileVerified(path.join(APP_ROOT, file), path.join(appDir, file), inventory, path.join('app', file));
  for (const directory of APP_DIRECTORIES) copyDirectoryAllowlist(APP_ROOT, directory, appDir, inventory);
  for (const file of TOOL_FILES) copyFileVerified(path.join(APP_ROOT, file), path.join(appDir, file), inventory, path.join('app', file));
  if (variant.trial) {
    for (const file of TRIAL_SEED_FILES) {
      copyFileVerified(path.join(APP_ROOT, file), path.join(appDir, file), inventory, path.join('app', file));
    }
  }

  const write = (name, content) => fs.writeFileSync(path.join(packageRoot, name), content, { encoding: 'utf8', flag: 'wx' });
  write('ติดตั้งระบบคลินิก.cmd', makeInstallerCmd(variant));
  write('เปิดระบบคลินิก.cmd', makeLauncherCmd(variant));
  write('รีสตาร์ทระบบคลินิก.cmd', makeRestartCmd(variant));
  write('อ่านก่อนติดตั้ง.txt', makeReadmeTxt(variant));
  fs.mkdirSync(path.join(packageRoot, 'scripts'));
  write(path.join('scripts', 'make-shortcuts.ps1'), makeShortcutsPs1(variant));
  // ทั้งสองชุดมีตัวช่วยสองเครื่องแบบ HTTPS (production เดิมห้ามมี LAN helper เพราะเป็น HTTP — ยกเลิกแล้วตาม A-refined)
  write(variant.lanSetupCmd, makeLanCmd(variant, 'setup'));
  write(variant.lanRemoveCmd, makeLanCmd(variant, 'remove'));
  write(path.join('scripts', 'setup-lan.ps1'), makeLanSetupPs1(variant));
  write(path.join('scripts', 'remove-lan.ps1'), makeLanRemovePs1(variant));
  write(path.join('scripts', 'make-cert.ps1'), makeCertPs1());

  fs.mkdirSync(path.join(packageRoot, 'update'), { recursive: true });
  write(path.join('update', 'install-profile.json'), JSON.stringify({
    format: 1, product: 'clinic-offline', edition: 'standard',
    variant: variant.trial ? 'trial' : 'production', channel: 'pilot', port: variant.port, https_port: variant.httpsPort,
  }, null, 2));
  // แหล่งอัปเดตของชุดนี้ — service อ่านจาก <install>/update/feed-url.txt (override ด้วย env CLINIC_UPDATE_FEED_URL ได้ตอนซ้อม)
  write(path.join('update', 'feed-url.txt'), updateFeedUrl(variant) + '\n');

  const documentsDir = path.join(packageRoot, 'เอกสาร');
  for (const file of DOCUMENT_FILES) {
    const source = path.join(REPO_ROOT, 'dist', file);
    if (fs.existsSync(source)) {
      copyFileVerified(source, path.join(documentsDir, file), inventory, path.join('เอกสาร', file));
    }
  }

  const appVersion = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  const manifest = {
    format: 1,
    kind: variant.kind,
    installTarget: variant.target,
    port: variant.port,
    httpsPort: variant.httpsPort,
    createdAt: new Date().toISOString(),
    appVersion,
    nodeVersion: 'v' + require('../lib/runtime').VERSION,
    files: inventory,
  };
  write('setup-manifest.json', JSON.stringify(manifest, null, 2));

  assertPackageClean(packageRoot, variant);

  // Keep the installed image exactly flat; only the distribution envelope changes.
  const payloadRoot=path.join(packageRoot,PAYLOAD_DIRECTORY);
  if(path.dirname(payloadRoot)!==packageRoot)throw new Error('ปลายทางชุดโปรแกรมไม่ถูกต้อง');
  const flatNames=fs.readdirSync(packageRoot);
  fs.mkdirSync(payloadRoot);
  for(const name of flatNames)if(name!=='อ่านก่อนติดตั้ง.txt')fs.renameSync(path.join(packageRoot,name),path.join(payloadRoot,name));
  fs.writeFileSync(path.join(packageRoot,'ติดตั้งระบบคลินิก.cmd'),makePackageEntryCmd());
  const packageFiles=[];
  function transport(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())transport(full);else if(full!==path.join(payloadRoot,'setup-manifest.json'))packageFiles.push({file:path.relative(packageRoot,full).replace(/\\/g,'/'),bytes:fs.statSync(full).size,sha256:sha256(full)});}}
  transport(packageRoot);
  manifest.packageFiles=packageFiles;manifest.payloadDirectory=PAYLOAD_DIRECTORY;
  fs.writeFileSync(path.join(payloadRoot,'setup-manifest.json'),JSON.stringify(manifest,null,2));

  let zipFile = null;
  if (!options.noZip) {
    // build ซ้ำในวันเดียวกันต้องแยกชื่อได้ ไม่งั้นหมอมี ZIP ชื่อเดียวกันสองรอบแล้วเลือกไม่ถูก
    const tag = String(options.buildTag || '').trim();
    if (tag && !/^[a-z0-9][a-z0-9-]{0,15}$/.test(tag)) throw new Error('--build-tag ใช้ได้เฉพาะ a-z 0-9 และ - ยาวไม่เกิน 16');
    const stamp = manifest.createdAt.slice(0, 10).replace(/-/g, '') + tag;
    zipFile = path.join(outDir, `${variant.zipPrefix}-${appVersion}-${stamp}.zip`);
    if (fs.existsSync(zipFile)) fs.rmSync(zipFile);
    writeZip(zipFile, packageRoot, variant.packageName);
  }
  return { ok: true, packageRoot, payloadRoot, zipFile, files: inventory.length, appVersion,
    nodeVersion: 'v' + require('../lib/runtime').VERSION, trial: variant.trial, packageName: variant.packageName,
    installTarget: variant.target, port: variant.port };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const tagIndex = args.indexOf('--build-tag');
  const result = buildInstaller({
    out: outIndex >= 0 ? args[outIndex + 1] : undefined,
    noZip: args.includes('--no-zip'),
    trial: args.includes('--trial'),
    buildTag: tagIndex >= 0 ? args[tagIndex + 1] : undefined,
  });
  console.log(`สร้างชุดติดตั้งแล้ว: ${result.packageRoot}`);
  console.log(`ไฟล์ ${result.files} รายการ · app v${result.appVersion} · Node ${result.nodeVersion}`);
  console.log(result.zipFile ? `ZIP: ${result.zipFile}` : 'ZIP: ไม่ได้สร้าง');
}

module.exports = { buildInstaller, PACKAGE_NAME, TRIAL_PACKAGE_NAME, DOCUMENT_FILES, PAYLOAD_DIRECTORY,
  consoleUtf8Ps1,
  // ใช้ร่วมกับ tools/build-hotfix.js (ชุดอัปเดตทับสำหรับเครื่องที่ติดตั้งแล้ว) เพื่อไม่ให้ allowlist/ZIP writer แยกทาง
  VARIANTS, CRLF, removeTreeSync, copyFileVerified, copyDirectoryAllowlist, writeZip };
