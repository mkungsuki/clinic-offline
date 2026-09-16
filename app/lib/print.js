'use strict';
// เอกสาร server-rendered; ใบรับรองใช้ profile snapshot ตอนออก ไม่เปลี่ยนตามค่าคลินิกภายหลัง
const fs = require('node:fs');
const path = require('node:path');
const { getSetting, ASSET_DIR } = require('./db');
const { bahtText } = require('./document-utils');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function thaiDate(sqlDt) {
  if (!sqlDt) return '';
  const [d, t] = sqlDt.split(' '), [y, m, day] = d.split('-');
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return `${Number(day)} ${months[Number(m) - 1]} ${Number(y) + 543}${t ? ' ' + t.slice(0, 5) + ' น.' : ''}`;
}
function baht(n) { return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function enDate(sqlDt) {
  if (!sqlDt) return '';
  const d = new Date(String(sqlDt).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? esc(sqlDt) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
function check(value) { return value ? '☑' : '☐'; }
function currentClinic() {
  return { name: getSetting('clinic_name', 'คลินิก'), address: getSetting('clinic_address', ''),
    phone: getSetting('clinic_phone', ''), license: getSetting('clinic_license', ''),
    logo_file: getSetting('clinic_logo_file', ''), footer: getSetting('document_footer', '') };
}
function logoData(file) {
  if (!file) return '';
  const safe = path.basename(file), full = path.join(ASSET_DIR, safe);
  if (!fs.existsSync(full)) return '';
  const mime = path.extname(safe).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`;
}

// กระดาษที่รองรับ (เจ้าของ 2026-08-17: "เอาตามที่จะเกิดได้ทุกรูปแบบ" — ตั้งค่าครั้งเดียวในหน้า Admin แยกรายเอกสาร):
//   'A4' เต็มหน้า · 'A4-half' พิมพ์บน A4 เนื้อหาครึ่งบน + รอยประกลางหน้า (หมอ feedback 17 ส.ค.) · 'A5' ใบเล็ก
//   'R80' / 'R58' สลิปเครื่องพิมพ์ความร้อน (กว้าง 80/58 มม. ยาวตามเนื้อหา)
const PAPERS = ['A4', 'A4-half', 'A5', 'R80', 'R58'];
function normalizePaper(value, fallback) { return PAPERS.includes(value) ? value : fallback; }
function isThermal(paper) { return paper === 'R80' || paper === 'R58'; }

// ---------- ขนาดตัวอักษรใบรับรองแพทย์ (หมอ feedback 2026-08-31 "ตัวอักษรเล็กไปนิด") ----------
// สองชั้นคูณกัน: (1) ฐานใหม่ต่อ template ยกของเดิมขึ้นให้ใกล้เกณฑ์เอกสารราชการ (TH Sarabun 14–16pt ≈ 18.5–21px)
//                (2) ตัวคูณที่หมอเลือกเองในหน้าตั้งค่า (medcert_font_scale — ของแบบนี้ขึ้นกับสายตารายคน ห้ามบังคับค่าเดียว)
// วิธี: คูณทุก font-size:*px ของเอกสารทั้งใบ (CSS+inline) — กรอบ/ระยะ mm คงเดิม ความสูงแถวยืดตาม line-height
// เป็นชั้น presentation ล้วน: พิมพ์ซ้ำใบเก่าก็ได้ขนาดตามที่ตั้งไว้ปัจจุบัน เนื้อหา snapshot ไม่ถูกแตะ
const MEDCERT_FONT_SCALES = ['100', '112', '125'];
// base = ฐานใหม่ที่ user scale 100 · max = เพดานที่วัดจริงแล้วยังจบหน้าเดียว (Edge print-to-pdf + footer ยาวสุด)
// template ที่แน่นอยู่แล้ว (TMC/A5) เพดานต่ำ — ตัวคูณของหมอถูก clamp ที่ max เพื่อไม่ให้เอกสารกฎหมายแตกเป็น 2 หน้า
const MEDCERT_FONT = {
  'medcert-general-a4': { base: 1.16, max: 1.3 }, // วัดจริง (footer ยาวสุด): 1.3 จบหน้าเดียว, 1.38 ล้น
  'medcert-general-a5': { base: 1.1, max: 1.2 },
  'tmc-certificate-a4': { base: 1.05, max: 1.05 }, // ขับขี่ไทยคือตัวแน่นสุด — วัดแล้ว 1.1 ล้นหน้า
  legacy: { base: 1.23, max: 1.5 },
  health: { base: 1.16, max: 1.38 },
};
function medcertScale(key, userScale) {
  const c = MEDCERT_FONT[key];
  return Math.min(c.base * userScale, c.max);
}
// ใบเสร็จ (หมอ feedback 2026-08-31 "ใบเสร็จก็เล็กไป") — กลไกเดียวกับใบรับรอง แต่ไม่ยกฐาน:
// ความยาวใบเสร็จแปรตามจำนวนรายการ ค่าเริ่มต้นคงขนาดเดิม หมอเลือก "ใหญ่ขึ้น/ใหญ่พิเศษ" เองจากหน้าตั้งค่า
// เพดานต่อกระดาษ: A4-half มีเส้นตายแข็ง (เนื้อหาต้องจบเหนือรอยประ — กล่อง .half สูงตายตัว) วัดจริงด้วย DOM:
// บิล 7 รายการที่ขนาดเดิมก็เฉียดรอยประอยู่แล้ว → ครึ่งบนให้ได้สุด "ใหญ่ขึ้น" (1.12) + สลับ dense เร็วขึ้นเมื่อขยาย
const RECEIPT_FONT_MAX = { 'A4-half': 1.12, A4: 1.25, A5: 1.25, R80: 1.25, R58: 1.25 };
function userFontScale(settingKey, override) {
  const saved = getSetting(settingKey, '100');
  const v = MEDCERT_FONT_SCALES.includes(String(override)) ? String(override)
    : MEDCERT_FONT_SCALES.includes(saved) ? saved : '100';
  return Number(v) / 100;
}
function receiptFontScale(paper, override) {
  return Math.min(userFontScale('receipt_font_scale', override), RECEIPT_FONT_MAX[paper] || 1.2);
}
// ใบนัดเนื้อหาสั้น แต่ครึ่งบน + document_footer ยาว วัด DOM แล้ว 1.25 ทะลุรอยประ → cap 1.12 เท่าใบเสร็จ
const APPT_FONT_MAX = { 'A4-half': 1.12, A4: 1.25, A5: 1.25, R80: 1.25, R58: 1.25 };
function apptFontScale(paper, override) {
  return Math.min(userFontScale('appt_font_scale', override), APPT_FONT_MAX[paper] || 1.25);
}
function medcertUserScale(override) {
  const saved = getSetting('medcert_font_scale', '100');
  const v = MEDCERT_FONT_SCALES.includes(String(override)) ? String(override)
    : MEDCERT_FONT_SCALES.includes(saved) ? saved : '100';
  return Number(v) / 100;
}
// ตัวอักษรโตโดย "กินช่องไฟ" — ยุบ line-height ที่หลวมลงตามสัดส่วนเดียวกัน กล่องบรรทัดจึงสูงใกล้เดิม
// เอกสารที่เคยจบหน้าเดียวต้องจบหน้าเดียวเท่าเดิม (template พวกนี้ถูกจัดให้เต็มหน้าพอดีอยู่แล้ว)
// floor 1.35 กันสระบน/วรรณยุกต์ไทยชนบรรทัดบน — line-height เดิมที่แน่นกว่า floor อยู่แล้วคงค่าเดิมไว้
const THAI_LINE_HEIGHT_FLOOR = 1.35;
function scaleFontSizes(html, scale) {
  if (!scale || Math.abs(scale - 1) < 0.001) return html;
  return html
    .replace(/font-size:\s*([\d.]+)px/g, (_, n) => `font-size:${Math.round(Number(n) * scale * 10) / 10}px`)
    .replace(/line-height:\s*([\d.]+)(?=[;}"'])/g, (_, n) => {
      const lh = Number(n);
      const compressed = Math.max(lh / scale, Math.min(lh, THAI_LINE_HEIGHT_FLOOR));
      return `line-height:${Math.round(compressed * 100) / 100}`;
    });
}

function page(title, body, opts = {}) {
  const clinic = opts.clinic || currentClinic();
  const paper = normalizePaper(opts.paper, 'A5');
  const thermal = isThermal(paper);
  // สลิป: CSS Paged Media ไม่รับ 'auto' เป็นความสูง (Chromium ทิ้งทั้ง size แล้วพิมพ์บนกระดาษปกติ — เห็นตอน render จริง)
  // จึงกำหนดสูง 150mm ต่อหน้า: ม้วนต่อเนื่องพิมพ์ต่อกันไปเอง ใบยาวกว่านั้นก็แค่ขึ้น "หน้า" ถัดไปบนม้วนเดียวกัน
  const size = thermal ? (paper === 'R80' ? '80mm 150mm' : '58mm 150mm') : paper === 'A5' ? 'A5' : 'A4';
  const margin = thermal ? '3mm' : paper === 'A4' ? '14mm' : '10mm';
  const sheetWidth = thermal ? (paper === 'R80' ? '74mm' : '52mm') : paper === 'A4' ? '182mm' : paper === 'A4-half' ? '190mm' : '128mm';
  const en = opts.language === 'en';
  const logo = logoData(clinic.logo_file);
  const half = paper === 'A4-half';
  // ตัวอักษรโตแล้วช่องว่างแนวตั้งที่จงใจถ่างไว้ (ลายเซ็น/หมายเหตุ/แถวกรอก) ต้องยุบตามสัดส่วน
  // ไม่งั้นเอกสารที่ถูกจัด "เต็มแผ่นพอดี" จะล้นเป็นหน้า 2 — sp() ใช้เฉพาะหน้าที่มี fontScale (ใบรับรอง)
  const fscale = opts.fontScale && opts.fontScale > 1 ? opts.fontScale : 1;
  const sp = v => Math.round(v / fscale * 10) / 10;
  return scaleFontSizes(`<!doctype html><html lang="${en ? 'en' : 'th'}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
/* margin 0 ที่ @page แล้วเว้นขอบด้วย padding ของ body แทน — เบราว์เซอร์จะไม่พิมพ์หัว/ท้ายกระดาษ (วันที่/URL localhost/1-1) ทับเอกสารทางการ */
@page { size: ${size}; margin: 0; }
* { box-sizing: border-box; }
body { font-family: 'TH Sarabun New', 'Sarabun', 'Leelawadee UI', sans-serif; font-size: ${paper === 'A4' ? '15px' : thermal ? '12px' : '14px'}; margin: 0; padding: ${margin}; color: #000; }
.sheet { width: ${sheetWidth}; margin: 0 auto; padding: ${thermal ? '0' : '4mm'}; }
/* A4-half: กล่องครึ่งบนสูงถึงรอยประพอดี (148.5mm − ขอบบน) — รอยประอยู่ "ใน" กล่อง ไม่ใช่ลอยจากขอบหน้าต่าง
   จึงเห็นเหมือนกันทั้งบนจอ (มีปุ่มพิมพ์ดันอยู่ข้างบน) และตอนพิมพ์จริง; เนื้อหาที่ล้นจะเห็นทะลุรอยประบนจอทันที */
.half { position: relative; height: calc(148.5mm - ${margin}); }
.half .sheet { max-height: 100%; }
.cutline { position: absolute; left: -${margin}; right: -${margin}; bottom: 0; border-top: 1px dashed #999; text-align: center; line-height: 0; }
.cutline span { position: relative; top: -1px; background: #fff; padding: 0 3mm; font-size: 9px; color: #777; }
.sheet.medcert-general-a4{font-size:16px}.medcert-general-a4 .head h1{font-size:22px}.sheet.medcert-general-a4 .formline{line-height:2.5;margin:${sp(1.2)}mm 0}.medcert-general-a4 .fillrow{min-height:${sp(8)}mm;line-height:2.2}
.medcert-general-a4 h2{font-size:24px!important;margin-bottom:${sp(5)}mm!important}.medcert-general-a4 .docmeta{line-height:2}
.medcert-general-a4 .sign{margin-top:${sp(13)}mm}.medcert-general-a4 .notes{margin-top:${sp(9)}mm;font-size:11.5px}
.head { display:flex; align-items:center; justify-content:center; gap:5mm; text-align:center; border-bottom: 1px solid #000; padding-bottom: ${sp(3)}mm; margin-bottom: ${sp(3)}mm; }
.head img { width:18mm; height:18mm; object-fit:contain; }
.head h1 { font-size: 20px; margin: 0; }.head .sub { font-size: 12px; }.head .txt{min-width:0}
table { width: 100%; border-collapse: collapse; } th, td { padding: 2px 4px; text-align: left; }
.lines { table-layout:fixed; font-size:12px }.lines th,.lines td { overflow-wrap:anywhere }.lines th { border-bottom: 1px solid #000; }.num { text-align: right; }.total td { border-top: 1px solid #000; font-weight: bold; }
.meta { display: flex; justify-content: space-between; align-items:flex-start; gap:4mm; flex-wrap:wrap; margin-bottom: 2mm; }.meta>*{min-width:0}.sign { margin-top: ${sp(12)}mm; display: flex; justify-content: flex-end; }
.sign .box { text-align: center; width: 62mm; }.sign .line { border-bottom: 1px dotted #000; height: ${sp(10)}mm; }
.void-stamp { position: fixed; top: 35%; left: 15%; font-size: 48px; color: #c00; border: 4px solid #c00; padding: 4px 24px; transform: rotate(-20deg); opacity: .5; }
.section { border:1px solid #555; padding:${sp(3)}mm 3mm; margin:${sp(3)}mm 0; }.section h3{font-size:16px;margin:0 0 2mm}.check{font-size:17px;margin-right:2mm}.vitals td{border:1px solid #aaa}.footer{margin-top:${sp(8)}mm;text-align:center;font-size:11px;color:#444}
.fill{display:inline-block;min-width:30mm;padding:0 2mm;border-bottom:1px dotted #000;text-align:center;font-weight:700}
.fill.wide{min-width:65mm}.fill.sm{min-width:14mm}
.fillrow{border-bottom:1px dotted #000;min-height:${sp(7.5)}mm;padding:0 2mm 1mm;line-height:2}
.formline{line-height:2.15;margin:1mm 0}
.seclab{display:inline-block;background:#000;color:#fff;padding:0 3mm;border-radius:2px;font-weight:700;margin-right:2mm}
.docmeta{display:flex;justify-content:flex-end;text-align:right;line-height:1.8;margin-bottom:2mm}
.idxlist{margin:1mm 0 1mm 7mm;padding:0}.idxlist li{margin:1mm 0;line-height:1.7}
.notes{margin-top:4mm;font-size:11px;color:#222;line-height:1.55}.notes b{font-size:12px}
.sheet.medcert-general-a5{padding:2mm;font-size:13px}
.medcert-general-a5 .head{gap:3mm;padding-bottom:2mm;margin-bottom:2mm}
.medcert-general-a5 .head img{width:14mm;height:14mm}
.medcert-general-a5 .head h1{font-size:18px}.medcert-general-a5 .head .sub{font-size:11px}
.medcert-general-a5 .docmeta{line-height:1.45;margin-bottom:1mm}
.medcert-general-a5 h2{font-size:18px!important;margin-bottom:2mm!important}
.medcert-general-a5 .formline{line-height:1.65;margin:.4mm 0}
.medcert-general-a5 .fillrow{min-height:${sp(5.5)}mm;line-height:1.55}
.medcert-general-a5 .sign{margin-top:${sp(6)}mm}.medcert-general-a5 .sign .box{font-size:12px}
.medcert-general-a5 .notes{margin-top:2mm;font-size:9.5px;line-height:1.3}
.sheet.tmc-certificate-a4{padding:2mm;font-size:12.5px}
.tmc-certificate-a4 .head{gap:3mm;padding-bottom:2mm;margin-bottom:2mm}
.tmc-certificate-a4 .head img{width:14mm;height:14mm}
.tmc-certificate-a4 .head h1{font-size:18px}.tmc-certificate-a4 .head .sub{font-size:10.5px}
.tmc-certificate-a4 .docmeta{line-height:1.4;margin-bottom:1mm}
.tmc-certificate-a4 h2{font-size:17px!important;margin-bottom:2mm!important}
.tmc-certificate-a4 .section{padding:${sp(2)}mm 2mm;margin:${sp(2)}mm 0}
.tmc-certificate-a4 .formline{line-height:1.5;margin:.35mm 0}
.tmc-certificate-a4 .fillrow{min-height:${sp(5)}mm;line-height:1.45}
.tmc-certificate-a4 .idxlist{margin:.5mm 0 .5mm 6mm}.tmc-certificate-a4 .idxlist li{margin:.35mm 0;line-height:1.4}
.tmc-certificate-a4 .sign{margin-top:${sp(5)}mm}.tmc-certificate-a4 .sign .box{font-size:11px}
.tmc-certificate-a4 .notes{margin-top:2mm;font-size:9px;line-height:1.3}.tmc-certificate-a4 .notes b{font-size:10px}
.sheet.receipt-half{padding:${sp(2)}mm 4mm;font-size:13px}.receipt-half .head{gap:3mm;padding-bottom:${sp(2)}mm;margin-bottom:${sp(2)}mm}.receipt-half .head img{width:14mm;height:14mm}
.receipt-half .head h1{font-size:18px}.receipt-half .head .sub{font-size:11px}.receipt-half .meta{margin-bottom:1mm}.receipt-half .section{padding:${sp(2)}mm 2mm;margin:${sp(2)}mm 0}
.receipt-half .lines{font-size:12.5px}.receipt-half .lines th,.receipt-half .lines td{padding:1px 4px}.receipt-half .sign{margin-top:${sp(5)}mm}.receipt-half .sign .line{height:${sp(8)}mm}.receipt-half .footer{margin-top:${sp(3)}mm;font-size:10px}
.sheet.receipt-half.dense{font-size:11.5px}.receipt-half.dense .lines{font-size:11px}.receipt-half.dense .lines th,.receipt-half.dense .lines td{padding:0 3px}.receipt-half.dense .sign{margin-top:${sp(3)}mm}
.sheet.receipt-a4 .lines{font-size:14px}.receipt-a4 .sign{margin-top:16mm}
/* สลิปความร้อน: คอลัมน์เดียว หัวเรียงลง ไม่มีกล่องกรอบหนา */
.sheet.thermal .head{flex-direction:column;gap:1mm;padding-bottom:1.5mm;margin-bottom:1.5mm}.thermal .head img{width:12mm;height:12mm}
.thermal .head h1{font-size:15px}.thermal .head .sub{font-size:10px}.thermal .meta{display:block;margin-bottom:.5mm}.thermal .meta>*{display:block}
.thermal .section{border:0;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:1mm 0;margin:1.5mm 0}
.thermal .lines{font-size:11px}.thermal .lines th,.thermal .lines td{padding:0 1px}.thermal .lines .item td{padding-top:1mm}
.thermal .sign{margin-top:4mm;justify-content:center}.thermal .sign .box{width:100%;font-size:11px}.thermal .sign .line{height:6mm}
.thermal .fill.wide{min-width:0}.thermal .fill{min-width:18mm}.thermal .formline{line-height:1.7}.thermal .footer{margin-top:3mm;font-size:9.5px}
.thermal .void-stamp{font-size:24px;top:30%;left:5%}.thermal h2{font-size:15px!important}
.sheet.receipt-a5{padding:2mm;font-size:12.5px}
.receipt-a5 .head{gap:3mm;padding-bottom:2mm;margin-bottom:2mm}
.receipt-a5 .head img{width:14mm;height:14mm}
.receipt-a5 .head h1{font-size:18px}.receipt-a5 .head .sub{font-size:10.5px}
.receipt-a5 .meta{gap:2mm;margin-bottom:1mm}
.receipt-a5 .section{padding:2mm;margin:2mm 0}
.receipt-a5 .lines{font-size:11px}.receipt-a5 .lines th,.receipt-a5 .lines td{padding:1px 3px}
.receipt-a5 .sign{margin-top:6mm}.receipt-a5 .sign .line{height:7mm}.receipt-a5 .sign .box{font-size:11px}
.receipt-a5 .footer{margin-top:4mm;font-size:9px}
.noprint { text-align: center; margin: 8px; } @media print { .noprint { display: none; } }
</style></head><body><div class="noprint"><button onclick="window.print()" style="font-size:16px;padding:8px 24px">🖨️ พิมพ์</button>${thermal ? `<div style="max-width:${sheetWidth};margin:6px auto 0;font-size:11px;color:#555;line-height:1.5;text-align:left">สลิป ${paper === 'R80' ? '80' : '58'} มม.: ในหน้าต่างพิมพ์ให้เลือก "เครื่องพิมพ์สลิป" เป็นปลายทาง (ถ้าเลือก Print to PDF/A4 จะเห็นสลิปอยู่กลางหน้าใหญ่ — ปกติ) · มาตราส่วน 100% ไม่ใช่ "พอดีหน้า" · ถ้ามีวันที่/ที่อยู่เว็บโผล่หัวท้าย ติ๊กออกที่ "การตั้งค่าเพิ่มเติม → ส่วนหัวและส่วนท้าย" ครั้งเดียว</div>` : ''}</div>
${half ? '<div class="half">' : ''}<div class="sheet${opts.pageClass ? ` ${esc(opts.pageClass)}` : ''}${thermal ? ' thermal' : ''}"><div class="head">${logo ? `<img src="${logo}" alt="${en ? 'Logo' : 'โลโก้'}">` : ''}<div class="txt"><h1>${esc(clinic.name || (en ? 'Clinic' : 'คลินิก'))}</h1><div class="sub">${esc(clinic.address || '')}${clinic.phone ? (en ? ' Phone ' : ' โทร. ') + esc(clinic.phone) : ''}${clinic.license ? `<br>${en ? 'Clinic licence no. ' : 'ใบอนุญาตเลขที่ '}${esc(clinic.license)}` : ''}</div></div></div>
${body}${clinic.footer ? `<div class="footer">${esc(clinic.footer)}</div>` : ''}</div>${half ? '<div class="cutline"><span>✂ ตัดตามรอยประได้ — ครึ่งล่างว่างไว้ตั้งใจ</span></div></div>' : ''}${getSetting('auto_print', '1') === '1' ? "<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),300))</script>" : ''}</body></html>`, opts.fontScale);
}

// กระดาษใบเสร็จ/ใบนัด แยกกันตั้งได้ (receipt_paper / appointment_paper) · ค่าเริ่มต้น A4 ครึ่งบน (ฉีกแบ่งได้)
// slip_paper = คีย์เดิมรอบ l (ใบเดียวคุมทั้งสอง) ยังอ่านเป็น fallback ให้เครื่องที่ตั้งไว้แล้ว
function legacySlipPaper() { return normalizePaper(getSetting('slip_paper', ''), 'A4-half'); }
function receiptPaper(override) { return normalizePaper(override, normalizePaper(getSetting('receipt_paper', ''), legacySlipPaper())); }
function appointmentPaper(override) { return normalizePaper(override, normalizePaper(getSetting('appointment_paper', ''), legacySlipPaper())); }
function receiptClass(paper, lineCount = 0, fontScale = 1) {
  if (isThermal(paper)) return 'receipt-thermal';
  if (paper === 'A5') return 'receipt-a5';
  if (paper === 'A4') return 'receipt-a4';
  // ครึ่งบน: ขยายตัวอักษรแล้วต้องสลับโหมดกระชับเร็วขึ้น (dense 11.5px × 1.12 ≈ ขนาดปกติเดิม)
  // ไม่งั้นบิล 5-7 รายการที่เคยจบเหนือรอยประจะทะลุ — วัดจริง 2026-08-31
  const denseAt = fontScale > 1.001 ? 4 : 7;
  return lineCount > denseAt ? 'receipt-half dense' : 'receipt-half';
}
function receiptHTML(r, opts = {}) {
  if (r.document && r.document.template_key === 'receipt_a5') return receiptV2(r, opts);
  const rows = r.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td class="num">${l.qty} ${esc(l.unit || '')}</td><td class="num">${baht(l.price_each)}</td><td class="num">${baht(l.amount)}</td></tr>`).join('');
  const discount = r.discount > 0 ? `<tr><td colspan="4" class="num">ส่วนลด${r.discount_reason ? ' (' + esc(r.discount_reason) + ')' : ''}</td><td class="num">-${baht(r.discount)}</td></tr>` : '';
  return page(`ใบเสร็จ ${r.receipt_no}`, `${r.status === 'VOID' ? '<div class="void-stamp">ยกเลิก</div>' : ''}
<h2 style="text-align:center;font-size:16px;margin:0 0 2mm">ใบเสร็จรับเงิน ${opts.copy ? '(สำเนา)' : '(รูปแบบเดิม)'}</h2><div class="meta"><span>เลขที่ <b>${esc(r.receipt_no)}</b></span><span>วันที่ ${thaiDate(r.created_at)}</span></div>
<div class="meta"><span>ผู้รับบริการ: <b>${esc(r.patient_name)}</b> (HN ${esc(r.hn)})</span><span>ชำระโดย: ${r.pay_method === 'cash' ? 'เงินสด' : 'โอน'}</span></div>
<table class="lines"><tr><th>#</th><th>รายการ</th><th class="num">จำนวน</th><th class="num">ราคา</th><th class="num">รวม</th></tr>${rows}
<tr><td colspan="4" class="num">รวม</td><td class="num">${baht(r.subtotal)}</td></tr>${discount}<tr class="total"><td colspan="4" class="num">ยอดสุทธิ</td><td class="num">${baht(r.total)} บาท</td></tr></table>
<div class="sign"><div class="box"><div class="line"></div>ผู้รับเงิน</div></div>`, (() => {
    const paper = receiptPaper(opts.paper);
    const fontScale = receiptFontScale(paper, opts.scale);
    return { paper, pageClass: receiptClass(paper, r.lines.length, fontScale), fontScale };
  })());
}

function receiptV2(r, opts) {
  const d = r.document, issuer = d.issuer || {}, payer = d.payer || {}, payment = d.payment || {}, cashier = d.cashier || {};
  const clinic = { name: issuer.name, address: issuer.address, phone: issuer.phone, license: issuer.clinic_license,
    logo_file: issuer.logo_file, footer: issuer.footer };
  const paper = receiptPaper(opts.paper);
  const thermal = isThermal(paper);
  // สลิปความร้อนแคบ: 2 บรรทัดต่อรายการ (ชื่อ / จำนวน×ราคา = จำนวนเงิน) แทนตาราง 6 คอลัมน์
  const rows = thermal
    ? r.lines.map(l => `<tr class="item"><td colspan="2">${esc(l.name)}${l.item_code ? ` <span style="color:#555">[${esc(l.item_code)}]</span>` : ''}</td></tr><tr><td class="num" style="color:#333">${esc(l.qty)} ${esc(l.unit || '')} × ${baht(l.price_each)}</td><td class="num">${baht(l.amount)}</td></tr>`).join('')
    : r.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item_code || '')}</td><td>${esc(l.name)}</td><td class="num">${esc(l.qty)} ${esc(l.unit || '')}</td><td class="num">${baht(l.price_each)}</td><td class="num">${baht(l.amount)}</td></tr>`).join('');
  const span = thermal ? 1 : 5;
  const discount = Number(r.discount) > 0 ? `<tr><td colspan="${span}" class="num">ส่วนลด${r.discount_reason ? ' (' + esc(r.discount_reason) + ')' : ''}</td><td class="num">-${baht(r.discount)}</td></tr>` : '';
  const paymentLine = payment.method === 'cash'
    ? `เงินสดรับ ${baht(payment.cash_received)} บาท &nbsp; เงินทอน ${baht(payment.change)} บาท`
    : `ชำระโดยโอน${payment.transfer_ref ? ` &nbsp; เลขอ้างอิง ${esc(payment.transfer_ref)}` : ''}`;
  const tax = issuer.tax_id ? `เลขประจำตัวผู้เสียภาษี ${esc(issuer.tax_id)}${issuer.branch ? ` &nbsp; สาขา ${esc(issuer.branch)}` : ''}` : '';
  return page(`ใบเสร็จ ${r.receipt_no}`, `${r.status === 'VOID' ? `<div class="void-stamp">ยกเลิก</div><div style="color:#900">เหตุผล: ${esc(r.void_reason || '-')}</div>` : ''}
<div class="meta"><span>${issuer.book_no ? `เล่มที่ ${esc(issuer.book_no)} &nbsp;` : ''}เลขที่ <b>${esc(r.receipt_no)}</b></span><b>ใบเสร็จรับเงิน / Receipt ${opts.copy ? '(สำเนา / COPY)' : '(ต้นฉบับ / ORIGINAL)'}</b></div>
<div class="meta"><span>${tax}</span><span>วันที่ ${thaiDate(r.created_at)}</span></div>
<div class="section"><b>ได้รับเงินจาก / Received from:</b> ${esc(payer.name || r.patient_name)}<br>
${payer.address ? `<b>ที่อยู่:</b> ${esc(payer.address)}<br>` : ''}${payer.tax_id ? `<b>เลขประจำตัวผู้เสียภาษี:</b> ${esc(payer.tax_id)}<br>` : ''}
<span>ผู้รับบริการ ${esc(r.patient_name)} · HN ${esc(r.hn)}</span>${cashier.doctor_name ? `<br><span>แพทย์ผู้ตรวจ ${esc(cashier.doctor_name)}</span>` : ''}</div>
<table class="lines">${thermal ? '<colgroup><col style="width:66%"><col style="width:34%"></colgroup><tr><th>รายการ</th><th class="num">จำนวนเงิน</th></tr>' : '<colgroup><col style="width:6%"><col style="width:12%"><col style="width:40%"><col style="width:14%"><col style="width:14%"><col style="width:14%"></colgroup><tr><th>#</th><th>รหัส</th><th>รายการ</th><th class="num">จำนวน</th><th class="num">ราคา/หน่วย</th><th class="num">จำนวนเงิน</th></tr>'}${rows}
<tr><td colspan="${span}" class="num">รวม</td><td class="num">${baht(r.subtotal)}</td></tr>${discount}<tr class="total"><td colspan="${span}" class="num">ยอดสุทธิ</td><td class="num">${baht(r.total)} บาท</td></tr></table>
<div style="margin-top:3mm"><b>ตัวอักษร:</b> ${esc(bahtText(r.total))}</div><div>${paymentLine}</div>
${issuer.vat_note ? `<div class="footer">${esc(issuer.vat_note)}</div>` : ''}
<div class="sign"><div class="box"><div class="line"></div>${esc(cashier.name || '')}<br>ผู้รับเงิน / Cashier</div></div>`, (() => {
    const fontScale = receiptFontScale(paper, opts.scale);
    return { clinic, paper, pageClass: receiptClass(paper, r.lines.length, fontScale), fontScale };
  })());
}

// ---------- ตัวอย่างเอกสารสำหรับลองกระดาษในหน้าตั้งค่า (ข้อมูลสมมติ ประทับ "ตัวอย่าง" ไม่แตะฐาน) ----------
const SAMPLE_STAMP = '<div class="void-stamp" style="color:#06c;border-color:#06c">ตัวอย่าง</div>';
function sampleReceiptHTML(paper, scale) {
  const clinic = currentClinic();
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const at = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:00`;
  const lines = [
    { item_code: 'D001', name: 'Paracetamol 500mg', qty: 10, unit: 'เม็ด', price_each: 1.5, amount: 15 },
    { item_code: 'D014', name: 'Amoxicillin 500mg', qty: 15, unit: 'แคปซูล', price_each: 4, amount: 60 },
    { item_code: '', name: 'ค่าตรวจรักษา', qty: 1, unit: 'ครั้ง', price_each: 100, amount: 100 },
  ];
  const r = { receipt_no: 'RC0000-SAMPLE', hn: '00-0000', patient_name: 'นายตัวอย่าง ทดลองพิมพ์', created_at: at, status: 'ISSUED',
    subtotal: 175, discount: 0, discount_reason: null, total: 175, lines,
    document: { template_key: 'receipt_a5', issuer: { name: getSetting('receipt_issuer_name', '') || clinic.name, address: getSetting('receipt_issuer_address', '') || clinic.address,
      phone: clinic.phone, clinic_license: clinic.license, tax_id: getSetting('receipt_tax_id', ''), branch: getSetting('receipt_branch', ''),
      book_no: getSetting('receipt_book_no', ''), vat_note: getSetting('receipt_vat_note', ''), logo_file: clinic.logo_file, footer: clinic.footer },
      payer: { name: 'นายตัวอย่าง ทดลองพิมพ์', address: '', tax_id: '' }, payment: { method: 'cash', cash_received: 200, change: 25, transfer_ref: '' },
      cashier: { name: 'เจ้าหน้าที่หน้าร้าน', doctor_name: 'นพ.ตัวอย่าง แพทย์' } } };
  return receiptV2(r, { paper, scale }).replace('<div class="meta">', SAMPLE_STAMP + '<div class="meta">');
}
// ตัวอย่างใบรับรองแพทย์ (แบบทั่วไป) — ให้หมอลองกระดาษ/ขนาดตัวอักษรจากหน้าตั้งค่าได้เองจนพอใจ
function sampleMedCertHTML(paper, scale) {
  const p = paper === 'A5' ? 'A5' : 'A4';
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const restTo = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  const c = {
    cert_no: 'MC0000-SAMPLE', created_at: `${iso(now)} 09:00:00`, hn: '00-0000',
    patient_name: 'นายตัวอย่าง ทดลองพิมพ์', doctor_name: 'นพ.ตัวอย่าง แพทย์',
    content: {
      template_type: 'general', template_version: 1, purpose: 'sick_leave',
      diagnosis_text: 'ไข้หวัดใหญ่ (ข้อมูลสมมติสำหรับลองกระดาษและขนาดตัวอักษร)',
      rest_from: iso(now), rest_to: iso(restTo), fitness: 'not_stated', remark: '',
      snapshot: { clinic: { ...currentClinic(), medcert_paper_size: p },
        doctor: { name: 'นพ.ตัวอย่าง แพทย์', medical_license: 'ว.00000' }, examined_at: `${iso(now)} 09:00:00` },
    },
  };
  return medCertHTML(c, { scale }).replace('<div class="docmeta">', SAMPLE_STAMP + '<div class="docmeta">');
}

function sampleAppointmentHTML(paper, scale) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14);
  return appointmentSlipHTML({ prefix: 'นาย', first_name: 'ตัวอย่าง', last_name: 'ทดลองพิมพ์', hn: '00-0000', appt_date: iso(next), days: 14,
    doctor_name: 'นพ.ตัวอย่าง แพทย์', note: 'ติดตามอาการ (ตัวอย่าง)', created_at: `${iso(now)} 09:00:00` }, { paper, scale, multipleDoctors: require('./doctors').multiple() })
    .replace('<h2 ', SAMPLE_STAMP + '<h2 ');
}

// ---------- เครื่องมือประกอบแบบฟอร์มทางการ ----------
function fill(value, cls = '') {
  const text = esc(value);
  return `<span class="fill${cls ? ' ' + cls : ''}">${text || '&nbsp;'}</span>`;
}
function fillRows(value, minRows = 1) {
  const rows = [`<div class="fillrow">${esc(value) || '&nbsp;'}</div>`];
  for (let i = 1; i < minRows; i++) rows.push('<div class="fillrow">&nbsp;</div>');
  return rows.join('');
}
function thaiDateOnly(sqlDt) { return thaiDate(sqlDt).split(' ').slice(0, 3).join(' '); }
function doctorSign(doctor, fallbackName, en = false) {
  const name = en ? (doctor.name_en || doctor.name || fallbackName) : (doctor.name || fallbackName);
  const licence = doctor.medical_license
    ? `<br>${en ? 'Medical licence no.' : 'ใบอนุญาตประกอบวิชาชีพเวชกรรมเลขที่'} ${esc(doctor.medical_license)}` : '';
  return `<div class="sign"><div class="box">(${en ? 'Signature' : 'ลงชื่อ'}) ...........................................................<br>( ${esc(name)} )<br>${en ? 'Examining physician' : 'แพทย์ผู้ตรวจ'}${licence}</div></div>`;
}

function medCertHTML(c, opts = {}) {
  const ct = c.content || {}, snap = ct.snapshot || {};
  const doctor = snap.doctor || { name: c.doctor_name }, patient = snap.patient || {};
  const clinic = snap.clinic || currentClinic(), vitals = snap.vitals || {};
  const signature = doctorSign(doctor, c.doctor_name);
  const userScale = medcertUserScale(opts.scale); // opts.scale ใช้เฉพาะตัวอย่างในหน้าตั้งค่า (ลองก่อนบันทึก)
  if (ct.template_type === 'general') return generalCert(c, ct, clinic, doctor, userScale);
  if (String(ct.template_type || '').startsWith('tmc_')) return tmcCert(c, ct, clinic, doctor, patient, vitals, userScale);
  const eventMark = certEventMark(c);
  if (ct.template_type === 'health_exam') {
    const general = ct.general_normal !== false;
    const fit = ct.fit_for_work !== false;
    return page(`ใบรับรองการตรวจสุขภาพ ${c.cert_no}`, `${eventMark}
<h2 style="text-align:center;font-size:18px;margin:0 0 2mm">ใบรับรองการตรวจสุขภาพ</h2><div class="meta"><span>เลขที่ <b>${esc(c.cert_no)}</b></span><span>วันที่ ${thaiDate(c.created_at)}</span></div>
<div class="section"><h3>ส่วนที่ 1 ข้อมูลผู้รับการตรวจ</h3>
ชื่อ <b>${esc(c.patient_name)}</b> HN ${esc(c.hn)} ${patient.citizen_id ? `เลขบัตรประชาชน ${esc(patient.citizen_id)}` : ''}<br>
ที่อยู่ ${esc(patient.address || '-')}<br>ประวัติสุขภาพ/คำรับรองของผู้รับการตรวจ: ${esc(ct.patient_declaration || 'ไม่ระบุ')}</div>
<div class="section"><h3>ส่วนที่ 2 ผลการตรวจของแพทย์</h3>
<table class="vitals"><tr><td>น้ำหนัก ${esc(vitals.weight_kg || '-')} กก.</td><td>ส่วนสูง ${esc(vitals.height_cm || '-')} ซม.</td><td>ชีพจร ${esc(vitals.pulse || '-')} /นาที</td></tr>
<tr><td>ความดัน ${esc(vitals.bp_sys || '-')}/${esc(vitals.bp_dia || '-')} mmHg</td><td>อุณหภูมิ ${esc(vitals.temp_c || '-')} °C</td><td>น้ำตาล ${esc(vitals.glucose || '-')} mg/dL</td></tr></table>
<p><span class="check">${general ? '☑' : '☐'}</span>สุขภาพทั่วไปปกติ &nbsp; <span class="check">${general ? '☐' : '☑'}</span>มีความผิดปกติ</p>
<p>โรค/ภาวะหรือผลตรวจที่พบ: ${esc(ct.findings || 'ไม่พบความผิดปกติสำคัญ')}</p>
<p>ความเห็นแพทย์: <span class="check">${fit ? '☑' : '☐'}</span>สุขภาพเหมาะสมตามวัตถุประสงค์ &nbsp; <span class="check">${fit ? '☐' : '☑'}</span>มีข้อจำกัด</p>
<p>คำแนะนำ/ข้อจำกัด: ${esc(ct.recommendation || '-')}</p></div>${signature}`, { clinic, paper: 'A4', fontScale: medcertScale('health', userScale) });
  }
  return page(`ใบรับรองแพทย์ ${c.cert_no}`, `${eventMark}
<h2 style="text-align:center;font-size:17px;margin:0 0 2mm">ใบรับรองแพทย์</h2><div class="meta"><span>เลขที่ <b>${esc(c.cert_no)}</b></span><span>วันที่ ${thaiDate(c.created_at)}</span></div>
<p style="line-height:1.9;text-indent:10mm">ข้าพเจ้า <b>${esc(doctor.name || c.doctor_name)}</b> ได้ตรวจ <b>${esc(c.patient_name)}</b> (HN ${esc(c.hn)}) เมื่อวันที่ ${thaiDate(c.created_at).split(' ').slice(0, 3).join(' ')} และขอรับรองว่า</p>
<p style="line-height:1.9;text-indent:10mm">${esc(ct.diagnosis_text || 'ผู้รับการตรวจมีสุขภาพแข็งแรง')}</p>
${ct.rest_days ? `<p style="line-height:1.9;text-indent:10mm">เห็นควรให้หยุดพักเป็นเวลา <b>${esc(ct.rest_days)}</b> วัน ตั้งแต่วันที่ ${esc(ct.rest_from || '')} ถึงวันที่ ${esc(ct.rest_to || '')}</p>` : ''}
${ct.remark ? `<p style="line-height:1.9;text-indent:10mm">หมายเหตุ: ${esc(ct.remark)}</p>` : ''}${signature}`, { clinic, paper: clinic.medcert_paper_size === 'A5' ? 'A5' : 'A4', fontScale: medcertScale('legacy', userScale) });
}

function certEventMark(c, en = false) {
  if (!c.event) return '';
  const label = c.event.action === 'replace' ? (en ? 'REPLACED' : 'ออกใบใหม่แทนแล้ว') : (en ? 'VOID' : 'ยกเลิก');
  return `<div class="void-stamp">${label}</div><div style="color:#900">${en ? 'Reason' : 'เหตุผล'}: ${esc(c.event.reason || '-')}${c.event.replacement_cert_no ? ` · ${en ? 'Replacement' : 'ใบใหม่'} ${esc(c.event.replacement_cert_no)}` : ''}</div>`;
}

function generalCert(c, ct, clinic, doctor, userScale = 1) {
  const labels = { attendance: 'รับรองการมารับการตรวจ', sick_leave: 'การลาป่วย/พักรักษาตัว', work_school: 'ยื่นต่อที่ทำงานหรือสถานศึกษา', return_to_work: 'การกลับเข้าทำงานหรือเรียน' };
  const fitness = { not_stated: '', fit: 'สามารถกลับไปทำงาน/เรียนได้ตามปกติ', fit_with_restrictions: 'สามารถกลับไปทำงาน/เรียนได้โดยมีข้อจำกัด', unfit: 'ยังไม่พร้อมกลับไปทำงาน/เรียน' };
  const examined = ct.snapshot && ct.snapshot.examined_at ? ct.snapshot.examined_at : c.created_at;
  // "จึงเห็นสมควร" ประกอบจากช่วงพัก + ความเห็นความพร้อม ตามที่แพทย์เลือกจริง
  const opinionParts = [];
  if (ct.rest_from && ct.rest_to) opinionParts.push(`ให้หยุดพักตั้งแต่วันที่ ${thaiDateOnly(ct.rest_from)} ถึงวันที่ ${thaiDateOnly(ct.rest_to)}`);
  if (fitness[ct.fitness]) opinionParts.push(`${fitness[ct.fitness]}${ct.restrictions ? ` (${ct.restrictions})` : ''}`);
  if (ct.review_date) opinionParts.push(`นัดประเมินซ้ำวันที่ ${thaiDateOnly(ct.review_date)}`);
  // ค่าเริ่มต้น A4 เต็มหน้า (หมอ feedback 17 ส.ค. "ขยายเป็น A4 ให้เต็มแผ่น") — ใบเก่าที่ snapshot ไว้เป็น A5 ยังพิมพ์ A5 เหมือนเดิม
  const paper = clinic.medcert_paper_size === 'A5' ? 'A5' : 'A4';
  return page(`ใบรับรองแพทย์ ${c.cert_no}`, `${certEventMark(c)}
<div class="docmeta"><div>เลขที่ <b>${esc(c.cert_no)}</b><br>วันที่ ${thaiDateOnly(c.created_at)}</div></div>
<h2 style="text-align:center;font-size:20px;margin:0 0 4mm">ใบรับรองแพทย์</h2>
<div class="formline">ข้าพเจ้า ${fill(doctor.name || c.doctor_name, 'wide')} แพทย์ผู้ประกอบวิชาชีพเวชกรรม${doctor.specialty ? ` สาขา${fill(doctor.specialty)}` : ''}</div>
<div class="formline">ใบอนุญาตประกอบวิชาชีพเวชกรรมเลขที่ ${fill(doctor.medical_license)}</div>
<div class="formline">ได้ทำการตรวจร่างกาย ${fill(c.patient_name, 'wide')} (HN ${esc(c.hn)})</div>
<div class="formline">เมื่อวันที่ ${fill(thaiDateOnly(examined))} เพื่อ${fill(labels[ct.purpose] || 'การรับรองทางการแพทย์', 'wide')}</div>
<div class="formline">พบว่า</div>
${fillRows(ct.diagnosis_text || 'มาตรวจตามวันและเวลาดังกล่าวจริง', 2)}
<div class="formline" style="margin-top:3mm">จึงเห็นสมควร</div>
${fillRows(opinionParts.join(' · '), 2)}
${ct.remark ? `<div class="formline" style="margin-top:2mm">หมายเหตุ ${fill(ct.remark, 'wide')}</div>` : ''}
${doctorSign(doctor, c.doctor_name)}
<div class="notes">ใบรับรองแพทย์ฉบับนี้รับรองผลการตรวจ ณ วันที่ระบุข้างต้นเท่านั้น · เอกสารออกโดยระบบและจัดเก็บต้นฉบับดิจิทัลไว้ที่คลินิก การพิมพ์ซ้ำจะแสดงเลขที่และข้อมูลเดิมเสมอ</div>`,
    { clinic, paper, pageClass: paper === 'A5' ? 'medcert-general-a5' : 'medcert-general-a4',
      fontScale: medcertScale(paper === 'A5' ? 'medcert-general-a5' : 'medcert-general-a4', userScale) });
}

function declarationRows(d = {}, en = false, driving = false) {
  const labels = en
    ? [['chronic', 'Congenital or chronic disease'], ['accident_surgery', 'Accident and surgery'], ['admitted', 'Previous hospital admission'], ['seizure', 'History of epilepsy/seizure'], ['other', 'Other significant history']]
    : [['chronic', 'โรคประจำตัว'], ['accident_surgery', 'อุบัติเหตุ และผ่าตัด'], ['admitted', 'เคยเข้ารับการรักษาในโรงพยาบาล'], ['seizure', 'ประวัติโรคลมชัก'], ['other', 'ประวัติสำคัญอื่น ๆ']];
  const yes = en ? 'Yes, specify' : 'มี (ระบุ)';
  const no = en ? 'None' : 'ไม่มี';
  return labels.filter(([key]) => d[key] && (key !== 'seizure' || driving)).map(([key, label], index) =>
    `<div class="formline">${index + 1}. ${esc(label)} &nbsp; <span class="check">${check(!d[key].has)}</span>${no} &nbsp; <span class="check">${check(d[key].has)}</span>${yes} ${fill(d[key].has ? d[key].detail : '', 'wide')}</div>`).join('');
}

function tmcCert(c, ct, clinic, doctor, patient, vitals, userScale = 1) {
  const en = ct.language === 'en' || ct.template_type.endsWith('_en');
  const driving = ct.template_type.includes('driving');
  const title = en ? 'MEDICAL CERTIFICATE' : (driving ? 'ใบรับรองแพทย์ (สำหรับใบอนุญาตขับรถ)' : 'ใบรับรองการตรวจสุขภาพ');
  const clinicOut = en ? { ...clinic, name: clinic.name_en || clinic.name, address: clinic.address_en || clinic.address } : clinic;
  const subjectName = en ? ct.patient_name_en : c.patient_name;
  const subjectAddress = en ? ct.patient_address_en : patient.address;
  const bp = `${vitals.bp_sys}/${vitals.bp_dia}`;
  const vitalsLine = en
    ? `Weight ${fill(vitals.weight_kg, 'sm')} kg &nbsp; Height ${fill(vitals.height_cm, 'sm')} cm &nbsp; Blood pressure ${fill(bp, 'sm')} mmHg &nbsp; Pulse ${fill(vitals.pulse, 'sm')} /min`
    : `น้ำหนักตัว ${fill(vitals.weight_kg, 'sm')} กก. &nbsp; ความสูง ${fill(vitals.height_cm, 'sm')} เซนติเมตร &nbsp; ความดันโลหิต ${fill(bp, 'sm')} มม.ปรอท &nbsp; ชีพจร ${fill(vitals.pulse, 'sm')} ครั้ง/นาที`;
  // ถ้อยคำรับรองและรายการโรคตามโครงแบบมาตรฐานแพทยสภา
  const attest = en
    ? `I hereby certify that the above-named person is not incapacitated by physical disability, shows no apparent symptoms of mental disorder or intellectual impairment, no signs of narcotic addiction or chronic alcoholism, and shows no signs or symptoms of the following diseases:`
    : `ขอรับรองว่า บุคคลดังกล่าวไม่เป็นผู้มีร่างกายทุพพลภาพจนไม่สามารถปฏิบัติหน้าที่ได้ ไม่ปรากฏอาการของโรคจิต หรือจิตฟั่นเฟือน หรือปัญญาอ่อน ไม่ปรากฏอาการของการติดยาเสพติดให้โทษ และอาการของโรคพิษสุราเรื้อรัง และไม่ปรากฏอาการและอาการแสดงของโรคดังต่อไปนี้`;
  const diseaseList = en
    ? [`Leprosy in the communicable stage or in a socially objectionable appearance`, `Tuberculosis in the dangerous stage`, `Elephantiasis in a socially objectionable appearance`]
    : [`โรคเรื้อนในระยะติดต่อ หรือในระยะที่ปรากฏอาการเป็นที่รังเกียจแก่สังคม`, `วัณโรคในระยะอันตราย`, `โรคเท้าช้างในระยะที่ปรากฏอาการเป็นที่รังเกียจแก่สังคม`];
  const notes = en
    ? `<div class="notes"><b>Notes</b> (1) This certificate must be issued by a physician holding a licence to practise medicine. (2) This certificate is valid for one month from the examination date. (3) The certification refers to the examination on the date stated only.${driving && ct.declaration.seizure && ct.declaration.seizure.has ? ' Where a history of epilepsy is declared, attach treatment records confirming no seizure for more than one year as required.' : ''}<br>Prepared in accordance with the standard medical certificate form of the Medical Council of Thailand.</div>`
    : `<div class="notes"><b>หมายเหตุ</b> (1) ต้องเป็นแพทย์ซึ่งได้ขึ้นทะเบียนรับใบอนุญาตประกอบวิชาชีพเวชกรรม (2) ใบรับรองแพทย์ฉบับนี้ใช้ได้ 1 เดือนนับแต่วันที่ตรวจร่างกาย (3) คำรับรองอ้างอิงผลการตรวจ ณ วันที่ระบุเท่านั้น${driving ? ' (4) ใช้ประกอบการขอรับ/ต่ออายุใบอนุญาตขับรถ' : ''}${driving && ct.declaration.seizure && ct.declaration.seizure.has ? ' — มีประวัติโรคลมชัก ให้แนบประวัติการรักษาที่รับรองว่าไม่มีอาการชักเกิน 1 ปีตามข้อกำหนด' : ''}<br>จัดทำตามโครงแบบใบรับรองแพทย์มาตรฐานของแพทยสภา</div>`;
  return page(`${title} ${c.cert_no}`, `${certEventMark(c, en)}
<div class="docmeta"><div>${en ? 'No.' : 'เลขที่'} <b>${esc(c.cert_no)}</b><br>${en ? 'Date' : 'วันที่'} ${en ? enDate(c.created_at) : thaiDateOnly(c.created_at)}</div></div>
<h2 style="text-align:center;font-size:19px;margin:0 0 3mm">${title}</h2>
<div class="section"><div style="margin-bottom:2mm"><span class="seclab">${en ? 'Part 1' : 'ส่วนที่ 1'}</span> <b>${en ? 'Applicant self-declaration' : 'ของผู้ขอรับใบรับรองสุขภาพ'}</b></div>
<div class="formline">${en ? 'I,' : 'ข้าพเจ้า'} ${fill(subjectName, 'wide')}</div>
<div class="formline">${en ? 'Address' : 'สถานที่อยู่ (ที่สามารถติดต่อได้)'} ${fill(subjectAddress, 'wide')}</div>
${en ? '' : `<div class="formline">หมายเลขบัตรประจำตัวประชาชน ${fill(patient.citizen_id)}</div>`}
<div class="formline">${en ? 'I request this certificate and declare my health history as follows:' : 'ข้าพเจ้าขอใบรับรองสุขภาพ โดยมีประวัติสุขภาพดังนี้'}</div>
${declarationRows(ct.declaration, en, driving)}
<div class="formline" style="margin-top:4mm">${en ? 'Applicant signature' : 'ลงชื่อ'} ...................................................... ${en ? '' : 'ผู้ขอรับใบรับรอง'} &nbsp; ${en ? 'Date' : 'วันที่'} ${fill(en ? enDate(c.created_at) : thaiDateOnly(c.created_at))}</div>
${en ? '' : '<div class="notes">ในกรณีเด็กที่ไม่สามารถรับรองตนเองได้ ให้ผู้ปกครองลงนามรับรองแทนได้</div>'}</div>
<div class="section"><div style="margin-bottom:2mm"><span class="seclab">${en ? 'Part 2' : 'ส่วนที่ 2'}</span> <b>${en ? 'Physician examination' : 'ของแพทย์'}</b></div>
<div class="formline">${en ? 'Place of examination' : 'สถานที่ตรวจ'} ${fill(clinicOut.name, 'wide')} ${en ? 'Date' : 'วันที่'} ${fill(en ? enDate(c.created_at) : thaiDateOnly(c.created_at))}</div>
<div class="formline">(1) ${en ? 'I,' : 'ข้าพเจ้า'} ${fill(en ? (doctor.name_en || doctor.name) : doctor.name, 'wide')} ${en ? 'holder of medical licence no.' : 'ใบอนุญาตประกอบวิชาชีพเวชกรรมเลขที่'} ${fill(doctor.medical_license)}</div>
<div class="formline">${en ? 'have examined' : 'ได้ตรวจร่างกาย'} ${fill(subjectName, 'wide')} ${en ? 'on' : 'แล้วเมื่อวันที่'} ${fill(en ? enDate(c.created_at) : thaiDateOnly(c.created_at))} ${en ? 'with the following findings:' : 'มีรายละเอียดดังนี้'}</div>
<div class="formline">${vitalsLine}</div>
<div class="formline">${en ? 'General physical condition' : 'สภาพร่างกายทั่วไปอยู่ในเกณฑ์'} &nbsp; <span class="check">${check(ct.general_normal)}</span>${en ? 'Normal' : 'ปกติ'} &nbsp; <span class="check">${check(!ct.general_normal)}</span>${en ? 'Abnormal, specify' : 'ผิดปกติ (ระบุ)'} ${fill(ct.general_normal ? '' : ct.abnormal_detail, 'wide')}</div>
<div class="formline" style="margin-top:2mm">${attest}</div>
<ol class="idxlist">${diseaseList.map(d => `<li>${esc(d)}</li>`).join('')}<li>${en ? 'Others (if any)' : 'อื่น ๆ (ถ้ามี)'} ${fill(ct.other_conditions, 'wide')}</li></ol>
<div class="formline">(2) <b>${en ? 'Summary of physician opinion and recommendation' : 'สรุปความเห็นและข้อแนะนำของแพทย์'}</b></div>
${fillRows(`${ct.physician_opinion}${ct.recommendation ? ` · ${ct.recommendation}` : ''}`, 2)}
${doctorSign(doctor, c.doctor_name, en)}</div>
${notes}`, { clinic: clinicOut, paper: 'A4', language: en ? 'en' : 'th', pageClass: 'tmc-certificate-a4',
    fontScale: medcertScale('tmc-certificate-a4', userScale) });
}

// ใบนัด — เอกสารอำนวยความสะดวก (ไม่ใช่เอกสารกฎหมาย) พิมพ์ตามการตั้งค่าปัจจุบันของคลินิก
// ส่วนบังคับ: หัวคลินิก+โทร, ชื่อคนไข้+HN, วันนัด · ส่วนที่เจ้าของเลือกได้: ชื่อแพทย์, หมายเหตุนัด, ข้อความท้ายใบ
function appointmentSlipHTML(a, opts = {}) {
  const patientName = `${a.prefix || ''}${a.first_name} ${a.last_name || ''}`.trim();
  const showDoctor = getSetting('appt_slip_show_doctor', '1') === '1' && a.doctor_name;
  const showNote = getSetting('appt_slip_show_note', '1') === '1' && a.note;
  const footerText = getSetting('appt_slip_footer', '') || 'หากไม่สะดวกมาตามนัด กรุณาโทรแจ้งเลื่อนนัดล่วงหน้า';
  const clinic = currentClinic();
  return page(`ใบนัด ${patientName}`, `
<h2 style="text-align:center;font-size:20px;margin:0 0 4mm">ใบนัด / Appointment</h2>
<div class="formline">ชื่อผู้ป่วย ${fill(patientName, 'wide')} HN ${fill(a.hn)}</div>
<div class="formline">แพทย์นัดตรวจครั้งต่อไปวันที่</div>
<div style="text-align:center;font-size:24px;font-weight:700;border:1.5px solid #000;border-radius:3mm;padding:4mm;margin:2mm 0">${thaiDateOnly(a.appt_date)}${a.days ? `<div style="font-size:13px;font-weight:400">(อีกประมาณ ${esc(a.days)} วันนับจากวันที่ออกใบนัด)</div>` : ''}</div>
${showDoctor ? `<div class="formline">${opts.multipleDoctors ? 'นัดกับ' : 'แพทย์ผู้ตรวจ'} ${fill(a.doctor_name, 'wide')}</div>` : ''}
${showNote ? `<div class="formline">หมายเหตุ ${fill(a.note, 'wide')}</div>` : ''}
<div class="formline">ออกใบนัดวันที่ ${fill(thaiDateOnly(a.created_at))}</div>
<div class="notes" style="text-align:center;font-size:13px;margin-top:6mm">${esc(footerText)}${clinic.phone ? `<br>โทร. ${esc(clinic.phone)}` : ''}</div>`,
    (() => {
      const paper = appointmentPaper(opts.paper);
      return { clinic, paper, fontScale: apptFontScale(paper, opts.scale) };
    })());
}

module.exports = { receiptHTML, medCertHTML, appointmentSlipHTML, sampleReceiptHTML, sampleAppointmentHTML, sampleMedCertHTML,
  PAPERS, normalizePaper, receiptPaper, appointmentPaper };
