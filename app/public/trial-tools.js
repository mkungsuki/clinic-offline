'use strict';
const TRIAL_OPERATION_KEY='clinic-trial-maintenance-operation';
let trialOperation=null;
let trialResultHome='';
function result(text){const box=document.getElementById('trialResult');box.hidden=false;box.textContent=text;}
function setTrialBusy(value){for(const id of ['resetTrial','uninstallTrial','retryTrial'])document.getElementById(id).disabled=value;}
function beginTrial(action){
 if(trialOperation)return;
 trialOperation={action,op_id:crypto.randomUUID()};
 trialOperation.resultFolder=trialResultHome+'\\'+trialOperation.op_id;
 try{localStorage.setItem(TRIAL_OPERATION_KEY,JSON.stringify(trialOperation));}catch{trialOperation=null;result('บันทึกคำสั่งรอบนี้ไม่ได้ กรุณาเปิดเบราว์เซอร์แบบปกติก่อน เพื่อป้องกันการลบซ้ำ');return;}
 sendTrial();
}
async function sendTrial(){
 if(!trialOperation)return;
 setTrialBusy(true);
 // Persist BEFORE dispatch: the helper may stop the server before its HTTP reply arrives.
 result('กำลังเปิดตัวช่วย กรุณาดูกล่อง Windows บนเครื่องนี้และอ่านก่อนยืนยัน\nโปรแกรมอาจปิดระหว่างทำงาน ให้รอกล่องแจ้งผล ไม่ต้องกดเริ่มฝึกใหม่ซ้ำ\n\nโฟลเดอร์ผลและปุ่ม ทำต่อ.cmd:\n'+trialOperation.resultFolder);
 document.getElementById('newTrialOperation').hidden=false;
 try{
  // Plain fetch deliberately avoids the global offline overlay hiding the durable instructions.
  const response=await fetch('/api/admin/trial-tools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(trialOperation)});
  const body=await response.json();if(!response.ok)throw Error(body.error||'ยังเปิดตัวช่วยไม่ได้');
  result(body.message+'\n\nโฟลเดอร์ผลและปุ่มทำต่อ:\n'+body.resultFolder+'\n\nเมื่อเริ่มฝึกใหม่เสร็จ ให้ปิดแท็บเก่าแล้วเปิดระบบคลินิก (ทดลอง) เพื่อเข้าสู่ระบบใหม่');
 }catch(error){const detail=/[ก-๙]/.test(error.message)?error.message:'การเชื่อมต่อขาดระหว่างรอผล';result('ยังยืนยันผลคำสั่งไม่ได้: '+detail+'\nตรวจกล่อง Windows บนเครื่องนี้ก่อน หากงานค้างให้เปิด ทำต่อ.cmd ในโฟลเดอร์ผลเดิม หากไม่มีหน้าต่างและโปรแกรมยังเปิดได้ ให้กด “เปิดตัวช่วยงานเดิมอีกครั้ง”\n\nโฟลเดอร์ผลเดิม:\n'+trialOperation.resultFolder);}
 finally{document.getElementById('retryTrial').hidden=false;document.getElementById('retryTrial').disabled=false;}
}
function newTrialOperation(){localStorage.removeItem(TRIAL_OPERATION_KEY);location.reload();}
initPage('admin').then(async me=>{
 if(!me||me.role!=='admin')return;
 try{
  const s=await api('GET','/api/admin/trial-tools');
  trialResultHome=s.resultHome||'';
  document.getElementById('availability').textContent=!s.available?'คำสั่งนี้ใช้ได้เฉพาะชุดทดลองที่ติดตั้งแล้ว':!s.host?'ให้ผู้ดูแลเปิดหน้านี้จากไอคอนชุดทดลองบนเครื่องหลัก':'ใช้กับชุดทดลองบนเครื่องนี้เท่านั้น';
  if(!s.available||!s.host)return;
  document.getElementById('choices').hidden=false;
  try{trialOperation=JSON.parse(localStorage.getItem(TRIAL_OPERATION_KEY)||'null');}catch{}
  if(trialOperation){setTrialBusy(true);result('มีคำสั่งจากรอบก่อน กรุณาดูผลในกล่อง Windows หรือโฟลเดอร์ผลเดิมก่อนเริ่มงานใหม่\n\n'+trialOperation.resultFolder);document.getElementById('retryTrial').hidden=false;document.getElementById('retryTrial').disabled=false;document.getElementById('newTrialOperation').hidden=false;}
 }catch{document.getElementById('availability').textContent='ยังตรวจชุดทดลองไม่ได้ กรุณาเปิดหน้านี้ใหม่';}
});
