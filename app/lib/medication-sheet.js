'use strict';
// Read-only presentation of immutable dispensing receipt lines. Never infer dosage.
const { db, getSetting } = require('./db');
const { matchReceiptDoses, doseVisual } = require('./medication-visual');
const { sanitizeDose, doseText } = require('./notes');
const PAPERS = ['A4', 'A5'];
const FONTS = ['18', '20', '24'];
const SETTINGS = { medication_sheet_enabled: ['0', '1'], medication_sheet_paper: PAPERS, medication_sheet_font: FONTS };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function validateSettings(body) {
  for (const [key, values] of Object.entries(SETTINGS)) if (key in body && !values.includes(body[key])) {
    throw Object.assign(new Error('ใบยาอ่านง่าย: เลือกเปิด/ปิด กระดาษ A4 หรือ A5 และตัวอักษร 18, 20 หรือ 24 pt'), { status: 400 });
  }
}
function enabled() { return getSetting('medication_sheet_enabled', '0') === '1'; }
function problem(r) {
  if (!enabled()) return 'ยังไม่ได้เปิดใบยาอ่านง่าย ให้ผู้ดูแลเปิดที่ ตั้งค่า → กระดาษและการพิมพ์ → ใบยาอ่านง่าย แล้วบันทึก';
  if (!r) return 'ไม่พบใบเสร็จนี้ กลับหน้าคลินิกแล้วเปิดเอกสารของครั้งที่ตรวจอีกครั้ง';
  if (r.status !== 'ISSUED') return 'ใบเสร็จนี้ยกเลิกแล้ว กลับหน้าคลินิกแล้วเลือกใบเสร็จใหม่ของครั้งที่ตรวจ';
  const drugs = r.lines.filter(l => l.line_type === 'drug');
  if (!drugs.length) return 'ใบเสร็จนี้ไม่มีรายการยา จึงไม่มีใบยาให้ออก';
  if (drugs.some(l => !String(l.instructions || '').trim())) return 'ยังออกใบยาอ่านง่ายไม่ได้: บางรายการไม่มีวิธีใช้ที่บันทึกไว้ ให้แพทย์ตรวจรายการยา และแก้ไขผ่านขั้นตอนแก้บิลเดิมก่อน ไม่ควรเติมหรือเดาวิธีใช้บนใบพิมพ์';
  return '';
}
function link(r) {
  return enabled() && r.status === 'ISSUED' && r.lines.some(l => l.line_type === 'drug')
    ? `<a id="medicationSheetLink" href="/print/medication/${encodeURIComponent(r.receipt_no)}" style="display:inline-block;font:18px sans-serif;padding:10px">เปิดใบยาอ่านง่าย</a>` : '';
}
function errorHTML(message) {
  return `<!doctype html><html lang="th"><meta charset="utf-8"><title>ใบยาอ่านง่าย</title><body style="font:20px 'Leelawadee UI',sans-serif;max-width:700px;margin:40px auto;padding:16px"><h1>ยังไม่ออกใบยา</h1><p role="alert">${esc(message)}</p><a href="/index.html">กลับหน้าคลินิก</a></body></html>`;
}
function render(r, opts = {}) {
  const choice = (list, v, key, fallback) => list.includes(String(v)) ? String(v) : list.includes(getSetting(key,'')) ? getSetting(key,'') : fallback;
  const paper = choice(PAPERS, opts.paper, 'medication_sheet_paper', 'A4');
  const font = choice(FONTS, opts.font, 'medication_sheet_font', '20');
  const style = opts.style === 'text' ? 'text' : 'visual';
  const option = (v, selected, label = v) => `<option value="${v}"${v === selected ? ' selected' : ''}>${label}</option>`;
  let orderLines = null;
  if (opts.sample) orderLines = opts.sampleOrder;
  else if (r.order_version_id && r.visit_id) {
    const order = db.prepare('SELECT lines_json FROM order_versions WHERE id = ? AND visit_id = ?').get(r.order_version_id, r.visit_id);
    if (order) { try { orderLines = JSON.parse(order.lines_json); } catch { /* old/corrupt metadata: literal fallback */ } }
  }
  const doses = matchReceiptDoses(r.lines, orderLines);
  const drugs = r.lines.map((line,i)=>({ ...line, visualDose:doses[i] })).filter(l => l.line_type === 'drug');
  const clinic = r.document?.issuer || {};
  const date = String(r.created_at || '').slice(0,10).split('-');
  const thaiDate = date.length === 3 ? `${Number(date[2])}/${Number(date[1])}/${Number(date[0])+543}` : '';
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ใบยาอ่านง่าย ${esc(r.receipt_no)}</title>
<style>
@page { size: ${paper} portrait; margin: 12mm; }
*{box-sizing:border-box}body{margin:0;color:#000;background:#fff;font-family:'Leelawadee UI',Tahoma,sans-serif;font-size:${font}pt;line-height:1.3;overflow-wrap:anywhere}
.sheet{width:100%;table-layout:fixed;border-collapse:collapse}
h1,h2,p{margin:0}h1{font-size:1.2em}h2{font-size:1em;margin-bottom:2mm}.identity{border-bottom:2px solid #000;padding-bottom:3mm}.medicine{border:1px solid #000;border-left:5px solid #000;padding:4mm}.instructions{white-space:pre-wrap}.quantity{margin-top:2mm}.reminder{margin-top:2mm}
.controls{font:18px/1.6 'Leelawadee UI',sans-serif;background:#f2f2f2;padding:16px;margin-bottom:20px}.choices{display:flex;flex-wrap:wrap;gap:12px;align-items:center}button,select,.controls a{font:inherit;padding:8px}#printError{color:#900;font-weight:bold}
.identity{font-size:18pt;line-height:1.25;margin-bottom:3mm}.identity .meta{font-size:12pt}.sample-notice{font-size:12pt}.print-page{width:${paper === 'A4' ? '186' : '124'}mm;height:${paper === 'A4' ? '272' : '185'}mm;position:relative;break-after:page;page-break-after:always}.print-page:last-child{break-after:auto;page-break-after:auto}.page-content{height:calc(100% - 10mm)}.page-counter{position:absolute;bottom:0;font-size:12pt}.medicine{margin-bottom:4mm}#medicationSource{display:none}
.dose-grid{display:grid;grid-template-columns:repeat(${paper==='A5'?'2':'4'},minmax(0,1fr));border:1px solid #000;margin:2mm 0}.dose-cell{text-align:center;padding:2mm 1mm;border:1px solid #555;min-width:0}.dose-icon{width:9mm;height:9mm;display:block;margin:0 auto 1mm}.dose-time{font-size:18pt}.dose-amount{font-weight:bold}.no-dose .dose-amount{font-weight:normal;font-size:18pt}.dose-detail{margin-top:1mm}.dose-heading{display:flex;align-items:center;gap:3mm;font-weight:bold}.dose-heading .dose-icon{margin:0;flex:none}.dose-visual{margin-bottom:3mm;break-inside:avoid}.text-dose-label{font-size:18pt;border-bottom:1px solid #777;margin-bottom:2mm}.instructions-label{font-size:18pt;font-weight:bold;margin-top:2mm}.exact-times{display:grid;gap:1mm}.quantity{font-size:18pt}.medicine{padding:3mm;border-left:3px solid #000}
@media screen{body{max-width:calc(${paper === 'A4' ? '186' : '124'}mm + 24px);margin:20px auto;padding:0 12px}#medicationPages{overflow-x:auto}.print-page{border-bottom:1px dashed #777;margin-bottom:20px}}
.dose-detail{font-size:18pt}.dose-slot-title{display:flex;flex-direction:${paper==='A5'?'row':'column'};align-items:center;justify-content:center;gap:1mm}.dose-slot-title .dose-icon{width:${paper==='A5'?'7':'9'}mm;height:${paper==='A5'?'7':'9'}mm;margin:0}.dose-cell{padding:${paper==='A5'?'1':'2'}mm 1mm}.medicine{line-height:1.2}
@media print{.controls{display:none!important}body{width:auto}#medicationPages{overflow:visible}.print-page{border:0;margin:0}}
</style></head><body>
<div class="controls"><form method="get" class="choices"><label>กระดาษ <select name="paper">${PAPERS.map(v=>option(v,paper)).join('')}</select></label><label>ตัวอักษรรายการยา <select name="font">${FONTS.map(v=>option(v,font,v+' pt')).join('')}</select></label><label>รูปแบบ <select name="style">${option('visual',style,'แบบภาพและข้อความ')}${option('text',style,'แบบข้อความ')}</select></label><button type="submit">ดูขนาดนี้</button></form>
<p>ภาพแสดงเฉพาะคำสั่งที่มีข้อมูลเวลาตรงกับข้อความเดิม รายการที่แปลงไม่ได้จะมีป้าย “อ่านตามข้อความ”</p>
<p>เลือกกระดาษ ${paper} และขนาดจริง 100% ในหน้าต่างพิมพ์ ไม่ใช้ “พอดีหน้า” ปิดส่วนหัวและท้ายของเบราว์เซอร์ ถ้ายาวจะขึ้นหน้าใหม่โดยไม่ลดตัวอักษร</p>
<p>ตรวจชื่อคนไข้และวิธีใช้กับยาที่ส่งมอบก่อนพิมพ์ ใบนี้ไม่ใช่รายการยาทั้งหมดที่ใช้ประจำ</p>
<button type="button" id="printMedication">พิมพ์ใบยาอ่านง่าย</button> <a href="/index.html">กลับหน้าคลินิก</a><p id="printError" role="alert"></p></div>
<div id="medicationSource"><table class="sheet"><thead><tr><th><div class="identity">${opts.sample ? '<div class="sample-notice">ตัวอย่าง — ข้อมูลสมมติ ไม่ใช่คำสั่งใช้ยา</div>' : ''}<h1>ยาที่ได้รับครั้งนี้</h1>${clinic.name ? `<div class="meta">${esc(clinic.name)}</div>` : ''}<div><b>${esc(r.patient_name)}</b> · HN ${esc(r.hn)}</div><div class="meta">วันที่รับยา ${esc(thaiDate)} · อ้างอิง ${esc(r.receipt_no)}</div></div></th></tr></thead><tbody>
${drugs.map((l,i)=>`<tr class="medication"><td><section class="medicine"><h2>${i+1}. ${esc(l.name)}</h2>${style==='visual'?doseVisual(l.visualDose,l.unit):''}<div class="instructions-label">วิธีใช้ตามคำสั่งเดิม</div><div class="instructions">${esc(l.instructions)}</div><div class="quantity">จำนวนที่ได้รับ ${esc(l.qty)} ${esc(l.unit)}</div></section></td></tr>`).join('')}
</tbody></table></div><div id="medicationPages" aria-label="ใบยาที่พร้อมพิมพ์"></div><noscript>กรุณาเปิด JavaScript จึงจะจัดหน้าใบยาพร้อมพิมพ์ได้</noscript>
<script src="/medication-print.js"></script>
<script>
document.getElementById('printMedication').addEventListener('click',async function(){
 if(!window.medicationPaginationReady)return;
 const error=document.getElementById('printError');this.disabled=true;error.textContent='กำลังตรวจว่าใบยายังใช้ได้…';
 try {
 ${opts.sample ? '' : `const response=await fetch(location.href,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('ใบยาอาจถูกปิดใช้หรือใบเสร็จถูกยกเลิก กรุณาเปิดใบยาใหม่จากใบเสร็จที่ยังใช้ได้');`}
 error.textContent='';window.print();
 }catch(e){error.textContent=e.name==='TypeError'||e.name==='TimeoutError'?'ติดต่อเครื่องหลักไม่ได้ ยังไม่สั่งพิมพ์ ตรวจการเชื่อมต่อแล้วกดพิมพ์ใหม่':e.message;}finally{this.disabled=false;}
});
</script></body></html>`;
}
function sample(opts) {
  const dose=sanitizeDose({mode:'standard',m:1,e:0.5,timing:'หลังอาหาร',days:7});
  const lines=[
    {type:'drug',ref_id:1,name:'ยาตัวอย่าง ก',qty:11,unit:'เม็ด',instructions:doseText(dose,'เม็ด'),dose},
    {type:'drug',ref_id:2,name:'ยาตัวอย่าง ข',qty:1,unit:'หลอด',instructions:'ทาบาง ๆ บริเวณที่ระบุ ตามคำสั่งแพทย์'},
  ];
  return render({receipt_no:'SAMPLE',patient_name:'คุณตัวอย่าง อ่านง่าย',hn:'ตัวอย่าง',created_at:'2026-09-13',document:{issuer:{name:'คลินิกตัวอย่าง'}},lines:lines.map(l=>({...l,line_type:l.type}))},{...opts,sample:true,sampleOrder:lines});
}
module.exports = { SETTINGS, PAPERS, FONTS, validateSettings, enabled, problem, link, render, sample, errorHTML };
