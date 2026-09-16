'use strict';
// Synthetic trial extension, reusable only on the demo database. No real data import.
const {db,txn,getSetting,setSetting,now,today}=require('./lib/db');
const appts=require('./lib/appointments');
function seedAppointmentFollowup() {
  if(getSetting('demo_mode')!=='1')throw Error('เพิ่มนัดตัวอย่างได้เฉพาะชุดทดลอง');
  if(getSetting('demo_appointment_followup_v1')==='1')return;
  const front=db.prepare("SELECT id FROM users WHERE role='front' AND active=1 LIMIT 1").get().id;
  const people=db.prepare('SELECT hn FROM patients WHERE hn NOT IN (SELECT hn FROM appointments WHERE cancelled=0 AND appt_date>=?) ORDER BY hn LIMIT 20').all(today());
  if(people.length<16)throw Error('ชุดทดลองต้องมีรายชื่อสังเคราะห์อย่างน้อย 16 คนที่ยังไม่มีนัดล่วงหน้า');
  const offset=n=>{const d=new Date(today()+'T00:00:00');d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  txn(()=>{
    people.slice(0,16).forEach((p,i)=>{
      const days=[-10,-8,-7,-5,-4,-3,-2,-1,-1,0,0,0,1,1,3,3][i];
      const id=Number(db.prepare('INSERT INTO appointments (hn,visit_id,appt_date,days,note,created_by,created_at) VALUES (?,NULL,?,?,?,?,?)').run(p.hn,offset(days),days,['ติดตามความดันและรับยาต่อ','นำบันทึกน้ำตาลมาด้วย','ติดตามอาการหลังรักษา','ตรวจติดตามตามนัด'][i%4],front,now()).lastInsertRowid);
      if(i<6)appts.attendance(id,{status:i===5?'attended':'no_show'},front);
      if(i===1)appts.contact(id,{outcome:'not_answered',note:'โทรแล้วหนึ่งครั้ง ยังไม่รับสาย — นัดตัวอย่าง'},front);
      if(i===2)appts.contact(id,{outcome:'declined',note:'ยังไม่สะดวกเดินทาง ขอคุยกับครอบครัวก่อน — นัดตัวอย่าง'},front);
      if(i===3)appts.contact(id,{outcome:'rebooked',rebook_date:offset(7),note:'ตกลงนัดใหม่ในสัปดาห์หน้า — นัดตัวอย่าง'},front);
      if(i===4)appts.contact(id,{outcome:'unreachable',note:'ติดต่อเบอร์เดิมไม่ได้ — นัดตัวอย่าง'},front);
      if(i===12)appts.contact(id,{outcome:'reminded',note:'รับทราบวันนัดและเตรียมสมุดความดัน — นัดตัวอย่าง'},front);
    });
    setSetting('demo_appointment_followup_v1','1');
  });
}
module.exports={seedAppointmentFollowup};