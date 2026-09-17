'use strict';
// Run only inside test-browser.js's isolated, token-proven server and fresh profile.
module.exports = async function({ tab, origins, viewport, evaluate, waitExpression, clickControl }) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const performClick = clickControl;
  clickControl = async (page, selector) => {
    try { return await performClick(page, selector); }
    catch (error) { throw new Error('dose units control ' + selector + ': ' + error.message); }
  };
  async function login(origin, user, password) {
    await evaluate(tab, "if(typeof draftDirty!=='undefined')draftDirty=false;true").catch(() => {});
    await tab.send('Page.navigate', { url: origin + '/login.html' });
    await waitExpression(tab, "document.readyState==='complete'&&!!document.querySelector('#go')", 'dose units login');
    await fill({ '#u': user, '#p': password });
    await clickControl(tab, '#go');
    await waitExpression(tab, `typeof ME!=='undefined'&&ME?.role===${JSON.stringify(user)}`, 'dose units authenticated');
  }
  async function fill(values) {
    for (const [selector, value] of Object.entries(values)) {
      await evaluate(tab, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing dose control '+${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    }
  }
  async function search(name) {
    await fill({ '#orderAdd': name });
    await waitExpression(tab, "!!document.querySelector('#orderAdd ~ .dd .it')", 'dose units search result');
    await clickControl(tab, '#orderAdd ~ .dd .it');
  }
  async function screenshot(stage, origin, selector) {
    if (selector) await evaluate(tab, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});true`);
    await waitExpression(tab, `(()=>{const box=document.querySelector('#modalBack.show .modal-box');if(!box)return true;const r=box.getBoundingClientRect(),s=getComputedStyle(box);return r.width>0&&r.height>0&&s.visibility==='visible'&&Number(s.opacity)===1&&box.getAnimations({subtree:true}).every(a=>a.playState==='finished'||a.playState==='idle');})()`, 'dose evidence modal fully visible after its animation');
    if (!process.env.CLINIC_DOSE_UNITS_EVIDENCE) return;
    const dir = path.resolve(process.env.CLINIC_DOSE_UNITS_EVIDENCE);
    fs.mkdirSync(dir, { recursive: true });
    const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(dir, `dose-units-${stage}-${viewport.screenWidth}-${viewport.dpr}-${new URL(origin).hostname}.png`), Buffer.from(shot.data, 'base64'));
  }
  async function verifyControls(selector) {
    const result = await evaluate(tab, `(()=>{const host=document.querySelector(${JSON.stringify(selector)}),els=[...host.querySelectorAll('input,select')].filter(e=>e.getBoundingClientRect().width>0);const rs=els.map(e=>e.getBoundingClientRect());return {count:rs.length,fits:rs.every(r=>r.left>=-1&&r.right<=innerWidth+1),apart:rs.every((a,i)=>rs.slice(i+1).every(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=1))};})()`);
    assert(result.count > 0 && result.fits && result.apart, 'dose controls clipped or overlapping ' + JSON.stringify(result));
  }
  const card = id => `.oline[data-drug-id="${id}"]`;
  async function addStock(name, mode, fields, price, origin, invalidFirst = false) {
    await fill({ '#d_name': name, '#d_unit': fields.unit, '#d_price': String(price), '#d_cost': '10', '#d_dose_mode': mode });
    const values = { '#drugDoseUnit': fields.doseUnit || '' };
    for (const [key, value] of Object.entries(fields.values)) values['#drugDose_' + key] = String(value);
    await fill(values);
    if (invalidFirst) {
      await fill({ '#drugDose_interval_min_hours': '8', '#drugDose_interval_max_hours': '4' });
      await clickControl(tab, 'button[onclick="saveDrug()"]');
      await waitExpression(tab, "document.querySelector('#toast')?.textContent.includes('ปลายช่วง')", 'inverted interval explained visibly');
      assert.equal(await evaluate(tab, `drugs.filter(d=>d.name===${JSON.stringify(name)}).length`), 0, 'invalid interval must not save');
      await fill({ '#drugDose_interval_min_hours': '4', '#drugDose_interval_max_hours': '6' });
    }
    await verifyControls('#drugDoseEditor');
    const preview = await evaluate(tab, "document.querySelector('#drugDosePreview').textContent");
    if (fields.doseUnit) assert(preview.includes(fields.doseUnit));
    if (mode === 'interval') { assert(preview.includes('4–6')); assert(!preview.includes('เมื่อ')); }
    await screenshot('stock-' + mode + (fields.unit === 'ขวด' ? '-bottle' : '-same-unit'), origin, '#drugDoseEditor');
    await clickControl(tab, 'button[onclick="saveDrug()"]');
    await waitExpression(tab, `!pendingDrugSave&&drugs.filter(d=>d.name===${JSON.stringify(name)}).length===1&&document.querySelector('#drugSaveStatus').textContent.includes('บันทึก')`, 'typed dose saved once');
    const id = await evaluate(tab, `drugs.find(d=>d.name===${JSON.stringify(name)}).id`);
    // Inventory is synthetic setup. The dose authoring and selecting path is operated in UI.
    await evaluate(tab, `api('POST','/api/drugs/${id}/receive',{qty:50,cost:10,reason:'ข้อมูลสังเคราะห์ทดสอบหน่วย',op_id:crypto.randomUUID()})`, true);
    return id;
  }
  for (const origin of origins) {
    await login(origin, 'admin', 'admin1234');
    const previousLabelSetting = await evaluate(tab, "(async()=>{const settings=await api('GET','/api/settings');await api('POST','/api/settings',{drug_label_enabled:'1'});return settings.drug_label_enabled||'0';})()", true);
    await login(origin, 'front', 'front123');
    await tab.send('Page.navigate', { url: origin + '/stock.html' });
    await waitExpression(tab, "typeof drugs!=='undefined'&&drugs.length>0&&!!document.querySelector('#drugDoseUnit')", 'dose units stock ready');
    const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const bottleName = 'ขวดสังเคราะห์-' + suffix, intervalName = 'ชั่วโมงสังเคราะห์-' + suffix, pillName = 'เม็ดสังเคราะห์-' + suffix;
    const bottleId = await addStock(bottleName, 'standard', { unit: 'ขวด', doseUnit: 'มล.', values: { m: 5, days: 7 } }, 50, origin);
    const intervalId = await addStock(intervalName, 'interval', { unit: 'ขวด', doseUnit: 'มล.', values: { interval_amount: 5, interval_min_hours: 4, interval_max_hours: 6 } }, 30, origin, true);
    const pillId = await addStock(pillName, 'standard', { unit: 'เม็ด', values: { m: 1, days: 7 } }, 2, origin);

    await tab.send('Page.navigate', { url: origin + '/' });
    await waitExpression(tab, "!!document.querySelector('#btnNewPat')&&typeof queue!=='undefined'", 'dose units intake');
    await clickControl(tab, '#btnNewPat');
    const patient = 'สังเคราะห์หน่วย-' + suffix;
    await fill({ '#r_first': patient, '#r_sex': 'F', '#r_cc': 'ทดสอบหน่วยยา' });
    await clickControl(tab, 'button[onclick="registerAndQueue()"]');
    await waitExpression(tab, `queue.some(v=>v.first_name===${JSON.stringify(patient)})`, 'dose units queued');
    const visitId = await evaluate(tab, `queue.find(v=>v.first_name===${JSON.stringify(patient)}).id`);
    await login(origin, 'doctor', 'doctor123');
    await tab.send('Page.navigate', { url: origin + '/exam.html' });
    await waitExpression(tab, `!!document.querySelector('button[onclick="callPatient(${visitId})"]')`, 'dose units real call');
    await clickControl(tab, `button[onclick="callPatient(${visitId})"]`);
    await waitExpression(tab, `typeof cur!=='undefined'&&cur?.id===${visitId}`, 'dose units exam open');
    if (origin === origins[0]) {
      // A bounded synthetic probe, separate from the clinical review screenshot:
      // opening a real menu clears old informational toasts but retains errors.
      await waitExpression(tab, "!!document.querySelector('#favGrid button[onclick=\"openFavManager()\"]')", 'toast probe real menu ready');
      await evaluate(tab, "toast('ข้อความแจ้งผลสังเคราะห์สำหรับทดสอบกล่อง');toast('ข้อผิดพลาดสังเคราะห์สำหรับทดสอบกล่อง',true);true");
      assert(await evaluate(tab, "[...document.querySelectorAll('#toast .m:not(.err)')].some(e=>e.textContent==='ข้อความแจ้งผลสังเคราะห์สำหรับทดสอบกล่อง')&&[...document.querySelectorAll('#toast .m.err')].some(e=>e.textContent==='ข้อผิดพลาดสังเคราะห์สำหรับทดสอบกล่อง')"));
      await clickControl(tab, '#favGrid button[onclick="openFavManager()"]');
      assert(await evaluate(tab, "document.querySelectorAll('#toast .m:not(.err)').length===0"), 'opening a dialog clears prior non-error notices');
      assert(await evaluate(tab, "[...document.querySelectorAll('#toast .m.err')].some(e=>e.textContent==='ข้อผิดพลาดสังเคราะห์สำหรับทดสอบกล่อง'&&getComputedStyle(e).display!=='none')"), 'opening a dialog must retain the error');
      await waitExpression(tab, "![...document.querySelectorAll('#toast .m.err')].some(e=>e.textContent==='ข้อผิดพลาดสังเคราะห์สำหรับทดสอบกล่อง')", 'synthetic error expires naturally before ordinary evidence');
      await clickControl(tab, '#modalBack button[onclick="closeModal()"]');
      console.log(`DOSE MODAL TOAST PASS ${origin} ${viewport.screenWidth}@${viewport.dpr} information cleared, error retained until normal expiry`);
    }
    // Direct reproduction of the owner's original demo: the authored seed has
    // a morning-one tablet grid, rather than prose saying 1x1 above empty slots.
    await search('Amlodipine 5mg');
    await waitExpression(tab, "lines.some(l=>l.type==='drug'&&l.name==='Amlodipine 5mg')", 'authored Amlodipine demo selected');
    const amloId = await evaluate(tab, "lines.find(l=>l.type==='drug'&&l.name==='Amlodipine 5mg').ref_id");
    assert.equal(await evaluate(tab, `document.querySelector(${JSON.stringify(card(amloId) + ' [data-dose-field="m"]')}).value`), '1', 'demo morning-one text must have a matching numeric grid');
    assert(await evaluate(tab, `document.querySelector(${JSON.stringify(card(amloId) + ' .drug-summary')}).textContent.includes('เช้า 1 เม็ด')`));
    assert.equal(await evaluate(tab, `document.querySelectorAll(${JSON.stringify(card(amloId) + ' .dose-missing')}).length`), 0, 'authored seed no longer displays a missing-dose warning');
    await fill({ [card(amloId) + ' [data-dose-field="days"]']: '7' });
    assert.equal(await evaluate(tab, `document.querySelector(${JSON.stringify(card(amloId) + ' [data-dispense-qty]')}).value`), '7');
    assert(await evaluate(tab, `document.querySelector(${JSON.stringify(card(amloId) + ' .drug-summary')}).textContent.includes('เช้า 1 เม็ด · 7 วัน')`));
    await screenshot('exam-seed-amlo', origin, card(amloId));
    await clickControl(tab, card(amloId) + ' button[onclick^="rmLine("]');
    assert.equal(await evaluate(tab, "lines.filter(l=>l.type==='drug'&&l.name==='Amlodipine 5mg').length"), 0);
    console.log(`DOSE SEED AMLO PASS ${origin} ${viewport.screenWidth}@${viewport.dpr} authored morning-one grid, no missing warning, seven-day quantity seven`);
    await search(bottleName);
    await waitExpression(tab, `!!document.querySelector(${JSON.stringify(card(bottleId))})`, 'bottle card visible');
    assert.equal(await evaluate(tab, `document.querySelector(${JSON.stringify(card(bottleId) + ' [data-dispense-qty]')}).value`), '', 'quantity starts blank, not 35 bottles');
    assert(await evaluate(tab, `document.querySelector(${JSON.stringify(card(bottleId))}).textContent.includes('5 มล.')`));
    await fill({ [card(bottleId) + ' [data-dispense-qty]']: '1' });
    assert(await evaluate(tab, `lines.find(l=>l.ref_id===${bottleId}).qty===1&&document.querySelector(${JSON.stringify(card(bottleId) + ' .osum')}).textContent.includes('50.00')`));
    await verifyControls(card(bottleId));
    await screenshot('exam-bottle', origin, card(bottleId));

    await search(intervalName);
    await waitExpression(tab, `!!document.querySelector(${JSON.stringify(card(intervalId))})`, 'interval card visible');
    assert.equal(await evaluate(tab, `document.querySelector(${JSON.stringify(card(intervalId) + ' [data-dispense-qty]')}).value`), '');
    for (const [key, value] of [['interval_amount', '5'], ['interval_min_hours', '4'], ['interval_max_hours', '6']]) {
      assert.equal(await evaluate(tab, `document.querySelector(${JSON.stringify(card(intervalId) + ' [data-dose-field="' + key + '"]')}).value`), value);
    }
    const intervalText = await evaluate(tab, `document.querySelector(${JSON.stringify(card(intervalId) + ' .drug-summary')}).textContent`);
    assert(intervalText.includes('ครั้งละ 5 มล. ทุก 4–6 ชม.'));
    assert(!intervalText.includes('เมื่อ'));
    await fill({ [card(intervalId) + ' [data-dispense-qty]']: '1' });
    await verifyControls(card(intervalId));
    await screenshot('exam-interval', origin, card(intervalId));
    await search(pillName);
    await waitExpression(tab, `!!document.querySelector(${JSON.stringify(card(pillId))})`, 'same-unit card visible');
    assert.equal(await evaluate(tab, `lines.find(l=>l.ref_id===${pillId}).qty`), 7);
    await fill({ '#daysAll': '10' });
    await clickControl(tab, 'button[onclick="applyDaysAll()"]');
    const daysResult = await evaluate(tab, "(()=>{const e=document.querySelector('#daysAllResult');return e?{text:e.textContent,role:e.getAttribute('role'),visible:!e.hidden&&!e.classList.contains('hidden')&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().height>0}:null;})()");
    assert(daysResult?.visible && daysResult.role === 'status', 'all-days result must remain in a visible status panel');
    assert(daysResult.text.includes('10 วัน') && daysResult.text.includes('คำนวณ') && /1 (?:ตัว|รายการ)/.test(daysResult.text), 'all-days result identifies the calculated pill');
    assert(daysResult.text.includes(bottleName) && daysResult.text.includes('กรอกเอง'), 'all-days result explains the retained bottle quantity');
    assert(daysResult.text.includes(intervalName) && daysResult.text.includes('ข้าม'), 'all-days result identifies the interval skipped for calculation');
    assert.equal(await evaluate(tab, "document.querySelectorAll('#toast .m:not(.err)').length"), 0, 'all-days outcomes must not stack informational toasts');
    assert.equal(await evaluate(tab, `lines.find(l=>l.ref_id===${pillId}).qty`), 10);
    assert.equal(await evaluate(tab, `lines.find(l=>l.ref_id===${bottleId}).qty`), 1);
    assert.equal(await evaluate(tab, `lines.find(l=>l.ref_id===${bottleId}).dose.days`), 10);
    assert(await evaluate(tab, `document.querySelector(${JSON.stringify(card(bottleId) + ' .drug-summary')}).textContent.includes('10 วัน')`));
    assert.equal(await evaluate(tab, `lines.find(l=>l.ref_id===${intervalId}).qty`), 1);
    await screenshot('exam-days-result', origin, '#daysAllResult');

    // A real mode transition must not carry a hidden meal instruction into an
    // interval. The user can deliberately select a meal, then remove it again.
    await fill({ [card(pillId) + ' [data-dose-field="timing"]']: 'หลังอาหาร' });
    assert(await evaluate(tab, `document.querySelector(${JSON.stringify(card(pillId) + ' .drug-summary')}).textContent.includes('หลังอาหาร')`));
    await clickControl(tab, card(pillId) + ' button[data-dose-mode="interval"]');
    assert.equal(await evaluate(tab, `document.querySelector(${JSON.stringify(card(pillId) + ' [data-dose-field="timing"]')}).value`), '', 'interval transition clears the previous meal');
    assert.equal(await evaluate(tab, `document.querySelector(${JSON.stringify(card(pillId) + ' [data-dispense-qty]')}).value`), '', 'automatic scheduled quantity needs explicit interval confirmation');
    await fill({
      [card(pillId) + ' [data-dose-field="interval_amount"]']: '1',
      [card(pillId) + ' [data-dose-field="interval_min_hours"]']: '4',
      [card(pillId) + ' [data-dose-field="interval_max_hours"]']: '6',
      [card(pillId) + ' [data-dispense-qty]']: '5',
    });
    let switchedText = await evaluate(tab, `document.querySelector(${JSON.stringify(card(pillId) + ' .drug-summary')}).textContent`);
    assert(switchedText.includes('ครั้งละ 1 เม็ด ทุก 4–6 ชม.') && !switchedText.includes('อาหาร') && !switchedText.includes('เมื่อ'));
    await fill({ [card(pillId) + ' [data-dose-field="timing"]']: 'ก่อนอาหาร' });
    assert(await evaluate(tab, `document.querySelector(${JSON.stringify(card(pillId) + ' .drug-summary')}).textContent.includes('ก่อนอาหาร')`));
    await fill({ [card(pillId) + ' [data-dose-field="timing"]']: '' });
    switchedText = await evaluate(tab, `document.querySelector(${JSON.stringify(card(pillId) + ' .drug-summary')}).textContent`);
    assert(!switchedText.includes('อาหาร'), 'clearing the visible interval meal field clears the instruction');
    await verifyControls(card(pillId));
    await screenshot('exam-interval-transition', origin, card(pillId));
    await clickControl(tab, card(pillId) + ' button[data-dose-mode="standard"]');
    await fill({ [card(pillId) + ' [data-dose-field="m"]']: '1', [card(pillId) + ' [data-dose-field="days"]']: '10', [card(pillId) + ' [data-dose-field="timing"]']: '' });
    await clickControl(tab, card(pillId) + ' button[onclick^="useCalculatedQty("]');
    assert.equal(await evaluate(tab, `document.querySelector(${JSON.stringify(card(pillId) + ' [data-dispense-qty]')}).value`), '10');
    assert(await evaluate(tab, `document.querySelector(${JSON.stringify(card(pillId) + ' .drug-summary')}).textContent.includes('เช้า 1 เม็ด · 10 วัน')`));
    assert.equal(await evaluate(tab, "document.querySelector('#daysAllResult').textContent"), daysResult.text, 'all-days outcome survives subsequent edits instead of expiring like a toast');
    assert(await evaluate(tab, "!document.querySelector('#daysAllResult').hidden&&getComputedStyle(document.querySelector('#daysAllResult')).display!=='none'"));

    const setName = 'ชุดหน่วยสังเคราะห์-' + suffix;
    await clickControl(tab, '#favGrid button[onclick="openFavManager()"]');
    await clickControl(tab, 'button[onclick="closeModal();saveFav()"]');
    await fill({ '#mFavName': setName });
    await clickControl(tab, 'button[onclick="saveFavConfirm()"]');
    await waitExpression(tab, `favSets.some(f=>f.name===${JSON.stringify(setName)})`, 'dose units favorite saved');
    const favId = await evaluate(tab, `favSets.find(f=>f.name===${JSON.stringify(setName)}).id`);
    await clickControl(tab, card(bottleId) + ' button[onclick^="rmLine("]');
    await clickControl(tab, '#favGrid button[onclick="openFavManager()"]');
    await clickControl(tab, `#modalBack button[onclick^="applyFav(${favId})"]`);
    assert(await evaluate(tab, `lines.find(l=>l.ref_id===${bottleId}).dose.dose_unit==='มล.'&&lines.find(l=>l.ref_id===${bottleId}).qty===1&&lines.find(l=>l.ref_id===${intervalId}).dose.interval_max_hours===6`));
    await fill({ '#n_cc': 'ข้อมูลสังเคราะห์', '#n_dx': 'ตรวจการทำงานของหน่วย' });
    await clickControl(tab, '#btnFinish');
    await waitExpression(tab, "!!document.querySelector('#btnConfirmFinish')", 'dose units review visible');
    assert(await evaluate(tab, "document.querySelector('#modalBack').textContent.includes('5 มล.')&&document.querySelector('#modalBack').textContent.includes('4–6')"));
    assert.equal(await evaluate(tab, "document.querySelectorAll('#toast .m:not(.err)').length"), 0, 'prior success toasts must not cover the finish review');
    await screenshot('finish-review', origin, '#btnConfirmFinish');
    await clickControl(tab, '#btnConfirmFinish');
    await waitExpression(tab, `typeof ME!=='undefined'&&ME&&JSON.parse(sessionStorage.getItem('clinic_finish_'+ME.user_id)||'null')?.done===${visitId}&&(!!document.querySelector('#finishNext')||location.pathname==='/')`, 'dose units visible finish result for this visit');
    const saved = await evaluate(tab, `api('GET','/api/visits/${visitId}')`, true);
    assert.equal(saved.state, 'DISPENSING');
    assert.equal(saved.order.lines.find(l => l.ref_id === bottleId && l.type === 'drug').dose.dose_unit, 'มล.');

    await login(origin, 'front', 'front123');
    const paid = await evaluate(tab, `api('POST','/api/visits/${visitId}/pay',{order_version_id:${saved.order.id},pay_method:'cash',op_id:crypto.randomUUID()})`, true);
    await tab.send('Page.navigate', { url: origin + '/print/labels/' + encodeURIComponent(paid.receiptNo) });
    await waitExpression(tab, "document.readyState==='complete'&&document.body.textContent.includes('4–6')", 'saved labels visible');
    const printed = await evaluate(tab, 'document.body.textContent');
    assert(printed.includes('5 มล.'));
    assert(!printed.includes('5 ขวด'));
    await screenshot('printed-labels', origin);

    // A second real visit takes the previously issued order through re-med.
    await login(origin, 'doctor', 'doctor123');
    const next = await evaluate(tab, `api('POST','/api/visits',{hn:${JSON.stringify(saved.hn)},cc:'ทดสอบเพิ่มยาจากประวัติสังเคราะห์',op_id:crypto.randomUUID()})`, true);
    await tab.send('Page.navigate', { url: origin + '/exam.html' });
    await waitExpression(tab, `!!document.querySelector('button[onclick="callPatient(${next.id})"]')`, 'second visit real call');
    await clickControl(tab, `button[onclick="callPatient(${next.id})"]`);
    const remed = `button[onclick="applyRemedFromHistory(${visitId})"]`;
    await waitExpression(tab, `!!document.querySelector(${JSON.stringify(remed)})`, 'prior order available in history');
    await clickControl(tab, remed);
    assert(await evaluate(tab, `lines.find(l=>l.ref_id===${bottleId}).dose.dose_unit==='มล.'&&lines.find(l=>l.ref_id===${bottleId}).qty===1&&lines.find(l=>l.ref_id===${intervalId}).dose.interval_max_hours===6`));
    assert(await evaluate(tab, "document.querySelector('#orderLines').textContent.includes('5 มล.')&&document.querySelector('#orderLines').textContent.includes('4–6')"));
    await screenshot('remed', origin, '#orderLines');
    await evaluate(tab, `(async()=>{draftDirty=false;await api('POST','/api/visits/${next.id}/cancel',{reason:'สิ้นสุดการทดสอบหน่วยสังเคราะห์'});cur=null;showView('queue');return true;})()`, true);
    await login(origin, 'admin', 'admin1234');
    await evaluate(tab, `api('POST','/api/settings',{drug_label_enabled:${JSON.stringify(previousLabelSetting)}})`, true);
    console.log(`DOSE UNITS BROWSER PASS ${origin} ${viewport.screenWidth}@${viewport.dpr} visible stock/exam/quantity/interval validation+mode-transition meal selection/favorite/finish/printed labels/re-med`);
  }
};
