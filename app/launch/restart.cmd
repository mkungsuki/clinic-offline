@echo off
chcp 65001 >nul
setlocal EnableExtensions
if not defined CLINIC_PORT set "CLINIC_PORT=8080"
for %%I in ("%~dp0..") do set "APP_ROOT=%%~fI"
for %%I in ("%APP_ROOT%\..") do set "INSTALL_ROOT=%%~fI"
cd /d "%APP_ROOT%"
if "%CLINIC_INSTALL_TEST%"=="1" (
  if not exist "%INSTALL_ROOT%\runtime\node.exe" exit /b 2
  if not exist "%APP_ROOT%\server.js" exit /b 3
  echo [โหมดทดสอบ] restart launcher พร้อมใช้ที่ port %CLINIC_PORT%
  exit /b 0
)
echo กำลังสั่งให้ระบบเดิมหยุดอย่างปลอดภัย...
set "CONTROL_TOKEN="
if exist "data\recovery-control.token" set /p CONTROL_TOKEN=<data\recovery-control.token
curl -s -m 5 -o nul -w "%%{http_code}" -X POST http://127.0.0.1:%CLINIC_PORT%/api/system/prepare-restore -H "X-Recovery-Control: %CONTROL_TOKEN%" > "%TEMP%\clinic_stop.txt" 2>nul
set /p STOP_CODE=<"%TEMP%\clinic_stop.txt"
del "%TEMP%\clinic_stop.txt" 2>nul
set "CONTROL_TOKEN="
rem ไม่มีระบบเดิมทำงานอยู่ (curl ต่อไม่ได้ = 000) → เปิดใหม่ได้เลย — ก่อนหน้านี้ผู้ใช้ปิดหน้าต่างโปรแกรมแล้วกดรีสตาร์ท จะถูกปฏิเสธจนเปิดไม่ได้ (พบ 2026-08-19 ตอนซ้อมอัปเดต)
if "%STOP_CODE%"=="000" goto :notrunning
if "%STOP_CODE%"=="" goto :notrunning
if not "%STOP_CODE%"=="200" (
  echo ** หยุดระบบเดิมไม่สำเร็จ ^(รหัส %STOP_CODE%^) — ยังไม่เปิดตัวใหม่เพื่อความปลอดภัย
  pause
  exit /b 1
)
set /a TRIES=0
:waitdown
timeout /t 1 >nul
curl -s -m 2 -o nul http://127.0.0.1:%CLINIC_PORT%/api/recovery/ready
if not errorlevel 1 (
  set /a TRIES+=1
  if %TRIES% GEQ 20 (
    echo ** ระบบเดิมยังไม่ปิดสนิทหลังรอ 20 วินาที ยกเลิกการเปิดใหม่
    pause
    exit /b 1
  )
  goto waitdown
)
call "%~dp0open.cmd"
exit /b 0
:notrunning
curl -s -m 2 -o nul http://127.0.0.1:%CLINIC_PORT%/api/recovery/ready
if not errorlevel 1 (
  echo ** ระบบเดิมยังทำงานอยู่แต่ไม่รับคำสั่งหยุด — ปิดหน้าต่างโปรแกรมเดิมก่อน แล้วกดเปิดระบบคลินิกใหม่
  pause
  exit /b 1
)
echo ไม่มีระบบเดิมทำงานอยู่ — เปิดใหม่เลย
call "%~dp0open.cmd"
