'use strict';
// All data, users, and injected failures in this suite live in a synthetic temp database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'clinic-audit-changes-'));
process.env.CLINIC_DATA_DIR = dir;
const {db,txn,getSetting,setSetting} = require('./lib/db');
const audit = require('./lib/audit');
const patients = require('./lib/patients');
const visits = require('./lib/visits');
const stock = require('./lib/stock');
const auth = require('./lib/auth');
const backup = require('./lib/backup');
const security = require('./lib/security');
const crypto = require('node:crypto');
let passed = 0;
function test(name,fn) { fn(); passed++; console.log('PASS '+name); }
const admin = Number(auth.createUser({username:'synthetic-admin',displayName:'ผู้ทดสอบ ก',role:'admin',password:'Synthetic-start-18'}).lastInsertRowid);
const ctx = {session:{userId:admin,displayName:'ผู้ทดสอบ ก',role:'admin'},remoteAddress:'192.168.44.8'};
const asAdmin = fn => audit.run(ctx,fn);
const count = () => db.prepare('SELECT count(*) n FROM audit_changes').get().n;
const last = () => db.prepare('SELECT * FROM audit_changes ORDER BY id DESC LIMIT 1').get();
const history = () => db.prepare('SELECT * FROM audit_changes ORDER BY id').all();
const hn = patients.register({first_name:'สังเคราะห์',sex:'F'},admin);
const hn2 = patients.register({first_name:'สังเคราะห์รอง',sex:'M'},admin);
const visit = visits.create(hn,admin);
const drug = stock.upsertDrug({name:'ยาสังเคราะห์',price:10,cost:3,unit:'เม็ด'});
const service = stock.upsertService({name:'บริการสังเคราะห์',price:100,cost:10});
let lot;
function failAudit(fn) {
  db.exec("CREATE TRIGGER audit_test_failure BEFORE INSERT ON audit_changes BEGIN SELECT RAISE(ABORT,'synthetic private payload'); END;");
  try { assert.throws(fn,e => e.code === 'AUDIT_WRITE_FAILED' && !e.message.includes('synthetic private payload')); }
  finally { db.exec('DROP TRIGGER audit_test_failure'); }
}
try {
  test('schema18 additive objects, recording start and no seed master rows',() => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,18);
    assert.ok(getSetting('audit_changes_since','')); assert.equal(count(),0);
    for(const fields of Object.values(audit.FIELDS))for(const key of fields)assert.match(audit.FIELD_LABELS[key],/[ก-๙]/);
  });
  test('patient normalized change, no-op, snapshot actor and station',() => {
    asAdmin(() => patients.update(hn,{first_name:'สังเคราะห์ใหม่',phone:'0812345678'},admin));
    const row=last(), changes=JSON.parse(row.changes_json);
    assert.deepEqual(changes.first_name,{before:'สังเคราะห์',after:'สังเคราะห์ใหม่'});
    assert.equal(row.actor_name,'ผู้ทดสอบ ก'); assert.equal(row.station,'lan');
    const n=count(); asAdmin(() => patients.update(hn,{first_name:'สังเคราะห์ใหม่',phone:'0812345678',address:''},admin)); assert.equal(count(),n);
  });
  test('patient mutation rolls back when only the history INSERT fails',() => {
    const before=patients.get(hn).first_name,n=count();
    failAudit(() => asAdmin(() => patients.update(hn,{first_name:'ไม่ควรบันทึก'},admin)));
    assert.equal(patients.get(hn).first_name,before); assert.equal(count(),n);
  });
  test('merge records primary HN, immediate repeat is no-op',() => {
    asAdmin(() => patients.markDuplicate(hn2,hn,admin)); const n=count(); assert.equal(last().action,'merge');
    asAdmin(() => patients.markDuplicate(hn2,hn,admin)); assert.equal(count(),n);
  });
  test('vitals values and rollback stay together',() => {
    asAdmin(() => visits.updateVitals(visit.id,{weight_kg:62,bp_sys:120,bp_dia:80},admin));
    assert.equal(last().category,'vitals'); assert.equal(JSON.parse(last().changes_json).weight_kg.after,62);
    const n=count(); asAdmin(() => visits.updateVitals(visit.id,{weight_kg:62,bp_sys:120,bp_dia:80},admin)); assert.equal(count(),n);
    failAudit(() => asAdmin(() => visits.updateVitals(visit.id,{weight_kg:64},admin))); assert.equal(visits.get(visit.id).weight_kg,62);
  });
  test('stale retry after an intervening change remains visibly attributable',() => {
    asAdmin(() => patients.update(hn,{address:'ที่อยู่ ก'},admin));
    asAdmin(() => patients.update(hn,{address:'ที่อยู่ ข'},admin));
    const n=count(); asAdmin(() => patients.update(hn,{address:'ที่อยู่ ก'},admin));
    assert.equal(count(),n+1); assert.deepEqual(JSON.parse(last().changes_json).address,{before:'ที่อยู่ ข',after:'ที่อยู่ ก'});
  });
  test('drug/service changes compare stored money and remain atomic',() => {
    asAdmin(() => stock.setCost(drug,3.255)); assert.deepEqual(JSON.parse(last().changes_json).cost,{before:3,after:3.26});
    const n=count(); asAdmin(() => stock.setCost(drug,3.26)); assert.equal(count(),n);
    failAudit(() => asAdmin(() => stock.setCost(drug,9))); assert.equal(stock.listDrugs().find(x=>x.id===drug).cost,3.26);
    failAudit(() => asAdmin(() => stock.upsertService({price:200},service))); assert.equal(stock.listServices()[0].price,100);
    asAdmin(() => stock.upsertService({price:120},service)); assert.equal(last().category,'service');
    failAudit(() => asAdmin(() => stock.upsertDrug({name:'เพิ่มไม่ได้',price:1}))); assert.equal(stock.listDrugs().length,1);
  });
  test('lot create/edit/close has full before-after and transaction rollback',() => {
    lot=asAdmin(() => stock.addLot(drug,{expiry_date:'2030-01-01',lot_label:'ล็อต ก',qty:20,userId:admin}));
    assert.equal(last().category,'lot'); assert.equal(last().ref,String(drug));
    asAdmin(() => stock.updateLot(lot,{expiry_date:'2030-02-01',lot_label:'ล็อต ข'}));
    assert.equal(JSON.parse(last().changes_json).expiry_date.before,'2030-01-01');
    const n=count(); asAdmin(() => stock.updateLot(lot,{expiry_date:'2030-02-01',lot_label:'ล็อต ข'})); assert.equal(count(),n);
    failAudit(() => asAdmin(() => stock.clearLot(lot,{reason:'ทดสอบ',userId:admin}))); assert.equal(stock.listLots(drug)[0].cleared_at,null);
  });
  test('drug warning update compares normalized number and records all entry points',() => {
    asAdmin(() => stock.setExpiryWarnDays(drug,'90')); const n=count(); assert.equal(JSON.parse(last().changes_json).expiry_warn_days.after,90);
    asAdmin(() => stock.setExpiryWarnDays(drug,90)); assert.equal(count(),n);
    failAudit(() => asAdmin(() => stock.setExpiryWarnDays(drug,30))); assert.equal(stock.listDrugs()[0].expiry_warn_days,90);
  });
  test('dose defaults become human text rather than stored request JSON',() => {
    asAdmin(() => stock.upsertDrug({name:'ยาสังเคราะห์',price:10,cost:3.26,unit:'เม็ด',default_dose:{mode:'standard',m:1,days:7}},drug));
    const changes=JSON.parse(last().changes_json); assert.match(changes.default_dose_json.after,/เช้า 1 เม็ด/); assert.match(changes.default_dose_json.after,/7 วัน/); assert.doesNotMatch(changes.default_dose_json.after,/\{/);
    const saved=stock.listDrugs().find(d=>d.id===drug),template={...JSON.parse(saved.default_dose_json),qty_source:'manual'};
    asAdmin(()=>stock.upsertDrug({...saved,default_dose:template},drug)); assert.match(JSON.parse(last().changes_json).default_dose_json.after,/ระบุจำนวนจ่ายเอง/);
    const n=count();asAdmin(()=>stock.upsertDrug({...saved,default_dose:template},drug)); assert.equal(count(),n);
  });
  test('account create plus history is atomic and password/PIN never enter changes',() => {
    failAudit(() => asAdmin(() => auth.createUser({username:'must-rollback',displayName:'ล้ม',role:'doctor',password:'Synthetic-create-18'},admin)));
    assert.equal(db.prepare('SELECT id FROM users WHERE username=?').get('must-rollback'),undefined);
    asAdmin(() => auth.updateUser(admin,{password:'Synthetic-new-18',pin:'8642'}));
    const changes=JSON.parse(last().changes_json); assert.deepEqual(changes.password_changed,{before:false,after:true}); assert.deepEqual(changes.pin_changed,{before:false,after:true});
    const n=count(); asAdmin(() => auth.updateUser(admin,{password:'Synthetic-new-18',pin:'8642'})); assert.equal(count(),n);
    const serialized=JSON.stringify(history()); for(const secret of ['Synthetic-new-18','8642','pass_hash','pin_hash'])assert.ok(!serialized.includes(secret));
  });
  test('renaming an account preserves historical actor name',() => {
    asAdmin(() => auth.updateUser(admin,{display_name:'ผู้ทดสอบ เปลี่ยนชื่อ'}));
    assert.equal(last().actor_name,'ผู้ทดสอบ ก'); assert.equal(history()[0].actor_name,'ผู้ทดสอบ ก');
  });
  test('permission and suspension audits roll back with account revision',() => {
    const id=Number(auth.createUser({username:'synthetic-doc',displayName:'แพทย์ทดสอบ',role:'doctor',password:'Synthetic-doc-18'}).lastInsertRowid);
    failAudit(() => asAdmin(() => auth.updateUser(id,{front_desk:true}))); assert.equal(getSetting('doctor_front_'+id,'0'),'0');
    asAdmin(() => auth.updateUser(id,{front_desk:true})); assert.equal(last().action,'permission');
    asAdmin(() => auth.updateUser(id,{active:false})); assert.equal(last().action,'suspend');
  });
  test('CSV suppresses per-row records; one failed summary rolls back the batch',() => {
    const n=count(), before=stock.listDrugs().length;
    const run=() => asAdmin(() => txn(() => {
      audit.withoutRecording(() => stock.upsertDrug({name:'นำเข้าสังเคราะห์',price:4,cost:1}));
      audit.record({category:'stock',action:'import',entityId:'csv',ref:'csv',after:{added_count:1,failed_count:0}});
    }));
    failAudit(run); assert.equal(stock.listDrugs().length,before); assert.equal(count(),n);
    run(); assert.equal(count(),n+1); assert.equal(last().action,'import');
  });
  test('settings allowlist rejects secret dumps and routine printing is not important',() => {
    asAdmin(() => txn(() => {setSetting('receipt_paper','A5'); audit.record({category:'settings',entityId:'clinic',before:{receipt_paper:'A4'},after:{receipt_paper:'A5',cookie_secret:'never-store',backup_cloud_key:'never-store'}});}));
    assert.equal(last().important,0); assert.deepEqual(Object.keys(JSON.parse(last().changes_json)),['receipt_paper']);
    asAdmin(() => txn(() => audit.record({category:'settings',entityId:'clinic',before:{},after:{clinic_name:'คลินิกสังเคราะห์'}}))); assert.equal(last().important,1);
  });
  test('backup destination settings and history commit together, including rollback',() => {
    const recovery=require('./lib/recovery-service'), discovery=require('./lib/recovery-discovery');
    const discover=discovery.discover, folders=discovery.oneDriveFolders;
    const cloud=path.join(dir,'synthetic-cloud'), target=path.join(cloud,'Clinic Backup');
    discovery.discover=()=>({volumes:[]}); discovery.oneDriveFolders=()=>[cloud];
    const cloudId=crypto.createHash('sha256').update(path.resolve(target).toLowerCase()).digest('hex').slice(0,16);
    try {
      failAudit(() => asAdmin(() => recovery.configureDestinations({cloudId})));
      assert.equal(getSetting('backup_cloud_dest',''),'');
      asAdmin(() => recovery.configureDestinations({cloudId})); assert.equal(getSetting('backup_cloud_dest',''),target); assert.equal(last().category,'settings');
      const n=count(); asAdmin(() => recovery.configureDestinations({cloudId})); assert.equal(count(),n);
    }finally{discovery.discover=discover; discovery.oneDriveFolders=folders; setSetting('backup_cloud_dest','');}
  });
  test('invalid patient/stock/account inputs never leave a history row',() => {
    const n=count();
    assert.throws(()=>asAdmin(()=>patients.update(hn,{first_name:''},admin)));
    assert.throws(()=>asAdmin(()=>patients.markDuplicate(hn,hn,admin)));
    assert.throws(()=>asAdmin(()=>stock.upsertService({price:-1},service)));
    assert.throws(()=>asAdmin(()=>stock.updateLot(lot,{expiry_date:'bad'})));
    assert.throws(()=>asAdmin(()=>stock.setExpiryWarnDays(drug,-10)));
    assert.throws(()=>asAdmin(()=>auth.createUser({username:'bad',role:'admin',password:'short'},admin)));
    assert.throws(()=>asAdmin(()=>auth.updateUser(admin,{active:'maybe'})));
    assert.equal(count(),n);
  });
  test('audit_changes cannot update or delete even via direct SQL',() => {
    assert.throws(() => db.exec("UPDATE audit_changes SET ref='x' WHERE id=1"),/append-only/);
    assert.throws(() => db.exec('DELETE FROM audit_changes WHERE id=1'),/append-only/);
  });
  test('backup format3 records manual actor vs scheduled system and preserves old parsing',() => {
    const manual=asAdmin(() => backup.runBackup()); const m=JSON.parse(manual.detail); assert.equal(m.format,3); assert.equal(m.source,'manual'); assert.equal(m.actor_id,admin); assert.equal(m.station,'lan'); assert.equal(manual.ok,1);
    const scheduled=asAdmin(() => backup.runBackup({source:'scheduled'})); const s=JSON.parse(scheduled.detail); assert.equal(s.source,'scheduled'); assert.equal(s.actor_id,null); assert.equal(s.actor_name,null); assert.equal(s.station,'system');
    assert.deepEqual(backup.parseDetail({detail:'old plain text'}),[]); assert.deepEqual(backup.parseDetail({detail:JSON.stringify({format:2,targets:[{ok:true}]})}),[{ok:true}]);
  });
  test('failed off-device backup keeps true target outcome and actor evidence',() => {
    const blocked=path.join(dir,'synthetic-blocked-destination'); fs.writeFileSync(blocked,'synthetic'); setSetting('backup_dest_1',blocked);
    try {
      const result=asAdmin(()=>backup.runBackup({source:'manual'})),detail=JSON.parse(result.detail);
      assert.equal(result.ok,0); assert.equal(detail.actor_id,admin); assert.ok(detail.targets.some(t=>t.kind==='external'&&!t.ok)); assert.ok(detail.targets.some(t=>t.kind==='local'&&t.ok));
    }finally{setSetting('backup_dest_1','');}
  });
  test('access/auth failures count since boot without leaking injected SQLite messages',() => {
    const captured=[], old=console.error; console.error=(...a)=>captured.push(a.join(' '));
    try {
      db.exec("CREATE TRIGGER synthetic_auth_failure BEFORE INSERT ON auth_events BEGIN SELECT RAISE(ABORT,'private test data'); END; CREATE TRIGGER synthetic_access_failure BEFORE INSERT ON access_log BEGIN SELECT RAISE(ABORT,'private test data'); END;");
      security.recordAuthEvent('login_fail',{username:'synthetic'}); security.recordAccess('view_patient',{session:ctx.session,remoteAddress:ctx.remoteAddress,ref:hn});
    } finally { db.exec('DROP TRIGGER synthetic_auth_failure; DROP TRIGGER synthetic_access_failure;'); console.error=old; }
    assert.equal(security.logHealth().write_failures_since_boot,2); assert.ok(security.authSummary().boot_started_at); assert.ok(captured.every(x=>!x.includes('private test data')));
  });
  test('schema17 migration preserves every old schema object and row, including immutable documents',() => {
    const billing=require('./lib/billing');
    const doctor=Number(auth.createUser({username:'migration-doctor',displayName:'แพทย์สังเคราะห์',role:'doctor',password:'Synthetic-doctor-18',medicalLicense:'TEST-18'}).lastInsertRowid);
    visits.transition(visit.id,'call',doctor);
    const finished=visits.finishExam(visit.id,{note:{cc:'อาการสังเคราะห์',dx_text:'Synthetic'},lines:[{type:'drug',ref_id:drug,qty:1}],baseVersionId:null},doctor);
    billing.pay(visit.id,{orderVersionId:finished.order.id,payMethod:'cash',userId:admin});
    billing.issueMedCert(visit.id,{template_type:'general',purpose:'attendance',doctor_confirmed:true},doctor);
    assert.ok(db.prepare('SELECT count(*) n FROM receipt_document_snapshots').get().n);
    assert.ok(db.prepare('SELECT count(*) n FROM med_certs').get().n);
    const migrationDir=path.join(dir,'migration');fs.mkdirSync(migrationDir);
    const file=path.join(migrationDir,'clinic.db'); db.exec("VACUUM INTO '"+file.replace(/'/g,"''")+"'");
    const old=new DatabaseSync(file); old.exec("DROP TABLE audit_changes; DELETE FROM settings WHERE key='audit_changes_since'; PRAGMA user_version=17;");
    const schema=old.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const tables=schema.filter(x=>x.type==='table').map(x=>x.name);
    const rows=Object.fromEntries(tables.map(t=>[t,old.prepare('SELECT * FROM "'+t+'" ORDER BY rowid').all()]));
    const expect={user_version:17,...Object.fromEntries(['patients','visits','receipts','med_certs'].map(t=>[t,rows[t].length]))}; old.close();
    const r=spawnSync(process.execPath,['--no-warnings','-e',"require('./lib/db').db.close()"],{cwd:__dirname,env:{...process.env,CLINIC_DATA_DIR:migrationDir},encoding:'utf8'}); assert.equal(r.status,0,r.stderr);
    const check=new DatabaseSync(file,{readOnly:true});
    try {
      for(const object of schema)assert.deepEqual(check.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?').get(object.name),object);
      for(const table of tables){const actual=check.prepare('SELECT * FROM "'+table+'" ORDER BY rowid').all().filter(r=>table!=='settings'||r.key!=='audit_changes_since'); assert.deepEqual(actual,rows[table],table);}
      assert.equal(check.prepare('SELECT count(*) n FROM audit_changes').get().n,0); assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    }finally{check.close();}
    const expectFile=path.join(migrationDir,'expected.json'); fs.writeFileSync(expectFile,JSON.stringify(expect));
    const rehearsal=spawnSync(process.execPath,['--no-warnings','tools/migrate-and-verify.js','--rehearsal','--expect',expectFile],{cwd:__dirname,env:{...process.env,CLINIC_DATA_DIR:migrationDir},encoding:'utf8'});
    assert.equal(rehearsal.status,0,rehearsal.stderr);
    const report=JSON.parse(rehearsal.stdout.trim().split('\n').pop()); assert.equal(report.markers_ok,true); assert.equal(report.user_version,18);
  });
  test('measure history growth with 1000 synthetic edits instead of claiming a yearly size',() => {
    const before=path.join(dir,'size-before.db'),after=path.join(dir,'size-after.db');
    db.exec("VACUUM INTO '"+before.replace(/'/g,"''")+"'");
    asAdmin(()=>txn(()=>{for(let i=0;i<1000;i++)audit.record({category:'patient',entityId:hn,ref:hn,before:{phone:'0800000000'},after:{phone:String(810000000+i)}});}));
    db.exec("VACUUM INTO '"+after.replace(/'/g,"''")+"'");
    const growth=fs.statSync(after).size-fs.statSync(before).size; assert.ok(growth>0);
    console.log('Synthetic 1000 one-field edits: '+growth+' bytes including indexes ('+(growth/1000).toFixed(1)+' bytes/edit in this fixture)');
  });
  console.log('Audit changes: '+passed+' passed');
} finally {
  db.close();
  fs.rmSync(dir,{recursive:true,force:true});
}
