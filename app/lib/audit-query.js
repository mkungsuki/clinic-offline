'use strict';
// Administrator-only callers must guard both entry points. The adapters return
// human-readable allowlisted fields, never rows from a business table verbatim.
const { db, today, getSetting, DATA_DIR } = require('./db');
const patients = require('./patients');
const { FIELD_LABELS, FIELDS } = require('./audit');
const { readStatus } = require('./audit-restore-status');
const CATEGORIES = Object.freeze({ patient:'คนไข้', stock:'ยาและสต็อก', money:'เงิน', document:'เอกสาร', account:'บัญชีผู้ใช้', backup:'สำรองข้อมูล' });
const SQL_BACKUP = "CASE WHEN json_valid(b.detail) THEN b.detail ELSE '{}' END";
const AUDIT_CATEGORY = `CASE WHEN a.category IN ('patient','vitals') THEN 'patient' WHEN a.category IN ('drug','service','lot','stock') THEN 'stock' WHEN a.category='settings' AND (json_type(a.changes_json,'$.backup_time') IS NOT NULL OR json_type(a.changes_json,'$.backup_dest_1') IS NOT NULL OR json_type(a.changes_json,'$.backup_dest_2') IS NOT NULL OR json_type(a.changes_json,'$.backup_cloud_dest') IS NOT NULL) THEN 'backup' ELSE 'account' END`;

