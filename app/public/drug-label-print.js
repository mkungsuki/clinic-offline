'use strict';
// Measure actual rendered Thai text. Any overflow blocks printing, never truncates a label.
let labelReady=false;
function layoutLabels(){
 const host=document.getElementById('labelPages'),warnings=document.getElementById('labelWarnings'),slots=Number(document.body.dataset.slots);
 const selected=[...document.querySelectorAll('.label-choice:checked')].map(c=>Number(c.value));
 document.getElementById('selectedItems').value=selected.join(',');
 host.replaceChildren();warnings.replaceChildren();
 const start=Number(document.getElementById('labelStart').value),errors=[];
 labelReady=false;document.body.classList.add('labels-blocked');document.getElementById('printLabels').disabled=true;
 if(!Number.isInteger(start)||start<1||start>slots)errors.push('เลือกช่องเริ่มพิมพ์ตั้งแต่ 1 ถึง '+slots);
 if(!selected.length)errors.push('เลือกยาอย่างน้อยหนึ่งรายการก่อนพิมพ์');
 if(!errors.length){
  const entries=Array(start-1).fill(null).concat(selected);let page;
  entries.forEach((id,i)=>{
   if(i%slots===0){page=document.createElement('div');page.className='label-page';host.append(page);}
   const label=id===null?document.createElement('div'):document.querySelector('#labelSource [data-item="'+id+'"]').cloneNode(true);
   if(id===null)label.className='drug-label empty';page.append(label);
  });
  for(const label of host.querySelectorAll('[data-item]')){
   const content=label.querySelector('.label-content');
   const bounds=content.getBoundingClientRect(),last=content.lastElementChild.getBoundingClientRect();
   if(content.scrollHeight>content.clientHeight+1||content.scrollWidth>content.clientWidth+1||last.bottom>bounds.bottom+1){
    label.classList.add('overfull');errors.push('ข้อความยาวเกินฉลาก: '+label.dataset.name+' — เปลี่ยนเป็น 2 × 5 หรือใช้ใบยาอ่านง่ายแทน');
   }
  }
 }
 for(const message of errors){const p=document.createElement('p');p.textContent=message;warnings.append(p);}
 labelReady=!errors.length&&document.body.dataset.canPrint==='1';
 document.body.classList.toggle('labels-blocked',!labelReady);document.getElementById('printLabels').disabled=!labelReady;
 window.drugLabelsReady=true;
}
async function printLabels(){
 layoutLabels();if(!labelReady)return;
 const error=document.getElementById('printError'),button=document.getElementById('printLabels');button.disabled=true;error.textContent='กำลังตรวจว่าใบเสร็จยังใช้ได้…';
 try{
  if(document.body.dataset.sample!=='1'){
   const response=await fetch(location.href,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error('ยังไม่สั่งพิมพ์ ฉลากอาจถูกปิดใช้หรือใบเสร็จยกเลิกแล้ว กรุณาเปิดใหม่จากใบเสร็จที่ยังใช้ได้');
  }
  error.textContent='';window.print();
 }catch(e){error.textContent=/TypeError|TimeoutError/.test(e.name)?'ติดต่อเครื่องหลักไม่ได้ ยังไม่สั่งพิมพ์ ตรวจการเชื่อมต่อแล้วกดใหม่':e.message;}
 finally{button.disabled=!labelReady;}
}
document.getElementById('printLabels').addEventListener('click',printLabels);
document.querySelectorAll('.label-choice,#labelStart').forEach(e=>e.addEventListener('change',layoutLabels));
document.querySelector('#labelForm select').addEventListener('change',()=>{document.getElementById('labelStart').value=1;});
window.addEventListener('beforeprint',layoutLabels);
document.fonts.ready.then(layoutLabels);
