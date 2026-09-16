'use strict';
// Called only by test-browser's isolated, token-gated synthetic instance.
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function verifyBackupStatus({ tab, origins, viewport, cloudDir, evaluate, waitExpression, clickControl }) {
  if (!cloudDir || !path.isAbsolute(cloudDir)) throw Error('ต้องมีปลายทางสังเคราะห์จาก isolated browser harness');
  const forbidden = /ข้อมูลปลอดภัยแล้ว|สำเนาบนคลาวด์: ตรวจแล้ว ใช้งานได้/;
  async function login(origin, role) {
    await tab.send('Page.navigate', { url: origin + '/login.html' });
    await waitExpression(tab, `document.readyState==='complete' && !!document.querySelector('#go')`, 'backup login ready');
    await evaluate(tab, `document.querySelector('#u').value=${JSON.stringify(role)};document.querySelector('#p').value=${JSON.stringify(role === 'admin' ? 'admin1234' : 'front123')};true`);
    await clickControl(tab, '#go');
    await waitExpression(tab, `typeof ME!=='undefined' && ME && ME.role===${JSON.stringify(role)}`, 'backup login outcome');
  }
  async function openBackup(origin) {
    await tab.send('Page.navigate', { url: origin + '/admin.html?section=backup' });
    await waitExpression(tab, `typeof adminReady!=='undefined' && adminReady && adminSection==='backup'`, 'backup settings ready');
    await clickControl(tab, '#adminPage details summary');
  }
  async function setCloud(value) {
    await evaluate(tab, `document.querySelector('#s_backup_cloud_dest').value=${JSON.stringify(value)};document.querySelector('#s_backup_cloud_dest').dispatchEvent(new Event('input',{bubbles:true}));true`);
  }
  async function visibleText(selector) {
    await evaluate(tab, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});true`);
    await waitExpression(tab, `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.bottom>0&&r.top<innerHeight;})()`, 'ผลสำรองไม่ปรากฏบนจอ: '+selector);
    return evaluate(tab, `(() => { const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      if(getComputedStyle(e).display==='none'||r.width===0||r.bottom<=0||r.top>=innerHeight)throw Error('ผลสำรองไม่ปรากฏบนจอ: '+${JSON.stringify(selector)});
      if(document.documentElement.scrollWidth>innerWidth+2)throw Error('หน้าสำรองล้นแนวนอน');return e.innerText; })()`);
  }
  for (const origin of origins) {
    await login(origin, 'admin');
    await openBackup(origin);
    await setCloud(cloudDir);
    await clickControl(tab, '#adminBackupBtn');
    await waitExpression(tab, `!document.querySelector('#adminBackupBtn').disabled && document.querySelector('#adminBackupResult').textContent.includes('ยังไม่ยืนยันการอัปโหลด')`, 'admin must see copy is not upload confirmation');
    const adminText = await visibleText('#adminBackupResult');
    if (forbidden.test(adminText) || !adminText.includes('Google Drive/OneDrive')) throw Error('admin copy message overclaims');
    await waitExpression(tab, `document.querySelector('#recoverySummary').textContent.includes('ยังไม่ยืนยันการอัปโหลด')`, 'health summary must distinguish cloud folder');

    await evaluate(tab, 'window.__backupReloadPending=true');
    await tab.send('Page.reload');
    await waitExpression(tab, `!window.__backupReloadPending && typeof adminReady!=='undefined' && adminReady && document.querySelector('#recoverySummary').textContent.includes('ยังไม่ยืนยันการอัปโหลด')`, 'cloud caveat survives reload for admin');
    await visibleText('#recoverySummary');
    const output = path.join(__dirname, '../output/cloud-backup-status-evidence');
    fs.mkdirSync(output, { recursive: true });
    const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `admin-${viewport.screenWidth}-${viewport.dpr}-${origin===origins[0]?'host':'lan'}.png`), Buffer.from(shot.data, 'base64'));

    await login(origin, 'front');
    await tab.send('Page.navigate', { url: origin + '/reports.html' });
    await waitExpression(tab, `!!document.querySelector('#backupNowBtn') && typeof ME!=='undefined' && ME && ME.role==='front' && document.querySelector('#bkStatus').textContent.includes('ยังไม่ยืนยันการอัปโหลด')`, 'reports cloud status ready');
    await clickControl(tab, '#backupNowBtn');
    await waitExpression(tab, `!document.querySelector('#backupNowBtn').disabled && document.querySelector('#bkRunResult').textContent.includes('ยังไม่ยืนยันการอัปโหลด')`, 'front must see persistent backup outcome');
    const frontText = await visibleText('#bkRunResult');
    if (forbidden.test(frontText)) throw Error('reports copy message overclaims');
    const banner = await evaluate(tab, `document.querySelector('#backupBanner').innerText`);
    const hasPassword = await evaluate(tab, `(async()=>!!(await api('GET','/api/backup/status')).password_ready)()`, true);
    if (!banner.includes('ยังไม่ยืนยันการอัปโหลด') || (!hasPassword && !banner.includes('USB'))) throw Error('recovery-method notice hides cloud caveat');
    if (hasPassword && banner.includes('ยังไม่ได้ตั้งรหัส')) throw Error('configured password must not require a Kit');

    await login(origin, 'admin');
    await openBackup(origin);
    await setCloud(path.join(cloudDir, 'not-a-directory'));
    await clickControl(tab, '#adminBackupBtn');
    await waitExpression(tab, `!document.querySelector('#adminBackupBtn').disabled && document.querySelector('#adminBackupResult').textContent.includes('โฟลเดอร์คลาวด์: ไม่สำเร็จ')`, 'failed copy must not claim copy complete');
    const failed = await visibleText('#adminBackupResult');
    if (failed.includes('☁️ โฟลเดอร์คลาวด์: คัดลอก')) throw Error('failed cloud target claimed success');

    await setCloud('');
    await clickControl(tab, '#adminBackupBtn');
    await waitExpression(tab, `!document.querySelector('#adminBackupBtn').disabled && document.querySelector('#adminBackupResult').textContent.includes('สำเนาในเครื่อง: คัดลอก')`, 'local-only copy outcome');
    const local = await visibleText('#adminBackupResult');
    if (/คลาวด์|อัปโหลด/.test(local)) throw Error('local-only copy must not imply cloud destination');
    console.log(`BACKUP STATUS: 6 outcomes ${viewport.screenWidth}@${viewport.dpr} ${origin===origins[0]?'host':'LAN'}`);
  }
};
