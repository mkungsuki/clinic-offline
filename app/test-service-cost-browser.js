'use strict';
module.exports=async function({tab,origins,viewport,evaluate,waitExpression,clickControl}){
 const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
 const money=value=>Number(value||0).toLocaleString('th-TH',{minimumFractionDigits:2});
 const saveEvidence=async(name,origin)=>{
  if(!process.env.CLINIC_SERVICE_COST_EVIDENCE)return;
  const dir=path.resolve(process.env.CLINIC_SERVICE_COST_EVIDENCE);fs.mkdirSync(dir,{recursive:true});
  const shot=await tab.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(dir,`${name}-${viewport.screenWidth}-${viewport.dpr}-${new URL(origin).hostname}.png`),Buffer.from(shot.data,'base64'));
 };
 const verifyCostNote=async(selector,stats,origin)=>{
  const note=await evaluate(tab,`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {text:n.innerText,links:[...n.querySelectorAll('a')].map(a=>a.getAttribute('href')),fits:r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,visible:r.width>0&&r.height>0,alerts:n.matches('[role="alert"],.danger,.warn-box')||!!n.querySelector('[role="alert"],.danger,.warn-box')};})()`);
  assert(note.visible&&note.fits,selector+' explanation must be readable without overflow');
  assert(!note.alerts,selector+' missing historical costs are a neutral explanation, not a repeated error');
  assert.match(note.text,/รายการในใบเสร็จ/);
  assert.match(note.text,/บิลเก่า|ใบเสร็จเดิม/);
  const drug=Number(stats.unknown_drug_cost_lines||0),service=Number(stats.unknown_service_cost_lines||0);
  if(drug)assert.match(note.text,new RegExp('ยา\\s*'+drug+'(?:\\s|รายการ)'),'drug missing-line count');
  if(service)assert.match(note.text,new RegExp('บริการ(?:\\s*/\\s*หัตถการ)?\\s*'+service+'(?:\\s|รายการ)'),'service missing-line count');
  assert.equal(note.links.filter(link=>link==='/stock.html'||link==='/stock.html#drugTable').length,drug?1:0,'show drug settings only for missing drug costs');
  assert.equal(note.links.filter(link=>link==='/stock.html#serviceCard').length,service?1:0,'show service settings only for missing service costs');
  assert.equal(note.links.length,(drug?1:0)+(service?1:0),'one direct settings link per relevant cause');
  assert(Array.isArray(stats.unknown_cost_items)&&stats.unknown_cost_items.length>0,'actual report must identify the missing receipt-time cost names');
  const detailsSelector=selector+' details.cost-details';
  assert(await evaluate(tab,`!!document.querySelector(${JSON.stringify(detailsSelector+' summary')})&&!document.querySelector(${JSON.stringify(detailsSelector)}).open`),'missing-cost names must be available in an initially collapsed list');
  await clickControl(tab,detailsSelector+' summary');
  await waitExpression(tab,`document.querySelector(${JSON.stringify(detailsSelector)}).open`,'owner can open missing-cost names');
  const details=await evaluate(tab,`(()=>{const d=document.querySelector(${JSON.stringify(detailsSelector)});d.scrollIntoView({block:'center'});return {items:[...d.querySelectorAll('li')].map(n=>({text:n.textContent.trim(),visible:n.getBoundingClientRect().height>0&&n.getBoundingClientRect().left>=0&&n.getBoundingClientRect().right<=innerWidth+1})),unsafe:!!d.querySelector('img,script,iframe')};})()`);
  assert(!details.unsafe,'receipt snapshot names must render as plain text');
  assert(details.items.every(item=>item.visible),'each missing-cost name must visibly fit the list');
  const expectedItems=stats.unknown_cost_items.map(item=>`${item.name||'ไม่ระบุชื่อ'} · ${item.line_type==='drug'?'ยา':'บริการ / หัตถการ'} ${Number(item.lines)} รายการในใบเสร็จ`);
  assert.deepEqual(details.items.map(item=>item.text).sort(),expectedItems.sort(),'show exact snapshot names, categories and receipt-line counts from the report');
  assert.equal(stats.unknown_cost_items.reduce((sum,item)=>sum+Number(item.lines),0),Number(stats.unknown_cost_lines),'item details must account for every missing receipt cost');
  await saveEvidence('report-unknown-items-'+selector.slice(1),origin);
  await clickControl(tab,detailsSelector+' summary');
  await waitExpression(tab,`!document.querySelector(${JSON.stringify(detailsSelector)}).open`,'owner can close missing-cost names');
  await evaluate(tab,`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});true`);
 };
 for(const origin of origins){
  await tab.send('Page.navigate',{url:origin+'/login.html'});
  await waitExpression(tab,"document.readyState==='complete' && document.querySelector('#go')",'service login ready');
  await evaluate(tab,"document.querySelector('#u').value='front';document.querySelector('#p').value='front123';document.querySelector('#go').click();true",true);
  await waitExpression(tab,"typeof ME!=='undefined' && ME?.role==='front'",'service front login');
  await tab.send('Page.navigate',{url:origin+'/stock.html'});
  await waitExpression(tab,"typeof services!=='undefined' && services.length>0",'service catalog ready');
  const name='หัตถการสังเคราะห์ '+viewport.screenWidth+' '+viewport.dpr+' '+new URL(origin).hostname;
  await evaluate(tab,`document.querySelector('#svcName').value=${JSON.stringify(name)};document.querySelector('#svcPrice').value='300';document.querySelector('#svcCost').value='120';true`);
  await clickControl(tab,'#addServiceBtn');
  await waitExpression(tab,`services.some(s=>s.name===${JSON.stringify(name)}&&s.cost===120)&&document.querySelector('#serviceSaveStatus').textContent.includes('บันทึก')`,'visible service saved');
  const id=await evaluate(tab,`services.find(s=>s.name===${JSON.stringify(name)}).id`);
  await clickControl(tab,`#svcTable tr[data-service-id="${id}"] button`);
  await waitExpression(tab,"!!document.querySelector('#mCost')",'edit cost dialog');
  assert.equal(await evaluate(tab,"document.querySelector('#mCost').value"),'120');
  await evaluate(tab,"document.querySelector('#mCost').value='';true");await clickControl(tab,'#mAskOk');
  await waitExpression(tab,`document.querySelector('#svcTable tr[data-service-id="${id}"]').textContent.includes('ยังไม่ใส่ทุน')`,'blank cost must visibly be unknown');
  await clickControl(tab,`#svcTable tr[data-service-id="${id}"] button`);
  await evaluate(tab,"document.querySelector('#mCost').value='0';true");await clickControl(tab,'#mAskOk');
  await waitExpression(tab,`services.find(s=>s.id===${id}).cost===0&&!document.querySelector('#mCost')`,'explicit zero saved');
  // Lose the HTTP response AFTER the server committed, then reload before retry.
  const lost=name+' ตอบกลับหาย';
  await evaluate(tab,`window.__realApi=api;window.api=async(method,url,body)=>{const result=await __realApi(method,url,body);if(method==='POST'&&url==='/api/services')throw new Error('สังเคราะห์ตอบกลับหาย');return result;};document.querySelector('#svcName').value=${JSON.stringify(lost)};document.querySelector('#svcPrice').value='300';document.querySelector('#svcCost').value='120';true`);
  await clickControl(tab,'#addServiceBtn');
  await waitExpression(tab,"!document.querySelector('#retryServiceSave').classList.contains('hidden')",'persistent lost-response recovery');
  await tab.send('Page.reload',{});
  await waitExpression(tab,"typeof services!=='undefined' && services.length>0 && !document.querySelector('#retryServiceSave').classList.contains('hidden')",'pending save survives reload');
  await clickControl(tab,'#retryServiceSave');
  await waitExpression(tab,`!pendingServiceSave&&services.filter(s=>s.name===${JSON.stringify(lost)}).length===1&&document.querySelector('#serviceSaveStatus').textContent.includes('บันทึก')`,'retry shows one saved item');
  const layout=await evaluate(tab,`(()=>{const ids=['svcName','svcPrice','svcCost','addServiceBtn'];const rects=ids.map(id=>document.getElementById(id).getBoundingClientRect());return {fits:rects.every(r=>r.left>=0&&r.right<=innerWidth),noOverlap:rects.every((r,i)=>rects.slice(i+1).every(b=>r.right<=b.left||b.right<=r.left||r.bottom<=b.top||b.bottom<=r.top))};})()`);
  assert(layout.fits&&layout.noOverlap,'service inputs overlap/overflow');
  if(process.env.CLINIC_SERVICE_COST_EVIDENCE){const dir=path.resolve(process.env.CLINIC_SERVICE_COST_EVIDENCE);fs.mkdirSync(dir,{recursive:true});await evaluate(tab,"document.querySelector('#serviceCard').scrollIntoView({block:'start'});true");const shot=await tab.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,`service-${viewport.screenWidth}-${viewport.dpr}-${new URL(origin).hostname}.png`),Buffer.from(shot.data,'base64'));}
  await tab.send('Page.navigate',{url:origin+'/reports.html'});
  await waitExpression(tab,"document.querySelector('#cards')?.innerText.includes('เหลือหลังต้นทุนตรง')",'direct-cost report card');
  const fixture=await evaluate(tab,"(async()=>{const daily=await api('GET','/api/reports/daily?date='+document.querySelector('#rptDate').value);const year=document.querySelector('#ledgerYear').value;const ledger=await api('GET','/api/reports/ledger?year='+year);return {daily,year,ledger};})()",true);
  assert(fixture.daily.money.unknown_drug_cost_lines>0,'synthetic daily fixture must include genuinely missing drug cost');
  assert(fixture.ledger.months.length>1&&fixture.ledger.total.unknown_service_cost_lines>0,'synthetic annual fixture must exercise repeated historical service-cost gaps');
  await waitExpression(tab,"!!document.querySelector('#dailyCostNote')?.textContent.trim()&&!!document.querySelector('#ledgerCostNote')?.textContent.trim()",'scoped explanations must be loaded');
  const cards=await evaluate(tab,"[...document.querySelectorAll('#cards .card')].map(c=>({label:c.querySelector('.muted')?.textContent.trim(),amount:c.querySelector('.big-num')?.textContent.trim(),unknown:!!c.querySelector('.cost-unavailable[aria-label]'),text:c.innerText}))");
  for(const [label,value,unknown] of [['รายรับรวม',fixture.daily.money.total,0],['ทุนยาที่จ่าย',fixture.daily.money.drug_cost,fixture.daily.money.unknown_drug_cost_lines],['ต้นทุนบริการ / หัตถการ',fixture.daily.money.service_cost,fixture.daily.money.unknown_service_cost_lines],['เหลือหลังต้นทุนตรง',fixture.daily.money.gross_profit,fixture.daily.money.unknown_cost_lines]]){
   const card=cards.find(c=>c.label===label);assert(card,'missing card '+label);
   assert.equal(card.amount,unknown?'—':money(value),label+' must preserve revenue/known values and mark unknown amounts');
   assert.equal(card.unknown,!!unknown,label+' must expose a readable unavailable-value label');
  }
  assert(cards.some(c=>c.text.includes('ไม่ใช่กำไรสุทธิ')));
  assert(!cards.some(c=>/ทุนไม่ครบ|ยังคำนวณไม่ได้/.test(c.text)),'no repeated warning prose inside numeric cards');
  await verifyCostNote('#dailyCostNote',fixture.daily.money,origin);
  await saveEvidence('report-unknown-daily',origin);
  await evaluate(tab,"document.querySelector('#ledgerTable').closest('details').open=true;true");
  await verifyCostNote('#ledgerCostNote',fixture.ledger.total,origin);
  const ledger=await evaluate(tab,"(()=>{const table=document.querySelector('#ledgerTable'),note=document.querySelector('#ledgerCostNote');return {rows:[...table.querySelectorAll('tr')].filter(r=>r.cells.length===10&&r.querySelector('td')).map(r=>[...r.cells].map(c=>c.textContent.trim())),text:table.innerText,before:!!(note.compareDocumentPosition(table)&Node.DOCUMENT_POSITION_FOLLOWING),accessible:[...table.querySelectorAll('.cost-unavailable')].every(n=>!!n.getAttribute('aria-label'))};})()");
  assert(ledger.before&&ledger.accessible,'annual explanation precedes table and dashes remain accessible');
  assert.doesNotMatch(ledger.text,/ทุนไม่ครบ|ยังคำนวณไม่ได้/,'annual rows must not repeat missing-cost prose');
  assert.equal(ledger.rows.length,fixture.ledger.months.length+1);
  for(const [i,entry] of [...fixture.ledger.months,fixture.ledger.total].entries()){
   const row=ledger.rows[i];
   assert.equal(row[2],money(entry.total),'annual revenue must not disappear because a cost is missing');
   assert.equal(row[7],entry.unknown_cost_lines?'—':money(entry.direct_cost));
   assert.equal(row[8],entry.unknown_cost_lines?'—':money(entry.gross_profit));
  }
  await saveEvidence('report-unknown-ledger',origin);
  await evaluate(tab,"document.querySelector('#rptDate').value='2020-03-15';document.querySelector('#rptDate').dispatchEvent(new Event('change'));true",true);
  await waitExpression(tab,"[...document.querySelectorAll('#cards .card')].some(c=>c.innerText.includes('เหลือหลังต้นทุนตรง')&&c.querySelector('.big-num')?.textContent==='180.00')",'300 minus 120 must visibly equal 180');
  assert(await evaluate(tab,"document.querySelector('#dailyCostNote').textContent.trim()===''&&[...document.querySelectorAll('#cards .card')].some(c=>c.querySelector('.muted')?.textContent==='ทุนยาที่จ่าย'&&c.querySelector('.big-num')?.textContent==='0.00')"),'known costs clear stale daily explanation and keep explicit zero');
  const cardFits=await evaluate(tab,"(()=>{const c=[...document.querySelectorAll('#cards .card')].find(c=>c.innerText.includes('เหลือหลังต้นทุนตรง'));c.scrollIntoView({block:'center'});const r=c.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height>0;})()");assert(cardFits);
  await saveEvidence('report-known-daily',origin);
  // These synthetic historical fixtures predate the normal five-year dropdown.
  // Adding options exercises the real change handler and API without changing product defaults.
  await evaluate(tab,"(()=>{const y=document.querySelector('#ledgerYear');for(const year of ['2020','2019'])if(![...y.options].some(o=>o.value===year)){const o=document.createElement('option');o.value=year;o.textContent=String(Number(year)+543);y.append(o);}y.value='2020';y.dispatchEvent(new Event('change'));return true;})()",true);
  await waitExpression(tab,"document.querySelector('#ledgerTable').textContent.includes('180.00')&&!document.querySelector('#ledgerCostNote').textContent.trim()",'known year clears unknown-cost explanation');
  const knownYear=await evaluate(tab,"[...document.querySelectorAll('#ledgerTable tr')].filter(r=>r.cells.length===10&&r.querySelector('td')).map(r=>[...r.cells].map(c=>c.textContent.trim()))");
  assert.equal(knownYear.length,2);
  for(const row of knownYear){assert.equal(row[2],'300.00');assert.equal(row[5],'0.00');assert.equal(row[7],'120.00');assert.equal(row[8],'180.00');}
  await evaluate(tab,"document.querySelector('#ledgerTable').scrollIntoView({block:'center'});true");
  await saveEvidence('report-known-ledger',origin);
  await evaluate(tab,`document.querySelector('#ledgerYear').value=${JSON.stringify(fixture.year)};document.querySelector('#ledgerYear').dispatchEvent(new Event('change'));true`,true);
  await waitExpression(tab,"!!document.querySelector('#ledgerCostNote').textContent.trim()&&!!document.querySelector('#ledgerTable .cost-unavailable')",'returning to unknown year restores one scoped explanation');
  await evaluate(tab,"document.querySelector('#ledgerYear').value='2019';document.querySelector('#ledgerYear').dispatchEvent(new Event('change'));true",true);
  await waitExpression(tab,"document.querySelector('#ledgerTable').textContent.includes('ยังไม่มีรายรับปีนี้')",'empty historical year has no receipt rows');
  assert(await evaluate(tab,"document.querySelector('#ledgerCostNote').textContent.trim()===''&&!document.querySelector('#ledgerTable .cost-unavailable')"),'empty year clears stale cost explanation and unknown amounts');
  await evaluate(tab,"document.querySelector('#ledgerTable').scrollIntoView({block:'center'});true");
  await saveEvidence('report-empty-ledger',origin);
  console.log('  PASS service cost browser: '+new URL(origin).hostname+' add/edit/blank/zero/lost response+reload/retry; one scoped cause, accurate counts/links, accessible unknowns, known180/zero/revenue, year changes/empty/layout');
 }
};
