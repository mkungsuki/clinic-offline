'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-solo-unit-'));process.env.CLINIC_DATA_DIR=dir;
const {db,getSetting}=require('./lib/db'),auth=require('./lib/auth');let passed=0;
function test(n,fn){fn();passed++;console.log('SOLO PASS: '+n);}
const make=(username,role)=>{auth.createUser({username,displayName:'สังเคราะห์',role,password:'Synthetic-123',pin:'1234'});return auth.login(username,'Synthetic-123');};
try{
const d=make('solo','doctor'),other=make('other','doctor'),front=make('solo-front','front'),admin=make('solo-admin','admin');
test('existing/new doctors default off; front works; admin does not inherit clinical rights',()=>{assert(!auth.canFrontDesk(d));assert(!auth.canFrontDesk(other));assert(auth.canFrontDesk(front));assert(!auth.canFrontDesk(admin));});
let cookie=auth.createSession(d);
test('grant is explicit and revokes pre-existing login',()=>{assert.equal(auth.updateUser(d.id,{front_desk:true}).sessions_revoked,true);assert.equal(auth.getSession(cookie),null);assert(auth.canFrontDesk(d));assert(!auth.canFrontDesk(other));});
cookie=auth.createSession(d);
test('new login remains doctor plus front capability, repeat same grant is no-op',()=>{assert.equal(auth.getSession(cookie).role,'doctor');assert.equal(auth.getSession(cookie).canFrontDesk,true);assert.equal(auth.updateUser(d.id,{front_desk:true}).sessions_revoked,false);assert(auth.getSession(cookie));});
test('unrelated account edits preserve permission',()=>{auth.updateUser(d.id,{display_name:'สังเคราะห์ใหม่'});assert(auth.canFrontDesk(d));});
test('invalid values/non-doctor flag rejected without grants',()=>{for(const v of ['true',1,null,{},[]])assert.throws(()=>auth.updateUser(d.id,{front_desk:v}));for(const u of [front,admin])assert.throws(()=>auth.updateUser(u.id,{front_desk:true}));assert(!auth.canFrontDesk(admin));});
test('disable revokes all old logins and repeat disable does not revoke new ones',()=>{const second=auth.createSession(d);auth.updateUser(d.id,{front_desk:false});assert.equal(auth.getSession(cookie),null);assert.equal(auth.getSession(second),null);cookie=auth.createSession(d);assert.equal(auth.getSession(cookie).canFrontDesk,false);auth.updateUser(d.id,{front_desk:false});assert(auth.getSession(cookie));});
test('transaction rollback cannot leave a half-granted capability',()=>{assert.throws(()=>auth.updateUser(d.id,{front_desk:true,display_name:{toString(){throw Error('injected');}}}));assert(!auth.canFrontDesk(d));assert(auth.getSession(cookie));});
test('auth revision is persisted in DB independently of session file',()=>{const before=Number(getSetting('auth_revision_'+d.id));auth.updateUser(d.id,{front_desk:true});assert.equal(Number(getSetting('auth_revision_'+d.id)),before+1);auth.saveSessionsNow();assert.equal(auth.getSession(cookie),null);});
console.log('SOLO TOTAL: '+passed);
}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
