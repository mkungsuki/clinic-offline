$ErrorActionPreference = 'Stop'
$transcriptStarted = $false
try {
  $target = ($env:CLINIC_SETUP_TARGET -replace '"','').TrimEnd('\')
  $setupCmd = ($env:CLINIC_SETUP_CMD -replace '"','')
  if (-not $target -or -not (Test-Path -LiteralPath $setupCmd)) { throw 'ไม่พบชุดติดตั้ง กรุณาแตก ZIP ใหม่' }
  if (Test-Path -LiteralPath (Join-Path $target 'app\data\clinic.db')) { throw 'มีฐานข้อมูลอยู่แล้ว ห้ามติดตั้งทับ ให้เปิดโปรแกรมเดิมแล้วใช้เมนูอัปเดต' }
  $logDir = Join-Path $target 'logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Transcript -Path (Join-Path $logDir 'install-elevated.log') -Append | Out-Null
  $transcriptStarted = $true
  $env:CLINIC_SETUP_ELEVATED = '1'
  $q = [char]34
  & $env:ComSpec /d /c ($q + $q + $setupCmd + $q + ' ' + $q + $target + $q + $q)
  if ($LASTEXITCODE -ne 0) { throw 'ติดตั้งไม่สำเร็จ กรุณาดูข้อความก่อนหน้าและไฟล์ logs ในโฟลเดอร์ติดตั้ง' }
} catch {
  if ($env:CLINIC_INSTALL_TEST -eq '1') { Write-Output $_.Exception.Message }
  else { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Clinic Offline', 'OK', 'Error') }
  exit 1
} finally { if ($transcriptStarted) { Stop-Transcript | Out-Null } }
