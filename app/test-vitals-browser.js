'use strict';
module.exports = async function({ tab, origins, viewport, evaluate, waitExpression, clickControl }) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const normal = { bp_sys: 124, bp_dia: 80, pulse: 72, temp_c: 36.8, weight_kg: 74, height_cm: 170, glucose: 95 };
  const expectedNormal = [
    ['ความดัน (BP)', '124/80', 'มม.ปรอท'], ['ชีพจร', '72', 'ครั้ง/นาที'],
    ['อุณหภูมิ', '36.8', '°C'], ['น้ำหนัก', '74', 'กก.'],
    ['ส่วนสูง', '170', 'ซม.'], ['น้ำตาล (DTX)', '95', 'mg/dL'],
  ];
  const abnormal = { ...normal, bp_sys: 140, bp_dia: 90, pulse: 110, temp_c: 37.8, glucose: 126 };
  const expectedAbnormal = expectedNormal.map(row => [...row]);
  expectedAbnormal[0][1] = '140/90'; expectedAbnormal[1][1] = '110';
  expectedAbnormal[2][1] = '37.8'; expectedAbnormal[5][1] = '126';
  async function login(origin, user, password) {
    await evaluate(tab, "if(typeof draftDirty!=='undefined')draftDirty=false;true").catch(() => {});
    await tab.send('Page.navigate', { url: origin + '/login.html' });
    await waitExpression(tab, "document.readyState==='complete'&&!!document.querySelector('#go')", 'vitals login ready');
    await evaluate(tab, `document.querySelector('#u').value=${JSON.stringify(user)};document.querySelector('#p').value=${JSON.stringify(password)};true`);
    await clickControl(tab, '#go');
    await waitExpression(tab, `typeof ME!=='undefined'&&ME?.role===${JSON.stringify(user)}`, 'vitals authenticated');
  }
  async function evidence(name, origin, theme) {
    if (!process.env.CLINIC_VITALS_EVIDENCE) return;
    const dir = path.resolve(process.env.CLINIC_VITALS_EVIDENCE);
    fs.mkdirSync(dir, { recursive: true });
    const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(dir, `vitals-${name}-${theme}-${viewport.screenWidth}-${viewport.dpr}-${new URL(origin).hostname}.png`), Buffer.from(shot.data, 'base64'));
  }
  // Inspect actual rendered styles/backgrounds, not merely the presence of CSS declarations.
  function inspect(selector) {
    const host = document.querySelector(selector);
    const number = value => Number.parseFloat(value);
    const rgba = text => {
      const channels = text.match(/[\d.]+/g)?.map(Number) || [];
      return channels.length >= 3 ? [channels[0], channels[1], channels[2], channels[3] ?? 1] : [0, 0, 0, 0];
    };
    const blend = (top, bottom) => top.slice(0, 3).map((channel, i) => channel * top[3] + bottom[i] * (1 - top[3]));
    function contrast(element) {
      const ancestors = [];
      for (let current = element; current; current = current.parentElement) ancestors.push(current);
      let background = [255, 255, 255];
      for (const current of ancestors.reverse()) background = blend(rgba(getComputedStyle(current).backgroundColor), background);
      const foreground = blend(rgba(getComputedStyle(element).color), background);
      const luminance = rgb => rgb.map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(foreground), b = luminance(background);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }
    function overlaps(a, b) { return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1; }
    const badges = [...host.querySelectorAll('.vital-reading')];
    const hostRect = host.getBoundingClientRect();
    const values = badges.map(badge => {
      const value = badge.querySelector('.vital-value'), label = badge.querySelector('.vital-label'), unit = badge.querySelector('.vital-unit');
      const rect = value.getBoundingClientRect(), badgeRect = badge.getBoundingClientRect(), style = getComputedStyle(value);
      let opacity = 1;
      for (let current = value; current; current = current.parentElement) opacity *= Number(getComputedStyle(current).opacity);
      const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const parts = [label, value, unit].map(e => e.getBoundingClientRect());
      return {
        text: [label.textContent.trim(), value.textContent.trim(), unit.textContent.trim()],
        warning: badge.classList.contains('vwarn'), fontSize: number(style.fontSize), fontWeight: number(style.fontWeight),
        contrast: contrast(value), labelContrast: contrast(label), unitContrast: contrast(unit),
        muted: !!value.closest('.muted,.sub'), opacity,
        fits: badgeRect.left >= hostRect.left - 1 && badgeRect.right <= hostRect.right + 1 && badgeRect.left >= 0 && badgeRect.right <= innerWidth + 1 && badgeRect.top >= 0 && badgeRect.bottom <= innerHeight + 1 && parts.every(part => part.left >= badgeRect.left - 1 && part.right <= badgeRect.right + 1 && part.top >= badgeRect.top - 1 && part.bottom <= badgeRect.bottom + 1),
        unoccluded: !!center && (value === center || value.contains(center)),
        hit: center ? { tag: center.tagName, id: center.id, className: center.className, text: center.textContent.slice(0, 100) } : null,
        valueRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        hostRect: { left: hostRect.left, top: hostRect.top, right: hostRect.right, bottom: hostRect.bottom },
        partsDoNotOverlap: parts.every((a, i) => parts.slice(i + 1).every(b => !overlaps(a, b))),
      };
    });
    const rects = badges.map(e => e.getBoundingClientRect());
    return { ariaLabel: host.getAttribute('aria-label'), values,
      noOverlap: rects.every((a, i) => rects.slice(i + 1).every(b => !overlaps(a, b))) };
  }
  function frameFrontPatient(selector) {
    const row = document.querySelector(selector).closest('.qrow.front-patient-row');
    const visibleTop = () => Math.max(0, ...[...document.querySelectorAll('.topbar,#callNotices')]
      .filter(element => ['fixed', 'sticky'].includes(getComputedStyle(element).position))
      .map(element => element.getBoundingClientRect().bottom));
    // Centre the whole patient row in the space below the sticky notice, rather
    // than centring only the values and leaving the patient's identity behind it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const rect = row.getBoundingClientRect(), top = visibleTop() + 8;
      const target = top + Math.max(0, (innerHeight - top - 8 - rect.height) / 2);
      window.scrollBy({ top: rect.top - target, behavior: 'instant' });
    }
    const rect = row.getBoundingClientRect(), top = visibleTop();
    const identity = [row.querySelector('.nm'), row.querySelector('.nm + .sub')];
    const actions = [...row.querySelectorAll('.queue-actions button')];
    const visible = element => {
      if (!element) return false;
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width > 0 && r.height > 0 && r.top >= top && r.bottom <= innerHeight + 1 && !!hit && (element === hit || element.contains(hit));
    };
    return { fits: rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= top && rect.bottom <= innerHeight + 1,
      identityVisible: identity.every(visible), actionsVisible: actions.length > 0 && actions.every(visible),
      row: { top: rect.top, bottom: rect.bottom, height: rect.height }, usableTop: top, viewportHeight: innerHeight };
  }
  async function verify(selector, expected, warningLabels, stage, origin) {
    for (const theme of ['light', 'soft', 'dark']) {
      await evaluate(tab, `setTheme(${JSON.stringify(theme)});document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});true`);
      await waitExpression(tab, `document.documentElement.dataset.theme===${JSON.stringify(theme)}`, 'vitals theme applied');
      await waitExpression(tab, `(()=>{const host=document.querySelector(${JSON.stringify(selector)});if(!host)return false;for(let current=host;current;current=current.parentElement)if(Number(getComputedStyle(current).opacity)!==1)return false;return true;})()`, 'vitals entry animation finished');
      if (stage === 'front') {
        const frame = await evaluate(tab, `(${frameFrontPatient.toString()})(${JSON.stringify(selector)})`);
        if (!frame.fits || !frame.identityVisible || !frame.actionsVisible) await evidence('front-identity-frame-failure', origin, theme);
        assert(frame.fits && frame.identityVisible && frame.actionsVisible, 'front evidence must show patient identity, measurements and actions together ' + JSON.stringify(frame));
      }
      const result = await evaluate(tab, `(${inspect.toString()})(${JSON.stringify(selector)})`);
      if (result.values.some(value => !value.fits || !value.unoccluded || !value.partsDoNotOverlap)) await evidence(stage + '-layout-failure', origin, theme);
      assert.deepEqual(result.values.map(v => v.text), expected, stage + ' exact readings and units ' + theme);
      assert(result.ariaLabel && result.noOverlap, stage + ' labelled group and non-overlapping badges ' + theme);
      for (const value of result.values) {
        assert.equal(value.warning, warningLabels.includes(value.text[0]), stage + ' existing warning for ' + value.text[0]);
        assert(value.fontSize >= 18 && value.fontWeight >= 700 && !value.muted && value.opacity === 1, stage + ' primary value is legible ' + JSON.stringify(value));
        assert(value.contrast >= 4.5 && value.labelContrast >= 4.5 && value.unitContrast >= 4.5, stage + ' text contrast below 4.5 ' + JSON.stringify(value));
        assert(value.fits && value.unoccluded && value.partsDoNotOverlap, stage + ' clipped, hidden or overlapping value ' + JSON.stringify(value));
      }
      if (stage === 'front' || stage === 'exam' || theme === 'soft') await evidence(stage, origin, theme);
    }
  }
  for (const origin of origins) {
    await login(origin, 'front', 'front123');
    await tab.send('Page.navigate', { url: origin + '/' });
    await waitExpression(tab, "typeof queue!=='undefined'&&typeof refresh==='function'", 'vitals front queue ready');
    const oldTheme = await evaluate(tab, 'currentTheme()');
    const fixture = await evaluate(tab, `(async()=>{const p=await api('POST','/api/patients',{first_name:'สมมติค่าตรวจ '+crypto.randomUUID().slice(0,8),sex:'F',op_id:crypto.randomUUID()});return api('POST','/api/visits',{hn:p.hn,cc:'ตรวจการอ่านค่าที่บันทึกสังเคราะห์',vitals:${JSON.stringify(normal)},op_id:crypto.randomUUID()});})()`, true);
    const visitId = fixture.id;
    assert(Number.isInteger(visitId));
    await evaluate(tab, 'refresh()', true);
    const frontSelector = `.qrow:has(button[onclick="openVitals(${visitId})"]) .vital-readings`;
    await waitExpression(tab, `!!document.querySelector(${JSON.stringify(frontSelector)})`, 'front must display normal recorded values');
    try {
      await verify(frontSelector, expectedNormal, [], 'front', origin);
      await login(origin, 'doctor', 'doctor123');
      await tab.send('Page.navigate', { url: origin + '/exam.html' });
      const callSelector = `button[onclick="callPatient(${visitId})"]`;
      await waitExpression(tab, `!!document.querySelector(${JSON.stringify(callSelector)})`, 'doctor can call synthetic patient');
      await verify(`.bigq:has(${callSelector}) .vital-readings`, expectedNormal, [], 'doctor-queue', origin);
      await clickControl(tab, callSelector);
      await waitExpression(tab, `typeof cur!=='undefined'&&cur?.id===${visitId}&&!!document.querySelector('#patientHead .vital-readings')`, 'doctor opened this visit');
      await verify('#patientHead .vital-readings', expectedNormal, [], 'exam', origin);
      const saved = await evaluate(tab, `api('GET','/api/visits/${visitId}')`, true);
      for (const [key, value] of Object.entries(normal)) assert.equal(saved[key], value, 'UI changes must not alter stored ' + key);
      await evaluate(tab, `(async()=>{draftDirty=false;await api('PATCH','/api/visits/${visitId}/vitals',${JSON.stringify(abnormal)});await openVisit(${visitId});draftDirty=false;return true;})()`, true);
      await verify('#patientHead .vital-readings', expectedAbnormal, ['ความดัน (BP)', 'ชีพจร', 'อุณหภูมิ', 'น้ำตาล (DTX)'], 'existing-warnings', origin);
      await evaluate(tab, `(async()=>{draftDirty=false;await api('POST','/api/visits/${visitId}/cancel',{reason:'สิ้นสุดการทดสอบหน้าจอสังเคราะห์'});cur=null;showView('queue');return true;})()`, true);
      console.log(`VITALS BROWSER PASS ${origin} ${viewport.screenWidth}@${viewport.dpr} front/doctor-queue/real-call/exam values, three themes, contrast, layout and existing warnings`);
    } finally {
      await evaluate(tab, `if(typeof draftDirty!=='undefined')draftDirty=false;setTheme(${JSON.stringify(oldTheme)});true`).catch(() => {});
    }
  }
};
