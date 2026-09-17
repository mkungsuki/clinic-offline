'use strict';
let stockDose = DoseTemplate.empty('standard');
function resetStockDose(value, mode) {
  stockDose = value ? structuredClone(value) : DoseTemplate.empty(mode || 'standard');
  document.getElementById('d_dose_mode').value = stockDose.mode;
  renderStockDose();
}
function changeStockDoseMode() {
  const doseUnit = stockDose.dose_unit || '';
  stockDose = DoseTemplate.empty(document.getElementById('d_dose_mode').value);
  stockDose.dose_unit = doseUnit;
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
  if(d.mode==='interval')fields=input('interval_amount','ขนาดต่อครั้ง')+input('interval_min_hours','ทุกกี่ชั่วโมง')+input('interval_max_hours','ถึงกี่ชั่วโมง (เว้นได้)')+input('interval_indication','ใช้เมื่อมีอาการ (เว้นว่างถ้าให้ตามเวลา)','text')+'<p class="muted" style="grid-column:1/-1">เช่น ช่องชั่วโมง 4 ถึง 6 จะแสดง “ทุก 4–6 ชั่วโมง” · กรอกช่องแรกช่องเดียวถ้าเป็นระยะเวลาคงที่ · ระบุจำนวนจ่ายเองเมื่อสั่งยา</p>';
  if(d.mode==='manual')fields='<p class="muted" style="grid-column:1/-1">ระบุคำสั่งในช่องคำแนะนำเพิ่มเติมด้านบน และจำนวนจ่ายตอนตรวจ ระบบไม่คำนวณจากข้อความ</p>';
  if(d.mode==='interval')fields+=`<label class="f"><span>มื้ออาหาร</span><select data-dose="timing" id="drugDose_timing">${['','ก่อนอาหาร','หลังอาหาร','พร้อมอาหาร'].map(t=>`<option value="${t}" ${d.timing===t?'selected':''}>${t||'ไม่ระบุ'}</option>`).join('')}</select></label>`;
  host.innerHTML=`<label class="f"><span>หน่วยขนาดที่ใช้ยา (เช่น เม็ด, มล., หยด)</span><input id="drugDoseUnit" data-dose="dose_unit" value="${esc(d.dose_unit || '')}" placeholder="เว้นว่าง = ใช้หน่วยที่จ่าย" maxlength="30" style="width:100%"></label><p class="muted" id="drugDoseUnitHelp"></p><div class="drug-default-fields">${fields}</div><div id="drugDosePreview" role="status"></div>`;
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
  const dispense=document.getElementById('d_unit').value.trim()||'หน่วย',doseUnit=String(stockDose.dose_unit||'').trim()||dispense;
  const helper=document.getElementById('drugDoseUnitHelp');
  if(helper)helper.textContent=`ตัวเลขขนาดใช้ยาเป็น ${doseUnit} · ราคาทุน ราคาขาย และจำนวนจ่ายใช้ ${dispense}`+(doseUnit!==dispense?' · คนละหน่วย: ระบุจำนวนจ่ายเอง ระบบไม่แปลงหน่วยให้':' · เช่น 0.5 คือครึ่งหน่วยที่ใช้ยา');
  try{const d=readStockDose();el.textContent=DoseTemplate.text(d)||'ยังไม่มีตารางวิธีใช้ — กรอกขนาดในช่องก่อนนำไปคำนวณวันยา';}catch(e){el.textContent=e.message;}
}
document.getElementById('d_dose_mode').addEventListener('change',changeStockDoseMode);
document.getElementById('d_instr').addEventListener('input',previewStockDose);
document.getElementById('d_unit').addEventListener('input',previewStockDose);
resetStockDose(null,'standard');