// Every source has the same small projection. Selection and COUNT run in SQLite;
// fetching one more page never loads an unbounded table into JavaScript.
const SOURCES = [
  { key:'change', sql:`SELECT a.id, a.created_at time, a.actor_id, a.actor_name, a.station, a.ref reference,
    CASE WHEN a.category IN ('patient','vitals') THEN a.ref ELSE '' END hn,
    CASE WHEN a.category='drug' THEN CAST(a.entity_id AS INTEGER) WHEN a.category='lot' THEN (SELECT drug_id FROM drug_lots WHERE id=CAST(a.entity_id AS INTEGER)) ELSE NULL END drug_id,
    ${AUDIT_CATEGORY} category, a.important, a.action, json_object('category',a.category,'changes',json(a.changes_json),'reason',a.reason,'entity',a.entity_id) data FROM audit_changes a WHERE a.category<>'settings'` },
  { key:'patient', sql:`SELECT hn id, created_at time, created_by actor_id, NULL actor_name, NULL station, hn reference, hn, NULL drug_id, 'patient' category, 0 important, 'create' action, '{}' data FROM patients` },
  { key:'allergy', sql:`SELECT id, created_at time, created_by actor_id, NULL actor_name, NULL station, hn reference, hn, NULL drug_id, 'patient' category, 1 important, action, json_object('substance',substance,'reaction',reaction,'reason',reason) data FROM allergy_log` },
  ...['note','order'].map(kind => ({ key:kind, sql:`SELECT n.id, n.created_at time, n.created_by actor_id, NULL actor_name, NULL station, v.hn reference, v.hn, NULL drug_id, 'patient' category, CASE WHEN n.version>1 THEN 1 ELSE 0 END important, 'version' action, json_object('version',n.version,'visit',n.visit_id${kind==='order' ? ", 'reason',n.edit_reason" : ''}) data FROM ${kind}_versions n JOIN visits v ON v.id=n.visit_id` })),
  { key:'stock', sql:`SELECT id, created_at time, created_by actor_id, NULL actor_name, NULL station, coalesce(ref,'') reference, coalesce((SELECT hn FROM receipts WHERE receipt_no=stock_movements.ref),'') hn, drug_id, 'stock' category, CASE WHEN type IN ('adjust','void_return') THEN 1 ELSE 0 END important, type action, json_object('qty',qty,'reason',reason) data FROM stock_movements` },
  ...['create','close'].map(kind=>({key:'lot_'+kind,sql:`SELECT l.id,l.${kind==='create'?'received_at':'cleared_at'} time,l.${kind==='create'?'received_by':'cleared_by'} actor_id,NULL actor_name,NULL station,CAST(l.id AS TEXT) reference,'' hn,l.drug_id,'stock' category,${kind==='create'?0:1} important,'${kind}' action,json_object('reason',${kind==='close'?'l.cleared_reason':"''"}) data FROM drug_lots l WHERE ${kind==='close'?'l.cleared_at IS NOT NULL AND ':''}NOT EXISTS(SELECT 1 FROM audit_changes a WHERE a.category='lot' AND a.entity_id=CAST(l.id AS TEXT) AND a.action='${kind==='create'?'create':'suspend'}')`})),
  ...['issue','void'].map(kind => ({ key:`receipt_${kind}`, sql:`SELECT receipt_no id, ${kind==='issue'?'created_at':'voided_at'} time, ${kind==='issue'?'created_by':'voided_by'} actor_id, NULL actor_name, NULL station, receipt_no reference, hn, NULL drug_id, 'money' category, ${kind==='void'?1:0} important, '${kind}' action, json_object('total',total,'pay_method',pay_method,'reason',${kind==='void'?'void_reason':'discount_reason'}) data FROM receipts${kind==='void'?" WHERE status='VOID' AND voided_at IS NOT NULL":''}` })),
  { key:'certificate', sql:`SELECT cert_no id, created_at time, created_by actor_id, NULL actor_name, NULL station, cert_no reference, hn, NULL drug_id, 'document' category, 0 important, 'issue' action, '{}' data FROM med_certs` },
  { key:'certificate_event', sql:`SELECT e.id, e.created_at time, e.created_by actor_id, NULL actor_name, NULL station, e.cert_no reference, c.hn, NULL drug_id, 'document' category, 1 important, e.action, json_object('reason',e.reason,'replacement',e.replacement_cert_no) data FROM med_cert_events e JOIN med_certs c ON c.cert_no=e.cert_no` },
  { key:'print', sql:`SELECT p.id, p.created_at time, p.printed_by actor_id, NULL actor_name, p.station, p.doc_ref reference, coalesce(v.hn,'') hn, NULL drug_id, 'document' category, 0 important, 'print' action, json_object('type',p.doc_type) data FROM document_print_events p LEFT JOIN visits v ON v.id=p.visit_id` },
  { key:'appointment', sql:`SELECT e.id,e.created_at time,e.created_by actor_id,NULL actor_name,NULL station,a.hn reference,a.hn,NULL drug_id,'document' category,CASE WHEN e.kind IN ('reschedule','cancel') THEN 1 ELSE 0 END important,e.kind action,json_object('previous_date',e.previous_date,'appointment_date',e.appointment_date,'outcome',e.outcome,'note',e.note) data FROM appointment_events e JOIN appointments a ON a.id=e.appointment_id` },
  { key:'auth', sql:`SELECT id, created_at time, user_id actor_id, username actor_name, station, coalesce(username,'') reference, '' hn, NULL drug_id, 'account' category, CASE WHEN event IN ('login_fail','unlock_fail','locked_out','clock_override') THEN 1 ELSE 0 END important, event action, '{}' data FROM auth_events` },
  // document_print_events is canonical; access_log.print would duplicate a print.
  { key:'access', sql:`SELECT id, created_at time, user_id actor_id, NULL actor_name, station, ref reference, ref hn, NULL drug_id, 'account' category, CASE WHEN action='export' THEN 1 ELSE 0 END important, action, '{}' data FROM access_log WHERE action<>'print'` },
  { key:'backup', sql:`SELECT b.id, b.finished_at time, json_extract(${SQL_BACKUP},'$.actor_id') actor_id, json_extract(${SQL_BACKUP},'$.actor_name') actor_name, json_extract(${SQL_BACKUP},'$.station') station, '' reference, '' hn, NULL drug_id, 'backup' category, CASE WHEN b.ok=0 THEN 1 ELSE 0 END important, CASE WHEN b.ok=1 THEN 'success' ELSE 'failure' END action, b.detail data FROM backup_log b` },
];
// One settings save may change independent topics. Project only that topic's
// fields in each group; keep one immutable stored event, with distinct view keys.
for (const category of ['document','stock','backup']) {
  const test=category==='backup'?"j.key IN ('backup_time','backup_dest_1','backup_dest_2','backup_cloud_dest')":category==='stock'?"j.key='stock_expiry_warn_days'":"j.key NOT IN ('backup_time','backup_dest_1','backup_dest_2','backup_cloud_dest','stock_expiry_warn_days')";
  SOURCES.push({key:'setting_'+category,sql:`SELECT a.id,a.created_at time,a.actor_id,a.actor_name,a.station,a.ref reference,'' hn,NULL drug_id,'${category}' category,a.important,a.action,json_object('category','settings','changes',json((SELECT json_group_object(j.key,json(j.value)) FROM json_each(a.changes_json) j WHERE ${test})),'reason',a.reason,'entity',a.entity_id) data FROM audit_changes a WHERE a.category='settings' AND EXISTS(SELECT 1 FROM json_each(a.changes_json) j WHERE ${test})`});
}
function bad(message) { throw Object.assign(new Error(message), { status:400 }); }
function text(value, max=300) { return value == null ? '' : String(value).slice(0,max); }
function escLike(value) { return String(value).replace(/[%_\\]/g, x => '\\'+x); }
function parse(value) { try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed==='object' ? parsed : {}; } catch { return {}; } }
function date(value, fallback) {
  if (!value) return fallback;
  const s=String(value); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s+'T00:00:00Z')) || new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s) bad('วันที่ค้นหาไม่ถูกต้อง');
  return s;
}
function options(input={}) {
  const q = text(input.q,121).trim(); if (q.length>120) bad('กรุณาใช้คำค้นไม่เกิน 120 ตัวอักษร');
  let category = input.category || 'all'; if (category!=='all' && !Object.hasOwn(CATEGORIES,category)) bad('ไม่พบหมวดที่เลือก');
  const quick = input.quick || ''; if (!['','adjust','price','void','patient'].includes(quick)) bad('ไม่พบทางลัดที่เลือก');
  if (quick) category = { adjust:'stock',price:'stock',void:'money',patient:'patient' }[quick];
  const end=date(input.to,today()); const startDate=new Date(end+'T00:00:00Z'); startDate.setUTCDate(startDate.getUTCDate()-6);
  const from=date(input.from,startDate.toISOString().slice(0,10)); if (from>end) bad('วันเริ่มต้นต้องไม่อยู่หลังวันสิ้นสุด');
  const requested=Number(input.limit ?? 50); if (!Number.isFinite(requested) || requested<1) bad('จำนวนรายการไม่ถูกต้อง');
  const actorId=input.actorId==null||input.actorId===''?null:Number(input.actorId); if (actorId!==null && (!Number.isSafeInteger(actorId)||actorId<1)) bad('ผู้ทำรายการไม่ถูกต้อง');
  return {q,category,quick,from,to:end,limit:Math.min(1000,Math.max(50,Math.ceil(requested/50)*50)),important:input.important!=='0',actorId};
}
function resolve(q) {
  if (!q) return { patients:[], drugs:[], actors:[], limited:false };
  const found=patients.search(q,101);
  const like='%'+escLike(q)+'%';
  // Clinical search hides merged records; investigation must still find the HN
  // that was merged, including when its name has never been edited.
  const merged=db.prepare("SELECT hn,prefix,first_name,last_name,duplicate_of_hn FROM patients WHERE duplicate_of_hn IS NOT NULL AND (hn LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR (first_name||' '||last_name) LIKE ? ESCAPE '\\') LIMIT 101").all(like,like,like,like);
  for(const p of merged) if(!found.some(x=>x.hn===p.hn)&&found.length<101)found.push(p);
  const historicalHns=db.prepare(`SELECT DISTINCT ref hn FROM audit_changes WHERE category='patient' AND (json_extract(changes_json,'$.first_name.before') LIKE ? ESCAPE '\\' OR json_extract(changes_json,'$.first_name.after') LIKE ? ESCAPE '\\' OR json_extract(changes_json,'$.last_name.before') LIKE ? ESCAPE '\\' OR json_extract(changes_json,'$.last_name.after') LIKE ? ESCAPE '\\') LIMIT 101`).all(like,like,like,like);
  for(const old of historicalHns) if(!found.some(p=>p.hn===old.hn) && found.length<101) {
    const p=db.prepare('SELECT hn,prefix,first_name,last_name,duplicate_of_hn FROM patients WHERE hn=?').get(old.hn);
    if(p) found.push({...p,currentName:true});
  }
  const drugs=db.prepare("SELECT id FROM drugs WHERE name LIKE ? ESCAPE '\\' OR generic_name LIKE ? ESCAPE '\\' LIMIT 101").all(like,like);
  const oldDrugs=db.prepare(`SELECT DISTINCT CAST(entity_id AS INTEGER) id FROM audit_changes WHERE category='drug' AND (json_extract(changes_json,'$.name.before') LIKE ? ESCAPE '\\' OR json_extract(changes_json,'$.name.after') LIKE ? ESCAPE '\\') LIMIT 101`).all(like,like);
  for(const old of oldDrugs) if(!drugs.some(d=>d.id===old.id)&&drugs.length<101)drugs.push(old);
  const actors=db.prepare("SELECT id FROM users WHERE display_name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' LIMIT 101").all(like,like);
  return {patients:found.slice(0,100),drugs:drugs.slice(0,100).map(x=>x.id),actors:actors.slice(0,100).map(x=>x.id),limited:found.length>100||drugs.length>100||actors.length>100||historicalHns.length>100||oldDrugs.length>100||merged.length>100};
}
function predicate(source, opts, resolved, category, important) {
  const clauses=['e.category=?','e.time>=?','e.time<=?'], args=[category,opts.from+' 00:00:00',opts.to+' 23:59:59'];
  if (important) clauses.push('e.important=1');
  if (opts.actorId) { clauses.push('e.actor_id=?'); args.push(opts.actorId); }
  if (opts.quick==='adjust') clauses.push(source.key==='stock'?"e.action='adjust'":'0');
  if (opts.quick==='void') clauses.push(source.key==='receipt_void'?'1':'0');
  if (opts.quick==='patient') clauses.push(source.key==='change'?"json_extract(e.data,'$.category')='patient'":'0');
  if (opts.quick==='price') clauses.push(source.key==='change'?"(json_type(e.data,'$.changes.price') IS NOT NULL OR json_type(e.data,'$.changes.cost') IS NOT NULL)":'0');
  if (opts.q) {
    const alternatives=["e.reference LIKE ? ESCAPE '\\'","e.actor_name LIKE ? ESCAPE '\\'"], like='%'+escLike(opts.q)+'%'; args.push(like,like);
    for (const [column,values] of [['hn',resolved.patients.map(x=>x.hn)],['drug_id',resolved.drugs],['actor_id',resolved.actors]]) if (values.length) {
      alternatives.push(`e.${column} IN (${values.map(()=>'?').join(',')})`); args.push(...values);
    }
    clauses.push('('+alternatives.join(' OR ')+')');
  }
  return {where:clauses.join(' AND '),args};
}
function station(value) { return ({host:'เครื่องหลัก',lan:'เครื่องห้องตรวจ',system:'ระบบอัตโนมัติ'})[value] || 'ไม่ระบุเครื่อง'; }
const ACTION_LABELS={create:'เพิ่ม',update:'แก้ไข',merge:'รวมเลขคนไข้',suspend:'ปิดใช้งาน',reactivate:'เปิดใช้งาน',secret_changed:'เปลี่ยนรหัส',permission:'เปลี่ยนสิทธิ์',import:'นำเข้ายาจากไฟล์'};
const SUBJECT_LABELS={patient:'ข้อมูลคนไข้',vitals:'สัญญาณชีพ',drug:'รายการยา',service:'ค่าบริการ',lot:'ล็อตยา',user:'บัญชีผู้ใช้',settings:'การตั้งค่า',stock:'รายการยา'};
const EXPORT_LABELS={patients:'ทะเบียนคนไข้',visits:'รายการมารับบริการ',note_versions:'บันทึกการตรวจ',order_versions:'ใบสั่งยา',order_acks:'การรับทราบใบสั่งยา',receipts:'ใบเสร็จ',receipt_lines:'รายการในใบเสร็จ',drugs:'รายการยา',services:'ค่าบริการ',stock_movements:'การรับและจ่ายยา',med_certs:'ใบรับรองแพทย์',allergy_log:'ประวัติแพ้ยา',attachments:'รายการไฟล์แนบ',fav_sets:'ชุดยา',users:'บัญชีผู้ใช้',backup_log:'ประวัติสำรองข้อมูล',appointments:'นัดหมาย',text_presets:'ข้อความสำเร็จรูป'};
function displayValue(field,value,summary=false) {
  if (value==null||value==='') return 'ไม่ได้ระบุ';
  if (['password_changed','pin_changed'].includes(field)) return value ? 'เปลี่ยนแล้ว' : 'ยังไม่ได้เปลี่ยน';
  if (['citizen_id','phone','emergency_phone','clinic_phone','receipt_tax_id'].includes(field) && summary) return '••••'+String(value).slice(-4);
  if (['backup_dest_1','backup_dest_2','backup_cloud_dest','clinic_logo_file'].includes(field)) return 'กำหนดไว้แล้ว';
  if (field==='role') return ({admin:'ผู้ดูแล',doctor:'แพทย์',front:'หน้าร้าน'})[value] || 'ไม่ทราบบทบาท';
  if (field==='sex') return ({M:'ชาย',F:'หญิง',O:'อื่น ๆ'})[value] || 'ไม่ได้ระบุ';
  if (field==='dose_mode') return ({standard:'เวลามาตรฐาน',exact_times:'ระบุเวลา',prn:'เมื่อมีอาการ',manual:'คำสั่งพิเศษ',interval:'ทุกช่วงชั่วโมง'})[value] || 'รูปแบบวิธีใช้';
  if (field==='active') return Number(value)===1?'ใช้งาน':'ปิดใช้งาน';
  if (field==='drug_id') {const drug=db.prepare('SELECT name FROM drugs WHERE id=?').get(value);return drug?text(drug.name)+' (ชื่อปัจจุบัน)':'ไม่พบชื่อยาปัจจุบัน';}
  if (typeof value==='boolean') return value?'เปิด':'ปิด';
  if (typeof value==='object') return 'รายละเอียดมีการเปลี่ยนแปลง';
  return text(value,1000);
}
function changesOf(data,summary=false) {
  const allowed=FIELDS[data.category] || [], changes=data.changes;
  if (!changes || typeof changes!=='object' || Array.isArray(changes)) return [];
  return allowed.filter(field=>Object.hasOwn(changes,field) && changes[field] && typeof changes[field]==='object').map(field=>({label:FIELD_LABELS[field],before:displayValue(field,changes[field].before,summary),after:displayValue(field,changes[field].after,summary)}));
}
function actorOf(row,data) {
  if (row._source==='backup' && data.source==='scheduled') return {actor:'ระบบอัตโนมัติ',actorCurrent:false};
  if (row._source==='change' || row._source.startsWith('setting_') || row._source==='backup') {
    if (row.actor_name) return {actor:text(row.actor_name),actorCurrent:false};
  }
  if (row.actor_id) {
    const user=db.prepare('SELECT display_name FROM users WHERE id=?').get(row.actor_id);
    if (user) return {actor:text(user.display_name),actorCurrent:true};
  }
  if (row._source==='auth' && row.actor_name) return {actor:'ชื่อบัญชีที่ระบุ: '+text(row.actor_name),actorCurrent:false};
  return {actor:'ไม่ระบุบัญชี',actorCurrent:false};
}
function present(row, detailed=false) {
  const data=parse(row.data), who=actorOf(row,data), type=row._source;
  let ref=text(row.reference);
  if(type.startsWith('setting_')) ref=({setting_backup:'การตั้งค่าสำรองข้อมูล',setting_document:'การตั้งค่าเอกสาร',setting_stock:'การตั้งค่าคลังยา'})[type];
  if(type==='access'&&row.action==='export') ref=ref.startsWith('table:')?(EXPORT_LABELS[ref.slice(6)]||'รายการข้อมูล'):'รายการข้อมูล';
  let summary='',reason='',changes=[],link;
  if (type==='change'||type.startsWith('setting_')) {
    changes=changesOf(data,!detailed); reason=text(data.reason,1000);
    let item=ref;
    if (row.drug_id) { const drug=db.prepare('SELECT name FROM drugs WHERE id=?').get(row.drug_id); item=drug?text(drug.name)+' (ชื่อปัจจุบัน)':ref; }
    if (data.category==='service') { const service=db.prepare('SELECT name FROM services WHERE id=?').get(data.entity); item=service?text(service.name)+' (ชื่อปัจจุบัน)':ref; }
    if (data.category==='user') { const user=db.prepare('SELECT display_name FROM users WHERE id=?').get(data.entity); item=user?text(user.display_name)+' (ชื่อบัญชีปัจจุบัน)':ref; }
    if (data.category==='settings') item='';
    summary=(ACTION_LABELS[row.action]||'เปลี่ยนแปลง')+' '+(SUBJECT_LABELS[data.category]||'ข้อมูล')+(item?' '+item:'');
    if (changes.length===1) summary+=' · '+changes[0].label+' '+changes[0].before+' → '+changes[0].after;
    else if (changes.length) summary+=' · '+changes.map(x=>x.label).slice(0,3).join(', ')+(changes.length>3?` และอีก ${changes.length-3} ช่อง`:'');
    if (data.category==='stock' && row.action==='import') summary='นำเข้ายาจากไฟล์ · '+changes.map(x=>x.label+' '+x.after).join(' · ');
  } else if (type==='patient') summary='ลงทะเบียนคนไข้ '+ref;
  else if (type==='allergy') { summary=(row.action==='add'?'เพิ่มข้อมูลแพ้ยา ':'นำข้อมูลแพ้ยาออก ')+ref; changes=[{label:'รายการแพ้ยา',before:row.action==='add'?'—':text(data.substance),after:row.action==='add'?text(data.substance):'นำออก'}]; reason=text(data.reason,1000); }
  else if (type==='note'||type==='order') { summary=`${type==='note'?'บันทึกการตรวจ':'บันทึกใบสั่งยา'} ${ref} ฉบับที่ ${Number(data.version)||1}`; changes=[{label:'ฉบับที่',before:'—',after:String(Number(data.version)||1)}]; reason=text(data.reason,1000); }
  else if (type==='stock') {
    const drug=db.prepare('SELECT name FROM drugs WHERE id=?').get(row.drug_id), name=drug?text(drug.name):'รายการยาที่ไม่พบชื่อปัจจุบัน';
    summary=({receive:'รับยาเข้า',dispense:'จ่ายยา',adjust:'ปรับยอดยา',void_return:'คืนยาเข้าคลัง'})[row.action]+' '+name+(drug?' (ชื่อปัจจุบัน)':'')+' '+(Number(data.qty)>0?'+':'')+Number(data.qty)+' หน่วย';
    changes=[{label:'จำนวนที่เพิ่มหรือลด',before:'—',after:String(Number(data.qty))},{label:'ชื่อยาในปัจจุบัน',before:'—',after:name},{label:'หน่วยขณะทำรายการ',before:'—',after:'ไม่ได้บันทึกไว้ในประวัติเดิม'}]; reason=text(data.reason,1000);
  } else if(type==='lot_create'||type==='lot_close') {
    const drug=db.prepare('SELECT name FROM drugs WHERE id=?').get(row.drug_id);
    summary=(type==='lot_create'?'เพิ่มล็อตยา ':'ปิดล็อตยา ')+(drug?text(drug.name)+' (ชื่อปัจจุบัน)':'ไม่พบชื่อยาปัจจุบัน');
    changes=[{label:'เลขรายการล็อต',before:'—',after:ref},{label:'หลักฐานเดิม',before:'—',after:'มีผู้ทำและเวลาที่บันทึกไว้ รายละเอียดล็อตปัจจุบันอาจแก้ไขไปแล้ว'}];reason=text(data.reason,1000);
  } else if (type.startsWith('receipt_')) {
    summary=(row.action==='void'?'ยกเลิกใบเสร็จ ':'ออกใบเสร็จ ')+ref+' · '+Number(data.total).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2})+' บาท';
    changes=[{label:'ยอดเงิน',before:'—',after:String(data.total)+' บาท'},{label:'วิธีรับชำระ',before:'—',after:({cash:'เงินสด',transfer:'เงินโอน'})[data.pay_method]||'ไม่ทราบวิธีรับชำระ'}]; reason=text(data.reason,1000); link='/print/receipt/'+encodeURIComponent(ref)+'?copy=1';
  } else if (type==='certificate'||type==='certificate_event') { summary=({issue:'ออกใบรับรองแพทย์ ',void:'ยกเลิกใบรับรองแพทย์ ',replace:'ออกใบรับรองแพทย์แทนฉบับเดิม '})[row.action]+ref; reason=text(data.reason,1000); if(data.replacement) changes.push({label:'ฉบับแทน',before:ref,after:text(data.replacement)}); link='/print/medcert/'+encodeURIComponent(ref); }
  else if (type==='print') { summary='สั่งพิมพ์'+({receipt:'ใบเสร็จ',medcert:'ใบรับรองแพทย์',appointment:'ใบนัด'})[data.type]+' '+ref; }
  else if (type==='appointment') {
    summary=({created:'สร้างนัด ',attendance:'บันทึกการมาตามนัด ',contact:'บันทึกผลติดต่อนัด ',reschedule:'เลื่อนนัด ',cancel:'ยกเลิกนัด '})[row.action]+ref;
    if(data.previous_date||data.appointment_date) changes.push({label:'วันนัด',before:text(data.previous_date)||'ไม่ได้ระบุ',after:text(data.appointment_date)||'ไม่ได้ระบุ'});
    const outcomes={attended:'มาตามนัด',no_show:'ไม่มาตามนัด',unconfirmed:'ยังไม่ยืนยัน',answered:'ติดต่อแล้ว',not_answered:'ไม่รับสาย',unreachable:'ติดต่อไม่ได้',declined:'ไม่สะดวกมาตามนัด',reminded:'แจ้งเตือนแล้ว',rebooked:'ตกลงนัดใหม่'};
    if(data.outcome) changes.push({label:'ผลการติดตาม',before:'—',after:outcomes[data.outcome]||'บันทึกผลแล้ว'});
    reason=text(data.note,1000);
  }
  else if (type==='auth') summary=({login_ok:'เข้าสู่ระบบสำเร็จ',login_fail:'เข้าสู่ระบบไม่สำเร็จ',unlock_ok:'ปลดล็อกสำเร็จ',unlock_fail:'ปลดล็อกไม่สำเร็จ',logout:'ออกจากระบบ',locked_out:'ระงับการเข้าสู่ระบบชั่วคราว',clock_override:'ยืนยันใช้เวลาของเครื่อง'})[row.action] || 'การเข้าสู่ระบบ';
  else if (type==='access') summary=({view_patient:'เปิดข้อมูลคนไข้ ',view_history:'เปิดประวัติคนไข้ ',view_documents:'เปิดรายการเอกสาร ',export:'ส่งออกข้อมูล '})[row.action]+ref;
  else if (type==='backup') {
    const source=data.source==='scheduled'?'ตามเวลา':data.source==='manual'?'ด้วยปุ่มสำรอง':'', targets=Array.isArray(data)?data:Array.isArray(data.targets)?data.targets:[];
    summary='สำรองข้อมูล'+source+(row.action==='success'?'สำเร็จ':'ไม่สำเร็จครบทุกแห่ง');
    const names={local:'สำเนาในเครื่อง',external:'สำเนาภายนอก',cloud_sync:'โฟลเดอร์สำรองคลาวด์'};
    changes=targets.filter(t=>t&&Object.hasOwn(names,t.kind)).map(t=>({label:names[t.kind],before:'—',after:t.ok?(t.kind==='cloud_sync'?'คัดลอกเข้าโฟลเดอร์แล้ว ยังไม่ยืนยันการอัปโหลด':'ตรวจสำเนาสำเร็จ'):'ไม่สำเร็จ'}));
    if (!changes.length) changes=[{label:'รายละเอียดปลายทาง',before:'—',after:'ไม่มีข้อมูลรูปแบบที่อ่านได้'}];
  }
  const outcome=type==='backup'&&row.action==='failure'||type==='auth'&&['login_fail','unlock_fail','locked_out'].includes(row.action)?'ไม่สำเร็จ':'บันทึกแล้ว';
  if (detailed) return {title:summary,time:row.time,...who,station:station(row.station),changes,reason,...(link?{link:{href:link,label:'เปิดเอกสาร'}}:{})};
  return {key:type+':'+row.id,time:row.time,...who,summary,reference:ref,important:!!row.important,outcome,station:station(row.station)};
}
function search(input={}) {
  const opts=options(input),resolved=resolve(opts.q), groups=[];
  const categories=opts.category==='all'?Object.keys(CATEGORIES):[opts.category];
  for (const category of categories) {
    let total=0, matching=0,rows=[];
    const limit=opts.category==='all'?3:opts.limit, important=opts.important;
    for (const source of SOURCES) {
      const sourceCategory=({patient:'patient',allergy:'patient',note:'patient',order:'patient',stock:'stock',lot_create:'stock',lot_close:'stock',receipt_issue:'money',receipt_void:'money',certificate:'document',certificate_event:'document',print:'document',appointment:'document',auth:'account',access:'account',backup:'backup',setting_document:'document',setting_stock:'stock',setting_backup:'backup'})[source.key];
      if (sourceCategory && sourceCategory!==category) continue;
      const all=predicate(source,opts,resolved,category,false), selected=predicate(source,opts,resolved,category,important);
      const counted=db.prepare(`SELECT COUNT(*) n,coalesce(SUM(e.important),0) important FROM (${source.sql}) e WHERE ${all.where}`).get(...all.args);
      total+=Number(counted.n);
      matching+=Number(important?counted.important:counted.n);
      rows.push(...db.prepare(`SELECT * FROM (${source.sql}) e WHERE ${selected.where} ORDER BY e.time DESC,e.id DESC LIMIT ?`).all(...selected.args,limit).map(row=>({...row,_source:source.key})));
    }
    rows.sort((a,b)=>String(b.time).localeCompare(String(a.time)) || b._source.localeCompare(a._source) || (typeof a.id==='number'&&typeof b.id==='number'?b.id-a.id:String(b.id).localeCompare(String(a.id))));
    groups.push({key:category,label:CATEGORIES[category],rows:rows.slice(0,limit).map(row=>present(row)),total,hidden:total-matching,matching,more:Math.max(0,matching-limit)});
  }
  const security=require('./security');
  return {since:getSetting('audit_changes_since',''),category:opts.category,limit:opts.limit,groups,total:groups.reduce((n,g)=>n+g.total,0),hidden:groups.reduce((n,g)=>n+g.hidden,0),
    candidates:resolved.patients.length>1?resolved.patients.map(p=>({hn:p.hn,label:[p.prefix,p.first_name,p.last_name].filter(Boolean).join(' ')+(p.currentName?' (ชื่อปัจจุบัน)':'')+' · '+p.hn+(p.duplicate_of_hn?' · รวมไปเลขคนไข้ '+p.duplicate_of_hn:'')})):[],
    ...(resolved.limited?{searchNotice:'พบชื่อมากกว่า 100 รายการ กรุณาเพิ่มคำค้นหรือเลือกเลขคนไข้ให้เจาะจง'}:{}),
    logHealth:typeof security.logHealth==='function'?security.logHealth():null, restore:readStatus({dataDir:DATA_DIR})};
}
function detail(key) {
  if (typeof key!=='string' || key.length>160 || !key.includes(':')) bad('ไม่พบรายการที่เลือก');
  const split=key.indexOf(':'),source=SOURCES.find(s=>s.key===key.slice(0,split)),id=key.slice(split+1);
  if (!source || !id) bad('ไม่พบรายการที่เลือก');
  const row=db.prepare(`SELECT * FROM (${source.sql}) e WHERE e.id=?`).get(id);
  if (!row) throw Object.assign(new Error('ไม่พบรายการที่เลือก'),{status:404});
  return present({...row,_source:source.key},true);
}
module.exports={search,detail,CATEGORIES};
