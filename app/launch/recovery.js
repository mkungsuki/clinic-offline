'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawn, spawnSync } = require('node:child_process');
let root = path.resolve(__dirname, '../..');
const installed = dir => fs.existsSync(path.join(dir, 'update/installed.marker')) && fs.existsSync(path.join(dir, 'app/recovery-assistant.js'));
function stop(message) {
  if (process.env.CLINIC_INSTALL_TEST === '1') { console.error('RECOVERY LAUNCH REFUSED'); process.exitCode = 1; return; }
  spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', "Add-Type -AssemblyName System.Windows.Forms;[void][System.Windows.Forms.MessageBox]::Show($env:CLINIC_RECOVERY_MESSAGE,'กู้ข้อมูลคลินิก')"], { env: { ...process.env, CLINIC_RECOVERY_MESSAGE: message }, windowsHide: true, stdio: 'ignore' });
}
if (!installed(root)) {
  const candidates = process.env.CLINIC_INSTALL_TEST === '1' ? [] : ['C:\\clinic', 'C:\\clinic-trial'].filter(installed);
  if (candidates.length === 1) root = candidates[0];
  else { stop('กรุณาติดตั้งโปรแกรมก่อน แล้วเปิดไอคอน “กู้ข้อมูลคลินิก” จากชุดที่ติดตั้งแล้ว'); return; }
}
if (process.env.CLINIC_INSTALL_TEST === '1') { console.log('RECOVERY LAUNCH READY'); return; }
let trial = false;
try { trial = JSON.parse(fs.readFileSync(path.join(root, 'update/install-profile.json'), 'utf8')).variant === 'trial'; } catch {}
const child = spawn(path.join(root, 'runtime/node.exe'), ['--no-warnings', path.join(root, 'app/recovery-assistant.js')], {
  cwd: path.join(root, 'app'), detached: true, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, CLINIC_DATA_DIR: path.join(root, 'app/data'), CLINIC_PORT: trial ? '8081' : '8080', CLINIC_HTTPS_PORT: trial ? '8444' : '8443' },
});
child.on('error', () => stop('เปิดตัวช่วยกู้ไม่ได้ กรุณาตรวจว่าชุดโปรแกรมติดตั้งครบแล้ว')); child.unref();
