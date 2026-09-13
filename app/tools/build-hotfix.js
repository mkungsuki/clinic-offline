'use strict';
// สร้าง "ชุดอัปเดตทับ" (hotfix) สำหรับเครื่องที่ติดตั้งระบบคลินิกไว้แล้ว — ไม่ต้องลบ/ลงใหม่ ไม่แตะฐานข้อมูล/ใบรับรอง/การตั้งค่าเครื่องห้องตรวจ
//   ใช้เมื่อ: ระบบอัปเดตอัตโนมัติยังไม่ทำงาน (Phase 6) และรุ่นใหม่ "ไม่มี migration" (schema เท่าเดิม)
//   รัน:  node --no-warnings tools/build-hotfix.js --trial --build-tag l   [--out <dir>] [--no-zip]
//   ได้:  dist/Clinic ทดลอง อัปเดต/  + ZIP ClinicTrialHotfix-<version>-<stamp><tag>.zip
//         ในโฟลเดอร์: อัปเดตชุดทดลอง.cmd (ดับเบิลคลิก) · app\ (โค้ดรุ่นใหม่ตาม allowlist เดียวกับตัวติดตั้ง) · เอกสาร\ (PDF)
//                     scripts\verify-hotfix.js (ตรวจ variant/schema/hash) · hotfix-manifest.json · อ่านก่อนอัปเดต.txt
//   ตัว .cmd ทำตามกติกาสคริปต์ใน AGENTS.md: CRLF, ตัด \ ท้าย, guard installed.marker ที่ปลายทาง, กล่อง MessageBox, โหมดทดสอบ CLINIC_INSTALL_TEST=1
//   ลำดับตอนรัน: ตรวจชุด → ตรวจปลายทาง (marker/journal) → verify-hotfix precheck (variant + schema เท่ากัน + hash ชุด)
//                → หยุด server (prepare-restore ด้วย token) → สำรอง app\ เดิม + VACUUM INTO ฐานข้อมูล ไว้ที่ update\hotfix-backup\<tag>\
//                → robocopy ทับ → verify-hotfix verify (hash ปลายทาง) → เปิดระบบใหม่ → กล่องเขียว
const fs = require('node:fs');
const path = require('node:path');
const { SCHEMA_VERSION } = require('../lib/schema-version');
const { APP_FILES, APP_DIRECTORIES, TOOL_FILES, TRIAL_SEED_FILES } = require('../lib/release-files');
const { VARIANTS, CRLF, DOCUMENT_FILES, removeTreeSync, copyFileVerified, copyDirectoryAllowlist, writeZip } = require('./build-installer');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const HOTFIX_PACKAGE_NAME = 'Clinic อัปเดต';
const TRIAL_HOTFIX_PACKAGE_NAME = 'Clinic ทดลอง อัปเดต';
const APPLY_CMD = 'อัปเดตชุดทดลอง.cmd';
const APPLY_CMD_PRODUCTION = 'อัปเดตระบบคลินิก.cmd';

