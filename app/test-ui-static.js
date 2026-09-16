'use strict';
// Release gate ราคาถูกสำหรับบั๊ก browser ที่เคยหลุดถึงหน้างาน
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, 'public');
const files = fs.readdirSync(publicDir).filter(name => /\.(?:html|js)$/i.test(name));
const sources = files.map(name => ({ name, text: fs.readFileSync(path.join(publicDir, name), 'utf8') }));
const css = fs.readFileSync(path.join(publicDir, 'app.css'), 'utf8');
const { markdownToHtml } = require('./tools/build-trial-docs');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✅ UI static: ${name}`); }
  catch (error) { console.error(`❌ UI static: ${name}\n${error.message}`); process.exitCode = 1; }
}

function zIndex(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert(block, `ไม่พบ CSS selector ${selector}`);
  const z = block[1].match(/z-index\s*:\s*(\d+)/);
  assert(z, `${selector} ไม่มี z-index`);
  return Number(z[1]);
}

test('window.open อยู่ใน helper reserve ก่อน await เท่านั้น', () => {
  const raw = [];
  for (const source of sources) {
    for (const match of source.text.matchAll(/window\.open\s*\(/g)) raw.push(`${source.name}:${match.index}`);
  }
  assert.deepStrictEqual(raw.length, 1, `พบ window.open นอก helper: ${raw.join(', ')}`);
  assert.equal(raw[0].startsWith('common.js:'), true, `window.open ต้องอยู่ใน common.js เท่านั้น: ${raw[0]}`);
  const helper = sources.find(item => item.name === 'common.js').text;
  assert.match(helper, /function reservePrintWindow\(\)\s*\{\s*const w\s*=\s*window\.open\('',\s*'_blank'\)/);
  assert.doesNotMatch(helper, /function reservePrintWindow[\s\S]{0,300}\bawait\b/);
});

test('11 print actions ใช้ reserve/finalize และมี persistent fallback', () => {
  const combined = sources.map(item => item.text).join('\n');
  const syncCalls = (combined.match(/openPrintWindow\s*\(/g) || []).length - 1; // หัก definition
  const reserveCalls = (combined.match(/reservePrintWindow\s*\(/g) || []).length - 2; // definition + call ใน openPrintWindow
  assert.equal(syncCalls, 6, `print synchronous actions ต้องมี 6 จุด แต่พบ ${syncCalls}`);
  assert.equal(reserveCalls, 5, `print หลัง side effect ต้อง reserve ก่อน await 5 จุด แต่พบ ${reserveCalls}`);
  assert.match(combined, /function showPersistentPrintLink/);
  assert.match(combined, /id = 'printFallbacks'/);
  assert.match(combined, /ออกเอกสารแล้ว แต่เบราว์เซอร์ไม่เปิดแท็บให้/);
});

// จำนวนอย่างเดียวไม่พอ: บั๊กหน้างานคือ reserve มา "หลัง" await จึงต้องตรวจลำดับในตัวฟังก์ชันจริง
test('ทุกฟังก์ชันที่เปิดแท็บหลัง await ต้อง reserve ก่อน await ตัวแรก', () => {
  const targets = [
    ['index.html', 'doPay'], ['index.html', 'printPendingDoc'], ['index.html', 'printAllPending'],
    ['index.html', 'doReissue'], ['exam.html', 'submitMedCert'],
  ];
  for (const [file, fn] of targets) {
    const text = sources.find(item => item.name === file).text;
    const start = text.indexOf(`async function ${fn}(`);
    assert.notEqual(start, -1, `ไม่พบ async function ${fn} ใน ${file}`);
    // ตัด comment ทิ้งก่อน ไม่งั้นคำว่า await ในคำอธิบายจะทำให้ผลเพี้ยน
    const body = text.slice(start, text.indexOf('\n}\n', start) + 1).replace(/\/\/[^\n]*/g, '');
    const firstAwait = body.indexOf('await ');
    const reserve = body.indexOf('reservePrintWindow(');
    assert.notEqual(reserve, -1, `${file}:${fn} ต้องเรียก reservePrintWindow`);
    assert(firstAwait === -1 || reserve < firstAwait,
      `${file}:${fn} เรียก reservePrintWindow หลัง await — popup blocker จะบล็อกแท็บ`);
  }
});

test('หน้าห้องตรวจมีโหมด "พิมพ์ที่หน้าร้าน" และไม่เปิดแท็บเองเมื่อไม่มีเครื่องพิมพ์', () => {
  const exam = sources.find(item => item.name === 'exam.html').text;
  assert.match(exam, /function stationHasPrinter\(\)/);
  assert.match(exam, /localStorage\.getItem\('station_printer'\)/);
  assert.match(exam, /ME && ME\.is_host/, 'ค่าเริ่มต้นต้องมาจาก is_host ของ session');
  assert.match(exam, /const printWindow = hasPrinter \? reservePrintWindow\(\) : null;/);
  assert.match(exam, /function showFrontPrintNotice/, 'ต้องมีร่องรอยค้างในหน้าเมื่อใบออกแล้วแต่ไม่ได้เปิดแท็บ');
  const index = sources.find(item => item.name === 'index.html').text;
  assert.match(index, /function pendingDocBadges/);
  assert.match(index, /หมอออกใบรับรองให้คิวที่/, 'หน้าร้านต้อง toast เมื่อมีใบใหม่รอพิมพ์');
  assert.match(index, /พิมพ์ทั้งหมดที่ค้าง/);
  assert.match(css, /\.printwait\s*\{/);
});

test('toast อยู่เหนือ overlay และ modal ทุกตัว', () => {
  const toast = zIndex('#toast');
  assert(toast > zIndex('.overlay'), `toast ${toast} ต้องสูงกว่า overlay`);
  assert(toast > zIndex('#modalBack'), `toast ${toast} ต้องสูงกว่า modalBack`);
});

test('ฟอร์มลงทะเบียนมี responsive wrap สำหรับ laptop scaling', () => {
  const index = sources.find(item => item.name === 'index.html').text;
  assert.match(index, /class="row reg-demographics-row"/);
  assert.match(index, /class="row reg-birth-fields"/);
  assert.match(css, /#regCard \.row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /@media \(max-width:\s*760px\)/);
  // เฟส 3 (2026-08-18): ฟอร์มเป็น modal กลางจอ — ฉากหลัง fixed + กล่องกว้างจำกัด + เลื่อนได้เมื่อจอเตี้ย (1280@150% สูง 480px) และ z ต่ำกว่า overlay/toast
  assert.match(index, /id="regBack"/, 'ต้องมีฉากหลัง #regBack');
  assert.match(index, /class="modal-box reg-modal hidden" id="regCard"/, '#regCard ต้องเป็น modal-box');
  assert.match(css, /#regBack\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*60/, '#regBack ต้อง fixed z 60 (ต่ำกว่า overlay 300/toast 1200)');
  assert.match(css, /#regCard\.reg-modal\s*\{[^}]*max-height:[^}]*overflow:\s*auto/, '#regCard ต้องเลื่อนได้เมื่อจอเตี้ย');
  assert.match(index, /regFormDirty\(\)/, 'Esc ต้องไม่ปิดฟอร์มที่กรอกค้าง');
});

test('PDF คู่มือมีสารบัญคลิกได้และปลายทางตรงกับทุกหัวข้อ', () => {
  const sample = '# คู่มือ\n\n[[toc]]\n\n## หัวข้อหลัก\n\n### หัวข้อย่อย\n\n## หัวข้อถัดไป';
  const guide = markdownToHtml(sample, 'guide');
  assert.match(guide, /<nav class="toc" aria-label="สารบัญ">/);
  assert.match(guide, /href="#section-1">หัวข้อหลัก<\/a>/);
  assert.match(guide, /href="#section-2">หัวข้อย่อย<\/a>/);
  assert.match(guide, /href="#section-3">หัวข้อถัดไป<\/a>/);
  assert.match(guide, /<h2 id="section-1">หัวข้อหลัก<\/h2>/);
  assert.match(guide, /<h3 id="section-2">หัวข้อย่อย<\/h3>/);
  assert.match(guide, /<h2 id="section-3">หัวข้อถัดไป<\/h2>/);

  const form = markdownToHtml(sample, 'form');
  const picture = markdownToHtml('# Guide\n\n## Picture\n\n![Example](screenshots/00-install-steps.svg)');
  assert.doesNotMatch(picture, /<p>\s*<figure>/, 'ภาพต้องไม่อยู่ใน p มิฉะนั้น browser แทรกย่อหน้าว่างและแยกหัวข้อจากภาพ');
  assert.match(form, /href="#section-1">หัวข้อหลัก<\/a>/);
  assert.doesNotMatch(form, /href="#section-2">หัวข้อย่อย<\/a>/,
    'แบบทดลองควรแสดงเฉพาะช่วงหลักเพื่อไม่ให้สารบัญยาวจนผู้ใช้เมา');
  assert.match(form, /<h3 id="section-2">หัวข้อย่อย<\/h3>/,
    'หัวข้อย่อยยังต้องมีปลายทาง แม้ไม่แสดงในสารบัญ');

  for (const file of ['คู่มือฉบับเต็ม-สำหรับหมอ.md', 'คู่มือฉบับเต็ม-สำหรับหน้าร้านและผู้ดูแล.md', 'แบบทดลองใช้-สำหรับหมอ.md']) {
    const docRoot = ['../public-release/docs', '../docs', '..'].map(p => path.resolve(__dirname, p)).find(p => fs.existsSync(path.join(p, file)));
    assert.match(fs.readFileSync(path.join(docRoot, file), 'utf8'), /^\[\[toc\]\]$/m,
      `${file} ต้องวางสารบัญไว้ในเอกสาร`);
  }
});

// ธีมพื้นหลัง 3 แบบ (เจ้าของสั่ง 2026-08-16): ทุกพื้นผิวกลางต้องผ่านตัวแปร CSS ไม่ hard-code ขาว/เทาในหน้าที่ใช้ app.css
// (recovery.html เป็นหน้ากู้แบบ standalone ไม่โหลด app.css — ยกเว้น) · หน้าพิมพ์ต้องขาวเสมอ · ธีมมืดต้องคุมตัวอักษรบนกล่องพื้นอ่อนที่มีความหมาย
test('ธีมสว่าง/นวล/มืด: ตัวแปรครบ, พิมพ์ขาวเสมอ, ไม่มี background ขาว hard-code ในหน้าที่โหลด app.css', () => {
  for (const theme of ['soft', 'dark']) {
    const block = css.match(new RegExp(':root\\[data-theme="' + theme + '"\\]\\s*\\{([^}]*)\\}'));
    assert(block, `app.css ต้องมีธีม ${theme}`);
    for (const v of ['--bg', '--card', '--line', '--ink', '--dim', '--surface2']) assert.match(block[1], new RegExp(v + '\\s*:'), `ธีม ${theme} ต้องกำหนด ${v}`);
  }
  const print = css.match(/@media print\s*\{([\s\S]*?)\n\}/);
  assert(print && /--card:\s*#fff/.test(print[1]) && /--bg:\s*#fff/.test(print[1]) && /data-theme="dark"/.test(print[1]), 'หน้าพิมพ์ต้องบังคับพื้นขาวทุกธีม');
  const cssNoPrint = css.replace(/@media print\s*\{[\s\S]*?\n\}/, '');
  assert.equal((cssNoPrint.match(/background:\s*(#fff\b|#ffffff\b|white\b)/g) || []).length, 0, 'app.css ห้าม background ขาว hard-code (ใช้ var(--card))');
  for (const source of sources) {
    if (!source.name.endsWith('.html') || source.name === 'recovery.html') continue;
    const styleBlocks = [...source.text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
    assert.equal((styleBlocks.match(/background:\s*(#fff\b|#ffffff\b|white\b)/g) || []).length, 0, `${source.name} <style> ห้าม background ขาว hard-code`);
  }
  const common = sources.find(item => item.name === 'common.js').text;
  assert.match(common, /localStorage\.getItem\('clinic_theme'\)/, 'จำธีมต่อเครื่องด้วย localStorage.clinic_theme');
  assert.match(common, /^applyTheme\(currentTheme\(\)\);/m, 'ต้อง apply ธีมทันทีตอนโหลดสคริปต์ (กันกะพริบ)');
  assert.match(common, /themePickerHtml\(\)/, 'topbar ต้องมีตัวเลือกพื้นหลัง');
  assert.match(sources.find(item => item.name === 'login.html').text, /class="theme-pick"/, 'หน้า login ต้องมีตัวเลือกพื้นหลัง');
  assert.match(css, /:root\[data-theme="dark"\] #allergyBar/, 'ธีมมืดต้องบังคับตัวอักษรเข้มบนกล่องแพ้ยาพื้นอ่อน');
});

// ซ้อมอัปเดตจริง 2026-08-19: updater เสร็จใน 6 วิ แต่หน้าที่กดไม่มีใคร poll → ค้าง "กำลังอัปเดต" จนผู้ใช้กด F5 เอง
// → ทุกจุดที่สั่ง apply ต้องส่งต่อให้ watchUpdateProgress ซึ่ง poll ด้วย fetch ตรง (api() จะเด้ง login ทันทีโดยไม่จำผล),
//   401 = server ใหม่ขึ้นแล้ว → ธง + พาไป login ที่บอกว่า "ปกติ" → กลับ /admin.html ต้องแสดงผลเป็นแถบถาวร ไม่ใช่ toast
test('สั่งอัปเดตแล้วต้องเฝ้าจนจบ: watchUpdateProgress ทุกจุด, 401→login พร้อมเหตุผล, กลับมาเห็นแถบผล', () => {
  const common = sources.find(item => item.name === 'common.js').text;
  const admin = sources.find(item => item.name === 'admin.html').text;
  const login = sources.find(item => item.name === 'login.html').text;
  const applies = [...common.matchAll(/api\('POST',\s*'\/api\/update\/apply'/g)].length + [...admin.matchAll(/api\('POST',\s*'\/api\/update\/apply'/g)].length;
  assert.equal(applies, 2, 'จุดสั่ง apply ต้องมี 2 จุด (banner + การ์ด) — เพิ่มจุดใหม่ต้องต่อ watchUpdateProgress ด้วย');
  assert.match(common, /await api\('POST', '\/api\/update\/apply', \{\}\);\s*\n\s*watchUpdateProgress\(banner,/, 'banner: หลัง apply ต้องเรียก watchUpdateProgress');
  assert.match(admin, /await api\('POST', '\/api\/update\/apply', \{\}\);\s*\n\s*watchUpdateProgress\(/, 'การ์ดอัปเดต: หลัง apply ต้องเรียก watchUpdateProgress');
  const watcher = common.match(/function watchUpdateProgress\([\s\S]*?\n\}\n/);
  assert(watcher, 'common.js ต้องมี watchUpdateProgress');
  assert.match(watcher[0], /fetch\('\/api\/update\/status'/, 'ตัวเฝ้าต้อง poll ด้วย fetch ตรง ไม่ใช่ api()');
  assert.doesNotMatch(watcher[0], /api\('GET'/, 'ตัวเฝ้าห้ามใช้ api() (401 จะเด้ง login ก่อนจำธง)');
  assert.match(watcher[0], /status === 401[\s\S]*clinic_after_login'[\s\S]*clinic_after_login_reason', 'update'[\s\S]*location\.href = '\/login\.html'/, '401 ต้องจำธงแล้วพาไป login');
  assert.match(watcher[0], /localStorage\.setItem\('clinic_update_started'/, 'ต้องจำว่าเริ่มอัปเดตรุ่นไหนเมื่อไหร่ เพื่อบอกผลตอนกลับมา');
  assert.match(watcher[0], /state === 'error'/, 'ล้มก่อนปิด server ต้องบอกผลบนหน้าเดิม');
  assert.match(watcher[0], /UPDATE_WATCH_TIMEOUT_MS/, 'ต้องมีเพดานเวลารอ แล้วบอกวิธีกู้ (ไอคอนเปิดระบบ)');
  assert.match(login, /clinic_after_login_reason'\) === 'update'/, 'login.html ต้องแยกข้อความกรณีกลับจากอัปเดต');
  assert.match(admin, /function afterUpdateReturn\(/, 'admin.html ต้องมี afterUpdateReturn');
  assert.match(admin, /renderUpdateResultBanner\('ok'/, 'สำเร็จต้องเป็นแถบเขียวถาวร');
  assert.match(admin, /rolled-back/, 'ย้อนกลับต้องบอกว่ากลับรุ่นเดิมแล้ว');
  assert.match(admin, /st\.state === 'applying'\) setTimeout\(loadUpdateStatus/, 'server ใหม่ขึ้นแต่ journal ยังไม่ปิด ต้อง poll ต่อเอง');
  assert.match(css, /\.banner\.green\s*\{/, 'app.css ต้องมี .banner.green');
  assert.match(css, /:root\[data-theme="dark"\] \.banner\.green/, 'ธีมมืดต้องบังคับตัวอักษรเข้มบนแถบเขียว');
});

// incident หน้างาน 2026-08-24: fetch พลาดครั้งเดียว → แถบ "ติดต่อเครื่องหลักไม่ได้" ค้างถาวร + อ้างว่า "กำลังอัปเดต"
// ทั้งที่ไม่มีอัปเดต → หมอรอตามข้อความแล้วไม่หาย เลยต้องปิดเปิดโปรแกรมทุกครั้ง (ผิด AGENTS §UI ข้อ 7)
test('แถบ offline ต้องลองใหม่เอง หายเองเมื่อติดต่อได้ และห้ามอ้างอัปเดตถ้าไม่ได้อัปเดตจริง', () => {
  const common = sources.find(item => item.name === 'common.js').text;
  // api() สำเร็จ (ได้ response ไม่ว่า status ใด) ต้องล้างแถบทันที — และต้องล้างก่อนเช็ค 401/423
  const apiFn = common.match(/async function api\([\s\S]*?\n\}\n/);
  assert(apiFn, 'ต้องมี api()');
  const clearAt = apiFn[0].indexOf('clearOfflineBanner()');
  assert.notEqual(clearAt, -1, 'api() ต้องเรียก clearOfflineBanner() เมื่อ fetch สำเร็จ');
  assert(clearAt < apiFn[0].indexOf('status === 401'), 'ต้องล้างแถบก่อนเช็ค status (ทุก response = เครื่องหลักตอบแล้ว)');
  // ข้อความ: โหมดปกติห้ามพูดเรื่องอัปเดต — พูดได้เฉพาะเมื่อมีธง clinic_update_started (ผู้ใช้เพิ่งกดอัปเดตจริง)
  const textFn = common.match(/function offlineBannerText\([\s\S]*?\n\}\n/);
  assert(textFn, 'ต้องมี offlineBannerText()');
  assert.match(textFn[0], /clinic_update_started/, 'จะบอกว่ากำลังอัปเดตได้เฉพาะเมื่อมีธงอัปเดตจริง');
  assert.match(textFn[0], /ลองใหม่ให้เอง/, 'โหมดปกติต้องบอกว่าระบบลองใหม่ให้เอง ไม่ใช่ให้ผู้ใช้รอเฉยๆ');
  // แถบต้อง retry เองด้วย fetch ตรง (api() จะวนเรียกตัวเอง) และมี clearOfflineBanner หยุด timer
  const bannerFn = common.match(/function showUpdateOfflineBanner\([\s\S]*?\n\}\n/);
  assert(bannerFn, 'ต้องมี showUpdateOfflineBanner()');
  assert.match(bannerFn[0], /setInterval/, 'แถบต้องตั้ง retry เอง');
  assert.match(bannerFn[0], /fetch\('\/api\/update\/status'/, 'retry ต้องใช้ fetch ตรง ไม่ใช่ api()');
  assert.doesNotMatch(bannerFn[0], /api\('GET'/, 'retry ห้ามใช้ api()');
  const clearFn = common.match(/function clearOfflineBanner\([\s\S]*?\n\}\n/);
  assert(clearFn, 'ต้องมี clearOfflineBanner()');
  assert.match(clearFn[0], /clearInterval/, 'ล้างแถบต้องหยุด retry timer ด้วย');
  assert.match(clearFn[0], /updateOfflineBanner/, 'ล้างแถบต้องลบ element จริง');
  // blind test 2026-08-24: supervisor ฟื้น server เร็วจนแถบไม่ทันโผล่ → ผู้ใช้โดนดีดไป login เงียบๆ
  // → 401 ทั้งที่หน้านี้เคย login แล้ว (ME มีค่า) ต้องจำธงและหน้า login ต้องอธิบาย (§UI ข้อ 7: ห้ามเด้งโดยไม่บอกเหตุผล)
  const api401 = apiFn[0].match(/status === 401[\s\S]*?\n  \}/);
  assert(api401, 'api() ต้องมี branch 401');
  assert.match(api401[0], /if \(ME\) localStorage\.setItem\('clinic_relogin_notice'/, '401 กลางงานต้องจำธง clinic_relogin_notice');
  const login = sources.find(item => item.name === 'login.html').text;
  assert.match(login, /clinic_relogin_notice/, 'login.html ต้องรู้จักธง relogin');
  assert.match(login, /หากเพิ่งเปลี่ยนรหัสผ่าน ให้ใช้รหัสใหม่ ข้อมูลที่บันทึกแล้วไม่หาย/, '401 ต้องอธิบายการเปลี่ยนสิทธิ์หรือหมดอายุโดยไม่เดาว่าเครื่องรีสตาร์ท');
});

// exactly-once (codex NO-GO 2026-08-24): connection ขาดหลัง commit แล้วผู้ใช้กดซ้ำ ห้ามได้ HN เบิ้ล
// → ลงทะเบียนต้องเป็นคำขอเดียว (queue ใน txn เดียวกัน) + แนบ op_id ที่ผูกกับการเปิดฟอร์ม
test('ลงทะเบียนเป็นคำขอเดียวแบบ exactly-once (op_id) — ห้ามแยกยิง /api/visits เป็นคำขอที่สอง', () => {
  const index = sources.find(item => item.name === 'index.html').text;
  const both = index.match(/async function registerAndQueue[\s\S]*?async function registerOnly[\s\S]*?\n\}\n/);
  assert(both, 'ต้องมี registerAndQueue และ registerOnly');
  assert.match(both[0], /op_id: regOpId, queue: true/, 'บันทึก+เข้าคิว ต้องส่ง op_id และ queue:true ในคำขอเดียว');
  assert.doesNotMatch(both[0], /\/api\/visits/, 'ห้ามยิง /api/visits แยก — server ตายกลางทางจะได้คนไข้ไม่มีคิว');
  assert.equal((both[0].match(/op_id: regOpId/g) || []).length, 2, 'ทั้งสองปุ่มต้องแนบ op_id');
  // codex NO-GO รอบ 2: op_id ต้องคงเดิมข้ามปิด-เปิดฟอร์มจนกว่าจะสำเร็จ/ถูกกู้ — ห้าม regenerate ทุกครั้งที่เปิด
  assert.match(index, /if \(!regOpId\) regOpId = crypto\.randomUUID\(\)/, 'op_id สร้างใหม่เฉพาะเมื่อไม่มีของค้าง');
  // และ 409 (แก้ช่อง/สลับปุ่มหลังบันทึกสำเร็จแบบคำตอบหาย) ต้องพาไปที่คนไข้เดิม ไม่ใช่บอกให้เปิดฟอร์มใหม่
  const recover = index.match(/function recoverAlreadyRegistered\([\s\S]*?\n\}\n/);
  assert(recover, 'ต้องมี recoverAlreadyRegistered');
  assert.match(recover[0], /already_registered/, 'ต้องอ่านผลเดิมจาก server');
  assert.match(recover[0], /showPatient\(prev\.hn\)/, 'ต้องเปิดหน้าคนไข้ที่บันทึกแล้วให้เลย');
  assert.match(recover[0], /regOpId = null/, 'กู้แล้วต้องล้าง op_id (รอบใหม่ = op ใหม่)');
  assert.equal((both[0].match(/recoverAlreadyRegistered\(e\)/g) || []).length, 2, 'catch ของทั้งสองปุ่มต้องเรียกตัวกู้');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(server, /const previous = clientOps\.lookup\(kind, opId\)/, 'exactlyOnce ต้องคืนผลเดิมเมื่อ op_id ซ้ำ');
  assert.match(server, /clientOps\.record\(kind, opId, payloadHash, out\)/, 'ผลกับ op ต้องบันทึกใน txn เดียวกัน');
  assert.match(server, /exactlyOnce\(ctx, 'register'/, 'ลงทะเบียนต้องวิ่งผ่าน exactlyOnce');
  assert.match(server, /conflictField: 'already_registered'/, '409 ต้องแนบผลเดิมให้ UI กู้ได้');
  assert.doesNotMatch(server, /ปิดฟอร์มลงทะเบียนแล้วเปิดใหม่/, 'ห้ามมีคำแนะนำที่พาไปสร้าง HN ซ้ำ');
});

// failure-injection 2026-08-25 (1.0.4): แก้เป็นคลาส — flow เขียนข้อมูลที่ผู้ใช้กดซ้ำได้หลัง connection ขาด
// ต้องวิ่งผ่าน exactlyOnce ทั้งหมด และ UI ต้องแนบ op_id + กู้ 409 พาไปดูของที่เกิดไปแล้ว
test('exactly-once ครอบเก็บเงิน/ใบรับรอง/รับยาเข้า (server + UI แนบ op_id + กู้ 409)', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  for (const kind of ['register', 'pay', 'medcert', 'stock_receive'])
    assert.match(server, new RegExp(`exactlyOnce\\(ctx, '${kind}'`), `server: flow ${kind} ต้องวิ่งผ่าน exactlyOnce`);
  for (const field of ['already_paid', 'already_issued', 'already_received'])
    assert.match(server, new RegExp(`conflictField: '${field}'`), `server: ต้องมี recovery payload ${field}`);
  const index = sources.find(item => item.name === 'index.html').text;
  assert.match(index, /op_id: payOpId/, 'ปุ่มเก็บเงินต้องแนบ op_id');
  assert.match(index, /payOpId = crypto\.randomUUID\(\)/, 'เลือกบิลใหม่ = ความพยายามเก็บเงินใหม่ (op ใหม่)');
  const exam = sources.find(item => item.name === 'exam.html').text;
  assert.match(exam, /body\.op_id = certOpId/, 'ฟอร์มใบรับรองต้องแนบ op_id');
  assert.match(exam, /e\.data\.already_issued/, 'exam ต้องกู้ 409 already_issued (พาไปดูใบที่ออกแล้ว)');
  assert.match(exam, /if \(certOpVisit !== cur\.id\) certOpId = null/, 'เปลี่ยน visit ต้องล้าง op เก่า (กัน op จับคู่คนไข้อื่น)');
  const stockPage = sources.find(item => item.name === 'stock.html').text;
  assert.match(stockPage, /op_id: opId/, 'กล่องรับยาเข้าต้องแนบ op_id');
  assert.match(stockPage, /e\.data\.already_received/, 'stock ต้องกู้ 409 already_received');
  const billing = fs.readFileSync(path.join(__dirname, 'lib', 'billing.js'), 'utf8');
  assert.match(billing, /เก็บเงินของคิวนี้ไปแล้ว/, 'จ่ายซ้ำแบบไม่มี op ต้องได้ภาษาคน ไม่ใช่ UNIQUE constraint ดิบ');
});

// ปุ่ม "🆘 แจ้งปัญหา" — ผู้ใช้ต้องส่งหลักฐานให้ผู้ดูแลได้ด้วยการกดปุ่มเดียว ไม่ต้องรู้จักโฟลเดอร์ log
test('ปุ่มแจ้งปัญหาอยู่บน topbar ทุก role และหน้า login', () => {
  const common = sources.find(item => item.name === 'common.js').text;
  const login = sources.find(item => item.name === 'login.html').text;
  assert.match(common, /id="supportReportBtn" href="\/api\/support-report" download/, 'topbar ต้องมีลิงก์ดาวน์โหลดรายงาน');
  assert.match(common, /ไม่มีข้อมูลคนไข้/, 'ต้องบอกผู้ใช้ว่ารายงานไม่มีข้อมูลคนไข้ (ให้กล้ากดส่ง)');
  assert.match(login, /\/api\/support-report/, 'หน้า login ต้องมีทางดาวน์โหลดรายงาน (กรณีเข้าระบบไม่ได้)');
});

// v13 (หมอขอ 2026-08-31 สองรอบ): ยาหมดอายุแบบรายลอต — กรอกทุก lot ตอนรับเข้า ระบบดึงตัวใกล้สุดมาเตือนเอง
// เกณฑ์เตือนหมอปรับเองจากหน้า stock (เจ้าของ: ห้าม fix ค่า ขึ้นกับ supplier แต่ละคลินิก — แยกรายยาได้)
test('หน้า stock: ระบบ lot ยา + เกณฑ์เตือนปรับเองได้ + แถวเตือนชี้สิ่งที่เห็นบนจอ', () => {
  const stockPage = sources.find(item => item.name === 'stock.html').text;
  assert.match(stockPage, /body\.expiry_date = v\.mExpiry/, 'กล่องรับเข้าต้องส่งวันหมดอายุ lot ไปกับ receive (txn เดียวกับยอด)');
  assert.match(stockPage, /body\.lot_label = v\.mLot/, 'กล่องรับเข้าต้องมีช่องเลข lot (ช่วยหาถูกกล่องตอนเก็บออก)');
  assert.doesNotMatch(stockPage, /id="d_expiry"/, 'ฟอร์มแก้ยาห้ามมีช่องวันหมดอายุ — วันหมดอายุเป็นราย lot เท่านั้น (โมเดลที่หมอเคาะ)');
  assert.match(stockPage, /function openLots\(/, 'ต้องมีกล่องจัดการ lot ต่อยา (เปิดจากคอลัมน์หมดอายุ)');
  assert.match(stockPage, /เก็บออกแล้ว/, 'lot ต้องปิดได้จากจอ — ตัวถัดไปเลื่อนขึ้นมาเตือนแทนเอง');
  assert.match(stockPage, /\/api\/lots\/\$\{lotId\}\/clear/, 'ปิด lot ผ่าน endpoint clear เท่านั้น');
  assert.match(stockPage, /id="warnDays"/, 'ต้องมีช่องปรับเกณฑ์ค่ากลางบนหน้า stock (ของอยู่ในมือหมอ ไม่ต้องมุดหน้าตั้งค่า)');
  assert.match(stockPage, /\/api\/stock\/expiry-warning/, 'ปรับเกณฑ์ค่ากลางต้องบันทึกเป็น setting กลาง');
  assert.match(stockPage, /id="d_warn"/, 'ต้องมีช่องเกณฑ์เตือนรายยา (supplier แต่ละยาต่างกัน — หมอขอ 2026-08-31)');
  assert.match(stockPage, /body\.expiry_warn_days = Number\(v\.mWarn\)/, 'กล่องรับเข้าต้องตั้งเกณฑ์รายยาได้');
  assert.match(stockPage, /function warnLimit\(d\) \{ return d\.expiry_warn_days != null \? d\.expiry_warn_days : warnDays; \}/,
    'เกณฑ์รายยาต้อง fallback ไปค่ากลางเมื่อไม่ได้ตั้ง');
  assert.match(stockPage, /หมดอายุแล้ว/, 'แถวยาที่หมดอายุต้องบอกตรงๆ บนจอ');
  assert.match(stockPage, /expirySummary/, 'ต้องมีสรุปจำนวนรายการเตือนเหนือตาราง');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(server, /stock\.addLot\(id, \{ expiry_date: ctx\.body\.expiry_date/, 'receive ต้องสร้าง lot ใน work() ของ exactlyOnce (txn เดียว)');
  assert.doesNotMatch(server, /route\('DELETE', '\/api\/lots/, 'ห้ามมี endpoint ลบ lot — ปิดด้วย cleared_at เท่านั้น (ประวัติต้องย้อนได้)');
  const stockLib = fs.readFileSync(path.join(__dirname, 'lib', 'stock.js'), 'utf8');
  assert.match(stockLib, /SELECT MIN\(l\.expiry_date\) FROM drug_lots l WHERE l\.drug_id = d\.id AND l\.cleared_at IS NULL/,
    'ตัวเตือน = lot ใกล้หมดสุดที่ยังไม่ปิด derive สดจาก drug_lots — ไม่มี cache ให้เพี้ยน');
  assert.doesNotMatch(stockLib, /DELETE FROM drug_lots/, 'stock.js ห้ามลบ lot');
});

// หมอ feedback 2026-08-31 "ใบรับรองแพทย์ตัวอักษรเล็ก" → ฐานใหม่ตามเกณฑ์เอกสารราชการ + หมอปรับเองได้จากหน้าตั้งค่า
// ปรับเป็นคลาส: ตัวคูณเดียวครอบใบรับรองทุกแบบ ไม่ใช่แก้ทีละ template
test('ขนาดตัวอักษรใบรับรอง: หมอเลือกเองในหน้าตั้งค่า + ดูตัวอย่างก่อนบันทึกได้', () => {
  const admin = sources.find(item => item.name === 'admin.html').text;
  assert.match(admin, /id="s_medcert_font_scale"/, 'หน้าตั้งค่าต้องมี dropdown ขนาดตัวอักษรใบรับรอง');
  assert.match(admin, /id="previewMedcert"/, 'ต้องมีปุ่มดูตัวอย่างใบรับรอง (ลองก่อนบันทึก)');
  assert.match(admin, /print\/sample\/medcert\?paper=\$\{[^}]*s_medcert_paper_size[^}]*\}&scale=\$\{[^}]*s_medcert_font_scale/,
    'ลิงก์ตัวอย่างต้องตามทั้งกระดาษและขนาดที่เลือกในช่อง (ยังไม่ต้องกดบันทึก)');
  assert.match(admin, /id="s_receipt_font_scale"/, 'ต้องมี dropdown ขนาดตัวอักษรใบเสร็จ (หมอ feedback 2026-08-31)');
  assert.match(admin, /id="s_appt_font_scale"/, 'ต้องมี dropdown ขนาดตัวอักษรใบนัด (ครบทุกเอกสาร — ไม่เหมารวม)');
  assert.equal((admin.match(/class="docbox"/g) || []).length, 3,
    'การ์ดกระดาษต้องแยก 3 กล่องต่อเอกสาร (เจ้าของ 2026-08-31: "ตัวหนังสือกองรวมกัน")');
  assert.match(admin, /print\/sample\/receipt\?paper=\$\{[^}]*s_receipt_paper[^}]*\}&scale=\$\{[^}]*s_receipt_font_scale/,
    'ลิงก์ตัวอย่างใบเสร็จต้องตามทั้งกระดาษและขนาดที่เลือก');
  assert.match(admin, /print\/sample\/appointment\?paper=\$\{[^}]*s_appointment_paper[^}]*\}&scale=\$\{[^}]*s_appt_font_scale/,
    'ลิงก์ตัวอย่างใบนัดต้องตามทั้งกระดาษและขนาดที่เลือก');
  const printLib = fs.readFileSync(path.join(__dirname, 'lib', 'print.js'), 'utf8');
  assert.match(printLib, /MEDCERT_FONT = \{/, 'print.js ต้องมีฐานขนาดใหม่ + เพดานหน้าเดียวต่อ template');
  assert.match(printLib, /RECEIPT_FONT_MAX = \{ 'A4-half': 1\.12/, 'ใบเสร็จครึ่งบนต้องถูก cap (รอยประ = เส้นตาย — วัดจริง 2026-08-31)');
  assert.match(printLib, /fontScale > 1\.001 \? 4 : 7/, 'ขยายตัวอักษรครึ่งบนต้องสลับ dense เร็วขึ้น ไม่งั้นบิล 5-7 รายการทะลุรอยประ');
  assert.match(printLib, /medcert_font_scale/, 'print.js ต้องอ่านตัวคูณที่หมอตั้งไว้');
  for (const tpl of ['medcert-general-a4', 'medcert-general-a5', 'tmc-certificate-a4', 'legacy', 'health'])
    assert.match(printLib, new RegExp(`'${tpl}'|${tpl}:`), `ฐานขนาดต้องครอบ template ${tpl} (แก้เป็นคลาส ไม่ใช่เป็นจุด)`);
  assert.match(printLib, /Math\.min\(c\.base \* userScale, c\.max\)/, 'ตัวคูณต้องถูก clamp ที่เพดานหน้าเดียว (เอกสารกฎหมายห้ามแตกเป็น 2 หน้า)');
});

test('เกี่ยวกับโปรแกรมทุกบทบาท โดยไม่ขยายสิทธิ์ผู้ดูแล และ QR อยู่ในการ์ดเดียว', () => {
  const admin = sources.find(s => s.name === 'admin.html').text;
  assert.match(admin, /id="aboutCard"/);
  assert.match(admin, /class="admin-shell hidden" id="adminControls"/);
  assert.match(admin, /if \(me.role !== 'admin'\) \{[^}]*return;/);
  assert(admin.indexOf("if (me.role !== 'admin')") < admin.lastIndexOf('  setupAdminNavigation();'));
  assert.match(admin, /height:auto;object-fit:contain/);
  assert.deepEqual(sources.filter(s => s.text.includes('/donate-qr.png')).map(s => s.name), ['admin.html']);
  const root = path.resolve(__dirname, '..');
  assert(fs.readFileSync(path.join(root, 'LICENSE')).equals(fs.readFileSync(path.join(__dirname, 'LICENSE'))));
  const qrDoc = path.join(root, fs.existsSync(path.join(root, 'public-release')) ? 'public-release/docs/donate-qr.png' : 'docs/donate-qr.png');
  assert(fs.readFileSync(qrDoc).equals(fs.readFileSync(path.join(publicDir, 'donate-qr.png'))));
});

test('ตัวช่วย LAN คืน UTF-8 หลัง subprocess และยังแจ้งผลด้วยกล่อง Windows', () => {
  const builder = fs.readFileSync(path.join(__dirname, 'tools/build-installer.js'), 'utf8');
  assert.match(builder, /chcp\.com.*65001/);
  assert.match(builder, /\[Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding/);
  assert.match(builder, /\$script:OutputEncoding = \[Console\]::OutputEncoding/);
  assert.equal((builder.match(/\.\.\.consoleUtf8Ps1\(\)/g) || []).length, 2, 'setup/remove ต้องใช้ boundary เดียวกัน');
  assert.match(builder, /-Verb RunAs -WindowStyle Hidden -ArgumentList \$argumentLine -Wait -PassThru/);
  assert.match(builder, /'    Reset-ClinicConsole',[\s\S]*?\$process\.ExitCode/);
  assert.match(builder, /\$certExit = \$LASTEXITCODE[\s\S]*?Reset-ClinicConsole[\s\S]*?if \(\$certExit -ne 0/, 'reset ห้ามกลบ exit code ของ cert helper');
  assert.match(builder, /Show-ClinicBox \$done 'info'/, 'ผลสำเร็จต้องเป็น MessageBox ไม่ใช่ console อย่างเดียว');
  assert.match(builder, /Show-ClinicBox \(\@\(/, 'error ต้องเป็น MessageBox');
});

test('appointment follow-up keeps durable result/history, retry identity and patient text escaping', () => {
  const script = sources.find(s => s.name === 'appointments.js').text;
  const page = sources.find(s => s.name === 'calendar.html').text;
  assert.match(page, /id="appointmentResult"[^>]*role="status"/);
  assert.match(script, /expected_event_id:dialogAppointment.last_event_id/);
  assert.match(script, /savePendingMarker\(\{id,op_id\}\)/);
  assert.match(script, /clinic_appt_pending_.*ME.user_id/);
  assert.match(script, /already_saved/);
  assert.match(script, /id="appointmentRetryBtn"/);
  assert.match(script, /esc\(a.phone\)/);
  assert.match(script, /esc\(e.note\)/);
  assert.doesNotMatch(script, /localStorage\.setItem/);
});

test('monthly drug report keeps unknown costs, current-stock context and read-only retry', () => {
  const script = sources.find(s => s.name === 'drug-report.js').text;
  assert.match(script, /n == null \? 'ต้องตรวจ'/);
  assert.match(script, /request !== sequence/);
  assert.match(script, /table.innerHTML = ''/);
  assert.match(script, /role="status"/);
  assert.match(script, /overflow-x:auto/);
  assert.match(script, /esc\(r.name\)/);
  assert.match(script, /ไม่ใช่ยอดสิ้นเดือน/);
  assert.doesNotMatch(script, /api\('(POST|PATCH|DELETE)'/);
  const page = sources.find(s => s.name === 'reports.html').text;
  assert.match(page, /missingDrugCosts \? 'ข้อมูลทุนไม่ครบ'/);
  assert.match(page, /lg.total.unknown_cost_lines \? 'ยังคำนวณไม่ได้'/);
  assert.match(page, /d.no_cost_lines \? 'ยังคำนวณไม่ได้'/);
  assert.match(page, /ส่วนต่างก่อนส่วนลดบิล/);
});

test('ใบยาอ่านง่ายปิดก่อน ไม่ย่อ ไม่เปิด popup หลัง await และมี error ค้าง', () => {
  const admin = sources.find(s=>s.name==='admin.html').text;
  const sheet = fs.readFileSync(path.join(__dirname,'lib/medication-sheet.js'),'utf8');
  assert.match(admin,/id="s_medication_sheet_enabled"><option value="0"/);
  for(const id of ['s_medication_sheet_paper','s_medication_sheet_font','previewMedication'])assert(admin.includes('id="'+id+'"'));
  assert.match(sheet,/const FONTS = \['18', '20', '24'\]/);
  assert(!sheet.includes('window.open(')); assert(!sheet.includes('transform:scale'));
  assert.match(sheet,/id="printError" role="alert"/); assert.match(sheet,/cache:'no-store'/);
  const pagination=sources.find(s=>s.name==='medication-print.js').text;
  assert.match(pagination,/Intl.Segmenter\('th',\{granularity:'grapheme'\}\)/);
  assert.match(pagination,/identity.cloneNode\(true\)/);
  assert.match(pagination,/วิธีใช้ยังมีต่อหน้าถัดไป/);
  assert.match(pagination,/page-counter/);
});
test('visual dose proof and whole-card fallback remain read-only and printable', () => {
  const visual=fs.readFileSync(path.join(__dirname,'lib/medication-visual.js'),'utf8');
  const sheet=fs.readFileSync(path.join(__dirname,'lib/medication-sheet.js'),'utf8');
  const pagination=sources.find(s=>s.name==='medication-print.js').text;
  assert.match(visual,/doseText\(dose, line.unit\) === line.instructions/);
  assert.match(visual,/o.ref_id===r.ref_id/);assert.match(visual,/o.qty===r.qty/);
  assert.match(sheet,/WHERE id = \? AND visit_id = \?/);
  assert.match(sheet,/name="style"/);assert.match(visual,/อ่านตามข้อความ/);
  assert.match(pagination,/visualTooTall=true;literalFallback\(\)/);
  assert.match(pagination,/window.medicationPaginationReady=false/);
  assert(!visual.includes('fetch('));assert(!sheet.includes('UPDATE '));
});
test('admin landing, direct role guard, scoped saves and unsaved navigation remain together', () => {
  const login = sources.find(s=>s.name==='login.html').text;
  const common = sources.find(s=>s.name==='common.js').text;
  const admin = sources.find(s=>s.name==='admin.html').text;
  const nav = sources.find(s=>s.name==='admin-navigation.js').text;
  assert.match(login, /r.role === 'admin' \? '\/admin.html'/);
  assert.match(common, /ME.role === 'admin' && pageKey !== 'admin'/);
  assert(common.indexOf("location.replace('/admin.html')") < common.indexOf('const nav = ['));
  for(const file of ['index.html','exam.html','calendar.html','stock.html','reports.html'])
    assert.match(sources.find(s=>s.name===file).text, /<html lang="th" class="role-routing">/);
  assert.match(css,/html\.role-routing body\s*\{\s*visibility: hidden/);
  assert.match(admin,/const body = adminSettingsPayload\(adminSection\)/);
  assert.match(nav,/closest\('\[data-admin-section\]'\)/);
  assert.match(nav,/beforeunload/); assert.match(nav,/adminSaving \|\| adminIsDirty\(\)/);
  assert.match(admin,/id="adminSaveError" role="alert"/);
  assert.match(admin,/Object.entries\(body\).every/);
  assert.match(css, /#toast\s*\{[^}]*pointer-events:\s*none/);
});
test('document visibility uses exclusive labelled buttons and keeps saved setting keys', () => {
  const admin=sources.find(s=>s.name==='admin.html').text;
  const nav=sources.find(s=>s.name==='admin-navigation.js').text;
  for(const key of ['receipt_show_doctor','appt_slip_show_doctor','appt_slip_show_note']) {
    assert(admin.includes(`id="s_${key}" hidden aria-hidden="true"`));
    assert(admin.includes(`data-setting="s_${key}"`));
  }
  assert.match(admin,/role="group" aria-labelledby=/);
  assert.match(admin,/\.document-choice.*data-value="0".*background: #b42318/);
  assert.match(admin,/\.document-choice.*data-value="1".*background: #245eea/);
  assert.match(nav,/field.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  assert.match(admin,/syncDocumentVisibility\(\);/);
});
test('multi-doctor UI hides choices for one doctor and retains replacement/retry outcomes', () => {
  const common=sources.find(s=>s.name==='common.js').text;
  const exam=sources.find(s=>s.name==='exam.html').text;
  const front=sources.find(s=>s.name==='index.html').text;
  assert.match(common,/if \(!multipleDoctors\(\)\) return ''/);
  assert.match(exam,/v.doctor_id===ME.user_id \?[^\n]*เปิดต่อ/);
  assert.match(exam,/previousAppointment=cur.appointment/);
  assert.match(exam,/previousAppointment\?\.hn===cur.hn/);
  assert.match(front,/ccEl\?\.dataset.hn===body.hn && ccEl.value===body.cc/);
  assert.match(exam,/replace_revision:e.data.replace_appointment.revision/);
  assert.match(exam,/examAppointmentNotice\('ยังไม่ได้เปลี่ยนนัด/);
  assert.match(front,/id='enqueueResult'/);
  assert.match(front,/pendingEnqueue.*op_id:crypto.randomUUID/);
  assert.match(front,/pendingEnqueue.hn!==hn/);
  assert.match(exam,/pendingExamAppointment.visitId!==cur.id/);
  assert.match(exam,/pendingExamAppointment.visitId!==cur\?\.id/);
  assert.match(sources.find(s=>s.name==='appointments.js').text,/pendingAppointment.id!==id/);
});
test('drug labels block overflow and doctor printing, revalidate before print',()=>{
  const src=sources.find(s=>s.name==='drug-label-print.js').text;
  const renderer=fs.readFileSync(path.join(__dirname,'lib','drug-labels.js'),'utf8');
  assert.match(src,/content.scrollHeight>content.clientHeight/);
  assert.match(src,/labelReady=!errors.length&&document.body.dataset.canPrint==='1'/);
  assert.match(src,/fetch\(location.href,\{cache:'no-store',redirect:'error'/);
  assert.match(renderer,/body.labels-blocked #labelPages\{display:none!important\}/);
  assert(!/text-overflow|line-clamp|overflow:hidden/.test(renderer));
});
test('queue call notice stays nonmodal, locally acknowledged, and safely grouped',()=>{
  const front=sources.find(s=>s.name==='index.html').text,exam=sources.find(s=>s.name==='exam.html').text;
  const notice=fs.readFileSync(path.join(__dirname,'public/queue-notices.js'),'utf8');
  const css=fs.readFileSync(path.join(__dirname,'public/queue-notices.css'),'utf8');
  assert.match(front,/sequence !== refreshSequence/);assert.match(front,/callNotices\?\.update\(queue\)/);
  assert(!notice.includes('.focus('));assert(!notice.includes('openModal('));assert(!notice.includes('setTimeout('));
  assert.match(css,/height:108px/);assert.match(css,/z-index:70/);assert.match(exam,/if\(multipleDoctors\(\)\)/);
  assert.match(front,/payHtml!==_lastPayQueueHTML/);
  assert.match(exam,/current.doctor_id!==ME.user_id/);assert.match(exam,/callResult\('ยังยืนยันผลเรียกคิวไม่ได้/);
});
test('trial transition keeps sessions separate and destructive confirmation guarded',()=>{
  const server=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
  const script=fs.readFileSync(path.join(__dirname,'scripts/trial-to-production.ps1'),'utf8');
  const builder=fs.readFileSync(path.join(__dirname,'tools/build-installer.js'),'utf8');
  assert.match(server,/'csid_trial' : 'csid_live'/);assert.match(server,/parseCookies\(req\)\[SESSION_COOKIE\]/);
  assert.match(script,/'YesNo','Warning','Button2'/);assert.match(script,/installed\.marker/);assert.match(script,/NoLinks \$state.cleanup/);
  assert(script.includes("$profile.variant -ne 'trial'"));assert(script.includes('TRANSITION_TEST_ROOT'));
  assert.match(builder,/if errorlevel 1 exit \/b 1/);assert(builder.includes('ส่งไปเครื่องหมอ (ทดลอง)'));
});
test('account changes and runtime maintenance retain visible outcomes',()=>{
 const admin=sources.find(s=>s.name==='admin.html').text,login=sources.find(s=>s.name==='login.html').text;
 assert.match(admin,/id="accountChangeHelp"/);assert.match(admin,/credentialResult/);assert.match(login,/account_changed/);
 assert.match(admin,/id="runtimeSummary"/);assert(admin.includes('onclick="loadRuntimeStatus()"'));assert.match(admin,/ตรวจกล่องบนเครื่องหน้าร้านและสถานะก่อนกดซ้ำ/);
});
test('service costs retain unknown state and persistent retry/outcome UI',()=>{
 const stock=sources.find(s=>s.name==='stock.html').text,reports=sources.find(s=>s.name==='reports.html').text;
 assert.match(stock,/id="svcCost"/);assert.match(stock,/id="serviceSaveStatus" role="status"/);
 assert.match(stock,/sessionStorage\.setItem\('clinic_service_save'/);assert.match(stock,/op_id: crypto\.randomUUID\(\)/);
 assert.match(stock,/id="retryServiceSave"/);assert.match(stock,/pendingServiceSave/);assert.doesNotMatch(stock,/กำไรจะนับทุน 0/);
 assert.match(reports,/m\.service_cost/);assert.match(reports,/m\.direct_cost/);assert.match(reports,/เหลือหลังต้นทุนตรง/);
 assert.doesNotMatch(reports,/กำไรขั้นต้น/);
});
test('solo doctor remains opt-in with durable finish and checkout outcomes',()=>{
 const admin=sources.find(s=>s.name==='admin.html').text,exam=sources.find(s=>s.name==='exam.html').text,front=sources.find(s=>s.name==='index.html').text;
 assert.match(admin,/data-front-user/);assert.match(admin,/id="frontPermissionResult" role="status"/);assert.match(admin,/retryFrontPermission/);
 assert.match(exam,/restoreFinish\(\)/);assert.match(exam,/sessionStorage\.setItem\(finishStorageKey\(\)/);assert.match(exam,/op_id:crypto\.randomUUID\(\)/);
 assert.match(exam,/host\.id='finishResult'/);assert.match(exam,/b\.id='retryFinish'/);assert.match(exam,/a\.id='finishNext'/);assert.match(exam,/ME\.can_front_desk/);
 assert.match(front,/box\.id='checkoutResult'/);assert.match(front,/me\.can_front_desk/);assert.match(front,/await selectBill\(checkoutId\)/);
});
test('drug defaults use numeric templates and retain visible recovery and legacy review',()=>{
 const stock=sources.find(s=>s.name==='stock.html').text,exam=sources.find(s=>s.name==='exam.html').text;
 assert.match(stock,/id="drugDoseEditor"/);assert.match(stock,/id="drugSaveStatus" role="status"/);
 assert.match(stock,/sessionStorage\.setItem\('clinic_drug_save'/);assert.match(stock,/id="retryDrugSave"/);
 assert.match(stock,/default_dose: template/);assert.match(exam,/DoseTemplate\.read\(it\)/);
 assert.doesNotMatch(exam,/parseDoseFromText|PRN_TEXT_RE/);assert.match(exam,/class="dose-missing"/);
 assert.match(exam,/dose-text-review/);assert.match(exam,/useCalculatedInstructions/);
});
function backupUiContext(role = 'admin') {
  const banner = { innerHTML: '' };
  const context = vm.createContext({
    document: { documentElement: { setAttribute() {} }, addEventListener() {}, getElementById: () => banner },
    localStorage: { getItem: () => null },
  });
  vm.runInContext(sources.find(s => s.name === 'common.js').text, context);
  vm.runInContext(`ME = { role: ${JSON.stringify(role)} }`, context);
  return { context, banner };
}
test('ข้อความสำรองไม่อ้างว่า copy เข้า sync folder คืออยู่บนคลาวด์หรือกู้ได้แล้ว', () => {
  const common = sources.find(s => s.name === 'common.js').text;
  const service = fs.readFileSync(path.join(__dirname, 'lib/recovery-service.js'), 'utf8');
  const admin = sources.find(s => s.name === 'admin.html').text;
  assert.doesNotMatch(service, /ข้อมูลปลอดภัยแล้ว/);
  assert.doesNotMatch(common, /สำเนาบนคลาวด์|ตรวจแล้ว ใช้งานได้/);
  assert.doesNotMatch(admin, /h\.offDeviceOk\s*\?/);
  for (const file of ['admin.html', 'reports.html']) {
    assert.match(sources.find(s => s.name === file).text, /toast\(backupRunToastText\(r\)/);
  }
});
test('ผลสำรองแยก cloud copy ที่ยังไม่ยืนยัน upload ออกจาก local/external และ failure', () => {
  const { context } = backupUiContext();
  const cloud = vm.runInContext(`backupTargetText({kind:'cloud_sync',ok:true,state:'encrypted_to_sync_folder'})`, context);
  assert.match(cloud, /โฟลเดอร์คลาวด์/);
  assert.match(cloud, /ยังไม่ยืนยันการอัปโหลด/);
  for (const kind of ['local', 'external']) {
    const text = vm.runInContext(`backupTargetText({kind:'${kind}',ok:true})`, context);
    assert.doesNotMatch(text, /คลาวด์|อัปโหลด/);
  }
  const failed = vm.runInContext(`backupTargetText({kind:'cloud_sync',ok:false,error:'พื้นที่เต็ม'})`, context);
  assert.match(failed, /ไม่สำเร็จ.*พื้นที่เต็ม/);
  assert.doesNotMatch(failed, /คัดลอก.*แล้ว/);
});
test('admin และผู้ใช้งานเห็นข้อจำกัด upload แม้สำรองล่าสุดสำเร็จ', () => {
  for (const role of ['admin', 'doctor', 'front']) {
    const { context, banner } = backupUiContext(role);
    vm.runInContext(`renderBackupBanner({ok:true,coverage:'multi_copy',cloud_key_exported:true,
      cloud:{kind:'cloud_sync',ok:true,state:'encrypted_to_sync_folder'}})`, context);
    assert.match(banner.innerHTML, /ยังไม่ยืนยันการอัปโหลด/, role);
  }
});
test('health แยกหลักฐาน cloud folder จาก external แม้มี Kit และเคยซ้อมกู้', () => {
  const stamp = new Date().toISOString();
  const cloud = { kind: 'cloud_sync', ok: true, state: 'encrypted_to_sync_folder' };
  const status = { ok: true, lastGood: { finished_at: stamp }, off_device_ok: true, cloud, targets: [cloud] };
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.join(__dirname, 'lib'),
    require(name) {
      if (name.startsWith('node:')) return require(name);
      if (name === './db') return { DATA_DIR: 'synthetic-only', getSetting: key => key === 'recovery_kit_fingerprint' ? 'synthetic-fingerprint' : stamp };
      if (name === './backup') return { status: () => status };
      if (name === './password-recovery') return { localStatus: () => ({ ready: false }) };
      if (['./recovery-core', './recovery-discovery', './recovery-kit'].includes(name)) return {};
      throw new Error('Unexpected module: ' + name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'lib/recovery-service.js'), 'utf8'), context);
  const health = context.module.exports.health();
  assert.match(health.headline, /ยังไม่ยืนยันการอัปโหลด/);
  assert.notEqual(health.state, 'safe');
  assert.equal(health.cloudCopyOk, true);
  assert.equal(health.externalCopyOk, false);
  status.cloud = null; status.targets = [{ kind: 'external', ok: true }];
  const external = context.module.exports.health();
  assert.equal(external.externalCopyOk, true);
  assert.equal(external.cloudCopyOk, false);
  assert.doesNotMatch(external.headline, /คลาวด์|ปลอดภัยแล้ว/);
});
test('trial reset/uninstall preserves operation before dispatch and durable failure guidance',()=>{
  const js=fs.readFileSync(path.join(publicDir,'trial-tools.js'),'utf8'),html=fs.readFileSync(path.join(publicDir,'trial-tools.html'),'utf8');
  assert(js.indexOf('localStorage.setItem')<js.indexOf('\n sendTrial();'));
  assert.match(js,/body:JSON.stringify\(trialOperation\)/);assert.match(js,/ยังยืนยันผลคำสั่งไม่ได้/);
  assert.match(html,/id="trialResult"[^>]+role="status"/);assert.match(html,/id="retryTrial"/);
  assert.match(html,/id="resetTrial"/);assert.match(html,/id="uninstallTrial"/);
  const server=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');assert(server.indexOf('trial-start-guard')<server.indexOf("require('./lib/db')"));
  const ps=fs.readFileSync(path.join(__dirname,'scripts/trial-maintenance.ps1'),'utf8');assert.match(ps,/'YesNo','Warning','Button2'/);assert.match(ps,/function DeleteScoped/);assert.match(ps,/synthetic-trial-tools-only/);
});
test('password recovery keeps persistent outcomes and never stores typed secrets in browser storage', () => {
  const admin = sources.find(s => s.name === 'admin.html').text;
  const helper = fs.readFileSync(path.join(publicDir, 'recovery.html'), 'utf8');
  assert.match(admin, /id="passwordResult" aria-live="polite"/);
  assert.match(admin, /expected_id: recoveryHealth\?\.password\?\.id/);
  assert.match(admin, /sessionStorage\.setItem\('recovery-password-operation', JSON\.stringify\(op\)\)/);
  assert.match(admin, /document\.getElementById\(id\)\.value = ''/);
  assert.match(helper, /lastOperation\?\.state==='published'/);
  assert.match(helper, /resumeRestore\(data\.lastOperation\.id\)/);
  assert.match(helper, /id="backupPassword" type="password" autocomplete="current-password"/);
  assert.doesNotMatch(admin + helper, /(?:localStorage|sessionStorage)\.setItem\([^\n]*(?:JSON\.stringify\(body\)|password:|\.value)/i);
});
if (process.exitCode) process.exit(process.exitCode);
console.log(`
UI static: ${passed} tests passed`);
