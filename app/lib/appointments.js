'use strict';
// นัดและประวัติติดตามใช้ SQLite ร่วมกันทั้งสองสถานี; ไม่อนุมานขาดนัดจากการไม่พบ visit.
const { db, txn, now, today } = require('./db');
const doctors = require('./doctors');
function err(message,status=400){return Object.assign(new Error(message),{status});}
function pad(n){return String(n).padStart(2,'0');}
function addDays(date,n){const d=new Date(date+'T00:00:00');d.setDate(d.getDate()+n);return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;}
function diffDays(from,to){return Math.round((new Date(to+'T00:00:00')-new Date(from+'T00:00:00'))/86400000);}
function validDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const [y,m,d]=value.split('-').map(Number);const x=new Date(y,m-1,d);return x.getFullYear()===y&&x.getMonth()===m-1&&x.getDate()===d;}
function nextDate({date,days}){if(date){if(!validDate(date))throw err('วันที่นัดไม่ถูกต้อง');if(date<=today())throw err('วันนัดต้องเป็นวันหน้า');return date;}const n=Number(days);if(!Number.isInteger(n)||n<=0||n>400)throw err('จำนวนวันนัดต้องเป็นเลขเต็ม 1–400 วัน');return addDays(today(),n);}
function text(value,max=2000){if(value==null)return null;if(typeof value!=='string'||value.length>max)throw err(`ข้อความต้องไม่เกิน ${max} ตัวอักษร`);return value.trim()||null;}
function event(id,kind,outcome,note,userId,oldDate,newDate){return Number(db.prepare('INSERT INTO appointment_events (appointment_id,kind,outcome,note,previous_date,appointment_date,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,kind,outcome||null,note||null,oldDate||null,newDate||null,userId??null,now()).lastInsertRowid);}
const SELECT=`SELECT a.*,u.display_name AS doctor_name,p.prefix,p.first_name,p.last_name,p.phone,p.chronic,
 COALESCE((SELECT MAX(e.id) FROM appointment_events e WHERE e.appointment_id=a.id),0) AS last_event_id,
 COALESCE((SELECT e.outcome FROM appointment_events e WHERE e.appointment_id=a.id AND e.kind='attendance'
  AND e.appointment_date=a.appt_date AND e.id>COALESCE((SELECT MAX(r.id) FROM appointment_events r WHERE r.appointment_id=a.id AND r.kind='reschedule'),0) ORDER BY e.id DESC LIMIT 1),'unconfirmed') AS attendance,
 (SELECT e.outcome FROM appointment_events e WHERE e.appointment_id=a.id AND e.kind='contact' AND e.appointment_date=a.appt_date
  AND e.id>COALESCE((SELECT MAX(r.id) FROM appointment_events r WHERE r.appointment_id=a.id AND r.kind='reschedule'),0) ORDER BY e.id DESC LIMIT 1) AS contact_outcome,
 (SELECT MAX(e.created_at) FROM appointment_events e WHERE e.appointment_id=a.id AND e.kind='contact') AS last_contact_at
 FROM appointments a JOIN patients p ON p.hn=a.hn LEFT JOIN users u ON u.id=a.doctor_id`;
function detail(id){const a=db.prepare(SELECT+' WHERE a.id=?').get(id);if(!a)throw err('ไม่พบนัดหมายนี้',404);return a;}
function current(id,expected={}){const a=detail(id);if(a.cancelled)throw err('นัดนี้ยกเลิกไปแล้ว กรุณาเปิดรายการล่าสุด',409);if((expected.expected_event_id!==undefined&&Number(expected.expected_event_id)!==a.last_event_id)||(expected.expected_date!==undefined&&expected.expected_date!==a.appt_date))throw err('รายการนี้เปลี่ยนไปแล้ว กรุณาปิดกล่องแล้วเปิดประวัติล่าสุดก่อนบันทึก',409);return a;}
function create(visitId,body,userId){
 const v=db.prepare('SELECT hn,doctor_id FROM visits WHERE id=?').get(visitId);
 if(!v)throw err('ไม่พบการตรวจครั้งนี้',404);
 const date=nextDate(body),note=text(body.note);
 return txn(()=>{
  const old=db.prepare('SELECT a.*,u.display_name AS doctor_name FROM appointments a LEFT JOIN users u ON u.id=a.doctor_id WHERE a.hn=? AND a.cancelled=0 AND a.appt_date>=? ORDER BY a.appt_date,a.id').all(v.hn,today());
  const foreign=old.filter(a=>a.doctor_id!=null&&a.doctor_id!==userId);
  // Bind confirmation to the exact prior appointments, so a concurrent replacement needs a fresh decision.
  const revision=foreign.map(a=>a.id+':'+a.appt_date+':'+a.doctor_id).join(',');
  if(doctors.multiple()&&foreign.length&&(body.confirm_replace!==true||(body.replace_revision!==undefined&&body.replace_revision!==revision))){
   const a=foreign[0];const e=err('คนไข้มีนัดกับ '+a.doctor_name+' วันที่ '+a.appt_date+' อยู่แล้ว — ตั้งนัดใหม่จะแทนที่นัดนั้น',409);
   e.replace_appointment={revision};throw e;
  }
  const previous=old.find(a=>a.doctor_id!=null);
  const defaultDoctor=previous?.doctor_id??v.doctor_id??null;
  const doctorId=body.doctor_id===undefined?defaultDoctor:doctors.validate(body.doctor_id);
  for(const a of old){db.prepare('UPDATE appointments SET cancelled=1 WHERE id=?').run(a.id);event(a.id,'cancel',null,'ตั้งนัดใหม่แทน'+(a.doctor_name?' · นัดเดิมกับ '+a.doctor_name:''),userId,a.appt_date,a.appt_date);}
  const r=db.prepare('INSERT INTO appointments (hn,visit_id,appt_date,days,note,created_by,created_at,doctor_id) VALUES (?,?,?,?,?,?,?,?)').run(v.hn,visitId,date,diffDays(today(),date),note,userId,now(),doctorId);
  const id=Number(r.lastInsertRowid);event(id,'created',null,note,userId,null,date);return detail(id);
 });
}
function cancel(id,userId,body={}){return txn(()=>{const a=current(id,body);db.prepare('UPDATE appointments SET cancelled=1 WHERE id=?').run(id);event(id,'cancel',null,text(body.reason),userId,a.appt_date,a.appt_date);return detail(id);});}
function reschedule(id,body,userId){return txn(()=>{const a=current(id,body),date=nextDate(body);if(date===a.appt_date)throw err('วันนัดใหม่ตรงกับวันเดิม กรุณาเลือกวันอื่น');const other=db.prepare('SELECT id FROM appointments WHERE hn=? AND id<>? AND cancelled=0 AND appt_date>=? LIMIT 1').get(a.hn,id,today());if(other)throw err('คนไข้มีนัดล่วงหน้าอีกใบอยู่แล้ว กรุณาเปิดนัดล่าสุดก่อนเลื่อน',409);const note=body.note===undefined?a.note:text(body.note);const doctorId=body.doctor_id===undefined?a.doctor_id:doctors.validate(body.doctor_id);db.prepare('UPDATE appointments SET appt_date=?,days=?,note=?,doctor_id=? WHERE id=?').run(date,diffDays(today(),date),note,doctorId,id);event(id,'reschedule',null,note,userId,a.appt_date,date);return detail(id);});}
function attendance(id,body,userId){return txn(()=>{const a=current(id,body);if(!['attended','no_show','unconfirmed'].includes(body.status))throw err('เลือกสถานะการมาตามนัด');if(a.appt_date>today())throw err('ยังไม่ถึงวันนัด จึงยังยืนยันการมาไม่ได้');if(body.status==='no_show'&&a.appt_date>=today())throw err('วันนี้ยังไม่สิ้นสุด ยืนยันขาดนัดได้ตั้งแต่วันพรุ่งนี้');event(id,'attendance',body.status,text(body.note),userId,a.appt_date,a.appt_date);return detail(id);});}
const OUTCOMES=['answered','not_answered','unreachable','declined','reminded','rebooked'];
function contact(id,body,userId){return txn(()=>{const a=current(id,body);if(!OUTCOMES.includes(body.outcome))throw err('เลือกผลการติดต่อ');const note=text(body.note);if(body.outcome==='rebooked'){nextDate({date:body.rebook_date});if(!body.rebook_date)throw err('เลือกวันนัดใหม่ก่อนบันทึก');}else if(body.rebook_date)throw err('เลือกผลติดต่อเป็นตกลงนัดใหม่ก่อน');event(id,'contact',body.outcome,note,userId,a.appt_date,a.appt_date);if(body.outcome==='rebooked')return reschedule(id,{date:body.rebook_date,...(body.doctor_id===undefined?{}:{doctor_id:body.doctor_id})},userId);return detail(id);});}
function history(id){const appointment=detail(id);const events=db.prepare('SELECT e.*,u.display_name AS by_name FROM appointment_events e LEFT JOIN users u ON u.id=e.created_by WHERE e.appointment_id=? ORDER BY e.id DESC').all(id);return {appointment,events};}
function forMonth(ym){if(typeof ym!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym))throw err('เดือนที่เลือกไม่ถูกต้อง');return db.prepare(SELECT+' WHERE a.cancelled=0 AND a.appt_date LIKE ? ORDER BY a.appt_date,a.id').all(ym+'-%');}
function followup(days=30){const n=Number(days);if(!Number.isInteger(n)||n<1||n>90)throw err('เลือกช่วงย้อนหลัง 1–90 วัน');return db.prepare(SELECT+' WHERE a.cancelled=0 AND a.appt_date BETWEEN ? AND ? ORDER BY a.appt_date,a.id').all(addDays(today(),-n),addDays(today(),3));}
function upcomingForPatient(hn){return db.prepare(SELECT+' WHERE a.hn=? AND a.cancelled=0 AND a.appt_date>=? ORDER BY a.appt_date LIMIT 1').get(hn,today())||null;}
module.exports={create,cancel,reschedule,forMonth,upcomingForPatient,diffDays,validDate,attendance,contact,history,followup,detail};