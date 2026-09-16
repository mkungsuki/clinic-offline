param([switch]$TestMode)
$ErrorActionPreference = 'Stop'
$test = $TestMode -or $env:CLINIC_INSTALL_TEST -eq '1'
$rootPath = $null
$toolPath = $null
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$workPath = Join-Path $tempBase ('clinic-sign-helper-' + [guid]::NewGuid().ToString('N'))
$progress = $null
$mutex = $null
$ownsMutex = $false
function Show-Result([string]$message, [bool]$ok) {
  if ($test) {
    if ($env:CLINIC_SIGN_TEST_REPORT) {
      @{ok=$ok;message=$message;testMode=$true} | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:CLINIC_SIGN_TEST_REPORT -Encoding UTF8
    }
    return
  }
  $icon = if ($ok) {'Information'} else {'Error'}
  [Windows.Forms.MessageBox]::Show($message, 'เตรียมรุ่นระบบคลินิก', 'OK', $icon) | Out-Null
}
function Invoke-OwnerTool([string]$action) {
  $suffix = if ($test) {' --test-mode'} else {''}
  $q = [char]34
  $outFile = Join-Path $workPath 'result.json'
  $errorFile = Join-Path $workPath 'tool-error.txt'
  $process = Start-Process -FilePath $script:nodePath -ArgumentList ('--no-warnings ' + $q + $toolPath + $q + ' --' + $action + $suffix) -WindowStyle Hidden -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errorFile
  while (-not $process.WaitForExit(100)) { if (-not $test) { [Windows.Forms.Application]::DoEvents() } }
  $result = Get-Content -LiteralPath $outFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $result.ok) { throw [string]$result.message }
  return $result
}
try {
  if (-not $test) { Add-Type -AssemblyName System.Windows.Forms }
  $rootValue = if ($env:CLINIC_SIGN_ROOT) { $env:CLINIC_SIGN_ROOT } else { Join-Path $PSScriptRoot '..\..' }
  $rootPath = [IO.Path]::GetFullPath(($rootValue -replace '"','').TrimEnd('\'))
  $toolPath = Join-Path $rootPath 'app\tools\owner-release.cjs'
  if (-not (Test-Path -LiteralPath $toolPath -PathType Leaf)) { throw 'ยังไม่พบชุดเครื่องมือครบ กรุณาเปิดปุ่มนี้จากโฟลเดอร์งานระบบคลินิก' }
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { throw 'ยังไม่พบตัวช่วยสร้างชุดโปรแกรม ให้ผู้ดูแลจัดเตรียมเครื่องนี้ก่อน' }
  $script:nodePath = $node.Source
  New-Item -ItemType Directory -Path $workPath | Out-Null
  $mutexName = 'Local\ClinicOwnerRelease-' + ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($rootPath))).Replace('-','').Substring(0,16))
  $mutex = New-Object Threading.Mutex($false,$mutexName)
  $ownsMutex = $mutex.WaitOne(0)
  if (-not $ownsMutex) { throw 'กำลังเตรียมรุ่นอยู่แล้ว กรุณารอหน้าต่างเดิม ไม่ต้องกดซ้ำ' }
  $plan = Invoke-OwnerTool 'plan'
  if ($test) { Show-Result ('ตรวจปุ่มสำเร็จ รุ่น ' + $plan.version + ' — ไม่เลือกกุญแจ ไม่เซ็น ไม่เผยแพร่') $true; exit 0 }
  $script:nodePath = Join-Path $rootPath ('app\' + [string]$plan.runtimeFile)
  if (-not (Test-Path -LiteralPath $script:nodePath -PathType Leaf)) { throw 'ยังไม่พบส่วนประกอบที่ตรวจแล้ว ให้ผู้ดูแลเตรียมชุดใหม่' }
  $picker = New-Object Windows.Forms.OpenFileDialog
  $picker.Title = 'เลือกรหัสกุญแจสำหรับเซ็นชุดอัปเดต (เก็บไว้นอกโฟลเดอร์งาน ไม่ต้องเปิดหรือคัดลอกเนื้อหา)'
  $picker.Filter = 'ไฟล์กุญแจ (*.pem)|*.pem|ไฟล์ทั้งหมด (*.*)|*.*'
  $picker.CheckFileExists = $true
  if ($picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { Show-Result 'ยกเลิกแล้ว ยังไม่ได้เซ็นหรือเผยแพร่รุ่น' $true; exit 0 }
  $env:CLINIC_OWNER_KEY_FILE = $picker.FileName
  $env:CLINIC_OWNER_SIGN_CONFIRM = '1'
  $picker.Dispose()
  $progress = New-Object Windows.Forms.Form
  $progress.Text = 'กำลังเตรียมรุ่น ' + $plan.version
  $progress.Width = 520; $progress.Height = 145; $progress.StartPosition = 'CenterScreen'; $progress.ControlBox = $false
  $label = New-Object Windows.Forms.Label
  $label.Text = 'กำลังสร้างและตรวจชุดใช้งานจริงกับชุดทดลอง กรุณารอ…'; $label.AutoSize = $false; $label.Dock = 'Fill'; $label.Padding = New-Object Windows.Forms.Padding(18)
  $progress.Controls.Add($label); $progress.Show(); [Windows.Forms.Application]::DoEvents()
  $result = Invoke-OwnerTool 'sign'
  $progress.Close(); $progress = $null
  Show-Result ('เตรียมรุ่น ' + $result.version + ' แล้ว' + [Environment]::NewLine + $result.message + [Environment]::NewLine + 'ไฟล์อยู่ที่: ' + $result.out) $true
  Start-Process -FilePath explorer.exe -ArgumentList ([char]34 + $result.out + [char]34) -WindowStyle Hidden
} catch {
  if ($progress) { $progress.Close(); $progress = $null }
  # Never show stderr or exception stacks from key-processing commands.
  $safe = if ($_.Exception.Message -match '^(ยัง|กำลัง|เลขรุ่น|ไฟล์ที่เลือก|สร้างชุด|ตรวจชุด|โหมดทดสอบ)') { $_.Exception.Message } else { 'ยังเตรียมรุ่นไม่ได้ กรุณาให้ผู้ดูแลตรวจเครื่องมือและพื้นที่ว่าง ไม่ต้องส่งกุญแจให้ใคร' }
  Show-Result $safe $false
  exit 1
} finally {
  Remove-Item Env:CLINIC_OWNER_KEY_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:CLINIC_OWNER_SIGN_CONFIRM -ErrorAction SilentlyContinue
  if ($ownsMutex -and $mutex) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
  $resolvedWork = [IO.Path]::GetFullPath($workPath)
  if ($resolvedWork.StartsWith($tempBase,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedWork -Leaf).StartsWith('clinic-sign-helper-')) {
    Remove-Item -LiteralPath $resolvedWork -Recurse -Force -ErrorAction SilentlyContinue
  }
}
