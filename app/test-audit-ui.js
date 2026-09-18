'use strict';
const assert = require('node:assert/strict');
const view = require('./public/audit-view');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS audit UI: ' + name); }
test('date shortcuts include today and cross year/leap-day correctly', () => {
  assert.deepEqual(view.dates('today', new Date(2026, 0, 1, 0, 15)), {from:'2026-01-01',to:'2026-01-01'});
  assert.deepEqual(view.dates('7', new Date(2026, 0, 1)), {from:'2025-12-26',to:'2026-01-01'});
  assert.deepEqual(view.dates('30', new Date(2024, 2, 1)), {from:'2024-02-01',to:'2024-03-01'});
});
test('query preserves user text as one value and sends explicit routine switch', () => {
  const params = new URLSearchParams(view.query({category:'stock',q:'<ยา> & important=0',important:true,quick:'price',limit:100,from:'2026-09-01',to:'2026-09-18'}));
  assert.equal(params.get('q'),'<ยา> & important=0');assert.equal(params.get('important'),'1');
  assert.equal(params.get('quick'),'price');assert.equal(params.get('limit'),'100');
  const all=new URLSearchParams(view.query({category:'all',q:'',important:false,limit:50000}));
  assert.equal(all.get('important'),'0');assert.equal(all.get('limit'),'1000');assert(!all.has('offset'));
});
test('detail links reject external, protocol-relative and control/Windows paths', () => {
  for(const url of ['https://example.invalid','//example.invalid','javascript:alert(1)','/\\example.invalid','/\n/example.invalid','/one two'])assert.equal(view.safeLink(url),null,url);
  assert.equal(view.safeLink('/print/receipt/69-001?copy=1'),'/print/receipt/69-001?copy=1');
});
test('field values retain zero and false, but do not serialize objects', () => {
  assert.equal(view.valueText(0),'0');assert.equal(view.valueText(false),'ปิด');assert.equal(view.valueText(null),'ไม่ได้ระบุ');
  assert.equal(view.valueText({private:'synthetic'}),'ดูข้อมูลในรายการที่เกี่ยวข้อง');
  assert.equal(view.valueText('<img src=x>'),'<img src=x>');
});
test('dates show Thai instead of raw invalid timestamps', () => {
  assert.equal(view.dateText('broken'), 'ไม่ระบุเวลา');
  assert.match(view.dateText('2026-09-18'),/2569/);
});
test('restore API rolled-back and pending warnings remain visible in overview', () => {
  assert.equal(view.restoreVisible('all',{state:'rolled-back'}),true);
  assert.equal(view.restoreVisible('all',{state:'pending'}),true);
  assert.equal(view.restoreVisible('all',{state:'unknown'}),false);
  assert.equal(view.restoreVisible('backup',{state:'unknown'}),true);
  assert.equal(view.restoreVisible('stock',{state:'rolled-back'}),false);
});
console.log(`Audit UI: ${passed} tests passed (no HTTP/DB)`);
