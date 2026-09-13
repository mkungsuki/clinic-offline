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
  if not exist "%APP_ROOT%\launch\supervisor.js" exit /b 4
  echo [โหมดทดสอบ] launcher พร้อมใช้ที่ port %CLINIC_PORT%
  exit /b 0
)
curl -s -m 2 -o nul http://127.0.0.1:%CLINIC_PORT%/api/recovery/ready
if not errorlevel 1 (
  echo ระบบคลินิกเปิดอยู่แล้ว กำลังเปิดหน้าเว็บให้...
  start http://localhost:%CLINIC_PORT%
  exit /b 0
)
echo กำลังเปิดระบบคลินิก...
rem เปิดผ่าน supervisor (launch\supervisor.js): server ตายโดยไม่ตั้งใจ = เปิดกลับเอง + จด log (incident 2026-08-24)
start "ClinicApp" /min "%INSTALL_ROOT%\runtime\node.exe" --no-warnings launch\supervisor.js
timeout /t 3 >nul
start http://localhost:%CLINIC_PORT%
exit /b 0