function makeApplyCmd(variant, tag) {
  const applyName = variant.trial ? APPLY_CMD : APPLY_CMD_PRODUCTION;
  // ข้อความไทยส่งให้ PowerShell ผ่าน env (กติกา AGENTS ข้อ 6) · [br] = ขึ้นบรรทัดใหม่ในกล่อง (cmd ใส่ newline ใน set ไม่ได้)
  const box = (envName, icon) => `powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:${envName}.Replace('[br]', [Environment]::NewLine), $env:CLINIC_MSG_TITLE, 'OK', '${icon}')"`;
  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal EnableExtensions',
    'rem ================================================',
    `rem  ${applyName} — อัปเดตทับ${variant.title} รุ่น ${tag} (ไม่ลบข้อมูล ไม่ต้องลงใหม่)`,
    'rem  ดับเบิลคลิกหลังแตก ZIP เสร็จ · ใช้ได้เฉพาะเครื่องที่ติดตั้งไว้แล้วเท่านั้น',
    'rem ================================================',
    'rem %~dp0 ลงท้ายด้วย \\ เสมอ — ตัดทิ้งก่อนใช้ใน "..." (กติกา AGENTS ข้อ 2)',
    'set "SRC=%~dp0"',
    'if "%SRC:~-1%"=="\\" set "SRC=%SRC:~0,-1%"',
    `set "TARGET=${variant.target}"`,
    'if not "%~1"=="" set "TARGET=%~1"',
    'if "%TARGET:~-1%"=="\\" set "TARGET=%TARGET:~0,-1%"',
    'set "TESTMODE=0"',
    'if "%CLINIC_INSTALL_TEST%"=="1" set "TESTMODE=1"',
    `set "TAG=${tag}"`,
    `set "PORT=${variant.port}"`,
    'set "NODE=%TARGET%\\runtime\\node.exe"',
    `set "CLINIC_MSG_TITLE=อัปเดต${variant.title} รุ่น ${tag}"`,
    'echo.',
    'echo ============================================',
    `echo    อัปเดต${variant.title} รุ่น ${tag} (อัปเดตทับ ไม่ลบข้อมูล)`,
    'echo ============================================',
    'echo.',
    'rem [1/6] ตรวจว่าแตก ZIP ครบ (กันเคสเปิดจากในหน้าต่าง ZIP)',
    'if not exist "%SRC%\\app\\server.js" goto :badzip',
    'if not exist "%SRC%\\hotfix-manifest.json" goto :badzip',
    'if not exist "%SRC%\\scripts\\verify-hotfix.js" goto :badzip',
    'rem [2/6] ตรวจปลายทาง: ต้องเป็นชุดที่ติดตั้งแล้ว (guard installed.marker — กติกา AGENTS ข้อ 5) และไม่มีการอัปเดตค้าง',
    'if not exist "%TARGET%\\update\\installed.marker" goto :not_installed',
    'if not exist "%NODE%" goto :not_installed',
    'rem [2.5/6] ต้องเขียนทับไฟล์โปรแกรมได้ — บั๊กหน้างานเครื่องหมอ 2026-08-17: ชุดถูกติดตั้งแบบ Run as administrator ไฟล์เป็นของ admin',
    'rem ผู้ใช้ธรรมดาเขียนไม่ได้ → robocopy รอ retry เงียบ ๆ (ค่าเริ่มต้น 1,000,000 ครั้ง × 30 วิ) = ค้างที่ "กำลังคัดลอกรุ่นใหม่" → เช็คก่อนแล้วยกสิทธิ์เอง',
    'set "ISADMIN=0"',
    'net session >nul 2>&1 && set "ISADMIN=1"',
    'set "LOGDIR=%TARGET%\\logs"',
    'if not exist "%LOGDIR%" mkdir "%LOGDIR%" 2>nul',
    'set "LOG=%LOGDIR%\\hotfix-%TAG%.log"',
    '(type nul >> "%TARGET%\\app\\package.json") 2>nul || goto :need_admin',
    '(type nul >> "%LOG%") 2>nul || goto :need_admin',
    'echo ==== %DATE% %TIME% hotfix %TAG% start (admin=%ISADMIN%) >> "%LOG%"',
    'if exist "%TARGET%\\update\\active-journal.json" goto :journal_pending',
    'if exist "%TARGET%\\update\\active-journal.json.previous" goto :journal_pending',
    'rem [3/6] ตรวจ variant ตรง + schema ของเครื่องนี้เท่ากับชุดอัปเดต (hotfix ห้ามมี migration) + hash ทุกไฟล์ในชุด',
    'echo กำลังตรวจชุดอัปเดตกับเครื่องนี้...',
    '"%NODE%" --no-warnings "%SRC%\\scripts\\verify-hotfix.js" precheck "%SRC%" "%TARGET%"',
    'if errorlevel 5 goto :wrong_variant',
    'if errorlevel 3 goto :zip_corrupt',
    'if errorlevel 2 goto :schema_mismatch',
    'if errorlevel 1 goto :precheck_failed',
    'rem [4/6] หยุดระบบที่เปิดอยู่อย่างปลอดภัย (ทางเดียวกับปุ่มรีสตาร์ท) — โหมดทดสอบไม่ยิงพอร์ตจริง',
    'if "%TESTMODE%"=="1" (',
    '  echo [โหมดทดสอบ] ข้ามการหยุด/เปิดระบบ',
    '  goto :stopped',
    ')',
    'curl -s -m 2 -o nul http://127.0.0.1:%PORT%/api/recovery/ready',
    'if errorlevel 1 (',
    '  echo ระบบไม่ได้เปิดอยู่ — ไปต่อ',
    '  goto :stopped',
    ')',
    'echo กำลังสั่งให้ระบบที่เปิดอยู่หยุดอย่างปลอดภัย...',
    'set "CONTROL_TOKEN="',
    'if exist "%TARGET%\\app\\data\\recovery-control.token" set /p CONTROL_TOKEN=<"%TARGET%\\app\\data\\recovery-control.token"',
    'curl -s -m 5 -o nul -w "%%{http_code}" -X POST http://127.0.0.1:%PORT%/api/system/prepare-restore -H "X-Recovery-Control: %CONTROL_TOKEN%" > "%TEMP%\\clinic_hotfix_stop.txt" 2>nul',
    'set "CONTROL_TOKEN="',
    'set "STOP_CODE="',
    'set /p STOP_CODE=<"%TEMP%\\clinic_hotfix_stop.txt"',
    'del "%TEMP%\\clinic_hotfix_stop.txt" 2>nul',
    'if not "%STOP_CODE%"=="200" goto :stop_failed',
    'set /a TRIES=0',
    ':waitdown',
    'timeout /t 1 >nul',
    'curl -s -m 2 -o nul http://127.0.0.1:%PORT%/api/recovery/ready',
    'if not errorlevel 1 (',
    '  set /a TRIES+=1',
    '  if %TRIES% GEQ 30 goto :stop_failed',
    '  goto :waitdown',
    ')',
    ':stopped',
    'rem บั๊กหน้างานเครื่องหมอ 2026-08-17 (log จริง): เพื่อนแตก ZIP "ทับลงใน C:\\clinic-trial โดยตรง" → SRC = TARGET → robocopy ก๊อปไฟล์ทับตัวเอง',
    'rem → ERROR 32 "being used by another process" ทุกไฟล์ (robocopy ถือต้นทางเปิดอยู่เอง) · กรณีนี้ไฟล์ใหม่อยู่ในที่แล้ว (Explorer แทนที่ตอนแตก) → ข้ามคัดลอก ไปตรวจ SHA เลย',
    'if /i "%SRC%"=="%TARGET%" (',
    '  echo ชุดอัปเดตถูกแตกไว้ในโฟลเดอร์ที่ติดตั้งโดยตรง — ไฟล์รุ่นใหม่อยู่ในที่แล้ว ข้ามการคัดลอก ไปตรวจความครบถ้วน',
    '  echo [same-folder] SRC = TARGET — skip copy >> "%LOG%"',
    '  set "BK=ไม่มีสำเนา - แตกทับลงโฟลเดอร์ติดตั้งโดยตรง"',
    '  goto :verify',
    ')',
    'rem [5/6] สำรองโปรแกรมเดิม + สำเนาฐานข้อมูล (VACUUM INTO) ไว้ก่อน — ถ้ามีปัญหาผู้ดูแลกู้กลับได้',
    'set "BK=%TARGET%\\update\\hotfix-backup\\%TAG%"',
    'if exist "%BK%" set "BK=%BK%-%RANDOM%"',
    'echo กำลังสำรองของเดิมไว้ที่ %BK% ...',
    'robocopy "%TARGET%\\app" "%BK%\\app" /E /R:2 /W:2 /XD "%TARGET%\\app\\data" /NFL /NDL /NJH >> "%LOG%" 2>&1',
    'if errorlevel 8 goto :backup_failed',
    'if exist "%TARGET%\\app\\data\\clinic.db" (',
    '  "%NODE%" --no-warnings "%SRC%\\app\\tools\\pre-upgrade-snapshot.js" "%TARGET%\\app\\data\\clinic.db" "%BK%\\clinic-before.db" >nul',
    '  if errorlevel 1 goto :backup_failed',
    ')',
    'rem [6/6] คัดลอกรุ่นใหม่ทับ (ไม่แตะ app\\data, cert, update, logs) แล้วตรวจ hash ปลายทาง',
    'rem /IS /IT /IM บังคับก๊อปทุกไฟล์ (Same/Tweaked/Modified) แม้ขนาด+เวลาเท่ากัน — บั๊กจริงเครื่องเจ้าของ 2026-08-17: ZIP ทุกรุ่นตั้งเวลาไฟล์คงที่ (2026-01-01)',
    'rem และ billing.js h→l ต่างแค่ตัวเดียว (ขนาดเท่ากัน) → robocopy ปกติเห็นเป็น "ไฟล์เดิม" ข้ามไป → hash ปลายทางไม่ตรง',
    'echo กำลังคัดลอกรุ่นใหม่...',
    'rem /R:2 /W:2 = ล้มแล้วบอกภายในไม่กี่วิ (ไม่รอ retry ไม่รู้จบ) · ผลลง log ไม่ซ่อน',
    'robocopy "%SRC%\\app" "%TARGET%\\app" /E /IS /IT /IM /R:2 /W:2 /XD "%SRC%\\app\\data" /NFL /NDL /NJH >> "%LOG%" 2>&1',
    'if errorlevel 8 goto :copy_failed',
    'if exist "%SRC%\\เอกสาร" (',
    '  robocopy "%SRC%\\เอกสาร" "%TARGET%\\เอกสาร" /E /IS /IT /IM /R:2 /W:2 /NFL /NDL /NJH >> "%LOG%" 2>&1',
    '  if errorlevel 8 goto :copy_failed',
    ')',
    ':verify',
    '"%NODE%" --no-warnings "%SRC%\\scripts\\verify-hotfix.js" verify "%SRC%" "%TARGET%"',
    'if errorlevel 1 goto :verify_failed',
    '>>"%TARGET%\\update\\hotfix-applied.txt" echo %TAG% %DATE% %TIME% backup=%BK%',
    'if "%TESTMODE%"=="1" goto :donetest',
    'echo กำลังเปิดระบบคลินิกรุ่นใหม่...',
    'rem ถ้าตัวนี้ถูกยกสิทธิ์อยู่ ห้ามเปิด server เป็น admin (บทเรียนรอบ h) → ให้ explorer.exe เปิด launcher แทน = สิทธิ์ผู้ใช้ปกติ',
    'if "%ISADMIN%"=="1" (',
    '  explorer.exe "%TARGET%\\เปิดระบบคลินิก.cmd"',
    ') else (',
    '  call "%TARGET%\\เปิดระบบคลินิก.cmd"',
    ')',
    'timeout /t 5 >nul',
    'curl -s -m 3 -o nul http://127.0.0.1:%PORT%/api/recovery/ready',
    'if errorlevel 1 goto :done_not_up',
    `set "CLINIC_MSG_OK=อัปเดตเสร็จแล้ว — ${variant.title} เป็นรุ่น ${tag}[br][br]ระบบกำลังเปิดในเบราว์เซอร์ ข้อมูลเดิม/การตั้งค่าเครื่องห้องตรวจอยู่ครบ[br]ถ้าหน้าจอยังดูเหมือนเดิม กด Ctrl+F5 หนึ่งครั้ง"`,
    box('CLINIC_MSG_OK', 'Information'),
    'exit /b 0',
    ':done_not_up',
    `set "CLINIC_MSG_OK=อัปเดตไฟล์เสร็จแล้ว - รุ่น ${tag} - แต่ระบบยังไม่ตอบใน 5 วินาที[br][br]ลองเปิดจากไอคอน ${variant.title} บนหน้าจอ — ถ้ายังไม่ขึ้น แจ้งผู้ดูแล สำเนาของเดิมอยู่ที่ %BK%"`,
    box('CLINIC_MSG_OK', 'Warning'),
    'exit /b 0',
    '',
    ':donetest',
    'echo [โหมดทดสอบ] อัปเดตไฟล์เสร็จ — ข้ามการเปิดระบบและกล่องข้อความ',
    'exit /b 0',
    '',
    ':badzip',
    'set "CLINIC_MSG_FAIL=ไม่พบไฟล์โปรแกรมข้าง ๆ ตัวอัปเดต — มักเกิดจากเปิดไฟล์จากในหน้าต่าง ZIP โดยตรง[br][br]คลิกขวาไฟล์ ZIP → Extract All ให้เสร็จก่อน แล้วดับเบิลคลิกไฟล์นี้ในโฟลเดอร์ที่แตกออกมา"',
    'goto :fail',
    ':need_admin',
    'if "%ISADMIN%"=="1" (',
    '  set "CLINIC_MSG_FAIL=เขียนทับไฟล์โปรแกรมที่ %TARGET%\\app ไม่ได้ แม้เป็นผู้ดูแลเครื่องแล้ว — ยังไม่ได้แก้อะไร[br][br]แจ้งผู้ดูแลระบบ — ดู %LOG% ถ้ามี"',
    '  goto :fail',
    ')',
    'echo ต้องใช้สิทธิ์ผู้ดูแลเครื่องเพื่อเขียนทับไฟล์โปรแกรม — ชุดนี้ถูกติดตั้งด้วยสิทธิ์ผู้ดูแล — กำลังขอสิทธิ์...',
    'if "%TESTMODE%"=="1" (',
    '  echo [โหมดทดสอบ] ไม่มีสิทธิ์เขียน — ปกติจะเปิดหน้าต่างขอสิทธิ์ผู้ดูแล; ในโหมดทดสอบหยุดที่นี่ ยังไม่ได้แก้อะไร',
    '  exit /b 1',
    ')',
    'rem ส่ง path ผ่าน env (ไทย/ช่องว่างปลอดภัย) แล้วให้ PowerShell เปิดตัวเองใหม่แบบยกสิทธิ์ — หน้าต่างนี้ปิดตัว หน้าต่างใหม่ทำต่อทั้งหมด',
    'set "CLINIC_HOTFIX_CMD=%~f0"',
    'set "CLINIC_HOTFIX_TARGET=%TARGET%"',
    'set "CLINIC_MSG_OK=ชุดทดลองเครื่องนี้ถูกติดตั้งด้วยสิทธิ์ผู้ดูแลเครื่อง — ตัวอัปเดตต้องขอสิทธิ์เดียวกัน[br][br]กด OK แล้วกด Yes เมื่อ Windows ถาม จะมีหน้าต่างดำใหม่ทำต่อจนขึ้นกล่อง อัปเดตเสร็จแล้ว"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:CLINIC_MSG_OK.Replace(\'[br]\', [Environment]::NewLine), $env:CLINIC_MSG_TITLE, \'OK\', \'Information\'); $q = [char]34; Start-Process -FilePath cmd.exe -Verb RunAs -ArgumentList (\'/c \' + $q + $q + $env:CLINIC_HOTFIX_CMD + $q + \' \' + $q + $env:CLINIC_HOTFIX_TARGET + $q + $q)"',
    'if errorlevel 1 (',
    '  set "CLINIC_MSG_FAIL=ไม่ได้รับสิทธิ์ผู้ดูแลเครื่อง — กด No หรือถูกยกเลิก — ยังไม่ได้แก้อะไร[br][br]ลองใหม่: คลิกขวาไฟล์นี้ → Run as administrator"',
    '  goto :fail',
    ')',
    'exit /b 0',
    ':not_installed',
    `set "CLINIC_MSG_FAIL=ไม่พบ${variant.title}ที่ %TARGET%[br][br]ชุดนี้เป็น 'ตัวอัปเดตทับ' ใช้ได้เฉพาะเครื่องที่ติดตั้งไว้แล้ว ถ้าเครื่องนี้ยังไม่เคยลง ให้ใช้ ZIP ติดตั้งเต็มแทน — ยังไม่ได้แก้อะไร"`,
    'goto :fail',
    ':wrong_variant',
    `set "CLINIC_MSG_FAIL=โปรแกรมที่ %TARGET% ไม่ใช่${variant.title} — ตัวอัปเดตนี้ใช้กับชุดนั้นไม่ได้ ยังไม่ได้แก้อะไร"`,
    'goto :fail',
    ':journal_pending',
    'set "CLINIC_MSG_FAIL=เครื่องนี้มีการอัปเดตค้างอยู่[br][br]กรุณาปิดแล้วเปิดระบบคลินิกจากไอคอนหนึ่งครั้ง ให้ระบบจัดการให้เรียบร้อยก่อน แล้วค่อยดับเบิลคลิกไฟล์นี้ใหม่ — ยังไม่ได้แก้อะไร"',
    'goto :fail',
    ':zip_corrupt',
    'set "CLINIC_MSG_FAIL=ไฟล์ในชุดอัปเดตไม่ครบหรือไม่ตรงต้นฉบับ - ZIP อาจโหลดมาไม่สมบูรณ์[br][br]ลองโหลด ZIP ใหม่แล้วแตกไฟล์อีกครั้ง — ยังไม่ได้แก้อะไร"',
    'goto :fail',
    ':schema_mismatch',
    'set "CLINIC_MSG_FAIL=รุ่นบนเครื่องนี้กับชุดอัปเดตใช้ฐานข้อมูลคนละแบบ — อัปเดตทับไม่ได้ ยังไม่ได้แก้อะไร[br][br]ต้องใช้ ZIP ติดตั้งเต็ม: ปิดระบบ → ลบโฟลเดอร์เดิม → ลงใหม่"',
    'goto :fail',
    ':precheck_failed',
    'set "CLINIC_MSG_FAIL=ตรวจชุดอัปเดตกับเครื่องนี้ไม่ผ่าน - ดูข้อความในหน้าต่างดำ — ยังไม่ได้แก้อะไร"',
    'goto :fail',
    ':stop_failed',
    'set "CLINIC_MSG_FAIL=หยุดระบบที่เปิดอยู่ไม่สำเร็จ — ยังไม่ได้แก้อะไร[br][br]ปิดหน้าต่าง ClinicApp - หน้าต่างดำเล็ก ๆ - ด้วยตัวเอง แล้วดับเบิลคลิกไฟล์นี้ใหม่"',
    'goto :fail',
    ':backup_failed',
    'set "CLINIC_MSG_FAIL=สำรองโปรแกรม/ฐานข้อมูลเดิมไม่สำเร็จ จึงยังไม่อัปเดต — ยังไม่ได้แก้อะไร[br][br]เปิดระบบคลินิกตามปกติได้ แล้วแจ้งผู้ดูแล"',
    'goto :fail',
    ':copy_failed',
    'set "CLINIC_MSG_FAIL=คัดลอกไฟล์รุ่นใหม่ไม่สำเร็จ — โปรแกรมอาจอยู่คนละรุ่นครึ่ง ๆ กลาง ๆ[br][br]สาเหตุที่พบบ่อย: มีโปรแกรมเปิดไฟล์ในโฟลเดอร์ค้างอยู่ - ปิดหน้าต่าง ClinicApp หรือรอโปรแกรมป้องกันไวรัสสแกนเสร็จ แล้วลองใหม่[br]อย่าเพิ่งเปิดใช้ แจ้งผู้ดูแล: สำเนาของเดิมอยู่ที่ %BK% · รายละเอียดใน %LOG%"',
    'goto :fail',
    ':verify_failed',
    'set "CLINIC_MSG_FAIL=ตรวจไฟล์หลังคัดลอกไม่ผ่าน — โปรแกรมอาจอยู่คนละรุ่นครึ่ง ๆ กลาง ๆ[br][br]อย่าเพิ่งเปิดใช้ แจ้งผู้ดูแล: สำเนาของเดิมอยู่ที่ %BK%"',
    'goto :fail',
    ':fail',
    'echo.',
    'echo ** %CLINIC_MSG_FAIL%',
    'if "%TESTMODE%"=="1" exit /b 1',
    box('CLINIC_MSG_FAIL', 'Error'),
    'exit /b 1',
    '',
  ].join(CRLF);
}

