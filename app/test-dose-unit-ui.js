'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const D=require('./public/dose-template');
const html=fs.readFileSync(path.join(__dirname,'public/exam.html'),'utf8');
let count=0;
function test(name,fn){fn();count++;console.log('DOSE UNIT UI PASS: '+name);}
const toasts=[];
const elements={daysAll:{value:'10'},daysAllResult:{textContent:'',hidden:true}};
const c={DoseTemplate:D,structuredClone,toast:t=>toasts.push(t),lines:[],document:{getElementById:id=>elements[id]},draftDirty:false};
vm.createContext(c);
vm.runInContext(html.slice(html.indexOf('function defaultDose('),html.indexOf('function updDose('))+'\n'+html.slice(html.indexOf('function newDrugLine('),html.indexOf('// ตั้งจำนวนวันให้ยาทุกตัว'))+'\n'+html.slice(html.indexOf('function applyDaysAll('),html.indexOf("attachSearch(document.getElementById('orderAdd')"))+'\nfunction renderOrder(){}',c);
const item={id:1,name:'ยาสังเคราะห์',unit:'ขวด',price:50,default_dose:{...D.empty(),m:5,days:7,dose_unit:'มล.'}};
test('new bottle has mL directions and empty explicit dispensing quantity',()=>{const l=c.newDrugLine(item);assert.equal(l.qty,'');assert.equal(l.dose.qty_source,'manual');assert.match(l.instructions,/5 มล\./);assert.equal(l.calculated_qty,null);});
test('switching calculated amount to another unit clears amount rather than carrying 35 bottles',()=>{const l={type:'drug',unit:'ขวด',qty:35,dose:{...D.empty(),m:5,days:7,dose_unit:'มล.'}};c.recomputeLine(l);assert.equal(l.qty,'');assert.equal(l.dose.qty_source,'manual');});
test('explicit manual bottle count survives dose changes and interval mode',()=>{const l={type:'drug',unit:'ขวด',qty:1,dose:{...D.empty('interval'),dose_unit:'มล.',interval_amount:5,interval_min_hours:4,interval_max_hours:6,qty_source:'manual'}};c.recomputeLine(l);assert.equal(l.qty,1);assert.match(l.instructions,/5 มล\. ทุก 4–6/);assert.equal(l.calculated_qty,null);});
test('all-days updates liquid duration without changing bottles and calculates same-unit pills',()=>{const bottle=c.newDrugLine(item);bottle.qty=2;const pill=c.newDrugLine({...item,id:2,unit:'เม็ด',default_dose:{...D.empty(),m:0.5,days:7}});c.lines=[bottle,pill];c.applyDaysAll();assert.equal(bottle.qty,2);assert.equal(bottle.dose.days,10);assert.match(bottle.instructions,/10 วัน/);assert.equal(pill.qty,5);assert.match(elements.daysAllResult.textContent,/คงจำนวนจ่าย/);assert.match(elements.daysAllResult.textContent,/คำนวณจำนวนให้ยา 1 ตัว/);assert.equal(elements.daysAllResult.hidden,false);assert.equal(toasts.length,0);});
test('all-days keeps interval quantity and interval wording intact',()=>{const l=c.newDrugLine({...item,default_dose:{...D.empty('interval'),dose_unit:'มล.',interval_amount:5,interval_min_hours:4,interval_max_hours:6}});l.qty=1;c.lines=[l];c.applyDaysAll();assert.equal(l.qty,1);assert.equal(l.dose.days,0);assert.match(l.instructions,/4–6/);});
test('appointment quantity uses shared unit eligibility, with no independent dose multiplication',()=>{const source=html.slice(html.indexOf('function calculateMedsToAppointment('),html.indexOf('function setApptCustom('));assert.match(source,/DoseTemplate.canCalculateQty/);assert.match(source,/DoseTemplate.quantity/);assert.doesNotMatch(source,/Math.ceil|dosePerDay/);});
test('switching into an hourly schedule never inherits a hidden after-food default',()=>{
  vm.runInContext(html.slice(html.indexOf('function setDoseMode('),html.indexOf('function updTime(')),c);
  const l={type:'drug',unit:'เม็ด',qty:7,dose:{...c.defaultDose(),m:1,days:7}};c.lines=[l];
  assert.equal(l.dose.timing,'หลังอาหาร');c.setDoseMode(0,'interval');assert.equal(l.dose.timing,'');assert.equal(l.qty,'');
  l.dose.interval_amount=1;l.dose.interval_min_hours=4;l.dose.interval_max_hours=6;c.recomputeLine(l);assert.doesNotMatch(l.instructions,/อาหาร/);
  l.dose.timing='ก่อนอาหาร';c.recomputeLine(l);assert.match(l.instructions,/ก่อนอาหาร/);assert.equal(c.defaultDose('interval').timing,'');
});
console.log(`Dose unit UI: ${count} tests passed`);
