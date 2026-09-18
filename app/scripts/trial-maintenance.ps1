param([switch]$TestMode)
$ErrorActionPreference='Stop'
$test=$TestMode -and $env:CLINIC_INSTALL_TEST -eq '1' -and $env:CLINIC_TEST_INSTANCE_TOKEN
. (Join-Path $PSScriptRoot 'windows-shortcuts.ps1')
$progress=$null;$progressLabel=$null
function Progress([string]$text){if($test){return};if(-not $script:progress){$script:progress=New-Object Windows.Forms.Form;$script:progress.Text='จัดการชุดทดลอง';$script:progress.Width=580;$script:progress.Height=180;$script:progress.StartPosition='CenterScreen';$script:progress.ControlBox=$false;$script:progress.Font=New-Object Drawing.Font('Segoe UI',12);$script:progressLabel=New-Object Windows.Forms.Label;$script:progressLabel.Dock='Fill';$script:progressLabel.Padding=New-Object Windows.Forms.Padding(20);$script:progress.Controls.Add($script:progressLabel);$script:progress.Show()};$script:progressLabel.Text=$text;[Windows.Forms.Application]::DoEvents()}
do {
$retry=$false
$mutex=$null;$owns=$false;$lockOwned=$false;$transcript=$false;$code=1
function Full([string]$p){[IO.Path]::GetFullPath(($p -replace '"','').TrimEnd('\'))}
function Parents([string]$p,[switch]$AllowCloud){while($p){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){if(-not ($AllowCloud -and [ClinicCloudTag]::IsCloud($p))){throw 'linked-parent'}};$p=Split-Path $p -Parent}}
function NoLinks([string]$p,[switch]$AllowCloud){if($progress){[Windows.Forms.Application]::DoEvents()};Parents $p -AllowCloud:$AllowCloud;if(Test-Path -LiteralPath $p){$item=Get-Item -LiteralPath $p -Force;if($item.PSIsContainer){foreach($child in Get-ChildItem -LiteralPath $p -Force){NoLinks $child.FullName -AllowCloud:$AllowCloud}}}}
function Save([string]$phase){$state.phase=$phase;[IO.File]::WriteAllText($stateFile+'.new',($state|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)));Move-Item -LiteralPath ($stateFile+'.new') -Destination $stateFile -Force}
function Tell([string]$message,[bool]$ok){
 if($progress){$progress.Hide()}
 if($stateFile){$resultPath=Join-Path $PSScriptRoot 'ผลการจัดการ.txt';Parents $resultPath;[IO.File]::WriteAllText($resultPath,$message,(New-Object Text.UTF8Encoding($true)))}
 if($test){Write-Output $(if($ok){'TRIAL OK'}else{'TRIAL STOP'});return}
 [Windows.Forms.MessageBox]::Show($message,'จัดการชุดทดลอง','OK',$(if($ok){'Information'}else{'Warning'}))|Out-Null
}
function Fault([string]$phase){if($test -and $env:CLINIC_TRIAL_TOOLS_FAIL -eq $phase){throw 'synthetic-failure'};if($test -and $env:CLINIC_TRIAL_TOOLS_KILL -eq $phase){Stop-Process -Id $PID -Force}}
function DeleteScoped([string]$p,[string]$parent,[string]$leaf,[switch]$AllowCloud){
 $p=Full $p;if((Split-Path $p -Parent) -ne (Full $parent) -or (Split-Path $p -Leaf) -ne $leaf){throw 'unsafe-delete'}
 NoLinks $p -AllowCloud:$AllowCloud;if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Recurse -Force}
}
function Installed([string]$p){
 NoLinks $p
 if(-not (Test-Path -LiteralPath (Join-Path $p 'update\installed.marker') -PathType Leaf)){throw 'not-installed'}
 $profile=Get-Content -LiteralPath (Join-Path $p 'update\install-profile.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($profile.product -ne 'clinic-offline' -or $profile.variant -ne 'trial'){throw 'not-trial'}
}
function StopTrial {
 $executables=@((Join-Path $root 'runtime\node.exe'))
 $vendor=Join-Path $root 'app\vendor'
 if(Test-Path -LiteralPath $vendor){$executables+=@(Get-ChildItem -LiteralPath $vendor -Filter 'node-v*-win-x64.exe' -File|ForEach-Object {$_.FullName})}
 $processes=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $executables -contains $_.ExecutablePath}|Sort-Object @{Expression={if($_.CommandLine -match 'supervisor\.js'){0}else{1}}})
 foreach($p in $processes){Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue}
 foreach($p in $processes){Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction SilentlyContinue}
 if(@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $executables -contains $_.ExecutablePath}).Count){throw 'still-running'}
}
try {
 if($TestMode -and -not $test){throw 'test-env-required'}
 if(-not $test){Add-Type -AssemblyName System.Windows.Forms}
 $dir=Full $PSScriptRoot;NoLinks $dir
 $request=Get-Content -LiteralPath (Join-Path $dir 'request.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($env:CLINIC_TRIAL_LAUNCH_NONCE -match '^[0-9a-f-]{36}$'){[IO.File]::WriteAllText((Join-Path $dir ('started-'+$env:CLINIC_TRIAL_LAUNCH_NONCE+'.txt')),'started')}
 $id=[string]$request.id;$action=[string]$request.action;$root=Full $request.root
 if($id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or $action -notin @('reset','uninstall')){throw 'invalid-request'}
 if($test){
  $sandbox=Full $env:CLINIC_TRIAL_TOOLS_TEST_ROOT;Parents $sandbox
  if(-not $sandbox.StartsWith((Full ([IO.Path]::GetTempPath()))+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.File]::ReadAllText((Join-Path $sandbox 'trial-tools-test.marker')) -ne 'synthetic-trial-tools-only'){throw 'unsafe-test'}
  if($root -ne (Join-Path $sandbox 'ชุดทดลอง') -or $dir -ne (Join-Path $sandbox ('เครื่องมือ\'+$id))){throw 'unsafe-test-target'}
  $shortcutFolders=@((Join-Path $sandbox 'Desktop'),(Join-Path $sandbox 'Startup'))
 }else{
  if($root -ne 'C:\clinic-trial' -or $dir -ne (Join-Path $env:LOCALAPPDATA ('ClinicOffline\TrialMaintenance\'+$id))){throw 'unsafe-root'}
  $shortcutFolders=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Startup'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('CommonStartup'))
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
   $env:CLINIC_TRIAL_ELEVATED_SCRIPT=$PSCommandPath
   $q=[char]34;$arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File '+$q+$env:CLINIC_TRIAL_ELEVATED_SCRIPT+$q
   try{$child=Start-Process -FilePath powershell.exe -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru;exit $child.ExitCode}catch{Tell 'ยกเลิกคำขอสิทธิ์ Windows แล้ว ยังไม่ได้เปลี่ยนข้อมูลในรอบนี้' $false;exit 2}
  }
 }
 Parents $root
 $stateFile=Join-Path $dir 'state.json'
 $old=Join-Path (Split-Path $root -Parent) ('clinic-trial-removing-'+$id)
 $app=Join-Path $root 'app';$data=Join-Path $app 'data'
 $fresh=Join-Path $app ('trial-reset-new-'+$id);$retired=Join-Path $app ('trial-reset-old-'+$id)
 $state=[pscustomobject]@{id=$id;action=$action;phase='new';certThumbprint=''}
 if(Test-Path -LiteralPath $stateFile){$state=Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8|ConvertFrom-Json;if($state.id -ne $id -or $state.action -ne $action){throw 'wrong-journal'}}
 $phases=if($action -eq 'reset'){@('new','confirmed','prepared','swapped','cleaned','complete','cancelled')}else{@('new','confirmed','deleting','cleaned','complete','cancelled')}
 if($state.phase -notin $phases){throw 'invalid-phase'}
 $mutex=New-Object Threading.Mutex($false,('Local\ClinicTrialRemoval-'+[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-','')))
 try{$owns=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$owns=$true}
 if(-not $owns){Tell 'กำลังจัดการชุดทดลองอยู่แล้ว กรุณารอหน้าต่างเดิม' $false;exit 3}
 if($state.phase -eq 'complete'){Tell 'คำสั่งรอบนี้ทำเสร็จแล้ว ไม่ได้ลบหรือเริ่มข้อมูลใหม่ซ้ำ' $true;exit 0}
 if($state.phase -eq 'cancelled'){Tell 'คำสั่งรอบนี้ยกเลิกแล้ว หากต้องการทำใหม่ให้กลับไปกดปุ่มในโปรแกรม' $false;exit 2}
 if(Test-Path -LiteralPath $root){Installed $root}elseif($action -ne 'uninstall' -or $state.phase -notin @('confirmed','deleting','cleaned')){throw 'missing-install'}
 if((Test-Path -LiteralPath $old) -and (Test-Path -LiteralPath $root)){throw 'two-installs'}
 # A second operation must not strand a half-finished reset/removal from a different request.
 foreach($other in Get-ChildItem -LiteralPath (Split-Path $dir -Parent) -Directory){
  $otherState=Join-Path $other.FullName 'state.json';Parents $otherState
  if($other.FullName -ne $dir -and (Test-Path -LiteralPath $otherState)){$s=Get-Content -LiteralPath $otherState -Raw|ConvertFrom-Json;if($s.phase -notin @('new','cancelled','complete')){Tell ('มีงานเดิมค้างอยู่ กรุณาเปิด ทำต่อ.cmd ในโฟลเดอร์ '+$other.FullName) $false;exit 3}}
 }
 Start-Transcript -LiteralPath (Join-Path $dir 'การทำงาน.log') -Append|Out-Null;$transcript=$true
 if($state.phase -eq 'new'){
  $description=if($action -eq 'reset'){'เริ่มฝึกใหม่: ลบข้อมูลฝึก บัญชี การตั้งค่า และสำเนาที่เก็บในชุดทดลอง แล้วสร้างข้อมูลตัวอย่างเหมือนตอนติดตั้งใหม่ โปรแกรมและการเชื่อมเครื่องหมอยังอยู่'}else{'ถอนชุดทดลอง: ลบโปรแกรมทดลอง ข้อมูลฝึก และสำเนาในชุดทดลองทั้งหมด พร้อมทางลัดและการเชื่อมต่อของชุดทดลองบนเครื่องนี้'}
  $message=$description+"`n`nย้อนกลับไม่ได้ หากเคยใส่ข้อมูลคนไข้จริงหรือต้องเก็บงาน ให้กด ไม่ใช่ ก่อน`nกรุณาให้ทุกเครื่องหยุดใช้งานชุดทดลอง`n`nไม่ลบไฟล์ที่ส่งออกไป USB/คลาวด์ โฟลเดอร์ ZIP ที่ดาวน์โหลด หรือไฟล์บนคอมเครื่องอื่น`n`nใช่ = ดำเนินการ   ไม่ใช่ = ยกเลิก"
  $yes=if($test){$env:CLINIC_TRIAL_TOOLS_CONFIRM -eq 'yes'}else{[Windows.Forms.MessageBox]::Show($message,'ยืนยันจัดการชุดทดลอง','YesNo','Warning','Button2') -eq 'Yes'}
  if(-not $yes){Save 'cancelled';Tell 'ยกเลิกแล้ว ข้อมูลฝึกและโปรแกรมยังอยู่ตามเดิม' $false;exit 2}
  # Probe both root and parent before stopping anything. No raw errors/data paths are logged.
  foreach($p in @($root,(Split-Path $root -Parent))){$probe=Join-Path $p ('trial-write-'+$id+'.tmp');[IO.File]::WriteAllText($probe,'');Remove-Item -LiteralPath $probe -Force}
  $cer=Join-Path $root 'cert\clinic.cer'
  if(Test-Path -LiteralPath $cer){$publicCert=New-Object Security.Cryptography.X509Certificates.X509Certificate2($cer);$state.certThumbprint=$publicCert.Thumbprint;$publicCert.Dispose()}
  Save 'confirmed'
 }
 Progress 'กำลังเตรียมจัดการชุดทดลอง กรุณารอจนมีข้อความแจ้งผล'
 $lock=Join-Path $root 'update\apply.lock'
 if(Test-Path -LiteralPath $root){
  if(Test-Path -LiteralPath $lock){$holder=Get-Content -LiteralPath $lock -Raw|ConvertFrom-Json;if(Get-Process -Id $holder.pid -ErrorAction SilentlyContinue){throw 'update-running'};Remove-Item -LiteralPath $lock -Force}
  $stream=[IO.File]::Open($lock,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$b=[Text.Encoding]::UTF8.GetBytes(('{"pid":'+$PID+'}'));$stream.Write($b,0,$b.Length);$stream.Flush($true)}finally{$stream.Dispose()};$lockOwned=$true
  foreach($name in @('active-journal.json','active-journal.json.previous')){$j=Join-Path $root ('update\'+$name);if(Test-Path -LiteralPath $j){$v=Get-Content -LiteralPath $j -Raw|ConvertFrom-Json;if($v.state -notin @('committed','rolled-back')){throw 'update-pending'}}}
 }
 if($action -eq 'reset'){
  if($state.phase -eq 'confirmed'){
   DeleteScoped $fresh $app ('trial-reset-new-'+$id)
   New-Item -ItemType Directory -Path $fresh|Out-Null
   $env:CLINIC_DATA_DIR=$fresh
   foreach($script in @('seed.js','seed-mock-clinic.js','scripts\trial-reset-verify.js')){
    $args=@('--no-warnings',(Join-Path $app $script));if($script -eq 'seed.js'){$args+='--demo'}
    & (Join-Path $root 'runtime\node.exe') @args *> $null
    if($LASTEXITCODE -ne 0){throw 'seed-failed'}
   }
   [IO.File]::WriteAllText((Join-Path $fresh '.trial-reset-id'),$id)
   Save 'prepared';Fault 'prepared'
  }
  $pending=Join-Path $root 'update\trial-maintenance-pending.json'
  [IO.File]::WriteAllText($pending,('{"operation":"'+$id+'"}'))
  StopTrial;NoLinks $app
  if($state.phase -in @('swapped','cleaned') -and [IO.File]::ReadAllText((Join-Path $data '.trial-reset-id')) -ne $id){throw 'wrong-reset-data'}
  if($state.phase -eq 'prepared'){
   if(-not (Test-Path -LiteralPath $retired)){
    if(-not (Test-Path -LiteralPath $fresh)){throw 'missing-prepared'}
    Move-Item -LiteralPath $data -Destination $retired
   }
   Fault 'after-retire'
   if(-not (Test-Path -LiteralPath $data)){Move-Item -LiteralPath $fresh -Destination $data}
   if([IO.File]::ReadAllText((Join-Path $data '.trial-reset-id')) -ne $id){throw 'wrong-reset-data'}
   Save 'swapped';Fault 'after-swap'
  }
  DeleteScoped $retired $app ('trial-reset-old-'+$id)
  Save 'cleaned';Fault 'after-delete'
  Remove-Item -LiteralPath $pending -Force
  # Never start the server elevated. Existing launcher restores its own port/data environment.
  if(-not $test){Start-Process -FilePath explorer.exe -ArgumentList (([char]34)+(Join-Path $root 'เปิดระบบคลินิก.cmd')+([char]34)) -WindowStyle Hidden|Out-Null}
  Save 'complete'
  Tell "เริ่มฝึกใหม่เรียบร้อยแล้ว ให้ปิดแท็บเก่าและเปิดระบบคลินิก (ทดลอง) อีกครั้ง`nผู้ดูแล: admin / admin1234`nหมอ: doctor / doctor123`nหน้าร้าน: front / front123`n`nข้อมูลฝึกและการตั้งค่าเดิมในชุดทดลองถูกลบแล้ว" $true
 }else{
  if(Test-Path -LiteralPath $root){StopTrial;NoLinks $root;Move-Item -LiteralPath $root -Destination $old}
  Progress 'กำลังถอนชุดทดลอง: ลบทางลัดและการเชื่อมต่อ'
  Save 'deleting';Fault 'after-rename'
  . (Join-Path $dir 'windows-shortcuts.ps1')
  foreach($folder in $shortcutFolders|Select-Object -Unique){if($folder -and (Test-Path -LiteralPath $folder)){
   Parents $folder -AllowCloud
   foreach($link in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File){
    if(($link.Attributes -band [IO.FileAttributes]::ReparsePoint) -and -not [ClinicCloudTag]::IsCloud($link.FullName)){continue}
    try{$destination=[ClinicUnicodeShortcut]::Target($link.FullName)}catch{continue}
    if($destination -and ((Full $destination) -eq $root -or (Full $destination).StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase))){Remove-Item -LiteralPath $link.FullName -Force}
   }
  }}
  # Remove the default handoff folder only when its public certificate proves ownership
  # and it contains exactly our known files. Custom folders/extra user files are left alone.
  foreach($desktop in $shortcutFolders|Select-Object -Unique){if($desktop){
   $doctorFolder=Join-Path $desktop 'ส่งไปเครื่องหมอ (ทดลอง)'
   $doctorCer=Join-Path $doctorFolder 'clinic.cer'
   if(Test-Path -LiteralPath $doctorCer){
    NoLinks $doctorFolder -AllowCloud
    $allowed=@('clinic.cer','ติดตั้งใบรับรอง (เครื่องห้องตรวจ).cmd','เปิดระบบคลินิก (ห้องหมอ ทดลอง).url','อ่านก่อนเปิด.txt')
    $files=@(Get-ChildItem -LiteralPath $doctorFolder -Force)
    $publicDoctorCert=New-Object Security.Cryptography.X509Certificates.X509Certificate2($doctorCer)
    $same=$publicDoctorCert.Thumbprint -eq $state.certThumbprint;$publicDoctorCert.Dispose()
    if($same -and @($files|Where-Object {$_.PSIsContainer -or $_.Name -notin $allowed}).Count -eq 0){DeleteScoped $doctorFolder $desktop 'ส่งไปเครื่องหมอ (ทดลอง)' -AllowCloud}
   }
  }}
  if(-not $test){
   foreach($name in @('Clinic Trial - Doctor computer (HTTPS 8444)','Clinic Trial - Doctor computer (TCP 8081)')){Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue|Remove-NetFirewallRule -ErrorAction Stop}
   # Thumbprint was obtained from the public .cer only. Never open the private PFX/key.
   if($state.certThumbprint -match '^[0-9A-F]{40}$'){foreach($store in @('Cert:\CurrentUser\Root','Cert:\LocalMachine\Root')){$certPath=Join-Path $store $state.certThumbprint;if(Test-Path -LiteralPath $certPath){Remove-Item -LiteralPath $certPath -Force}}}
  }
  Progress 'กำลังลบโปรแกรมทดลองและข้อมูลฝึก กรุณารอจนมีข้อความแจ้งผล'
  DeleteScoped $old (Split-Path $root -Parent) ('clinic-trial-removing-'+$id)
  if((Test-Path -LiteralPath $old) -or (Test-Path -LiteralPath $root)){throw 'removal-incomplete'}
  Save 'cleaned';Fault 'after-delete'
  Save 'complete'
  Tell "ถอนโปรแกรมทดลองและข้อมูลในชุดทดลองทั้งหมดแล้ว ปิดแท็บทดลองเดิมได้เลย`n`nไฟล์ ZIP สำเนาโฟลเดอร์ส่งหมอที่ย้ายหรือเพิ่มไฟล์เอง และสำเนาที่เคยส่งออกไป USB/คลาวด์หรือเครื่องอื่นต้องลบแยกหากไม่ต้องการเก็บ`nระบบใช้งานจริงและโปรแกรมอื่นไม่ได้ถูกถอน" $true
 }
 $code=0
}catch{
 Write-Output ('TRIAL FAILED phase='+$state.phase+' category='+$_.CategoryInfo.Category+' type='+$_.Exception.GetType().Name)
 if($progress){$progress.Hide()}
 $message='ยังถอนหรือเริ่มฝึกใหม่ไม่เสร็จ กรุณาปิดหน้าต่างโฟลเดอร์ชุดทดลองและโปรแกรมที่เปิดไฟล์ในนั้น แล้วกด ลองอีกครั้ง'+"`n`nหากปิดหน้าต่างนี้ สามารถเปิดตัวถอนชุดทดลองเพื่อต่องานเดิมได้"
 if($_.Exception.Message -in @('linked-parent','unsafe-delete','unsafe-root','not-trial','two-installs')){$message='ยังทำไม่เสร็จ เพราะตำแหน่งไฟล์ไม่ตรงกับชุดทดลองที่กำลังถอน ระบบหยุดเพื่อไม่ให้ลบผิดโฟลเดอร์ กรุณาให้ผู้ดูแลตรวจสอบก่อนลองอีกครั้ง'}
 if($test){Tell $message $false;if($env:CLINIC_TRIAL_TOOLS_RETRY_ONCE -eq '1' -and -not $testRetried){$testRetried=$true;$retry=$true;$env:CLINIC_TRIAL_TOOLS_FAIL=''}}else{
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ผลการจัดการ.txt'),$message,(New-Object Text.UTF8Encoding($true)))
  $retry=[Windows.Forms.MessageBox]::Show($message,'ยังทำไม่เสร็จ','RetryCancel','Warning') -eq 'Retry'
 }

}finally{
 if($lockOwned -and (Test-Path -LiteralPath $lock)){Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue}
 if($transcript){Stop-Transcript|Out-Null}
 if($progress){$progress.Dispose();$progress=$null}
 if($owns -and $mutex){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}
}
} while($retry)
exit $code
