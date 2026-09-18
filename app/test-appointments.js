'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-appointments-unit-'));
process.env.CLINIC_DATA_DIR = temp;
const { db, now, today } = require('./lib/db');
const appts = require('./lib/appointments');
const auth = require('./lib/auth');
const visits = require('./lib/visits');
const user = Number(auth.createUser({ username:'front-unit', displayName:'ทดสอบ', role:'front', password:'Test-pass-123', pin:'1234' }).lastInsertRowid);
let passed = 0, serial = 0;
function test(name, work) { work(); passed++; console.log('PASS appointment: ' + name); }
function offset(n) { const d = new Date(today()+'T00:00:00'); d.setDate(d.getDate()+n); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fixture(n = -2) {
  const hn = '99-'+String(++serial).padStart(4,'0');
  db.prepare('INSERT INTO patients (hn,first_name,sex,phone,created_by,created_at) VALUES (?,?,?,?,?,?)').run(hn,'ข้อมูลสังเคราะห์','F',serial%2?'0800000000':null,user,now());
  const v = visits.create(hn,user);
  const id = Number(db.prepare('INSERT INTO appointments (hn,visit_id,appt_date,days,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)').run(hn,v.id,offset(n),n,'ติดตามสังเคราะห์',user,now()).lastInsertRowid);
  return appts.detail(id);
}
try {
  test('legacy past appointment is unconfirmed, never inferred no-show; phone and missing phone retained', () => {
    const a=fixture(), b=fixture();
    assert.equal(a.attendance,'unconfirmed'); assert.equal(a.last_event_id,0);
    assert.equal(a.phone,'0800000000'); assert.equal(b.phone,null);
    assert.deepEqual(appts.history(a.id).events,[]);
  });
  test('attendance is explicit; contact does not turn it into attended; correction appends', () => {
    const a=fixture(); appts.attendance(a.id,{status:'no_show'},user);
    appts.contact(a.id,{outcome:'answered',note:'โทรจริงในสถานการณ์สังเคราะห์'},user);
    assert.equal(appts.detail(a.id).attendance,'no_show');
    appts.attendance(a.id,{status:'attended'},user);
    assert.equal(appts.detail(a.id).attendance,'attended');
    assert.deepEqual(appts.history(a.id).events.map(e=>e.outcome),['attended','answered','no_show']);
  });
  test('today cannot be called a no-show; future attendance and invalid outcomes rejected', () => {
    assert.throws(()=>appts.attendance(fixture(0).id,{status:'no_show'},user),/วันนี้/);
    assert.throws(()=>appts.attendance(fixture(2).id,{status:'attended'},user),/ยังไม่ถึง/);
    assert.throws(()=>appts.contact(fixture().id,{outcome:'invented'},user),/ผลการติดต่อ/);
  });
  test('second station stale event/date cannot overwrite changes', () => {
    const a=fixture(); const body={expected_event_id:a.last_event_id,expected_date:a.appt_date};
    appts.contact(a.id,{...body,outcome:'not_answered'},user);
    for(const work of [()=>appts.attendance(a.id,{...body,status:'attended'},user),()=>appts.reschedule(a.id,{...body,date:offset(5)},user),()=>appts.cancel(a.id,user,body)]) assert.throws(work,/เปลี่ยนไปแล้ว/);
    assert.equal(appts.history(a.id).events.length,1);
  });
  test('rebook is atomic and preserves old call/attendance history while new date starts unconfirmed', () => {
    const a=fixture(); appts.attendance(a.id,{status:'no_show'},user);
    const out=appts.contact(a.id,{outcome:'rebooked',rebook_date:offset(8),note:'ตกลงวันใหม่'},user);
    assert.equal(out.id,a.id); assert.equal(out.appt_date,offset(8)); assert.equal(out.attendance,'unconfirmed'); assert.equal(out.contact_outcome,null);
    const events=appts.history(a.id).events; assert.deepEqual(events.map(e=>e.kind),['reschedule','contact','attendance']);
    assert.equal(events[0].previous_date,a.appt_date); assert.equal(events[1].note,'ตกลงวันใหม่');
  });
  test('conflicting future appointment rolls back contact and date together', () => {
    const a=fixture(); appts.create(a.visit_id,{days:7},user);
    assert.throws(()=>appts.contact(a.id,{outcome:'rebooked',rebook_date:offset(10)},user),/อีกใบ/);
    assert.equal(appts.history(a.id).events.length,0); assert.equal(appts.detail(a.id).appt_date,a.appt_date);
  });
  test('history append-only enforced by SQLite; cancelled appointment cannot accept new writes', () => {
    const a=fixture(); appts.cancel(a.id,user,{reason:'ข้อมูลสังเคราะห์'});
    assert.throws(()=>db.prepare('UPDATE appointment_events SET note=? WHERE appointment_id=?').run('x',a.id),/append-only/);
    assert.throws(()=>db.prepare('DELETE FROM appointment_events WHERE appointment_id=?').run(a.id),/append-only/);
    assert.throws(()=>appts.contact(a.id,{outcome:'answered'},user),/ยกเลิกไปแล้ว/);
    assert(!appts.followup().some(x=>x.id===a.id));
  });
  test('real dates only: leap year, year rollover and input bounds', () => {
    assert(appts.validDate('2028-02-29')); assert(!appts.validDate('2027-02-29')); assert(!appts.validDate('2028-04-31'));
    assert.equal(appts.diffDays('2026-12-31','2027-01-01'),1);
    const a=fixture(); for(const body of [{date:'2099-02-30'},{date:today()},{days:1.5},{days:401}]) assert.throws(()=>appts.reschedule(a.id,body,user));
    assert.throws(()=>appts.contact(a.id,{outcome:'answered',note:'x'.repeat(2001)},user),/2000/);
    const future=fixture(7);assert.throws(()=>appts.reschedule(future.id,{date:future.appt_date},user),/ตรงกับวันเดิม/);
    assert.throws(()=>appts.forMonth('2026-13')); assert.throws(()=>appts.followup('all'));
  });
  test('schema 13 data survives migration with no guessed status or synthetic history', () => {
    const legacy=path.join(temp,'legacy'); fs.mkdirSync(legacy);
    const file=path.join(legacy,'clinic.db'); db.prepare('VACUUM INTO ?').run(file);
    const {DatabaseSync}=require('node:sqlite'); const copy=new DatabaseSync(file);
    copy.exec("DROP TABLE audit_changes; DELETE FROM settings WHERE key='audit_changes_since'; ALTER TABLE drugs DROP COLUMN default_dose_json; ALTER TABLE services DROP COLUMN cost; DROP TABLE appointment_events; ALTER TABLE appointments DROP COLUMN doctor_id; ALTER TABLE visits DROP COLUMN preferred_doctor_id; PRAGMA user_version=13");
    const count=copy.prepare('SELECT COUNT(*) n FROM appointments').get().n; copy.close();
    const run=spawnSync(process.execPath,['--no-warnings','-e',`const {db}=require('./lib/db'); console.log(JSON.stringify({count:db.prepare('SELECT COUNT(*) n FROM appointments').get().n,events:db.prepare('SELECT COUNT(*) n FROM appointment_events').get().n,version:db.prepare('PRAGMA user_version').get().user_version}));db.close()`],{cwd:__dirname,env:{...process.env,CLINIC_DATA_DIR:legacy},encoding:'utf8',windowsHide:true});
    assert.equal(run.status,0,run.stderr); const out=JSON.parse(run.stdout.trim());
    assert.deepEqual(out,{count,events:0,version:require('./lib/schema-version').SCHEMA_VERSION});
  });
  test('demo follow-up seed rejects a non-demo database and adds scenarios once', () => {
    const {seedAppointmentFollowup}=require('./seed-appointment-followup');
    assert.throws(()=>seedAppointmentFollowup(),/เฉพาะชุดทดลอง/);
    for(let i=0;i<24;i++)fixture();
    require('./lib/db').setSetting('demo_mode','1');
    const count=()=>db.prepare('SELECT COUNT(*) n FROM appointments').get().n;
    const before=count();seedAppointmentFollowup();assert.equal(count(),before+16);
    const events=db.prepare('SELECT COUNT(*) n FROM appointment_events').get().n;
    seedAppointmentFollowup();assert.equal(count(),before+16);assert.equal(db.prepare('SELECT COUNT(*) n FROM appointment_events').get().n,events);
  });
  console.log(`APPOINTMENTS UNIT PASS: ${passed}`);
} finally { db.close(); fs.rmSync(temp,{recursive:true,force:true}); }
