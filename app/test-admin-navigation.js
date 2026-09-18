'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const read = name => fs.readFileSync(path.join(__dirname, 'public', name), 'utf8');
const inline = text => [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS admin: ' + name); }
(async () => {
  for (const [role, after, reason, expected] of [
    ['admin', '', '', '/admin.html'], ['front', '', '', '/'], ['doctor', '', '', '/exam.html'],
    ['admin', '/admin.html', 'update', '/admin.html?section=system'],
    ['admin', '/admin.html', '', '/admin.html?section=connections'],
    ['front', '/admin.html', 'update', '/'], ['doctor', '/admin.html', '', '/exam.html'],
    ['admin', 'https://invalid.example/', '', '/admin.html'],
  ]) await test(`login ${role} ${after} ${reason}`, async () => {
    const values = new Map([['clinic_after_login', after], ['clinic_after_login_reason', reason]]);
    const context = vm.createContext({ URLSearchParams, api: async () => ({role}), location: {href:'',search:''},
      localStorage: {getItem:k=>values.get(k)||null, removeItem:k=>values.delete(k)},
      document: {getElementById:()=>({value:'synthetic',classList:{remove(){}},addEventListener(){}}),addEventListener(){}},
    });
    vm.runInContext(inline(read('login.html')), context);
    await vm.runInContext('doLogin()', context);
    assert.equal(context.location.href, expected);
  });
  const common = read('common.js');
  for (const role of ['doctor', 'front']) await test('audit URL keeps ' + role + ' on About without audit request', async () => {
    let ready; let mounted = 0; const visible = new Set();
    const ctx = vm.createContext({
      initPage: () => ({then(fn) { ready = fn; }}),
      document: {getElementById: id => ({textContent:'',classList:{remove: name => visible.add(id + ':' + name)}})},
      AuditView: {mount() { mounted++; }},
      localStorage: {getItem:()=>null,removeItem(){}},
    });
    vm.runInContext(inline(read('admin.html')), ctx);
    ready({role,app_version:'synthetic'});
    assert.equal(mounted,0);assert(visible.has('aboutCard:hidden'));
    assert.equal(ctx.document.title,'เกี่ยวกับโปรแกรม');
  });
  await test('audit is a first-class category with direct account link', () => {
    const ctx=vm.createContext({});vm.runInContext(read('admin-navigation.js'),ctx);
    assert.equal(vm.runInContext('ADMIN_SECTIONS.audit',ctx),'ประวัติการทำรายการ');
    assert.match(read('admin.html'),/href="\/admin.html\?section=audit&amp;category=account"/);
  });
  await test('missing/unknown selects retain defaults; empty text clears old content', () => {
    const ctx=vm.createContext({});vm.runInContext(read('admin-navigation.js'),ctx);
    ctx.el={tagName:'SELECT',options:[{value:'0'},{value:'1'}],value:'0'};
    vm.runInContext("setAdminFieldValue(el,'')",ctx);assert.equal(ctx.el.value,'0');
    vm.runInContext("setAdminFieldValue(el,'invalid')",ctx);assert.equal(ctx.el.value,'0');
    vm.runInContext("setAdminFieldValue(el,'1')",ctx);assert.equal(ctx.el.value,'1');
    ctx.el={tagName:'INPUT',type:'text',value:'old'};
    vm.runInContext("setAdminFieldValue(el,'')",ctx);assert.equal(ctx.el.value,'');
    ctx.el={tagName:'INPUT',type:'time',value:'21:00'};
    vm.runInContext("setAdminFieldValue(el,'')",ctx);assert.equal(ctx.el.value,'21:00');
  });
  const init = common.slice(common.indexOf('async function initPage('), common.indexOf('function renderBackupBanner('));
  for (const key of ['front','exam','calendar','stock','reports']) await test('direct admin ' + key, async () => {
    const ctx=vm.createContext({api:async()=>({role:'admin'}),location:{replace(url){this.to=url;}}});
    vm.runInContext(init,ctx);
    assert.equal(await vm.runInContext(`initPage('${key}')`,ctx),null);
    assert.equal(ctx.location.to,'/admin.html');
  });
  for (const mode of ['normal','lost-response','before-commit','edited-in-flight']) await test('scoped settings ' + mode, async () => {
    const elements = new Map();
    const field = (id, scope, value) => {
      const el={id,value,type:'text',closest:()=>({dataset:{adminSection:scope}})};
      elements.set(id,el); return el;
    };
    const print=field('s_medication_sheet_font','printing','20');
    field('s_clinic_name','clinic','must-not-save');
    field('s_backup_time','backup','23:59');
    for(const id of ['adminSaveError','adminSave','adminSaveState'])elements.set(id,{textContent:'',disabled:false});
    const stored={medication_sheet_font:'18'};let postCount=0;
    const ctx=vm.createContext({
      document:{getElementById:id=>elements.get(id),querySelectorAll:()=>[print]},initPage:()=>({then(){}}),toast(){},
      localStorage:{getItem:()=>null,removeItem(){}},
      api:async(method,url,body)=>{
        assert.equal(url,'/api/settings');
        if(method==='GET')return {...stored};
        postCount++;assert.deepEqual(Object.keys(body),['medication_sheet_font']);
        if(mode==='before-commit')throw Error('synthetic network failure');
        Object.assign(stored,body);
        if(mode==='edited-in-flight')print.value='24';
        if(mode==='lost-response')throw Error('synthetic reply lost after commit');
      },
    });
    vm.runInContext(read('admin-navigation.js')+'\n'+inline(read('admin.html')),ctx);
    vm.runInContext("adminSection='printing';rememberAdminFields();adminBaseline.set('s_medication_sheet_font','18')",ctx);
    if(mode==='before-commit') {
      await assert.rejects(vm.runInContext('saveSettings()',ctx));
      assert.match(elements.get('adminSaveError').textContent,/ยังยืนยันการบันทึกไม่ได้/);
      assert.equal(vm.runInContext('adminIsDirty()',ctx),true);
    } else {
      await vm.runInContext('saveSettings()',ctx);
      assert.equal(stored.medication_sheet_font,'20');
      assert.equal(vm.runInContext('adminIsDirty()',ctx),mode==='edited-in-flight');
    }
    assert.equal(postCount,1);
    assert.equal(elements.get('adminSave').disabled,false);
    assert.throws(()=>vm.runInContext("adminSettingsPayload('backup')",ctx));
  });
  console.log(`Admin navigation: ${passed} tests passed (synthetic VM, no HTTP/DB)`);
})().catch(e=>{console.error(e);process.exitCode=1;});