// สคริปต์ตรวจ: precheck (variant ตรง + schema เท่ากัน + hash ไฟล์ในชุด) / verify (hash ไฟล์ที่ปลายทางหลังคัดลอก)
// exit code: 0 ผ่าน · 1 error ทั่วไป · 2 schema ไม่ตรง (ต้องใช้ตัวติดตั้งเต็ม) · 3 ไฟล์ในชุดไม่ครบ/hash ไม่ตรง · 4 hash ปลายทางไม่ตรง · 5 variant ไม่ตรง
function makeVerifyJs() { return [
  "'use strict';",
  '// ตรวจชุดอัปเดตทับ (hotfix) — รันด้วย runtime\\node.exe ของเครื่องปลายทาง ไม่ require lib/db.js (จึงไม่ trigger migration)',
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const crypto = require('node:crypto');",
  "const { DatabaseSync } = require('node:sqlite');",
  'const [mode, src, target] = process.argv.slice(2);',
  "if (!['precheck', 'verify'].includes(mode) || !src || !target) { console.error('ใช้: verify-hotfix.js precheck|verify <src> <target>'); process.exit(1); }",
  "const manifest = JSON.parse(fs.readFileSync(path.join(src, 'hotfix-manifest.json'), 'utf8'));",
  "const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');",
  'function checkFiles(root, code, label) {',
  '  let bad = 0;',
  '  for (const item of manifest.files) {',
  "    const full = path.join(root, ...item.file.split('/'));",
  "    if (!fs.existsSync(full)) { console.error(`${label}: ไม่พบ ${item.file}`); bad++; continue; }",
  "    if (sha256(full) !== item.sha256) { console.error(`${label}: hash ไม่ตรง ${item.file}`); bad++; }",
  '  }',
  '  if (bad) process.exit(code);',
  '}',
  "if (mode === 'precheck') {",
  '  let profile = null;',
  "  try { profile = JSON.parse(fs.readFileSync(path.join(target, 'update', 'install-profile.json'), 'utf8')); } catch {}",
  '  if (!profile || profile.variant !== manifest.variant) {',
  "    console.error(`ปลายทางเป็นชุด ${profile ? profile.variant : 'ไม่ทราบ'} แต่ชุดอัปเดตนี้สำหรับ ${manifest.variant}`);",
  '    process.exit(5);',
  '  }',
  "  checkFiles(src, 3, 'ชุดอัปเดต');",
  "  const dbFile = path.join(target, 'app', 'data', 'clinic.db');",
  '  if (fs.existsSync(dbFile)) {',
  '    const db = new DatabaseSync(dbFile, { readOnly: true });',
  '    let version;',
  "    try { version = db.prepare('PRAGMA user_version').get().user_version; } finally { db.close(); }",
  '    if (version !== manifest.schema_version) {',
  '      console.error(`schema บนเครื่อง = ${version} แต่ชุดอัปเดต = ${manifest.schema_version} — hotfix ใช้ได้เฉพาะรุ่นที่ schema เท่ากัน`);',
  '      process.exit(2);',
  '    }',
  '  }',
  '  console.log(`ตรวจชุดอัปเดต ${manifest.tag} ผ่าน (${manifest.files.length} ไฟล์, schema ${manifest.schema_version})`);',
  '} else {',
  "  checkFiles(target, 4, 'ปลายทาง');",
  '  console.log(`ตรวจไฟล์ปลายทางผ่าน (${manifest.files.length} ไฟล์)`);',
  '}',
  '',
].join(CRLF); }

