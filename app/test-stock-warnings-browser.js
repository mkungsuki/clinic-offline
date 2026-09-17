'use strict';
// Runs only inside test-browser's isolated, synthetic server; no default server URL.
module.exports = async function ({ tab, origins, viewport, evaluate, waitExpression, clickControl }) {
  const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
  const js = JSON.stringify;
  async function fill(values) {
    await evaluate(tab, `(()=>{for(const [id,value] of Object.entries(${js(values)})){const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));}return true;})()`);
  }
  async function shot(name, origin, selector) {
    if (!process.env.CLINIC_STOCK_EVIDENCE) return;
    if (selector) await evaluate(tab, `document.querySelector(${js(selector)}).scrollIntoView({block:'center'});true`);
    await waitExpression(tab, "[...document.querySelectorAll('#modalBack .modal-box,.card')].every(n=>n.getAnimations().every(a=>a.playState!=='running'))", 'stock evidence after entry animation');
    const dir = path.resolve(process.env.CLINIC_STOCK_EVIDENCE);
    fs.mkdirSync(dir, { recursive: true });
    const image = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(dir, `${name}-${viewport.screenWidth}-${viewport.dpr}-${new URL(origin).hostname}.png`), Buffer.from(image.data, 'base64'));
  }
  async function layout(selectors, label) {
    const result = await evaluate(tab, `(()=>{const selectors=${js(selectors)},nodes=selectors.map(s=>document.querySelector(s));if(nodes.some(n=>!n))return {missing:true};const rs=nodes.map(n=>n.getBoundingClientRect());return {fits:rs.every(r=>r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1),noOverlap:rs.every((a,i)=>rs.slice(i+1).every(b=>a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1))};})()`);
    assert(!result.missing && result.fits && result.noOverlap, label + ': fields must fit and not overlap');
  }
  async function stockReady() {
    await waitExpression(tab, "typeof drugs!=='undefined'&&drugs.length>0&&!!document.querySelector('#drugDose_m')&&!!document.querySelector('#warnDaysStatus').textContent", 'stock warnings ready');
    assert.doesNotMatch(await evaluate(tab, "document.querySelector('#toast')?.textContent||''"), /⏰|มีล็อตหมดอายุแล้ว|มีล็อตใกล้หมดอายุ/, 'expiry status must stay in the page instead of covering the next modal');
    assert.match(await evaluate(tab, "document.querySelector('#expirySummary').textContent"), /หมดอายุ/, 'synthetic expiry warning remains in the persistent summary');
  }
  async function saveGlobal(value, expected) {
    await fill({ warnDays: String(value) });
    assert.match(await evaluate(tab, "document.querySelector('#warnDaysStatus').textContent"), /ยังไม่ได้บันทึก/);
    await clickControl(tab, '#saveWarnDaysBtn');
    await waitExpression(tab, `!document.querySelector('#saveWarnDaysBtn').disabled&&document.querySelector('#warnDaysStatus').textContent.includes(${js(expected || 'บันทึกแล้ว')})`, 'global expiry save result');
  }
  for (const origin of origins) {
    await tab.send('Page.navigate', { url: origin + '/login.html' });
    await waitExpression(tab, "document.readyState==='complete'&&!!document.querySelector('#go')", 'stock login');
    await fill({ u: 'front', p: 'front123' }); await clickControl(tab, '#go');
    await waitExpression(tab, "typeof ME!=='undefined'&&ME?.role==='front'", 'stock front session');
    await tab.send('Page.navigate', { url: origin + '/stock.html' }); await stockReady();
    // Reset this independent scenario, never an installed clinic's settings.
    await evaluate(tab, "api('POST','/api/stock/expiry-warning',{days:90})", true);
    await tab.send('Page.reload', {}); await stockReady();
    assert.equal(await evaluate(tab, "document.querySelector('#warnDays').value"), '90');
    assert.match(await evaluate(tab, "document.querySelector('#warnDaysHelp').innerText"), /90 วัน/);
    await layout(['#warnDays', '#saveWarnDaysBtn', '#filter'], 'global expiry controls versus search');
    const globalVisible = await evaluate(tab, "(()=>{const n=document.querySelector('.stock-warning-panel');n.scrollIntoView({block:'center'});const i=document.querySelector('#warnDays'),r=i.getBoundingClientRect();return {text:n.innerText,label:i.labels[0].textContent,atPoint:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===i};})()");
    assert(globalVisible.atPoint, 'days input must remain visibly clickable');
    assert.match(globalVisible.label, /วันล่วงหน้า/);
    assert.match(globalVisible.text, /ค่าเริ่มต้นสำหรับยาที่ยังไม่ได้ตั้งเฉพาะ/);
    await shot('stock-warning-settings', origin, '.stock-warning-panel');

    // Existing trial examples are inspected only: several lot states, real relative dates.
    const demo = await evaluate(tab, `(()=>{const names=['Amlodipine 5mg','Amoxicillin 500mg','Paracetamol 500mg'];return names.map(name=>{const d=drugs.find(x=>x.name===name);return d?{id:d.id,name:d.name,state:expiryState(d),active:d.active_lots}:null;});})()`);
    assert(demo.every(Boolean), 'trial drug examples must exist');
    assert.equal(demo[0].state, 'expiring'); assert(demo[0].active >= 2, 'trial needs two open lots to demonstrate rotation');
    assert.equal(demo[1].state, 'expired'); assert.equal(demo[2].state, '');
    await fill({ filter: 'Amlodipine 5mg' });
    await clickControl(tab, `#drugTable tr[data-drug-id="${demo[0].id}"] a`);
    await waitExpression(tab, "!!document.querySelector('#lotGuide')&&document.querySelector('#lotTable').rows.length>=3", 'trial lots visible');
    let modalText = await evaluate(tab, "document.querySelector('#modalBack').innerText");
    assert.match(modalText, /ใกล้หมดอายุ/); assert.match(modalText, /ยังไม่ถึงช่วงเตือน/);
    assert.match(modalText, /ไม่ได้แยกจำนวนคงเหลือตามล็อต/); assert.match(modalText, /ปิดล็อตไม่ตัดจำนวนคงเหลือ/);
    await layout(['#lotGuide', '#lotTable'], 'lot guide and rows');
    await shot('stock-trial-lots', origin);
    await clickControl(tab, '.lot-actions button:nth-child(2)');
    await waitExpression(tab, "document.querySelector('#lotTable')?.innerText.includes('ปิดแล้ว')", 'closed trial lot history');
    await shot('stock-trial-lot-history', origin); await clickControl(tab, '.lot-actions button:last-child');
    await fill({ filter: 'Amoxicillin 500mg' });
    assert.match(await evaluate(tab, `document.querySelector('#drugTable tr[data-drug-id="${demo[1].id}"]').innerText`), /หมดอายุแล้ว/);
    await shot('stock-expired-example', origin, '#drugTable');

    await saveGlobal(60);
    assert.equal(await evaluate(tab, 'warnDays'), 60);
    await tab.send('Page.reload', {}); await stockReady();
    assert.equal(await evaluate(tab, "document.querySelector('#warnDays').value"), '60');
    assert.match(await evaluate(tab, "document.querySelector('#drugWarnHelp').innerText"), /60 วัน/);
    // The commit really happens, but its reply is suppressed in the isolated browser.
    await evaluate(tab, "window.__stockRealApi=api;window.api=async(m,u,b)=>{const value=await __stockRealApi(m,u,b);if(m==='POST'&&u==='/api/stock/expiry-warning')throw Error('คำตอบสังเคราะห์หายหลังบันทึก');return value;};true");
    await saveGlobal(61, 'ตรวจพบว่าบันทึกแล้ว');
    assert.equal(await evaluate(tab, 'warnDays'), 61);
    await shot('stock-setting-confirmed-after-lost-reply', origin, '.stock-warning-panel');
    await evaluate(tab, "window.api=__stockRealApi;true");
    // A failure before commit must preserve the requested input, show the actual saved value, and allow retry.
    await evaluate(tab, "window.api=async(m,u,b)=>{if(m==='POST'&&u==='/api/stock/expiry-warning')throw Error('สังเคราะห์ส่งไม่ถึงเครื่องหลัก');return __stockRealApi(m,u,b);};true");
    await saveGlobal(62, 'ยังไม่ได้เปลี่ยน');
    assert.equal(await evaluate(tab, 'warnDays'), 61);
    assert.equal(await evaluate(tab, "document.querySelector('#warnDays').value"), '62');
    assert.match(await evaluate(tab, "document.querySelector('#warnDaysStatus').innerText"), /กำลังใช้ 61 วัน/);
    await shot('stock-setting-retry', origin, '.stock-warning-panel');
    await evaluate(tab, "window.api=__stockRealApi;true"); await clickControl(tab, '#saveWarnDaysBtn');
    await waitExpression(tab, "warnDays===62&&!document.querySelector('#saveWarnDaysBtn').disabled&&document.querySelector('#warnDaysStatus').innerText.includes('บันทึกแล้ว')", 'same input retry saved');
    await saveGlobal(60);

    // A separate synthetic drug keeps all teaching examples unchanged across repeated viewports/origins.
    const name = `ล็อตสังเคราะห์ ${viewport.screenWidth} ${viewport.dpr} ${new URL(origin).hostname} ${Date.now()}`;
    const fixture = await evaluate(tab, `(async()=>{const day=n=>{const d=new Date();d.setDate(d.getDate()+n);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};const created=await api('POST','/api/drugs',{name:${js(name)},unit:'ขวด',price:10,cost:2,reorder_level:10,expiry_warn_days:null,op_id:crypto.randomUUID()});for(const [qty,offset,label] of [[2,30,'BROWSER-NEAR'],[3,365,'BROWSER-FAR']])await api('POST','/api/drugs/'+created.id+'/receive',{qty,expiry_date:day(offset),lot_label:label,op_id:crypto.randomUUID()});const lots=await api('GET','/api/drugs/'+created.id+'/lots');return {id:created.id,near:lots.find(l=>l.lot_label==='BROWSER-NEAR').id,far:day(365)};})()`, true);
    await tab.send('Page.reload', {}); await stockReady(); await fill({ filter: name });
    await evaluate(tab, "window.__stockRepeatExpiryToasts=0;window.__stockSaveToasts=0;window.__stockOriginalToast=toast;window.toast=(message,...rest)=>{if(String(message).startsWith('⏰'))window.__stockRepeatExpiryToasts++;if(['บันทึกรายการยาแล้ว','บันทึกราคาและทุนแล้ว'].includes(String(message)))window.__stockSaveToasts++;return __stockOriginalToast(message,...rest);};true");
    const row = `#drugTable tr[data-drug-id="${fixture.id}"]`;
    let rowText = await evaluate(tab, `document.querySelector(${js(row)}).innerText`);
    assert.match(rowText, /5 ขวด/); assert.match(rowText, /จำนวนเหลือน้อย/); assert.match(rowText, /ใกล้หมดอายุ/);
    await clickControl(tab, `button[onclick="editDrug(${fixture.id})"]`);
    assert.match(await evaluate(tab, "document.querySelector('#drugReorderLabel').innerText"), /ขวด/);
    assert.match(await evaluate(tab, "document.querySelector('#drugReorderHelp').innerText"), /10 ขวด.*ไม่ใช่จำนวนล็อต/);
    await fill({ d_unit: 'เม็ด' }); assert.match(await evaluate(tab, "document.querySelector('#drugReorderLabel').innerText"), /เม็ด/);
    await fill({ d_unit: 'ขวด', d_warn: '14' });
    assert.match(await evaluate(tab, "document.querySelector('#drugWarnHelp').innerText"), /14 วัน.*60 วัน/);
    await layout(['#d_reorder', '#drugReorderHelp', '#d_warn', '#drugWarnHelp'], 'quantity and expiry form explanations');
    await shot('stock-quantity-vs-expiry', origin, '.stock-warning-fields');
    await clickControl(tab, 'button[onclick="saveDrug()"]');
    await waitExpression(tab, `drugs.some(d=>d.id===${fixture.id}&&d.expiry_warn_days===14)&&!pendingDrugSave`, 'per drug 14 days saved');
    assert.doesNotMatch(await evaluate(tab, `document.querySelector(${js(row)}).innerText`), /ใกล้หมดอายุ/);
    await clickControl(tab, row + ' a'); await waitExpression(tab, "!!document.querySelector('#lotGuide')", 'custom lot guide visible');
    assert.match(await evaluate(tab, "document.querySelector('#lotGuide').innerText"), /14 วัน.*ตั้งเฉพาะยานี้/);
    await clickControl(tab, '.lot-actions button:last-child');
    await clickControl(tab, `button[onclick="editDrug(${fixture.id})"]`); await fill({ d_warn: '' });
    await clickControl(tab, 'button[onclick="saveDrug()"]');
    await waitExpression(tab, `drugs.some(d=>d.id===${fixture.id}&&d.expiry_warn_days==null)&&!pendingDrugSave`, 'blank returns to inherited days');
    assert.match(await evaluate(tab, `document.querySelector(${js(row)}).innerText`), /ใกล้หมดอายุ/);
    assert.equal(await evaluate(tab, 'window.__stockSaveToasts'), 0, 'catalog saves already have persistent status and must not stack success toasts over receive');
    assert.match(await evaluate(tab, "document.querySelector('#drugSaveStatus').textContent"), /บันทึก/);
    await clickControl(tab, `button[onclick="receive(${fixture.id})"]`);
    await waitExpression(tab, "!!document.querySelector('#mQty')", 'receive quantities and date');
    const receiveText = await evaluate(tab, "document.querySelector('#modalBack').innerText");
    assert.match(receiveText, /ขวด ไม่ใช่จำนวนล็อต/); assert.match(receiveText, /วันหมดอายุบนกล่อง/); assert.match(receiveText, /ใช้ค่าเริ่มต้น 60/);
    await layout(['#mQty', '#mCost', '#mExpiry', '#mLot', '#mWarn'], 'receive form');
    await shot('stock-receive-meaning', origin); await clickControl(tab, '#modalBack button[onclick="closeModal()"]');
    // Real close action: date advances, stock quantity remains five, closed row survives in history.
    await clickControl(tab, row + ' a'); await waitExpression(tab, "!!document.querySelector('#lotGuide')", 'action lots');
    await clickControl(tab, `button[onclick="clearLotAsk(${fixture.id},${fixture.near})"]`);
    await waitExpression(tab, "!!document.querySelector('#mReason')", 'close lot reason');
    await fill({ mReason: 'สังเคราะห์ใช้ล็อตหมดแล้ว ทดสอบการเตือน' }); await clickControl(tab, '#mAskOk');
    await waitExpression(tab, "!!document.querySelector('#lotTable')&&document.querySelector('#lotTable').innerText.includes('BROWSER-FAR')&&!document.querySelector('#lotTable').innerText.includes('BROWSER-NEAR')", 'next open lot is visible');
    await waitExpression(tab, `drugs.some(d=>d.id===${fixture.id}&&d.expiry_date===${js(fixture.far)}&&d.qty_on_hand===5)`, 'closing lot preserves aggregate count');
    assert.match(await evaluate(tab, "document.querySelector('#lotTable').innerText"), /ยังไม่ถึงช่วงเตือน/);
    await shot('stock-next-lot-unchanged-quantity', origin);
    await clickControl(tab, '.lot-actions button:nth-child(2)');
    await waitExpression(tab, "document.querySelector('#lotTable').innerText.includes('BROWSER-NEAR')&&document.querySelector('#lotTable').innerText.includes('ปิดแล้ว')", 'closed action lot history preserved');
    await shot('stock-closed-lot-history', origin); await clickControl(tab, '.lot-actions button:last-child');
    rowText = await evaluate(tab, `document.querySelector(${js(row)}).innerText`);
    assert.match(rowText, /5 ขวด/); assert.match(rowText, /จำนวนเหลือน้อย/); assert.doesNotMatch(rowText, /ใกล้หมดอายุ/);
    assert.equal(await evaluate(tab, 'window.__stockRepeatExpiryToasts'), 0, 'saving drug settings and closing a lot must update the persistent summary without repeating the entry warning');
    await shot('stock-low-count-only', origin, '#drugTable');
    // History belongs to the clicked drug and must open in the middle of this screen.
    const historyButton = `button[onclick="showMoves(${fixture.id})"]`;
    await evaluate(tab, "window.__stockHistoryApi=api;window.api=async(m,u,b)=>{if(m==='GET'&&u.endsWith('/movements'))await new Promise(resolve=>{window.__resumeHistory=resolve;});return __stockHistoryApi(m,u,b);};true");
    await clickControl(tab, historyButton);
    await waitExpression(tab, "document.querySelector('#stockMovesStatus')?.textContent.includes('กำลังโหลด')", 'history loading is visible before request finishes');
    await shot('stock-history-loading', origin);
    await evaluate(tab, "__resumeHistory();window.api=__stockHistoryApi;true");
    await waitExpression(tab, "document.querySelector('#stockMovesTable')?.rows.length===3", 'read-only receipt and issue history');
    await waitExpression(tab, "document.querySelector('#modalBack .modal-box').getAnimations().every(a=>a.playState!=='running')", 'history entry animation complete');
    assert((await evaluate(tab, "document.querySelector('#stockMovesTitle').textContent")).includes(name), 'history title identifies the chosen drug');
    const history = await evaluate(tab, "(()=>{const m=document.querySelector('#modalBack .modal-box'),t=document.querySelector('#stockMovesTable');const r=m.getBoundingClientRect(),width=document.documentElement.clientWidth;return {title:document.querySelector('#stockMovesTitle').textContent,text:t.innerText,rows:[...t.querySelectorAll('tr')].slice(1).map(tr=>[...tr.cells].map(td=>td.textContent)),within:r.left>=0&&r.right<=width+1&&r.top>=0&&r.bottom<=innerHeight+1,centered:Math.abs((r.left+r.right)/2-width/2)<3&&Math.abs((r.top+r.bottom)/2-innerHeight/2)<3,hiddenCard:!!document.querySelector('#moveCard')};})()");
    assert(!history.hiddenCard && history.within && history.centered, 'history must fit as a centred modal, not a right-hand card');
    assert.match(history.text, /เวลา/); assert.match(history.text, /ประเภท/); assert.match(history.text, /จำนวน \(ขวด\)/);
    assert(history.rows.every(cells => cells[0] && cells[1] === 'รับเข้า' && /\+[23] ขวด/.test(cells[2])), 'history shows dated receipt movements with drug units');
    await shot('stock-history-centred', origin);
    await clickControl(tab, '#closeStockMoves');
    assert(await evaluate(tab, `!document.querySelector('#stockMovesDialog')&&document.activeElement===document.querySelector(${js(historyButton)})`), 'closing history returns focus to the clicked row');
    await evaluate(tab, "window.api=async(m,u,b)=>{if(m==='GET'&&u.endsWith('/movements'))throw Error('สังเคราะห์อ่านประวัติไม่ได้');return __stockHistoryApi(m,u,b);};true");
    await clickControl(tab, historyButton);
    await waitExpression(tab, "document.querySelector('#stockMovesStatus')?.innerText.includes('ยังโหลดประวัติไม่ได้')&&!document.querySelector('#retryStockMoves').classList.contains('hidden')", 'history failure keeps a visible retry');
    await shot('stock-history-retry', origin); await evaluate(tab, "window.api=__stockHistoryApi;true");
    await clickControl(tab, '#retryStockMoves'); await waitExpression(tab, "document.querySelector('#stockMovesTable')?.rows.length===3", 'history read retry succeeds');
    await clickControl(tab, '#closeStockMoves');
    await saveGlobal(90); // Leave later scenarios with the original default.
    console.log(`STOCK WARNINGS BROWSER PASS ${origin} ${viewport.screenWidth}@${viewport.dpr}: teaching lots/expiry states; quantity units; save/reload/readback/retry; custom/inherited days; close lot/next/unchanged quantity/history; centred movement history/loading/retry/focus; responsive controls`);
  }
};
