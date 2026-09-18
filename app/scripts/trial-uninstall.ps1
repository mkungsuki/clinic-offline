param([switch]$TestMode)
$ErrorActionPreference='Stop'
$test=$TestMode -and $env:CLINIC_INSTALL_TEST -eq '1' -and $env:CLINIC_TEST_INSTANCE_TOKEN
try {
 if($TestMode -and -not $test){throw 'test-env-required'}
 if($test){$sandbox=[IO.Path]::GetFullPath($env:CLINIC_TRIAL_TOOLS_TEST_ROOT);if(-not $sandbox.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -or [IO.File]::ReadAllText((Join-Path $sandbox 'trial-tools-test.marker')) -ne 'synthetic-trial-tools-only'){throw 'unsafe-test'}}
 . (Join-Path $PSScriptRoot 'windows-shortcuts.ps1')
 $source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
 $target=if($test){Join-Path $env:CLINIC_TRIAL_TOOLS_TEST_ROOT 'ชุดทดลอง'}else{'C:\clinic-trial'}
 $maintenanceDir=if($test){Join-Path $env:CLINIC_TRIAL_TOOLS_TEST_ROOT 'เครื่องมือ'}else{Join-Path $env:LOCALAPPDATA 'ClinicOffline\TrialMaintenance'}
 function Safe([string]$p){while($p){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'linked-parent'};$p=Split-Path $p -Parent}}
 Safe $source;Safe $target;Safe $maintenanceDir
 # A package can redirect only to the fixed installed trial. Never operate on the package.
 $pending=@()
 if(Test-Path -LiteralPath $maintenanceDir){foreach($d in Get-ChildItem -LiteralPath $maintenanceDir -Directory){Safe $d.FullName;$state=Join-Path $d.FullName 'state.json';$request=Join-Path $d.FullName 'request.json';Safe $state;Safe $request;if((Test-Path -LiteralPath $state) -and (Test-Path -LiteralPath $request)){$s=Get-Content -LiteralPath $state -Raw -Encoding UTF8|ConvertFrom-Json;$r=Get-Content -LiteralPath $request -Raw -Encoding UTF8|ConvertFrom-Json;if($r.root -eq $target -and $s.phase -notin @('new','cancelled','complete')){if($r.action -ne 'uninstall'){throw 'reset-pending'};$pending+= $d.FullName}}}}
 if($pending.Count -gt 1){throw 'multiple-pending'}
 if($pending.Count -eq 1){$stage=$pending[0]}else{
  if(-not (Test-Path -LiteralPath (Join-Path $target 'update\installed.marker') -PathType Leaf)){throw 'not-installed'}
  $profilePath=Join-Path $target 'update\install-profile.json';Safe $profilePath
  $profile=Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8|ConvertFrom-Json
  if($profile.product -ne 'clinic-offline' -or $profile.variant -ne 'trial'){throw 'not-trial'}
  $id=[guid]::NewGuid().ToString();$stage=Join-Path $maintenanceDir $id
  New-Item -ItemType Directory -Path $stage -Force|Out-Null
  [IO.File]::WriteAllText((Join-Path $stage 'request.json'),(@{id=$id;root=$target;action='uninstall'}|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
 }
 foreach($name in @('trial-maintenance.ps1','windows-shortcuts.ps1')){Safe (Join-Path $stage $name);Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $stage $name) -Force}
 # Stage and change working directory outside the installation before removing it.
 Set-Location -LiteralPath $stage
 & (Join-Path $stage 'trial-maintenance.ps1') -TestMode:$test
 exit $LASTEXITCODE
}catch{
 if($test){Write-Output ('UNINSTALL STOP '+$_.Exception.Message)}else{Add-Type -AssemblyName System.Windows.Forms;[Windows.Forms.MessageBox]::Show('เปิดตัวถอนชุดทดลองไม่ได้ กรุณาตรวจว่าติดตั้งชุดทดลองแล้ว และไม่มีงานเริ่มฝึกใหม่ค้างอยู่','ถอนชุดทดลอง','OK','Warning')|Out-Null}
 exit 1
}
