param([switch]$TestMode)
$ErrorActionPreference='Stop'
$test=$env:CLINIC_INSTALL_TEST -eq '1'
$transcribing=$false
$mutex=$null
$ownsMutex=$false
$resultCode=1
$safeMessage='ยังลบชุดทดลองไม่สำเร็จ การติดตั้งตัวจริงหยุดไว้ ข้อมูลที่ยังลบไม่ครบจะไม่ถูกนำไปใช้จริง กรุณากดติดตั้งอีกครั้งหรือติดต่อผู้ดูแล'
function Full([string]$value){[IO.Path]::GetFullPath(($value -replace '"','').TrimEnd('\'))}
function NoLinks([string]$dir){
 $item=Get-Item -LiteralPath $dir -Force
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'unsafe-link'}
 if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $dir -Force){NoLinks $child.FullName}}
}
function SaveState([string]$phase){
 $state.phase=$phase
 $text=$state | ConvertTo-Json -Compress
 [IO.File]::WriteAllText($stateFile+'.new',$text,(New-Object Text.UTF8Encoding($false)))
 Move-Item -LiteralPath ($stateFile+'.new') -Destination $stateFile -Force
}
function Tell([string]$message,[bool]$ok){
 if($test){Write-Output $(if($ok){'TRANSITION OK'}else{'TRANSITION STOP'});return}
 $icon=if($ok){'Information'}else{'Warning'}
 [Windows.Forms.MessageBox]::Show($message,'จากชุดทดลองไปใช้งานจริง','OK',$icon) | Out-Null
}
try {
 if($TestMode -and -not $test){throw 'test-requires-env'}
 if($test -and -not $env:CLINIC_TRANSITION_TEST_ROOT){exit 0} # ordinary installer tests never inspect a real installation
 if(-not $test){Add-Type -AssemblyName System.Windows.Forms}
 if($test){
  $sandbox=Full $env:CLINIC_TRANSITION_TEST_ROOT
  $tempBase=(Full ([IO.Path]::GetTempPath()))+'\'
  if(-not $sandbox.StartsWith($tempBase,[StringComparison]::OrdinalIgnoreCase)){throw 'outside-test-temp'}
  if([IO.File]::ReadAllText((Join-Path $sandbox 'transition-test.marker')) -ne 'synthetic-transition-only'){throw 'missing-test-marker'}
  NoLinks $sandbox
  $trial=Join-Path $sandbox 'ชุดทดลอง'
  $shortcutFolders=@((Join-Path $sandbox 'Desktop'),(Join-Path $sandbox 'Startup'))
 }else{
  $trial='C:\clinic-trial'
  $shortcutFolders=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Startup'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('CommonStartup'))
 }
 $target=Full $env:CLINIC_TRANSITION_TARGET
 if($test -and -not $target.StartsWith($sandbox+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'outside-test-target'}
 $trial=Full $trial
 if($target -eq $trial -or $target.StartsWith($trial+'\',[StringComparison]::OrdinalIgnoreCase) -or $trial.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'overlapping-targets'}
 if(Test-Path -LiteralPath (Join-Path $target 'app\data\clinic.db')){throw 'live-database-exists'}
 # Reject reparse points in every existing ancestor, not only the leaf.
 foreach($candidate in @($trial,$target)){$parent=$candidate;while($parent){if(Test-Path -LiteralPath $parent){if((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'unsafe-parent'}};$parent=Split-Path $parent -Parent}}
 if(Test-Path -LiteralPath $target){NoLinks $target}
 $stateFile=Join-Path $target 'logs\trial-removal.json'
 if(-not (Test-Path -LiteralPath $trial) -and -not (Test-Path -LiteralPath $stateFile)){exit 0}
 $mutex=New-Object Threading.Mutex($false,('Local\ClinicTrialRemoval-'+[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($trial))).Replace('-','')))
 $ownsMutex=$mutex.WaitOne(0)
 if(-not $ownsMutex){$safeMessage='กำลังจัดการชุดทดลองอยู่แล้ว กรุณารอหน้าต่างเดิม';throw 'busy'}
 $state=$null
 if(Test-Path -LiteralPath $stateFile){
  $state=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if($state.original -ne $trial -or (Split-Path $state.cleanup -Parent) -ne (Split-Path $trial -Parent) -or (Split-Path $state.cleanup -Leaf) -notmatch '^clinic-trial-removing-[0-9a-f]{32}$'){throw 'invalid-journal'}
  if($state.phase -eq 'complete' -and -not (Test-Path -LiteralPath $trial)){exit 0}
  if((Test-Path -LiteralPath $trial) -and (Test-Path -LiteralPath $state.cleanup)){throw 'two-trial-directories'}
 }
 if(Test-Path -LiteralPath $trial){
  NoLinks $trial
  if(-not (Test-Path -LiteralPath (Join-Path $trial 'update\installed.marker') -PathType Leaf)){throw 'not-installed'}
  $profile=Get-Content -LiteralPath (Join-Path $trial 'update\install-profile.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if($profile.product -ne 'clinic-offline' -or $profile.variant -ne 'trial'){throw 'not-trial'}
  $probe=Join-Path $trial ('write-check-'+[guid]::NewGuid().ToString('N')+'.tmp')
  try{[IO.File]::WriteAllText($probe,'');Remove-Item -LiteralPath $probe -Force}catch{$resultCode=5;throw 'need-admin'}
  $state=[pscustomobject]@{original=$trial;cleanup=(Join-Path (Split-Path $trial -Parent) ('clinic-trial-removing-'+[guid]::NewGuid().ToString('N')));phase='confirmed'}
 }elseif($state -and (Test-Path -LiteralPath $state.cleanup)){NoLinks $state.cleanup}
 $logDir=Join-Path $target 'logs'
 try{New-Item -ItemType Directory -Path $logDir -Force | Out-Null;Start-Transcript -LiteralPath (Join-Path $logDir ('trial-removal-'+[guid]::NewGuid().ToString('N')+'.log')) | Out-Null;$transcribing=$true}catch{$resultCode=5;throw 'need-admin'}
 if((Test-Path -LiteralPath $trial) -or (Test-Path -LiteralPath $state.cleanup)){
  $message="พบชุดทดลองเดิม`n`nลบชุดทดลองและข้อมูลทั้งหมดที่เคยกรอกในชุดนั้นอย่างถาวร แล้วติดตั้งตัวจริงต่อหรือไม่?`nข้อมูลฝึกจะไม่ย้ายไปตัวจริง ตัวจริงจะเริ่มฐานใหม่`n`nหากมีข้อมูลที่ต้องเก็บ หรือเคยใส่ข้อมูลคนไข้จริงในชุดทดลอง ให้กด ไม่ใช่ เพื่อหยุดก่อน`n`nใช่ = ลบทั้งหมดแล้วติดตั้งตัวจริงต่อ`nไม่ใช่ = ยกเลิก ไม่ลบข้อมูลที่เหลือ"
  $confirmed=if($test){$env:CLINIC_TRANSITION_TEST_CONFIRM -eq 'yes'}else{[Windows.Forms.MessageBox]::Show($message,'ลบชุดทดลองก่อนเริ่มใช้จริง','YesNo','Warning','Button2') -eq 'Yes'}
  if(-not $confirmed){$resultCode=2;Tell 'ยกเลิกแล้ว ยังไม่ติดตั้งตัวจริง และไม่ได้ลบข้อมูลเพิ่มเติม' $false;exit 2}
 }
 SaveState 'confirmed'
 if(Test-Path -LiteralPath $trial){
  # Stop only processes using the dedicated runtime inside this verified trial installation.
  $runtime=Full (Join-Path $trial 'runtime\node.exe')
  $owned=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {$_.ExecutablePath -and (Full $_.ExecutablePath) -eq $runtime} | Sort-Object @{Expression={if($_.CommandLine -match 'supervisor\.js'){0}else{1}}})
  foreach($process in $owned){Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue}
  foreach($process in $owned){Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue}
  NoLinks $trial
  # The exact destination was chosen above under the same verified parent; no shell path expansion.
  if((Split-Path $state.cleanup -Parent) -ne (Split-Path $trial -Parent)){throw 'bad-cleanup-parent'}
  Move-Item -LiteralPath $trial -Destination $state.cleanup
 }
 SaveState 'deleting'
 if($test -and $env:CLINIC_TRANSITION_TEST_FAIL -eq 'after-rename'){throw 'injected-after-rename'}
 . (Join-Path $PSScriptRoot 'windows-shortcuts.ps1')
 foreach($folder in $shortcutFolders | Select-Object -Unique){if($folder -and (Test-Path -LiteralPath $folder)){
  foreach($link in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File){
   if($link.Attributes -band [IO.FileAttributes]::ReparsePoint){continue}
   try{$destination=[ClinicUnicodeShortcut]::Target($link.FullName)}catch{continue} # unrelated broken links must not block removal
   if($destination -and ((Full $destination) -eq $trial -or (Full $destination).StartsWith($trial+'\',[StringComparison]::OrdinalIgnoreCase))){Remove-Item -LiteralPath $link.FullName -Force}
  }
 }}
 if(Test-Path -LiteralPath $state.cleanup){
  if((Split-Path $state.cleanup -Parent) -ne (Split-Path $trial -Parent) -or (Split-Path $state.cleanup -Leaf) -notmatch '^clinic-trial-removing-[0-9a-f]{32}$'){throw 'unsafe-delete'}
  NoLinks $state.cleanup
  Remove-Item -LiteralPath $state.cleanup -Recurse -Force
 }
 if(-not $test){
  foreach($name in @('Clinic Trial - Doctor computer (HTTPS 8444)','Clinic Trial - Doctor computer (TCP 8081)')){
   Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
  }
 }
 if($test -and $env:CLINIC_TRANSITION_TEST_FAIL -eq 'after-delete'){throw 'injected-after-delete'}
 SaveState 'complete'
 Tell 'ลบชุดทดลองและข้อมูลฝึกทั้งหมดแล้ว ต่อไปจะติดตั้งตัวจริงและเริ่มข้อมูลใหม่ กรุณาปิดแท็บทดลองเดิม และใช้ไอคอน ระบบคลินิก สำหรับงานจริง' $true
 $resultCode=0
}catch{
  # Do not print arbitrary exception text or file names from the removed data tree.
 if($_.Exception -is [UnauthorizedAccessException] -or $_.CategoryInfo.Category -eq 'PermissionDenied'){$resultCode=5;$safeMessage='ต้องขอสิทธิ์ Windows เพื่อจัดการชุดทดลอง กรุณาอนุญาตหน้าต่างขอสิทธิ์ของตัวติดตั้งเพื่อทำต่อ'}
 Tell $safeMessage $false
}finally{
 if($transcribing){Stop-Transcript | Out-Null}
 if($ownsMutex -and $mutex){$mutex.ReleaseMutex()}
 if($mutex){$mutex.Dispose()}
}
exit $resultCode
