'use strict';
// Presentation only. Never parse free text into doses or read the current drug master.
const { doseText } = require('./notes');
const { doseUnit } = require('../public/dose-template');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
function provenDose(line, dose) {
  if (typeof line.unit!=='string' || !line.unit.trim()) return null;
  if (!dose || dose.instructions_source !== 'calculated' || !['standard','exact_times','prn'].includes(dose.mode)) return null;
  if (!['','ก่อนอาหาร','หลังอาหาร','พร้อมอาหาร'].includes(dose.timing) || !Number.isInteger(dose.days) || dose.days < 0) return null;
  if (dose.mode === 'standard' && (!['m','n','e','b'].every(k=>finite(dose[k])) || !['m','n','e','b'].some(k=>dose[k]>0))) return null;
  if (dose.mode === 'exact_times' && (!Array.isArray(dose.times) || !dose.times.length || dose.times.length>8 || !dose.times.every(t=>t && typeof t.time==='string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time) && finite(t.amount) && t.amount>0))) return null;
  if (dose.mode === 'prn' && (!(finite(dose.prn_amount)&&dose.prn_amount>0) || !finite(dose.prn_interval_hours) || !finite(dose.prn_max_per_day) || typeof dose.prn_indication!=='string')) return null;
  try { return doseText(dose, line.unit) === line.instructions ? dose : null; }
  catch { return null; }
}
function matchReceiptDoses(receiptLines, orderLines) {
  const fallback=receiptLines.map(()=>null);
  if (!Array.isArray(orderLines) || orderLines.some(l=>!l || typeof l!=='object')) return fallback;
  const ordered=orderLines.filter(l=>l.type!=='discount');
  if (ordered.length!==receiptLines.length) return fallback;
  // Positional match is essential: a medicine may appear twice with different doses.
  if (!ordered.every((o,i)=>{
    const r=receiptLines[i];
    return o.type===r.line_type && o.ref_id===r.ref_id && o.name===r.name && o.qty===r.qty && o.unit===r.unit && String(o.instructions??'')===String(r.instructions??'');
  })) return fallback;
  return ordered.map((o,i)=>o.type==='drug'?provenDose(receiptLines[i],o.dose):null);
}
const paths={
  morning:'<path d="M5 31h38M10 26h28M15 25a9 9 0 0 1 18 0M24 4v7M7 12l5 5M41 12l-5 5M24 40v-7m-4 4 4-4 4 4"/>',
  noon:'<circle cx="24" cy="24" r="9"/><path d="M24 3v6m0 30v6M3 24h6m30 0h6M9 9l4 4m22 22 4 4M9 39l4-4m22-22 4-4"/>',
  evening:'<path d="M5 31h38M10 26h28M15 25a9 9 0 0 1 18 0M24 4v7M7 12l5 5M41 12l-5 5M24 33v9m-4-4 4 4 4-4"/>',
  bedtime:'<path d="M32 5a18 18 0 1 0 11 29A18 18 0 0 1 32 5Z"/>',
  clock:'<circle cx="24" cy="24" r="19"/><path d="M24 12v13l8 5"/>',
  prn:'<rect x="6" y="6" width="36" height="36" rx="7"/><path d="M24 14v20M14 24h20"/>',
};
function icon(kind) { return `<svg class="dose-icon" aria-hidden="true" focusable="false" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg>`; }
const amount = n => Number.isInteger(n) ? String(n) : n===0.5 ? '½' : String(n);
function doseVisual(dose, unit) {
  if (!dose) return '<div class="text-dose-label">อ่านตามข้อความ</div>';
  // An interval is not a meal grid or necessarily PRN. Its immutable instruction
  // remains visible in the medication sheet's ordinary text block.
  if (!['standard','exact_times','prn'].includes(dose.mode)) return '<div class="text-dose-label">อ่านตามข้อความ</div>';
  const u=esc(doseUnit(dose,unit)), number=n=>`${esc(amount(n))} ${u}`;
  if(dose.mode==='standard') {
    return `<div class="dose-visual" data-dose-mode="standard"><div class="dose-grid">${[['m','เช้า','morning'],['n','กลางวัน','noon'],['e','เย็น','evening'],['b','ก่อนนอน','bedtime']].map(([k,label,kind])=>`<div class="dose-cell${dose[k]?'':' no-dose'}"><div class="dose-slot-title">${icon(kind)}<span class="dose-time">${label}</span></div><div class="dose-amount">${dose[k]?number(dose[k]):'ไม่ต้องใช้'}</div></div>`).join('')}</div>${dose.timing||dose.days?`<div class="dose-detail">${[dose.timing, dose.days?`${dose.days} วัน`:''].filter(Boolean).map(esc).join(' · ')}</div>`:''}</div>`;
  }
  if(dose.mode==='exact_times') return `<div class="dose-visual" data-dose-mode="exact_times"><div class="dose-detail dose-heading">${icon('clock')} ใช้ตามเวลาที่ระบุ</div><div class="exact-times">${dose.times.map(t=>`<div><b>${esc(t.time)}</b> · ${number(t.amount)}</div>`).join('')}</div></div>`;
  return `<div class="dose-visual" data-dose-mode="prn"><div class="dose-detail dose-heading">${icon('prn')} เมื่อ${esc(dose.prn_indication||'มีอาการ')}</div><div>ครั้งละ ${number(dose.prn_amount)}</div>${dose.prn_interval_hours?`<div>ห่างอย่างน้อย ${dose.prn_interval_hours} ชม.</div>`:''}${dose.prn_max_per_day?`<div>ไม่เกิน ${dose.prn_max_per_day} ครั้ง/วัน</div>`:''}</div>`;
}
module.exports={matchReceiptDoses,provenDose,doseVisual};