function makeReadmeTxt(variant, tag) {
  const applyName = variant.trial ? APPLY_CMD : APPLY_CMD_PRODUCTION;
  return [
    `ชุดอัปเดต${variant.title} รุ่น ${tag} — "อัปเดตทับ" ไม่ต้องลบของเดิม ไม่ต้องลงใหม่`,
    '',
    'ใช้กับเครื่องที่ติดตั้งไว้แล้วเท่านั้น (ถ้าเครื่องยังไม่เคยลง ให้ใช้ ZIP ติดตั้งเต็ม)',
    'ข้อมูล การตั้งค่า ใบรับรอง HTTPS และการเชื่อมเครื่องห้องตรวจ อยู่ครบเหมือนเดิม — เครื่องห้องตรวจไม่ต้องทำอะไร',
    '',
    'ขั้นตอน (ทำที่เครื่องหน้าร้าน/เครื่องหลัก):',
    '  1. คลิกขวาไฟล์ ZIP → Extract All (แตกไฟล์ทั้งหมด) ให้เสร็จ — แตกไว้ที่ Desktop หรือ Downloads ก็ได้ **ไม่ต้อง**แตกลงใน C:\clinic-trial (ตัวอัปเดตจะก๊อปให้เอง)',
    `  2. เปิดโฟลเดอร์ที่แตกออกมา ดับเบิลคลิก "${applyName}"`,
    '     ถ้า Windows ขึ้นกล่องสีฟ้า SmartScreen → กด More info → Run anyway',
    '  3. ปล่อยให้ทำงานเอง ~10-30 วินาที: จะปิดระบบที่เปิดอยู่ให้ → สำรองของเดิม → คัดลอกรุ่นใหม่ → เปิดระบบใหม่',
    '  4. เห็นกล่อง "อัปเดตเสร็จแล้ว" = จบ · เข้าระบบตามปกติ (ถ้าหน้าจอยังเหมือนเดิม กด Ctrl+F5 หนึ่งครั้ง)',
    '',
    'ถ้าขึ้นกล่องสีแดง: อ่านข้อความในกล่อง — ทุกกรณีที่ขึ้นแดง ระบบยัง "ไม่ได้แก้อะไร" หรือมีสำเนาของเดิมอยู่ที่ update\\hotfix-backup\\ ให้ถ่ายภาพกล่องส่งผู้ดูแล',
    '',
    `สำเนาของเดิมเก็บไว้ที่ ${variant.target}\\update\\hotfix-backup\\${tag}\\ (โปรแกรมเดิม + clinic-before.db) — ลบทิ้งได้เมื่อใช้รุ่นใหม่จนพอใจ`,
    'รายการไฟล์ + SHA-256: hotfix-manifest.json',
    '',
  ].join(CRLF);
}

