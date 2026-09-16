'use strict';
// Invoked only by test-http.js (npm run test:http). Never accepts a production URL.
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const crypto=require('node:crypto'), assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
module.exports=async function testAppointmentsHttp() {
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-appointment-http-'));
  const token=crypto.randomBytes(24).toString('hex'), port=20000+crypto.randomInt(12000);
  const base='http://127.0.0.1:'+port;
  const env={...process.env,CLINIC_DATA_DIR:data,CLINIC_PORT:String(port),CLINIC_TEST_INSTANCE_TOKEN:token,CLINIC_IDLE_LOCK_MS:'3600000',CLINIC_HTTPS_PORT:'0'};
  let server, passed=0;
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  async function start(){
    server=spawn(process.execPath,['--no-warnings','server.js'],{cwd:__dirname,env,stdio:'ignore',windowsHide:true});
    for(let n=0;n<100;n++){try{if((await fetch(base+'/api/test-instance',{headers:{'X-Clinic-Test-Token':token}})).status===200)return;}catch{} await pause(50);}
    throw Error('isolated appointment server did not start');
  }
  async function stop(){if(server&&server.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}}
  async function req(cookie,method,url,body,crash){
    try{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(crash?{'X-Clinic-Test-Token':token,'X-Clinic-Test-Crash':crash}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text);}catch{}return {status:r.status,data,text,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
    catch(e){if(crash)return {status:0};throw e;}
  }
  async function died(){for(let i=0;i<100;i++){if(server.exitCode!==null)return;await pause(20);}throw Error('crash hook did not stop server');}
  function check(name){passed++;console.log('PASS appointment HTTP: '+name);}
  try{
    const seed=spawnSync(process.execPath,['--no-warnings','seed.js','--demo'],{cwd:__dirname,env,encoding:'utf8',windowsHide:true});assert.equal(seed.status,0,seed.stderr);
    const fixture=spawnSync(process.execPath,['--no-warnings','-e',`const {db,now,today}=require('./lib/db');const pats=require('./lib/patients'),visits=require('./lib/visits');const user=db.prepare("SELECT id FROM users WHERE username='front'").get().id;const date=new Date(today()+'T00:00:00');date.setDate(date.getDate()-2);const past=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');const rows=[];for(let i=0;i<16;i++){const hn=pats.register({first_name:'ติดตามสังเคราะห์'+i,sex:'F',phone:'0800000000'},user);const v=visits.create(hn,user);const id=Number(db.prepare('INSERT INTO appointments (hn,visit_id,appt_date,days,created_by,created_at) VALUES (?,?,?,?,?,?)').run(hn,v.id,past,0,user,now()).lastInsertRowid);rows.push({id,visit_id:v.id,appt_date:past});}console.log(JSON.stringify(rows));db.close()`],{cwd:__dirname,env,encoding:'utf8',windowsHide:true});
    assert.equal(fixture.status,0,fixture.stderr);const rows=JSON.parse(fixture.stdout.trim());
    await start();
    const front=(await req(null,'POST','/api/login',{username:'front',password:'front123'})).cookie;
    const doctor=(await req(null,'POST','/api/login',{username:'doctor',password:'doctor123'})).cookie;
    const admin=(await req(null,'POST','/api/login',{username:'admin',password:'admin1234'})).cookie;
    assert(front&&doctor&&admin);
    assert.equal((await req(null,'GET','/api/appointments/followup')).status,401);
    assert.equal((await req(admin,'POST',`/api/appointments/${rows[0].id}/contact`,{})).status,403);
    assert.equal((await req(front,'POST',`/api/appointments/${rows[0].id}/contact`,{outcome:'answered'})).status,400);
    check('authentication, role and operation/revision are required');
    const future=new Date();future.setDate(future.getDate()+12);const date=`${future.getFullYear()}-${String(future.getMonth()+1).padStart(2,'0')}-${String(future.getDate()).padStart(2,'0')}`;
    let index=0;
    for(const phase of ['before-commit','after-commit'])for(const kind of ['create','cancel','reschedule','attendance','contact','rebook']){
      const a=rows[index++]; const op_id=crypto.randomUUID();
      const body={op_id,expected_event_id:0,expected_date:a.appt_date};
      let method='POST',url=`/api/appointments/${a.id}/${kind}`,events=1,status=200;
      if(kind==='create'){url=`/api/visits/${a.visit_id}/appointment`;body.days=7;status=201;}
      if(kind==='reschedule'){method='PATCH';url=`/api/appointments/${a.id}`;body.date=date;}
      if(kind==='attendance')body.status='no_show';
      if(kind==='contact')body.outcome='not_answered';
      if(kind==='rebook'){url=`/api/appointments/${a.id}/contact`;body.outcome='rebooked';body.rebook_date=date;events=2;}
      const crash=await req(front,method,url,body,phase);assert.equal(crash.status,0,`${kind}: expected dropped response`);
      await died();await start();
      const recovered=await req(front,'GET','/api/appointment-operations/'+op_id);
      assert.equal(recovered.data.known,phase==='after-commit');
      const out=await req(front,method,url,body);assert.equal(out.status,status,JSON.stringify(out));
      const retry=await req(front,method,url,body);assert.equal(retry.status,status);assert.deepEqual(retry.data,out.data);
      const history=await req(front,'GET',`/api/appointments/${out.data.id}/history`);
      assert.equal(history.data.events.length,events,`${kind}: exactly one logical write`);
      if(kind==='rebook')assert.equal(history.data.appointment.appt_date,date);
      const changed=await req(front,method,url,{...body,note:'changed after unknown result'});
      assert.equal(changed.status,409);assert.equal(changed.data.already_saved.id,out.data.id);
      const foreign=await req(doctor,method,url,body);assert.equal(foreign.status,409);assert(!foreign.data.already_saved);
      assert.equal((await req(doctor,'GET','/api/appointment-operations/'+op_id)).data.known,false);
      check(`${kind}: ${phase}, restart, unchanged + changed retry, other actor protected`);
    }
    const a=rows[index++],body={op_id:crypto.randomUUID(),expected_event_id:0,expected_date:a.appt_date,outcome:'answered',note:'<img src=x onerror=alert(1)> ข้อมูลสังเคราะห์'};
    assert.equal((await req(front,'POST',`/api/appointments/${a.id}/contact`,body)).status,200);
    const stale=await req(doctor,'POST',`/api/appointments/${a.id}/attendance`,{op_id:crypto.randomUUID(),expected_event_id:0,expected_date:a.appt_date,status:'attended'});
    assert.equal(stale.status,409);assert(!stale.data.already_saved);
    const history=(await req(doctor,'GET',`/api/appointments/${a.id}/history`)).data;
    assert.equal(history.events.length,1);assert.equal(history.events[0].note,body.note);assert.equal(history.appointment.attendance,'unconfirmed');
    check('two stations share history and reject stale write; contact never infers attendance');
    const singleDoctor=(await req(front,'GET','/api/doctors')).data[0];
    const legacy=rows.at(-1);
    assert.equal((await req(doctor,'POST',`/api/visits/${legacy.visit_id}/call`)).status,200);
    const singleSlip=await req(front,'GET','/print/appointment/'+legacy.id);
    assert.equal(singleSlip.status,200);assert(singleSlip.text.includes('แพทย์ผู้ตรวจ'));assert(singleSlip.text.includes(singleDoctor.display_name));
    assert.equal((await req(admin,'POST','/api/settings',{appt_slip_show_doctor:'0'})).status,200);
    const hiddenSlip=await req(front,'GET','/print/appointment/'+legacy.id);
    assert(!hiddenSlip.text.includes('แพทย์ผู้ตรวจ'));assert(!hiddenSlip.text.includes(singleDoctor.display_name));
    assert.equal((await req(admin,'POST','/api/settings',{appt_slip_show_doctor:'1'})).status,200);
    check('single doctor legacy slip retains examiner line and respects hide setting');
    assert.equal((await req(admin,'POST','/api/users',{username:'doctor-b',display_name:'หมอ บี สังเคราะห์',role:'doctor',password:'Synthetic-123',pin:'1234'})).status,201);
    const doctorB=(await req(null,'POST','/api/login',{username:'doctor-b',password:'Synthetic-123'})).cookie;
    const doctors=(await req(front,'GET','/api/doctors')).data;
    const A=doctors.find(d=>d.display_name!=='หมอ บี สังเคราะห์').id,B=doctors.find(d=>d.display_name==='หมอ บี สังเคราะห์').id;
    async function freshCallVisit(){const p=await req(front,'POST','/api/patients',{first_name:'เรียกคิวสังเคราะห์',sex:'F',op_id:crypto.randomUUID()});const v=await req(front,'POST','/api/visits',{hn:p.data.hn,op_id:crypto.randomUUID()});assert.equal(v.status,201);return v.data.id;}
    for(const phase of ['before-commit','after-commit'])for(const event of ['call','requeue']){
      const id=await freshCallVisit();if(event==='requeue')assert.equal((await req(doctor,'POST',`/api/visits/${id}/call`,{op_id:crypto.randomUUID()})).status,200);
      const body={op_id:crypto.randomUUID()},url=`/api/visits/${id}/${event}`;
      assert.equal((await req(doctor,'POST',url,body,phase)).status,0);await died();await start();
      const out=await req(doctor,'POST',url,body),replay=await req(doctor,'POST',url,body);assert.equal(out.status,200);assert.deepEqual(replay.data,out.data);
      const current=await req(doctor,'GET',`/api/visits/${id}`);assert.equal(current.data.state,event==='call'?'IN_EXAM':'WAITING');assert.equal(current.data.doctor_id,A);
      assert.equal((await req(doctorB,'POST',url,body)).status,event==='call'?409:403);
      assert.equal((await req(front,'POST',url,body)).status,403);
      check('call notice '+event+' '+phase+': real crash and same-op replay, role/user scope');
    }
    const raceId=await freshCallVisit();const raced=await Promise.all([req(doctor,'POST',`/api/visits/${raceId}/call`,{op_id:crypto.randomUUID()}),req(doctorB,'POST',`/api/visits/${raceId}/call`,{op_id:crypto.randomUUID()})]);
    assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]);assert.match(raced.find(r=>r.status===409).data.error,/เรียกคิวที่/);
    const distinct=[await freshCallVisit(),await freshCallVisit()];const called=await Promise.all([req(doctor,'POST',`/api/visits/${distinct[0]}/call`,{op_id:crypto.randomUUID()}),req(doctorB,'POST',`/api/visits/${distinct[1]}/call`,{op_id:crypto.randomUUID()})]);assert(called.every(r=>r.status===200));
    const noticeQueue=(await req(front,'GET','/api/queue')).data.queue;assert.equal(noticeQueue.find(v=>v.id===distinct[0]).doctor_id,A);assert.equal(noticeQueue.find(v=>v.id===distinct[1]).doctor_id,B);
    check('two simultaneous doctors: one winner for same visit, both independent calls retained');
    const legacyMultiSlip=await req(front,'GET','/print/appointment/'+legacy.id);
    assert.equal(legacyMultiSlip.status,200);assert(legacyMultiSlip.text.includes('นัดกับ'));assert(legacyMultiSlip.text.includes(singleDoctor.display_name));
    check('multi doctor legacy slip falls back to recorded examiner without backfill');
    const visit=rows[index++].visit_id;
    assert.equal((await req(doctorB,'POST',`/api/visits/${visit}/call`)).status,200);
    assert.equal((await req(doctor,'PUT',`/api/visits/${visit}/draft`,{cc:'synthetic'})).status,403);
    const first=await req(doctorB,'POST',`/api/visits/${visit}/appointment`,{days:7,doctor_id:A,op_id:crypto.randomUUID()});assert.equal(first.status,201);
    const body2={days:14,doctor_id:A,op_id:crypto.randomUUID()};
    const conflict=await req(doctorB,'POST',`/api/visits/${visit}/appointment`,body2);assert.equal(conflict.status,409);assert(conflict.data.replace_appointment);
    const confirmed={...body2,confirm_replace:true,replace_revision:conflict.data.replace_appointment.revision};
    assert.equal((await req(doctorB,'POST',`/api/visits/${visit}/appointment`,confirmed,'after-commit')).status,0);
    await died();await start();
    const replay=await req(doctorB,'POST',`/api/visits/${visit}/appointment`,confirmed);assert.equal(replay.status,201);assert.equal(replay.data.doctor_id,A);
    const oldHistory=(await req(front,'GET',`/api/appointments/${first.data.id}/history`)).data;
    assert.equal(oldHistory.appointment.cancelled,1);assert.equal(oldHistory.events.filter(e=>e.kind==='cancel').length,1);assert(oldHistory.events[0].note.includes(doctors.find(d=>d.id===A).display_name));
    const slip=await fetch(base+'/print/appointment/'+replay.data.id,{headers:{Cookie:front}});assert.equal(slip.status,200);assert((await slip.text()).includes(doctors.find(d=>d.id===A).display_name));
    check('two doctors: ownership 403, replacement 409, confirmed crash/replay exactly once and named print');
    for(const phase of ['before-commit','after-commit']){
      const p=await req(front,'POST','/api/patients',{first_name:'คิวสังเคราะห์',sex:'F',op_id:crypto.randomUUID()});
      const body={hn:p.data.hn,preferred_doctor_id:B,op_id:crypto.randomUUID()};
      assert.equal((await req(front,'POST','/api/visits',body,phase)).status,0);await died();await start();
      const v=await req(front,'POST','/api/visits',body);assert.equal(v.status,201);
      assert.deepEqual((await req(front,'POST','/api/visits',body)).data,v.data);
      const q=(await req(front,'GET','/api/queue')).data.queue.filter(v=>v.hn===p.data.hn);assert.equal(q.length,1);assert.equal(q[0].preferred_doctor_id,B);
      assert.equal((await req(doctor,'POST',`/api/visits/${v.data.id}/call`)).status,200);
      check('preferred queue '+phase+': crash/replay one visit, other doctor may call');
    }
    await require('./test-drug-labels-http')({req,front,doctor,admin,check});
    console.log(`APPOINTMENTS HTTP PASS: ${passed}`);
  }finally{await stop();fs.rmSync(data,{recursive:true,force:true});}
};
