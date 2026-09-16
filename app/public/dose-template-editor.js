'use strict';
let stockDose = DoseTemplate.empty('standard');
function resetStockDose(value, mode) {
  stockDose = value ? structuredClone(value) : DoseTemplate.empty(mode || 'standard');
  document.getElementById('d_dose_mode').value = stockDose.mode;
  renderStockDose();
}
function changeStockDoseMode() {
  stockDose = DoseTemplate.empty(document.getElementById('d_dose_mode').value);
  renderStockDose();
}
function renderStockDose() {
  const host=document.getElementById('drugDoseEditor'),d=stockDose;
  const input=(key,label,type='number')=>`<label class="f"><span>${label}</span><input id="drugDose_${key}" data-dose="${key}" type="${type}" ${type==='number'?'min="0" step="'+(key==='days'?'1':'any')+'"':''} value="${esc(d[key]||'')}"></label>`;
  let fields='';
  if(d.mode==='standard')fields=[['m','เช้า'],['n','เที่ยง'],['e','เย็น'],['b','ก่อนนอน']].map(([k,l])=>input(k,l)).join('');
  if(d.mode==='exact_times')fields=`<div style="grid-column:1/-1">${d.times.map((x,i)=>`<div class="dose-time-default"><label class="f"><span>เวลา</span><input type="time" data-time="${i}" value="${esc(x.time||'')}"></label><label class="f"><span>จำนวน</span><input type="number" min="0" step="any" data-amount="${i}" value="${esc(x.amount||'')}"></label><button class="btn" type="button" data-remove="${i}">ลบ</button></div>`).join('')}<button class="btn" type="button" id="addDefaultTime" ${d.times.length>=8?'disabled':''}>＋ เพิ่มเวลา</button></div>`;
  if(['standard','exact_times'].includes(d.mode))fields+=`<label class="f"><span>มื้ออาหาร</span><select data-dose="timing" id="drugDose_timing">${['','ก่อนอาหาร','หลังอาหาร','พร้อมอาหาร'].map(t=>`<option value="${t}" ${d.timing===t?'selected':''}>${t||'ไม่ระบุ'}</option>`).join('')}</select></label>`+input('days','จำนวนวันเริ่มต้น (เว้นได้)');
  if(d.mode==='prn')fields=input('prn_amount','ครั้งละ')+input('prn_indication','ใช้เมื่อมีอาการ','text')+input('prn_interval_hours','ห่างอย่างน้อย (ชม.)')+input('prn_max_per_day','ไม่เกิน (ครั้ง/วัน)');
  if(d.mode==='manual')fields='<p class="muted" style="grid-column:1/-1">ระบุคำสั่งในช่องคำแนะนำเพิ่มเติมด้านบน และจำนวนจ่ายตอนตรวจ ระบบไม่คำนวณจากข้อความ</p>';
  host.innerHTML=`<div class="drug-default-fields">${fields}</div><p class="muted">จำนวนต่อเวลาใช้หน่วยเดียวกับรายการยา เช่น 0.5 คือครึ่งหน่วย ต้องทวนให้เหมาะกับคนไข้ก่อนสั่งทุกครั้ง</p><div id="drugDosePreview" role="status"></div>`;
  for(const el of host.querySelectorAll('[data-dose]'))el.addEventListener('input',()=>{stockDose[el.dataset.dose]=el.value;previewStockDose();});
  for(const el of host.querySelectorAll('[data-time]'))el.addEventListener('input',()=>{stockDose.times[+el.dataset.time].time=el.value;previewStockDose();});
  for(const el of host.querySelectorAll('[data-amount]'))el.addEventListener('input',()=>{stockDose.times[+el.dataset.amount].amount=el.value;previewStockDose();});
  for(const el of host.querySelectorAll('[data-remove]'))el.addEventListener('click',()=>{stockDose.times.splice(+el.dataset.remove,1);renderStockDose();});
  host.querySelector('#addDefaultTime')?.addEventListener('click',()=>{stockDose.times.push({time:'',amount:''});renderStockDose();});
  previewStockDose();
}
function readStockDose(){return DoseTemplate.normalize({...stockDose,unit:document.getElementById('d_unit').value,additional_instructions:document.getElementById('d_instr').value},document.getElementById('d_unit').value);}
function previewStockDose(){
  const el=document.getElementById('drugDosePreview');if(!el)return;
  try{const d=readStockDose();el.textContent=DoseTemplate.text(d)||'ยังไม่มีตารางวิธีใช้ — กรอกขนาดในช่องก่อนนำไปคำนวณวันยา';}catch(e){el.textContent=e.message;}
}
document.getElementById('d_dose_mode').addEventListener('change',changeStockDoseMode);
document.getElementById('d_instr').addEventListener('input',previewStockDose);
document.getElementById('d_unit').addEventListener('input',previewStockDose);
resetStockDose(null,'standard');
