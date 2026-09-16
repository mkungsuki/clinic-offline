'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.DoseTemplate=factory();})(typeof globalThis==='object'?globalThis:this,function(){
 const modes=['standard','exact_times','prn','manual'];
 function empty(mode='standard'){return {mode,m:0,n:0,e:0,b:0,timing:'',days:0,times:[],prn_amount:0,prn_indication:'',prn_interval_hours:0,prn_max_per_day:0,additional_instructions:'',qty_source:'calculated',instructions_source:'calculated'};}
 function fail(message){throw Object.assign(new Error(message),{status:400});}
 function num(x,label){if(x==null||x==='')return 0;if(!['number','string'].includes(typeof x)||!/^\d+(?:\.\d+)?$/.test(String(x).trim()))fail(label+' ต้องเป็นตัวเลข เช่น 0.5 สำหรับครึ่งหน่วย');const n=Number(x);if(!Number.isFinite(n)||n<0||n>100000)fail(label+' ไม่ถูกต้อง');return n;}
 function normalize(value,unit){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value)||!modes.includes(value.mode))fail('เลือกรูปแบบสั่งยาให้ถูกต้อง');
  const d=empty(value.mode);d.unit=String(unit||'').trim();if(!d.unit)fail('ใส่หน่วยยาก่อนตั้งวิธีใช้');
  if(value.unit&&value.unit!==d.unit)fail('หน่วยยาเปลี่ยน กรุณาทวนตารางวิธีใช้ให้ตรงกับหน่วยใหม่');
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
  if(d.mode==='manual'){d.qty_source='manual';d.instructions_source='manual';}
  return d;
 }
 function perDay(d){if(!d)return 0;if(d.mode==='standard')return (+d.m||0)+(+d.n||0)+(+d.e||0)+(+d.b||0);if(d.mode==='exact_times')return (d.times||[]).reduce((a,x)=>a+(+x.amount||0),0);return 0;}
 function text(d,unit){if(!d)return '';const u=unit||d.unit||'หน่วย';let t='';
  if(d.mode==='standard')t=[['m','เช้า'],['n','เที่ยง'],['e','เย็น'],['b','ก่อนนอน']].filter(([k])=>+d[k]>0).map(([k,label])=>label+' '+d[k]+' '+u).join(' / ');
  if(d.mode==='exact_times')t=d.times.map(x=>x.time+' '+x.amount+' '+u).join(' / ');
  if(['standard','exact_times'].includes(d.mode)&&t){if(d.timing)t+=' '+d.timing;if(d.days)t+=' · '+d.days+' วัน';}
  if(d.mode==='prn'&&d.prn_amount&&d.prn_indication){t='ครั้งละ '+d.prn_amount+' '+u+' เมื่อ'+d.prn_indication;if(d.prn_interval_hours)t+=' ห่างอย่างน้อย '+d.prn_interval_hours+' ชม.';if(d.prn_max_per_day)t+=' ไม่เกิน '+d.prn_max_per_day+' ครั้ง/วัน';}
  return [t,d.additional_instructions].filter(Boolean).join(' · ');
 }
 function read(item){try{const raw=item.default_dose_json?JSON.parse(item.default_dose_json):item.default_dose;if(!raw)return null;return normalize(raw,item.unit);}catch{return null;}}
 return {empty,normalize,perDay,text,read};
});
