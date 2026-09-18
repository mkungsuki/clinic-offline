'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
process.env.CLINIC_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-dose-defaults-'));
const {db}=require('./lib/db'),stock=require('./lib/stock'),notes=require('./lib/notes'),D=require('./public/dose-template');let count=0;
function test(n,fn){fn();console.log('DOSE DEFAULT PASS: '+n);count++;}
const base={name:'ยาสังเคราะห์ทดสอบ',unit:'เม็ด',price:10,cost:2};
let id,template;
test('migration marker is nullable and text-only drug is never backfilled',()=>{id=stock.upsertDrug({...base,default_instructions:'ครั้งละ 1/2 เม็ด วันละ 1 ครั้ง'});assert.equal(db.prepare('SELECT default_dose_json FROM drugs WHERE id=?').get(id).default_dose_json,null);});
test('stored half dose uses typed numeric grid, preserves supplemental text',()=>{template=D.normalize({...D.empty(),m:0.5,days:7,additional_instructions:'คำแนะนำสมมติ'},'เม็ด');stock.upsertDrug({...base,default_dose:template},id);const item=stock.searchItems(base.name)[0];assert.equal(JSON.parse(item.default_dose_json).m,0.5);assert(item.default_instructions.includes('เช้า 0.5'));assert(item.default_instructions.includes('คำแนะนำสมมติ'));});
test('server quantity from half grid for seven days is four, not seven',()=>{const lines=notes.buildLines([{type:'drug',ref_id:id,qty:99,dose:template}]);assert.equal(lines[0].qty,4);assert.equal(lines[0].dose.additional_instructions,'คำแนะนำสมมติ');});
test('fraction prose cannot enter numeric fields',()=>assert.throws(()=>D.normalize({...D.empty(),m:'1/2'},'เม็ด'),/ตัวเลข/));
test('invalid negative, exponent, boolean and non-finite quantities refused',()=>{for(const v of [-1,'1e2',true,Infinity,'1-2','½'])assert.throws(()=>D.normalize({...D.empty(),m:v},'เม็ด'));});
test('exact times retain distinct typed amounts and reject duplicate/incomplete rows',()=>{const d=D.normalize({...D.empty('exact_times'),times:[{time:'07:30',amount:0.5},{time:'19:00',amount:1}]},'เม็ด');assert.equal(D.perDay(d),1.5);for(const times of [[{time:'07:30',amount:1},{time:'07:30',amount:2}],[{time:'',amount:1}]])assert.throws(()=>D.normalize({...D.empty('exact_times'),times},'เม็ด'));});
test('PRN and manual never acquire scheduled daily totals',()=>{for(const mode of ['prn','manual']){const d=D.normalize({...D.empty(mode),m:2,days:7,prn_amount:1,prn_indication:'อาการสมมติ'},'เม็ด');assert.equal(D.perDay(d),0);assert.equal(d.days,0);}});
test('unit change requires review and does not silently reuse old quantities',()=>assert.throws(()=>stock.upsertDrug({...base,unit:'ขวด'},id),/หน่วย/));
test('legacy caller cannot replace displayed text while retaining conflicting grid',()=>assert.throws(()=>stock.upsertDrug({...base,default_instructions:'ข้อความใหม่'},id),/ตาราง/));
test('editing master leaves previously built order snapshot untouched',()=>{const old=notes.buildLines([{type:'drug',ref_id:id,qty:1,dose:template}]);stock.upsertDrug({...base,default_dose:{...template,m:2}},id);assert.equal(old[0].qty,4);assert.equal(old[0].dose.m,0.5);});
test('browser factory leaves legacy prose uncalculated and fills typed defaults',()=>{
 const html=fs.readFileSync(path.join(__dirname,'public/exam.html'),'utf8');assert(!html.includes('parseDoseFromText'));assert(!html.includes('PRN_TEXT_RE'));
 const c={DoseTemplate:D,structuredClone};vm.createContext(c);
 const math=html.slice(html.indexOf("function defaultDose("),html.indexOf('function updDose('));const factory=html.slice(html.indexOf('function newDrugLine('),html.indexOf('// ตั้งจำนวนวันให้ยาทุกตัว'));
 vm.runInContext(math+'\n'+factory,c);
 const legacy=c.newDrugLine({...base,id:99,default_instructions:'ครั้งละ 1/2 เม็ด วันละ 1 ครั้ง'});assert.equal(c.dosePerDay(legacy.dose),0);assert.equal(legacy.instructions,'ครั้งละ 1/2 เม็ด วันละ 1 ครั้ง');assert.equal(legacy.dose.instructions_source,'manual');
 const numeric=c.newDrugLine({...base,id,default_dose_json:JSON.stringify(template)});assert.equal(numeric.qty,4);numeric.dose.m=99;assert.equal(template.m,0.5);
 assert.equal((html.match(/newDrugLine\(it\)/g)||[]).length,3);assert(html.includes('class="dose-missing"'));
});
test('stock UI has all modes, persistent save recovery, no legacy parser',()=>{const html=fs.readFileSync(path.join(__dirname,'public/stock.html'),'utf8');for(const v of ['drugDoseEditor','retryDrugSave','clinic_drug_save','default_dose: template'])assert(html.includes(v));const script=fs.readFileSync(path.join(__dirname,'public/dose-template-editor.js'),'utf8');for(const mode of ['standard','exact_times','prn','manual'])assert(script.includes(mode));});
test('omitted template preserves stored mode, unit and display as one contract',()=>{stock.upsertDrug({...base,default_dose:{...D.empty('prn'),prn_amount:0.5,prn_indication:'อาการสมมติ'}},id);const before=stock.listDrugs().find(d=>d.id===id);stock.upsertDrug({name:base.name,price:20},id);const after=stock.listDrugs().find(d=>d.id===id);for(const k of ['unit','dose_mode','default_instructions','default_dose_json'])assert.equal(after[k],before[k]);});
test('populated schema16 migration and master edit preserve immutable order bytes',()=>{
 const {spawnSync}=require('child_process'),{DatabaseSync}=require('node:sqlite');
 db.exec("INSERT INTO patients(hn,first_name,sex,created_at) VALUES('DOSE-SYNTHETIC','สมมติ','F','2026-09-16'); INSERT INTO visits(hn,visit_date,queue_no,state,created_by,created_at) VALUES('DOSE-SYNTHETIC','2026-09-16',1,'IN_EXAM',1,'2026-09-16')");
 const visit=db.prepare('SELECT id FROM visits WHERE hn=?').get('DOSE-SYNTHETIC').id;
 const order=notes.saveOrderVersion(visit,[{type:'drug',ref_id:id,qty:4,dose:template}],null,1);
 const before=db.prepare('SELECT lines_json FROM order_versions WHERE id=?').get(order.id).lines_json;
 stock.upsertDrug({...base,default_dose:{...template,m:2}},id);assert.equal(db.prepare('SELECT lines_json FROM order_versions WHERE id=?').get(order.id).lines_json,before);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clinic-dose-migrate-'));db.prepare('VACUUM INTO ?').run(path.join(dir,'clinic.db'));
 const old=new DatabaseSync(path.join(dir,'clinic.db'));old.exec("DROP TABLE audit_changes; DELETE FROM settings WHERE key='audit_changes_since'; ALTER TABLE drugs DROP COLUMN default_dose_json; PRAGMA user_version=16");const text=old.prepare('SELECT default_instructions FROM drugs WHERE id=?').get(id).default_instructions;old.close();
 const run=spawnSync(process.execPath,['--no-warnings','-e',`const assert=require('assert/strict'),{db}=require('./lib/db');assert.equal(db.prepare('PRAGMA user_version').get().user_version,require('./lib/schema-version').SCHEMA_VERSION);assert.equal(db.prepare('SELECT default_dose_json FROM drugs WHERE id=?').get(${id}).default_dose_json,null);assert.equal(db.prepare('SELECT default_instructions FROM drugs WHERE id=?').get(${id}).default_instructions,${JSON.stringify(text)});assert.equal(db.prepare('SELECT lines_json FROM order_versions WHERE id=?').get(${order.id}).lines_json,${JSON.stringify(before)});assert.throws(()=>db.exec('UPDATE order_versions SET lines_json=lines_json'),/append-only/);db.close();`],{cwd:__dirname,env:{...process.env,CLINIC_DATA_DIR:dir},encoding:'utf8',windowsHide:true});assert.equal(run.status,0,run.stderr);
});
for(const [mode,fields,qty] of [['exact_times',{times:[{time:'08:15',amount:0.5},{time:'19:30',amount:1}],days:3},5],['prn',{prn_amount:0.5,prn_indication:'อาการสมมติ'},2],['manual',{additional_instructions:'คำสั่งสังเคราะห์'},2]])test(mode+' master to search to order retains typed data and quantity contract',()=>{
 const d=D.normalize({...D.empty(mode),...fields},'เม็ด');const ref=stock.upsertDrug({...base,name:'synthetic-'+mode,default_dose:d});const stored=D.read(stock.searchItems('synthetic-'+mode)[0]);assert.deepEqual(stored,d);const line=notes.buildLines([{type:'drug',ref_id:ref,qty:2,dose:stored,instructions:D.text(stored)}])[0];assert.equal(line.qty,qty);assert.equal(line.instructions,D.text(stored));
});
console.log('DOSE DEFAULT TOTAL: '+count);db.close();
