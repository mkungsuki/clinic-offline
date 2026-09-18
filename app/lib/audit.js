'use strict';
// Only explicit business fields enter this history. Never serialize a request or user row.
const { AsyncLocalStorage } = require('node:async_hooks');
const { db, now } = require('./db');
const context = new AsyncLocalStorage();
const FIELD_LABELS = Object.freeze({
  prefix:'คำนำหน้า',first_name:'ชื่อ',last_name:'นามสกุล',sex:'เพศ',birth_date:'วันเกิด',citizen_id:'เลขบัตรประชาชน',phone:'เบอร์โทรศัพท์',address:'ที่อยู่',chronic:'โรคประจำตัว',emergency_name:'ผู้ติดต่อฉุกเฉิน',emergency_phone:'เบอร์ผู้ติดต่อฉุกเฉิน',duplicate_of_hn:'เลขคนไข้หลัก',
  weight_kg:'น้ำหนัก',height_cm:'ส่วนสูง',temp_c:'อุณหภูมิ',bp_sys:'ความดันตัวบน',bp_dia:'ความดันตัวล่าง',pulse:'ชีพจร',glucose:'น้ำตาลในเลือด',
  code:'รหัสยา',name:'ชื่อรายการ',generic_name:'ชื่อสามัญยา',unit:'หน่วย',price:'ราคาขาย',cost:'ต้นทุน',reorder_level:'จำนวนเตือนใกล้หมด',default_instructions:'วิธีใช้เริ่มต้น',dose_mode:'รูปแบบสั่งยา',default_dose_json:'ตารางวิธีใช้เริ่มต้น',active:'สถานะใช้งาน',expiry_warn_days:'จำนวนวันเตือนใกล้หมดอายุ',
  drug_id:'รายการยา',expiry_date:'วันหมดอายุ',lot_label:'เลขล็อต / ที่มา',qty_received:'จำนวนรับเข้า',cleared_at:'วันที่ปิดล็อต',cleared_reason:'เหตุผลปิดล็อต',
  username:'ชื่อบัญชี',display_name:'ชื่อแสดง',display_name_en:'ชื่อภาษาอังกฤษ',role:'บทบาท',medical_license:'เลขใบประกอบวิชาชีพ',specialty:'สาขา',front_desk:'สิทธิ์ทำงานหน้าร้าน',password_changed:'เปลี่ยนรหัสผ่าน',pin_changed:'เปลี่ยนรหัสปลดล็อก',
  clinic_name:'ชื่อคลินิก',clinic_address:'ที่อยู่คลินิก',clinic_phone:'เบอร์โทรคลินิก',clinic_license:'เลขใบอนุญาตคลินิก',clinic_logo_file:'ตราคลินิก',document_footer:'ข้อความท้ายเอกสาร',medcert_paper_size:'กระดาษใบรับรองแพทย์',medcert_font_scale:'ขนาดตัวอักษรใบรับรองแพทย์',receipt_font_scale:'ขนาดตัวอักษรใบเสร็จ',appt_font_scale:'ขนาดตัวอักษรใบนัด',stock_expiry_warn_days:'จำนวนวันเตือนหมดอายุค่ากลาง',slip_paper:'กระดาษเอกสารย่อ',receipt_paper:'กระดาษใบเสร็จ',appointment_paper:'กระดาษใบนัด',clinic_name_en:'ชื่อคลินิกภาษาอังกฤษ',clinic_address_en:'ที่อยู่คลินิกภาษาอังกฤษ',receipt_issuer_name:'ชื่อผู้ออกใบเสร็จ',receipt_issuer_address:'ที่อยู่ผู้ออกใบเสร็จ',receipt_tax_id:'เลขผู้เสียภาษี',receipt_branch:'สาขา',receipt_book_no:'เล่มใบเสร็จ',receipt_vat_note:'ข้อความภาษี',receipt_show_doctor:'ชื่อแพทย์บนใบเสร็จ',appt_slip_show_doctor:'ชื่อแพทย์บนใบนัด',appt_slip_show_note:'หมายเหตุบนใบนัด',appt_slip_footer:'ข้อความท้ายใบนัด',default_service_name:'ค่าบริการเริ่มต้น',backup_dest_1:'ที่สำรองภายนอกแห่งแรก',backup_dest_2:'ที่สำรองภายนอกแห่งที่สอง',backup_cloud_dest:'โฟลเดอร์สำรองคลาวด์',backup_time:'เวลาสำรองอัตโนมัติ',auto_print:'การเปิดเอกสารหลังทำรายการ',
  medication_sheet_enabled:'เปิดใบยาอ่านง่าย',medication_sheet_paper:'กระดาษใบยาอ่านง่าย',medication_sheet_font:'ขนาดตัวอักษรใบยาอ่านง่าย',drug_label_enabled:'เปิดฉลากยา',drug_label_layout:'รูปแบบฉลากยา',drug_label_width:'ความกว้างฉลากยา',drug_label_height:'ความสูงฉลากยา',added_count:'จำนวนรายการที่นำเข้า',failed_count:'จำนวนรายการที่นำเข้าไม่ได้',
});
const list = s => Object.freeze(s.split(' '));
const FIELDS = Object.freeze({
  patient:list('prefix first_name last_name sex birth_date citizen_id phone address chronic emergency_name emergency_phone duplicate_of_hn'),
  vitals:list('weight_kg height_cm temp_c bp_sys bp_dia pulse glucose'),
  drug:list('code name generic_name unit price cost reorder_level default_instructions dose_mode default_dose_json active expiry_warn_days'),
  service:list('name price cost active'),
  lot:list('drug_id expiry_date lot_label qty_received cleared_at cleared_reason'),
  user:list('username display_name display_name_en role medical_license specialty active front_desk password_changed pin_changed'),
  settings:list('clinic_name clinic_address clinic_phone clinic_license clinic_logo_file document_footer medcert_paper_size medcert_font_scale receipt_font_scale appt_font_scale stock_expiry_warn_days slip_paper receipt_paper appointment_paper clinic_name_en clinic_address_en receipt_issuer_name receipt_issuer_address receipt_tax_id receipt_branch receipt_book_no receipt_vat_note receipt_show_doctor appt_slip_show_doctor appt_slip_show_note appt_slip_footer default_service_name backup_dest_1 backup_dest_2 backup_cloud_dest backup_time auto_print medication_sheet_enabled medication_sheet_paper medication_sheet_font drug_label_enabled drug_label_layout drug_label_width drug_label_height'),
  stock:list('added_count failed_count'),
});
const ACTIONS = Object.freeze(['create','update','merge','suspend','reactivate','secret_changed','permission','import']);
const ROUTINE_SETTINGS = new Set(['medcert_paper_size','medcert_font_scale','receipt_font_scale','appt_font_scale','slip_paper','receipt_paper','appointment_paper','receipt_show_doctor','appt_slip_show_doctor','appt_slip_show_note','appt_slip_footer','auto_print','medication_sheet_enabled','medication_sheet_paper','medication_sheet_font','drug_label_enabled','drug_label_layout','drug_label_width','drug_label_height']);
function run(ctx, fn) { return context.run({ ...ctx, suppressed:false }, fn); }
function withoutRecording(fn) { return context.run({ ...context.getStore(), suppressed:true }, fn); }
function actor(actorId, source) {
  const ctx = context.getStore();
  const id = source === 'scheduled' ? null : ctx?.session?.userId ?? actorId ?? null;
  const user = id == null ? null : db.prepare('SELECT id, display_name, role FROM users WHERE id=?').get(id);
  const remote = ctx?.remoteAddress || ctx?.session?.remoteAddress;
  return { actor_id:user?.id ?? null, actor_name:source === 'scheduled' ? null : ctx?.session?.displayName ?? user?.display_name ?? null, actor_role:source === 'scheduled' ? null : ctx?.session?.role ?? user?.role ?? null,
    station: source === 'scheduled' || !remote ? 'system' : ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(String(remote).toLowerCase()) ? 'host' : 'lan' };
}
function value(field, value) {
  if (value == null || value === '') return null;
  if (field === 'password_changed' || field === 'pin_changed') return value === true;
  if (field === 'default_dose_json') {
    try {
      const d = typeof value === 'string' ? JSON.parse(value) : value, template = require('../public/dose-template');
      const mode = {standard:'เวลามาตรฐาน',exact_times:'ระบุเวลา',prn:'เมื่อมีอาการ',interval:'ทุกกี่ชั่วโมง',manual:'คำสั่งพิเศษ'}[d.mode] || 'ไม่ทราบรูปแบบ';
      return [template.text(d,d.unit),mode,'หน่วยจ่าย '+String(d.unit||'ไม่ระบุ'),'หน่วยรับประทาน '+template.doseUnit(d,d.unit),d.qty_source==='manual'?'ระบุจำนวนจ่ายเอง':'คำนวณจำนวนจ่ายจากตาราง',d.instructions_source==='manual'?'ระบุวิธีใช้เอง':'สร้างวิธีใช้จากตาราง'].join(' · ');
    }
    catch { return 'รูปแบบเดิมที่อ่านรายละเอียดไม่ได้'; }
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error('ค่าประวัติการทำรายการไม่ถูกต้อง');
}
function record({ category, action='update', entityId, ref, before={}, after={}, reason=null, actorId, important } = {}) {
  const ctx = context.getStore();
  if (ctx?.suppressed || (!ctx?.session && actorId == null)) return null;
  if (!Object.hasOwn(FIELDS,category) || !ACTIONS.includes(action)) throw new Error('ชนิดประวัติการทำรายการไม่ถูกต้อง');
  const changes = {};
  for (const field of FIELDS[category]) {
    if (!Object.hasOwn(after,field)) continue;
    const old = value(field,before?.[field]), next = value(field,after[field]);
    const changed = field === 'default_dose_json' ? (before?.[field] ?? null) !== (after[field] ?? null) : old !== next;
    if (changed) changes[field] = { before:old, after:old === next ? (next || 'ตารางวิธีใช้')+' (เปลี่ยนรายละเอียดตาราง)' : next };
  }
  if (!Object.keys(changes).length && !['create','import'].includes(action)) return null;
  const who = actor(actorId);
  if (!who.actor_id) throw Object.assign(new Error('ไม่พบบัญชีผู้ทำรายการ กรุณาเข้าสู่ระบบใหม่'), {status:401});
  const isImportant = important ?? (category !== 'settings' || Object.keys(changes).some(k => !ROUTINE_SETTINGS.has(k)));
  try {
    return Number(db.prepare(`INSERT INTO audit_changes (created_at,actor_id,actor_name,actor_role,station,category,action,entity_id,ref,changes_json,reason,source,important) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(now(),who.actor_id,who.actor_name,who.actor_role,who.station,category,action,String(entityId ?? ''),String(ref ?? '').slice(0,200),JSON.stringify(changes),reason ? String(reason).slice(0,1000) : null,'app',isImportant?1:0).lastInsertRowid);
  } catch {
    throw Object.assign(new Error('บันทึกประวัติการทำรายการไม่สำเร็จ จึงยังไม่เปลี่ยนข้อมูล กรุณาลองใหม่'), {status:503,code:'AUDIT_WRITE_FAILED'});
  }
}
module.exports = { run, withoutRecording, record, actor, FIELD_LABELS, FIELDS, ACTIONS };
