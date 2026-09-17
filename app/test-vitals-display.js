'use strict';
// Display-only regression. No database, network, or patient data is loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = process.argv[2] === '--source' ? path.resolve(process.argv[3]) : path.join(__dirname, 'public', 'common.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('function vitalReadings(');
assert(start >= 0, 'recorded values need the shared, labelled vitalReadings display');
const end = source.indexOf('\nasync function api(', start);
assert(end > start);
const escapeStart = source.indexOf('function esc(');
const escapeEnd = source.indexOf('\n}', escapeStart) + 2;
assert(escapeStart >= 0 && escapeEnd > escapeStart);
const context = vm.createContext({});
vm.runInContext(source.slice(escapeStart, escapeEnd) + '\n' + source.slice(start, end), context);
const render = context.vitalReadings;
const rows = html => [...html.matchAll(/<span class="vital-reading([^\"]*)"><span class="vital-label">([^<]+)<\/span><strong class="vital-value">([^<]*)<\/strong><span class="vital-unit">([^<]*)<\/span><\/span>/g)]
  .map(m => ({ warning: m[1].includes('vwarn'), label: m[2], value: m[3], unit: m[4] }));
const normal = { bp_sys: 124, bp_dia: 80, pulse: 72, temp_c: 36.8, weight_kg: 74, height_cm: 170, glucose: 95 };
let count = 0;
function test(name, fn) { fn(); count++; console.log('VITALS DISPLAY PASS: ' + name); }

test('normal recorded measurements retain exact values, Thai labels and units', () => {
  assert.deepEqual(rows(render(normal)), [
    { warning: false, label: 'ความดัน (BP)', value: '124/80', unit: 'มม.ปรอท' },
    { warning: false, label: 'ชีพจร', value: '72', unit: 'ครั้ง/นาที' },
    { warning: false, label: 'อุณหภูมิ', value: '36.8', unit: '°C' },
    { warning: false, label: 'น้ำหนัก', value: '74', unit: 'กก.' },
    { warning: false, label: 'ส่วนสูง', value: '170', unit: 'ซม.' },
    { warning: false, label: 'น้ำตาล (DTX)', value: '95', unit: 'mg/dL' },
  ]);
});
test('missing readings stay absent and do not turn into zero or previous readings', () => {
  for (const absent of [{}, { bp_sys: null, pulse: null, temp_c: null, weight_kg: null }, { bp_sys: '', pulse: '', temp_c: '' }]) {
    assert.equal(render(absent), '');
  }
  assert.deepEqual(rows(render({ weight_kg: 74 })), [{ warning: false, label: 'น้ำหนัก', value: '74', unit: 'กก.' }]);
  assert.equal(rows(render({ bp_sys: 124 }))[0].value, '124/—', 'missing diastolic must not be fabricated as zero');
});
test('display escapes unexpected stored text without creating markup', () => {
  const html = render({ weight_kg: '<img src=x onerror="alert(1)">&\'ค่าทดลอง' });
  assert(!html.includes('<img'));
  assert(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;ค่าทดลอง'));
  assert.equal(rows(html).length, 1);
});
test('existing BP warning boundaries remain systolic 140 or diastolic 90', () => {
  assert(!rows(render({ bp_sys: 139, bp_dia: 89 }))[0].warning);
  assert(rows(render({ bp_sys: 140, bp_dia: 80 }))[0].warning);
  assert(rows(render({ bp_sys: 124, bp_dia: 90 }))[0].warning);
});
test('existing pulse, temperature and glucose warning boundaries are unchanged', () => {
  for (const [field, below, at] of [['pulse', 109, 110], ['temp_c', 37.7, 37.8], ['glucose', 125, 126]]) {
    assert(!rows(render({ [field]: below }))[0].warning, field + ' below existing threshold');
    assert(rows(render({ [field]: at }))[0].warning, field + ' at existing threshold');
  }
  assert(rows(render({ weight_kg: 140, height_cm: 180 })).every(r => !r.warning), 'no new warning criteria for weight/height');
});
test('normal measurements use labelled primary content, not muted text or colour alone', () => {
  const html = render(normal);
  assert.match(html, /aria-label="ค่าที่บันทึกในการตรวจครั้งนี้"/);
  assert.equal((html.match(/class="vital-value"/g) || []).length, 6);
  assert.doesNotMatch(html, /class="[^"]*(?:muted|sub)[^"]*"/);
});
console.log(`Vitals display: ${count} tests passed`);
