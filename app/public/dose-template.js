'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.DoseTemplate=factory();})(typeof globalThis==='object'?globalThis:this,function(){
 const modes=['standard','exact_times','prn','interval','manual'];
 function empty(mode='standard'){return {mode,m:0,n:0,e:0,b:0,timing:'',days:0,times:[],dose_unit:'',prn_amount:0,prn_indication:'',prn_interval_hours:0,prn_max_per_day:0,interval_amount:0,interval_min_hours:0,interval_max_hours:0,interval_indication:'',additional_instructions:'',qty_source:'calculated',instructions_source:'calculated'};}
 function fail(message){throw Object.assign(new Error(message),{status:400});}
 function num(x,label){if(x==null||x==='')return 0;if(!['number','string'].includes(typeof x)||!/^\d+(?:\.\d+)?$/.test(String(x).trim()))fail(label+' ต้องเป็นตัวเลข เช่น 0.5 สำหรับครึ่งหน่วย');const n=Number(x);if(!Number.isFinite(n)||n<0||n>100000)fail(label+' ไม่ถูกต้อง');return n;}
 function normalize(value,unit){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value)||!modes.includes(value.mode))fail('เลือกรูปแบบสั่งยาให้ถูกต้อง');
  const d=empty(value.mode);d.unit=String(unit||'').trim();if(!d.unit)fail('ใส่หน่วยยาก่อนตั้งวิธีใช้');
  if(value.unit&&value.unit!==d.unit)fail('หน่วยยาเปลี่ยน กรุณาทวนตารางวิธีใช้ให้ตรงกับหน่วยใหม่');
  if(value.dose_unit!=null&&typeof value.dose_unit!=='string')fail('ใส่หน่วยขนาดยาเป็นข้อความ เช่น มล.');
  d.dose_unit=String(value.dose_unit||'').trim();if(d.dose_unit.length>80)fail('หน่วยขนาดยายาวเกินไป');
  d.additional_instructions=String(value.additional_instructions||'').trim();if(d.additional_instructions.length>2000)fail('คำแนะนำเพิ่มเติมยาวเกินไป');
  d.timing=value.timing||'';if(!['','ก่อนอาหาร','หลังอาหาร','พร้อมอาหาร'].includes(d.timing))fail('เลือกมื้ออาหารให้ถูกต้อง');
  if(['standard','exact_times'].includes(d.mode)){d.days=num(value.days,'จำนวนวัน');if(!Number.isInteger(d.days)||d.days>3650)fail('จำนวนวันต้องเป็นจำนวนเต็มไม่เกิน 3650');}
  if(d.mode==='standard')for(const k of ['m','n','e','b'])d[k]=num(value[k],'ขนาดต่อเวลา');
  if(d.mode==='exact_times'){
   if(!Array.isArray(value.times)||value.times.length>8)fail('ระบุเวลาได้ไม่เกิน 8 ช่วง');
   d.times=value.times.filter(x=>x&&(x.time||x.amount)).map(x=>{const amount=num(x.amount,'จำนวนต่อเวลา');if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x.time))||amount<=0)fail('ใส่เวลาและจำนวนให้ครบทุกแถว');return {time:x.time,amount};});
   if(new Set(d.times.map(x=>x.time)).size!==d.times.length)fail('มีเวลาซ้ำ กรุณาทวนตาราง');
  }
  if(d.mode==='prn'){d.prn_amount=num(value.prn_amount,'ขนาดเมื่อมีอาการ');d.prn_indication=String(value.prn_indication||'').trim();d.prn_interval_hours=num(value.prn_interval_hours,'ระยะห่าง');d.prn_max_per_day=num(value.prn_max_per_day,'จำนวนครั้งสูงสุด');if(d.prn_indication.length>500)fail('ข้อความอาการยาวเกินไป');if((d.prn_amount||d.prn_indication||d.prn_interval_hours||d.prn_max_per_day)&&(!d.prn_amount||!d.prn_indication))fail('ใส่ขนาดและอาการที่ใช้ยาให้ครบ');}
  if(d.mode==='interval'){
   d.interval_amount=num(value.interval_amount,'ขนาดต่อครั้ง');d.interval_min_hours=num(value.interval_min_hours,'ระยะห่างชั่วโมง');d.interval_max_hours=num(value.interval_max_hours,'ระยะห่างสูงสุด');d.interval_indication=String(value.interval_indication||'').trim();
   if(!d.interval_amount||!d.interval_min_hours)fail('ใส่ขนาดต่อครั้งและทุกกี่ชั่วโมงให้ครบ');
   if(d.interval_max_hours&&d.interval_max_hours<d.interval_min_hours)fail('ชั่วโมงปลายช่วงต้องไม่น้อยกว่าชั่วโมงเริ่มต้น');
   if(d.interval_indication.length>500)fail('ข้อความอาการยาวเกินไป');
  }
  if(value.qty_source==='manual'||d.mode==='interval'||doseUnit(d,d.unit)!==d.unit)d.qty_source='manual';
  if(value.instructions_source==='manual')d.instructions_source='manual';
  if(d.mode==='manual'){d.qty_source='manual';d.instructions_source='manual';}
  return d;
 }
 function perDay(d){if(!d)return 0;if(d.mode==='standard')return (+d.m||0)+(+d.n||0)+(+d.e||0)+(+d.b||0);if(d.mode==='exact_times')return (d.times||[]).reduce((a,x)=>a+(+x.amount||0),0);return 0;}
 function doseUnit(d,dispenseUnit){return String(d?.dose_unit||dispenseUnit||d?.unit||'หน่วย').trim();}
 function canCalculateQty(d,dispenseUnit){const unit=String(dispenseUnit||d?.unit||'').trim();return !!(d&&unit&&['standard','exact_times'].includes(d.mode)&&doseUnit(d,unit)===unit&&Number.isFinite(perDay(d))&&perDay(d)>0&&Number.isInteger(+d.days)&&+d.days>0);}
 function quantity(d,dispenseUnit){return canCalculateQty(d,dispenseUnit)?Math.ceil(perDay(d)*Number(d.days)):0;}
 function text(d,unit){if(!d)return '';const u=doseUnit(d,unit);let t='';
  if(d.mode==='standard')t=[['m','เช้า'],['n','เที่ยง'],['e','เย็น'],['b','ก่อนนอน']].filter(([k])=>+d[k]>0).map(([k,label])=>label+' '+d[k]+' '+u).join(' / ');
  if(d.mode==='exact_times')t=d.times.map(x=>x.time+' '+x.amount+' '+u).join(' / ');
  if(['standard','exact_times'].includes(d.mode)&&t){if(d.timing)t+=' '+d.timing;if(d.days)t+=' · '+d.days+' วัน';}
  if(d.mode==='prn'&&d.prn_amount&&d.prn_indication){t='ครั้งละ '+d.prn_amount+' '+u+' เมื่อ'+d.prn_indication;if(d.prn_interval_hours)t+=' ห่างอย่างน้อย '+d.prn_interval_hours+' ชม.';if(d.prn_max_per_day)t+=' ไม่เกิน '+d.prn_max_per_day+' ครั้ง/วัน';}
  if(d.mode==='interval'&&d.interval_amount&&d.interval_min_hours){const range=d.interval_max_hours&&d.interval_max_hours!==d.interval_min_hours?d.interval_min_hours+'–'+d.interval_max_hours:d.interval_min_hours;t='ครั้งละ '+d.interval_amount+' '+u+' ทุก '+range+' ชม.';if(d.interval_indication)t+=' เมื่อ'+d.interval_indication;if(d.timing)t+=' '+d.timing;}
  return [t,d.additional_instructions].filter(Boolean).join(' · ');
 }
 function read(item){try{const raw=item.default_dose_json?JSON.parse(item.default_dose_json):item.default_dose;if(!raw)return null;return normalize(raw,item.unit);}catch{return null;}}
 return {empty,normalize,perDay,doseUnit,canCalculateQty,quantity,text,read};
});