function buildHotfix(options = {}) {
  const variant = options.trial ? VARIANTS.trial : VARIANTS.production;
  const tag = String(options.buildTag || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(tag)) throw new Error('--build-tag จำเป็น (a-z 0-9 - ไม่เกิน 16 ตัว) เพื่อให้รู้ว่า hotfix นี้เท่ากับ ZIP เต็มรุ่นไหน');
  const outDir = path.resolve(options.out || path.join(REPO_ROOT, 'dist'));
  const packageName = variant.trial ? TRIAL_HOTFIX_PACKAGE_NAME : HOTFIX_PACKAGE_NAME;
  const applyName = variant.trial ? APPLY_CMD : APPLY_CMD_PRODUCTION;
  const packageRoot = path.join(outDir, packageName);
  if (packageRoot.toLowerCase().startsWith(APP_ROOT.toLowerCase() + path.sep)) throw new Error('ปลายทาง build ต้องอยู่นอกโฟลเดอร์ app');
  removeTreeSync(packageRoot);
  fs.mkdirSync(packageRoot, { recursive: true });

  const inventory = [];
  const appDir = path.join(packageRoot, 'app');
  for (const file of APP_FILES) copyFileVerified(path.join(APP_ROOT, file), path.join(appDir, file), inventory, path.join('app', file));
  for (const directory of APP_DIRECTORIES) copyDirectoryAllowlist(APP_ROOT, directory, appDir, inventory);
  for (const file of TOOL_FILES) copyFileVerified(path.join(APP_ROOT, file), path.join(appDir, file), inventory, path.join('app', file));
  if (variant.trial) for (const file of TRIAL_SEED_FILES) copyFileVerified(path.join(APP_ROOT, file), path.join(appDir, file), inventory, path.join('app', file));
  for (const file of DOCUMENT_FILES) {
    const source = path.join(REPO_ROOT, 'dist', file);
    if (fs.existsSync(source)) copyFileVerified(source, path.join(packageRoot, 'เอกสาร', file), inventory, path.join('เอกสาร', file));
  }
  const appVersion = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  const createdAt = new Date().toISOString();
  const stamp = createdAt.slice(0, 10).replace(/-/g, '') + tag;
  const manifest = {
    format: 1, kind: variant.trial ? 'clinic-trial-hotfix' : 'clinic-hotfix', variant: variant.trial ? 'trial' : 'production',
    tag: `${appVersion}-${stamp}`, installTarget: variant.target, port: variant.port, appVersion,
    schema_version: SCHEMA_VERSION, createdAt, nodeVersion: process.version, files: inventory,
  };
  const write = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(packageRoot, name)), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, name), content, { encoding: 'utf8', flag: 'wx' });
  };
  write(applyName, makeApplyCmd(variant, manifest.tag));
  write(path.join('scripts', 'verify-hotfix.js'), makeVerifyJs());
  write('อ่านก่อนอัปเดต.txt', makeReadmeTxt(variant, manifest.tag));
  write('hotfix-manifest.json', JSON.stringify(manifest, null, 2));

  // ตรวจความสะอาดอิสระจาก builder ของ installer: ห้ามมี data/runtime/กุญแจ/test และไฟล์ .cmd ต้องเป็น CRLF ล้วน
  const forbidden = /^(test-|codex-)|recovery-key|private|\.(db|db-wal|db-shm|enc|key)$/i;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'data' || entry.name === 'runtime') throw new Error(`โฟลเดอร์ต้องห้ามใน hotfix: ${path.relative(packageRoot, full)}`);
        walk(full);
      } else if (forbidden.test(entry.name)) throw new Error(`ไฟล์ต้องห้ามใน hotfix: ${path.relative(packageRoot, full)}`);
    }
  })(packageRoot);
  const cmdText = fs.readFileSync(path.join(packageRoot, applyName), 'utf8');
  if (/[^\r]\n/.test(cmdText)) throw new Error('ไฟล์ .cmd ต้องเป็น CRLF ทุกบรรทัด');
  if (!cmdText.includes('installed.marker') || !cmdText.includes('CLINIC_INSTALL_TEST')) throw new Error('.cmd ขาด guard/โหมดทดสอบ');
  if (/robocopy [^\r\n]*>nul/.test(cmdText) || !/robocopy [^\r\n]*\/R:2 \/W:2/.test(cmdText)) throw new Error('.cmd: robocopy ต้อง /R:2 /W:2 และลง log ไม่ใช่ >nul (บั๊กหน้างาน 2026-08-17 ค้างเงียบ)');
  if (!variant.trial && (cmdText.includes('--demo') || fs.existsSync(path.join(appDir, 'seed-mock-clinic.js')))) throw new Error('hotfix ชุดจริงมีของทดลองปน');

  let zipFile = null;
  if (!options.noZip) {
    zipFile = path.join(outDir, `${variant.zipPrefix}Hotfix-${appVersion}-${stamp}.zip`);
    if (fs.existsSync(zipFile)) { fs.unlinkSync(zipFile); if (fs.existsSync(zipFile)) throw new Error(`ลบ ZIP เดิมไม่ได้: ${zipFile}`); }
    writeZip(zipFile, packageRoot, packageName);
  }
  return { ok: true, packageRoot, packageName, zipFile, files: inventory.length, appVersion, tag: manifest.tag,
    schemaVersion: SCHEMA_VERSION, trial: variant.trial, installTarget: variant.target, applyCmd: applyName };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const tagIndex = args.indexOf('--build-tag');
  const result = buildHotfix({
    out: outIndex >= 0 ? args[outIndex + 1] : undefined,
    noZip: args.includes('--no-zip'),
    trial: args.includes('--trial'),
    buildTag: tagIndex >= 0 ? args[tagIndex + 1] : undefined,
  });
  console.log(`สร้างชุดอัปเดตทับแล้ว: ${result.packageRoot}`);
  console.log(`ไฟล์ ${result.files} รายการ · รุ่น ${result.tag} · schema ${result.schemaVersion} · ปลายทาง ${result.installTarget}`);
  console.log(result.zipFile ? `ZIP: ${result.zipFile}` : 'ZIP: ไม่ได้สร้าง');
}

module.exports = { buildHotfix, HOTFIX_PACKAGE_NAME, TRIAL_HOTFIX_PACKAGE_NAME, APPLY_CMD, APPLY_CMD_PRODUCTION };
