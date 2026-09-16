'use strict';
// Read-only labels from issued receipt_lines. No dosage inference or new document issue.
const { getSetting } = require('./db');
const LAYOUTS={
 'a4-2x5':{width:210,height:297,columns:2,rows:5,labelWidth:105,labelHeight:59.4,title:'A4 · 2 × 5 ช่อง'},
 'a4-3x8':{width:210,height:297,columns:3,rows:8,labelWidth:70,labelHeight:37.125,title:'A4 · 3 × 8 ช่อง'},
 roll:{width:80,height:50,columns:1,rows:1,labelWidth:80,labelHeight:50,title:'ม้วนฉลาก (ทดลอง)'},
};
const SETTINGS={drug_label_enabled:['0','1'],drug_label_layout:Object.keys(LAYOUTS),drug_label_width:null,drug_label_height:null};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function bad(message){throw Object.assign(new Error('ฉลากยา: '+message),{status:400});}
function size(v){const n=Number(v);if(!Number.isFinite(n)||n<20||n>200)bad('ขนาดม้วนต้องอยู่ระหว่าง 20–200 มม.');return n;}
function enabled(){return getSetting('drug_label_enabled','0')==='1';}
function validateSettings(body){for(const[k,values]of Object.entries(SETTINGS))if(k in body){if(values&&!values.includes(body[k]))bad('เลือกเปิด/ปิดและรูปแบบกระดาษจากรายการ');if(!values)size(body[k]);}}
function options(opts={},total=0){
 const layout=opts.layout||getSetting('drug_label_layout','a4-2x5')||'a4-2x5';if(!LAYOUTS[layout])bad('เลือกรูปแบบกระดาษจากรายการ');
 const paper={...LAYOUTS[layout]};
 if(layout==='roll'){paper.width=paper.labelWidth=size(opts.width||getSetting('drug_label_width','80')||80);paper.height=paper.labelHeight=size(opts.height||getSetting('drug_label_height','50')||50);}
 const slots=paper.columns*paper.rows,start=Number(opts.start??1);
 if(!Number.isInteger(start)||start<1||start>slots)bad('ช่องเริ่มพิมพ์ต้องอยู่ระหว่าง 1–'+slots);
 const selected=opts.items===undefined?Array.from({length:total},(_,i)=>i):opts.items===''?[]:String(opts.items).split(',').map(x=>Number(x));
 if(selected.some(i=>!Number.isInteger(i)||i<0||i>=total)||new Set(selected).size!==selected.length)bad('เลือกรายการยาใหม่จากใบเสร็จ');
 return {layout,paper,slots,start,selected};
}
function problem(r){
 if(!enabled())return 'ยังไม่ได้เปิดฉลากยาติดซอง ให้ผู้ดูแลเปิดที่ ตั้งค่า → กระดาษและการพิมพ์ → ฉลากยาติดซอง';
 if(!r)return 'ไม่พบใบเสร็จนี้ กลับหน้าคลินิกแล้วเปิดเอกสารอีกครั้ง';
 if(r.status!=='ISSUED')return 'ใบเสร็จนี้ยกเลิกแล้ว กรุณาเลือกใบเสร็จใหม่';
 const drugs=r.lines.filter(l=>l.line_type==='drug');
 if(!drugs.length)return 'ใบเสร็จนี้ไม่มีรายการยา';
 if(drugs.some(l=>!String(l.instructions||'').trim()))return 'ยังพิมพ์ฉลากไม่ได้ บางรายการไม่มีวิธีใช้ที่บันทึกไว้ ให้แพทย์ตรวจและแก้ผ่านขั้นตอนแก้บิลเดิมก่อน ห้ามเติมวิธีใช้บนฉลาก';
 return '';
}
function link(r){return enabled()&&r.status==='ISSUED'&&r.lines.some(l=>l.line_type==='drug')?`<a id="drugLabelLink" href="/print/labels/${encodeURIComponent(r.receipt_no)}" style="display:inline-block;font:18px sans-serif;padding:10px">เปิดฉลากยาติดซอง</a>`:'';}
function errorHTML(message){return `<!doctype html><html lang="th"><meta charset="utf-8"><title>ฉลากยา</title><body style="font:20px sans-serif;padding:24px"><h1>ยังพิมพ์ฉลากยาไม่ได้</h1><p role="alert">${esc(message)}</p><a href="/index.html">กลับหน้าคลินิก</a></body></html>`;}
function render(r,opts={}){
 const drugs=r.lines.filter(l=>l.line_type==='drug'),o=options(opts,drugs.length),p=o.paper;
 const clinic=opts.sample?'คลินิกตัวอย่าง':getSetting('clinic_name',''),phone=opts.sample?'02-000-0000':getSetting('clinic_phone','');
 const doctor=getSetting('receipt_show_doctor','1')==='1'?(r.document?.cashier?.doctor_name||''):'';
 const date=String(r.created_at||'').slice(0,10).split('-'),thaiDate=date.length===3?`${Number(date[2])}/${Number(date[1])}/${Number(date[0])+543}`:'';
 const compact=o.layout==='a4-3x8',canPrint=opts.canPrint!==false;
 const option=(value,label)=>`<option value="${value}"${o.layout===value?' selected':''}>${label}</option>`;
 return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ฉลากยา ${esc(r.receipt_no)}</title><style>
@page{size:${p.width}mm ${p.height}mm;margin:0}*{box-sizing:border-box}body{margin:0;background:#fff;color:#000;font-family:'Leelawadee UI',Tahoma,sans-serif}button,input,select{font:inherit}button,select,input[type=number]{padding:6px}h1{font-size:24px;margin:0 0 12px}.controls{font:16px/1.5 'Leelawadee UI',sans-serif;background:#f4f4f4;padding:16px}.choices{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.choices label{display:flex;gap:6px;align-items:center;flex-wrap:wrap}input[type=number]{width:90px}.items{display:flex;flex-wrap:wrap;gap:12px}.items label{max-width:100%;overflow-wrap:anywhere}#labelWarnings,#printError{font-weight:bold;color:#900}#labelSource{display:none}.label-page{display:grid;grid-template-columns:repeat(${p.columns},${p.labelWidth}mm);grid-template-rows:repeat(${p.rows},${p.labelHeight}mm);width:${p.width}mm;height:${p.height}mm;break-after:page;page-break-after:always}.label-page:last-child{break-after:auto;page-break-after:auto}.drug-label{width:${p.labelWidth}mm;height:${p.labelHeight}mm;padding:${compact?'1.5':'2.5'}mm;overflow-wrap:anywhere;line-height:1.15;color:#000;background:#fff}.label-content{width:100%;height:100%}.clinic,.identity,.quantity,.sample{font-size:${compact?'8':'9'}pt}.drug-name{font-size:${compact?'11':'14'}pt;font-weight:bold;margin:.7mm 0}.instructions{font-size:${compact?'10':'12'}pt;white-space:pre-wrap}.quantity,.identity{margin-top:.6mm}.sample{font-weight:bold}.label-page .empty{background:#fff}
@media screen{#labelPages{overflow:auto;padding:12px}.label-page{border:1px solid #777;margin:0 auto 20px}.drug-label{outline:1px dashed #bbb}.overfull{outline:2px solid #900}.overfull .label-content{overflow:auto}.controls{position:relative}#labelWarnings p{margin:4px 0}}
@media print{.controls{display:none!important}#labelPages{padding:0;overflow:visible}.drug-label{outline:0}body.labels-blocked #labelPages{display:none!important}body.labels-blocked::before{content:'ยังพิมพ์ไม่ได้ กรุณากลับไปตรวจข้อความเตือนในหน้าฉลาก';font-size:16pt}}
</style></head><body class="labels-blocked" data-can-print="${canPrint?'1':'0'}" data-sample="${opts.sample?'1':'0'}" data-slots="${o.slots}"><div class="controls"><h1>ฉลากยาติดซอง${opts.sample?' — ตัวอย่างข้อมูลสมมติ':''}</h1>
<form method="get" id="labelForm"><div class="choices"><label>รูปแบบ <select name="layout">${Object.entries(LAYOUTS).map(([k,v])=>option(k,v.title)).join('')}</select></label><label>กว้างม้วน (มม.) <input name="width" type="number" min="20" max="200" step="0.1" value="${o.layout==='roll'?p.width:80}"></label><label>สูงม้วน (มม.) <input name="height" type="number" min="20" max="200" step="0.1" value="${o.layout==='roll'?p.height:50}"></label><button>ใช้ขนาดนี้</button></div><input type="hidden" name="items" id="selectedItems" value="${o.selected.join(',')}"></form>
<p>พิมพ์ขนาดจริง 100% ปิดหัวและท้ายกระดาษ เลือกกระดาษให้ตรง ลองบนกระดาษเปล่าก่อนติดซอง ขอบที่เครื่องพิมพ์พิมพ์ไม่ถึงอาจทำให้ตำแหน่งคลาดเคลื่อน</p>
${o.layout==='roll'?'<p>ม้วนฉลากเป็นการทดลอง ยังไม่ได้ทดสอบกับเครื่องพิมพ์จริง และไม่รับประกันการตั้งขนาดของไดรเวอร์</p>':''}
<label>เริ่มพิมพ์ที่ช่องที่ <input id="labelStart" form="labelForm" name="start" type="number" value="${o.start}" min="1" max="${o.slots}"> (นับจากซ้ายไปขวา แล้วลงแถวถัดไป)</label>
<p>เลือกรายการยา</p><div class="items">${drugs.map((l,i)=>`<label><input type="checkbox" class="label-choice" value="${i}"${o.selected.includes(i)?' checked':''}>${esc(l.name)}</label>`).join('')}</div>
<div id="labelWarnings" role="alert"></div><button type="button" id="printLabels" disabled>${canPrint?'พิมพ์ฉลากยา':'ให้หน้าร้านพิมพ์ฉลากยา'}</button> <a href="/index.html">กลับหน้าคลินิก</a><p id="printError" role="alert"></p></div>
<div id="labelSource">${drugs.map((l,i)=>`<section class="drug-label" data-item="${i}" data-name="${esc(l.name)}"><div class="label-content">${opts.sample?'<div class="sample">ตัวอย่าง — ข้อมูลสมมติ</div>':''}<div class="clinic">${esc(clinic)}${phone?' · โทร '+esc(phone):''}</div><div class="drug-name">${esc(l.name)}</div><div class="instructions">${esc(l.instructions)}</div><div class="quantity">จำนวน ${esc(l.qty)} ${esc(l.unit)}</div><div class="identity">${esc(r.patient_name)} · HN ${esc(r.hn)} · ${esc(thaiDate)}${doctor?'<br>'+esc(doctor):''}</div></div></section>`).join('')}</div><div id="labelPages" aria-label="ฉลากที่เลือก"></div><noscript>กรุณาเปิด JavaScript เพื่อจัดฉลากและตรวจข้อความล้นก่อนพิมพ์</noscript><script src="/drug-label-print.js"></script></body></html>`;
}
function sample(opts={}){return render({receipt_no:'SAMPLE',patient_name:'คุณตัวอย่าง',hn:'ตัวอย่าง',created_at:'2026-09-14',lines:[{line_type:'drug',name:'ยาตัวอย่าง ก 500 mg',instructions:'ครั้งละ 1 เม็ด หลังอาหารเช้าและเย็น',qty:10,unit:'เม็ด'},{line_type:'drug',name:'ยาตัวอย่าง ข',instructions:'ทาบาง ๆ บริเวณที่ระบุ\nตามคำสั่งแพทย์',qty:1,unit:'หลอด'}]},{...opts,sample:true});}
module.exports={LAYOUTS,SETTINGS,validateSettings,options,enabled,problem,link,render,sample,errorHTML};
