param([switch]$TestMode)
$ErrorActionPreference = 'Stop'
$started = $false
$test = $TestMode -or $env:CLINIC_RUNTIME_TEST -eq '1'
try {
  $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  if (-not (Test-Path -LiteralPath (Join-Path $root 'update\installed.marker'))) { throw 'กรุณาเปิดตัวช่วยจากระบบที่ติดตั้งแล้ว' }
  if ($test -and (-not $root.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath (Join-Path $root 'synthetic-runtime.marker')))) { throw 'Unsafe test root' }
  $node = [IO.Path]::GetFullPath(($env:CLINIC_RUNTIME_EXE -replace '"',''))
  if (-not $node.StartsWith((Join-Path $root 'app\vendor\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'ตำแหน่งส่วนประกอบไม่ถูกต้อง' }
  if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $env:CLINIC_RUNTIME_SHA) { throw 'ส่วนประกอบโปรแกรมตรวจไม่ผ่าน' }
  $logs = Join-Path $root 'logs'
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  Start-Transcript -LiteralPath (Join-Path $logs ('runtime-maintenance-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')) | Out-Null
  $started = $true
  if ($test) { & $node --version; exit $LASTEXITCODE }
  $env:CLINIC_RUNTIME_ELEVATED = '1'
  & $node --no-warnings (Join-Path $PSScriptRoot 'runtime-maintenance.js') $env:CLINIC_RUNTIME_PORT
  exit $LASTEXITCODE
} catch {
  if (-not $test) {
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show('อัปเดตส่วนประกอบไม่สำเร็จ กรุณาเปิดหน้าผู้ดูแลตรวจสถานะและแจ้งผู้ดูแล รายละเอียดอยู่ในโฟลเดอร์ logs','ระบบคลินิก','OK','Error') | Out-Null
  }
  exit 1
} finally { if ($started) { Stop-Transcript | Out-Null } }
