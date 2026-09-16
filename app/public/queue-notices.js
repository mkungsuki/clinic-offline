'use strict';
// Presentation only; acknowledge locally without storing names/HN or changing visits.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.QueueNotices=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function key(v){return [v.visit_date,v.id,v.created_at,v.requeued_at||'',v.doctor_id].join('|');}
  function groups(rows,id){const w=rows.filter(v=>v.state==='WAITING');return [
    {id:'mine',title:'รอฉัน',rows:w.filter(v=>v.preferred_doctor_id===id)},
    {id:'shared',title:'ไม่ระบุหมอ · เรียกได้ตามคิว',rows:w.filter(v=>!v.preferred_doctor_id)},
    {id:'other',title:'รอหมออื่น · เรียกตรวจแทนได้',rows:w.filter(v=>v.preferred_doctor_id&&v.preferred_doctor_id!==id)}];}
  function pending(rows,ack){return rows.filter(v=>v.state==='IN_EXAM'&&!ack.has(key(v)));}
  function mount({host,storage,storageKey,esc,multiple,onStorageEvent}){
    let rows=[],ack=new Set(),lastHTML='',storageFailed=false;
    function read(){try{const saved=JSON.parse(storage.getItem(storageKey)||'[]');if(!Array.isArray(saved)||saved.some(k=>typeof k!=='string'))throw Error('invalid');ack=new Set(saved.slice(-500));}catch{storageFailed=true;}}
    read();
    function render(){const list=pending(rows,ack);
      const html=`<div class="call-notice-heading" role="status" aria-live="polite">${list.length?`หมอเรียกเข้าห้องตรวจ · รอเรียก ${list.length} รายการ`:'ยังไม่มีรายการเรียกคิวที่รอรับทราบ'}<small>${storageFailed?'จำการรับทราบไม่ได้ — เปิดหน้าใหม่อาจแจ้งซ้ำ':'รับทราบเฉพาะเบราว์เซอร์นี้ · เลื่อนดูได้เมื่อมีหลายรายการ'}</small></div>
      <div class="call-notice-list" tabindex="0" aria-label="รายการหมอเรียกคนไข้">${list.map(v=>`<div class="call-notice-item" data-call-key="${esc(key(v))}"><b class="call-notice-number">${v.queue_no}</b><div class="call-notice-person"><strong>${multiple()?esc(v.doctor_name||'หมอผู้ตรวจ'):'หมอเรียกตรวจ'}</strong><span title="${esc((v.prefix||'')+v.first_name+' '+(v.last_name||''))}">${esc((v.prefix||'')+v.first_name+' '+(v.last_name||''))}</span></div><button type="button" class="btn sm" data-ack-call="${esc(key(v))}">เรียกคนไข้แล้ว ✓</button></div>`).join('')||'<div class="call-notice-empty">ทำงานหน้าร้านต่อได้ตามปกติ</div>'}</div>`;
      if(html!==lastHTML){host.innerHTML=html;lastHTML=html;}
    }
    host.addEventListener('click',event=>{const button=event.target.closest('[data-ack-call]');if(!button||!host.contains(button))return;
      read();ack.add(button.dataset.ackCall);const dates=new Set(rows.map(v=>v.visit_date));ack=new Set([...ack].filter(k=>dates.has(k.split('|')[0])).slice(-500));
      try{storage.setItem(storageKey,JSON.stringify([...ack]));}catch{storageFailed=true;}render();
    });
    if(onStorageEvent)onStorageEvent(event=>{if(event.key===storageKey){read();render();}});
    return {update(next){rows=next;render();}};
  }
  return {key,groups,pending,mount};
});
