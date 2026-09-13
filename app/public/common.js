'use strict';
// ของกลางทุกหน้า: api wrapper, topbar, lock overlay, poll, toast, format helpers

let ME = null;

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    showUpdateOfflineBanner();
    // ข้อความห้ามอ้าง "กำลังอัปเดต" มั่วๆ (ผิด AGENTS §UI ข้อ 7 — หมอรอ 1-2 นาทีแล้วไม่หาย เลยปิดเปิดโปรแกรมทั้งวัน 2026-08-24)
    throw new Error(offlineBannerText());
  }
  clearOfflineBanner(); // ติดต่อได้แล้ว (ไม่ว่า status อะไร = เครื่องหลักตอบ) — แถบ "ติดต่อไม่ได้" ต้องหายเอง ไม่ใช่ค้างจนต้องปิดเปิดโปรแกรม
  if (res.status === 401) {
    // session หายทั้งที่หน้านี้เคย login แล้ว (ME มีค่า) = server เพิ่งรีสตาร์ท/เกิดใหม่ — ต้องบอกเหตุผลบนหน้า login
    // (blind test 2026-08-24: supervisor ฟื้น server ใน 2 วิ ผู้ใช้เลยโดนดีดไป login เงียบๆ โดยไม่รู้ว่าทำไม)
    if (ME) localStorage.setItem('clinic_relogin_notice', '1');
    location.href = '/login.html'; throw new Error('ต้อง login');
  }
  if (res.status === 423) { showLock(); throw new Error('หน้าจอถูกล็อก'); }
  let data = null;
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('json')) data = await res.json();
  else data = await res.text();
  if (!res.ok) {
    const msg = (data && data.error) || `error ${res.status}`;
    const e = new Error(msg); e.status = res.status; e.data = data; // ให้ caller ใช้ payload กู้สถานการณ์ได้ (เช่น already_registered)
    throw e;
  }
  return data;
}

// แถบ "ติดต่อเครื่องหลักไม่ได้": พูดเฉพาะสิ่งที่จริง — จะบอกว่า "กำลังอัปเดต" ได้ก็ต่อเมื่อผู้ใช้เพิ่งกดอัปเดตจริง
// (ธง clinic_update_started) · แถบต้องลองใหม่เองและหายเองเมื่อเครื่องหลักกลับมา (บั๊กหน้างาน 2026-08-24: แถบค้างถาวร)
function offlineBannerText() {
  return localStorage.getItem('clinic_update_started')
    ? 'ติดต่อเครื่องหลักไม่ได้ — ระบบกำลังอัปเดตรุ่นและจะกลับมาเองใน 1–2 นาที กรุณาอย่าปิดเครื่องหลัก'
    : 'ติดต่อเครื่องหลักไม่ได้ — ระบบกำลังลองใหม่ให้เอง ถ้าเกิน 1 นาทียังไม่หาย ให้ตรวจว่าเครื่องหลักเปิดอยู่และสายแลนเสียบแน่น';
}
let offlineRetryTimer = null;
let offlineSince = null;
function showUpdateOfflineBanner() {
  let host = document.getElementById('sysBanners');
  if (!host) { host = document.createElement('div'); host.id = 'sysBanners'; document.body.prepend(host); }
  if (!document.getElementById('updateOfflineBanner')) {
    offlineSince = Date.now();
    host.insertAdjacentHTML('afterbegin', `<div class="banner amber" id="updateOfflineBanner">⏳ ${esc(offlineBannerText())} <span id="offlineSeconds" class="muted"></span></div>`);
  }
  if (!offlineRetryTimer) {
    // ลองใหม่เองทุก 5 วิ (fetch ตรง — ห้ามใช้ api() เพราะจะวนเรียกตัวเอง): สำเร็จเมื่อไหร่แถบหาย ผู้ใช้ทำงานต่อได้เลย
    offlineRetryTimer = setInterval(async () => {
      const secondsEl = document.getElementById('offlineSeconds');
      if (secondsEl) secondsEl.textContent = `(ลองใหม่อยู่ ${Math.round((Date.now() - offlineSince) / 1000)} วินาที)`;
      try {
        await fetch('/api/update/status', { cache: 'no-store' });
        clearOfflineBanner();
        toast('เชื่อมต่อเครื่องหลักได้แล้ว ใช้งานต่อได้ตามปกติ');
      } catch {}
    }, 5000);
  }
}
function clearOfflineBanner() {
  if (offlineRetryTimer) { clearInterval(offlineRetryTimer); offlineRetryTimer = null; }
  document.getElementById('updateOfflineBanner')?.remove();
}

function renderUpdateBanner(status) {
  const host = document.getElementById('sysBanners');
  if (!host || !status || !status.host || ME?.role !== 'admin') return;
  document.getElementById('updateAvailableBanner')?.remove();
  if (!['available', 'ready_to_apply'].includes(status.state)) return;
  const banner = document.createElement('div');
  banner.className = 'banner amber'; banner.id = 'updateAvailableBanner';
  banner.innerHTML = `⬆️ มีโปรแกรมรุ่น ${esc(status.available_version)} พร้อมอัปเดต
    <button class="btn sm primary" id="updateNowBtn">อัปเดตตอนนี้</button>
    <button class="btn sm" id="updateLaterBtn">ไว้ทีหลัง</button>
    <span class="muted">ระบบจะหยุดสั้น ๆ และกลับมาเองใน 1–2 นาที</span>`;
  host.appendChild(banner);
  document.getElementById('updateLaterBtn').onclick = () => banner.remove();
  document.getElementById('updateNowBtn').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = 'กำลังเตรียมอัปเดต…';
    try {
      const result = await api('POST', '/api/update/apply', {});
      watchUpdateProgress(banner, result.version || status.available_version);
    } catch (error) { toast(error.message, true); button.disabled = false; button.textContent = 'อัปเดตตอนนี้'; }
  };
}

// หลังสั่งอัปเดต: assistant ปิด server → สลับไฟล์ → เปิดใหม่ (ของจริงใช้ ~6 วินาที) session ใน memory หาย
// แต่หน้าที่กดไม่มีใคร poll ต่อ → ค้างข้อความ "กำลังอัปเดต" ตลอดไป ผู้ใช้คิดว่าค้าง/บั๊ก (เจ้าของเจอจริง 2026-08-19 รอ 5 นาทีแล้วกด F5 เอง)
// → poll /api/update/status ทุก 3 วิด้วย fetch ตรง (ไม่ใช้ api() เพราะ 401 จะเด้ง login ทันทีโดยไม่จำอะไร):
//   ติดต่อไม่ได้ = กำลังสลับรุ่น · 200 state error = ล้มก่อนปิด server (บอกผล ไม่ต้อง login ใหม่) · 401 = server ใหม่ขึ้นแล้ว
//   → จำธง clinic_update_started + clinic_after_login แล้วพาไป login (login.html บอกว่าเป็นเรื่องปกติ, เข้าแล้วกลับ /admin.html ซึ่งอ่านผลจาก journal มาแสดง)
const UPDATE_WATCH_TIMEOUT_MS = 5 * 60 * 1000;
function watchUpdateProgress(el, version) {
  const startedAt = Date.now();
  localStorage.setItem('clinic_update_started', JSON.stringify({ at: startedAt, version: String(version || '') }));
  const show = text => { if (el) el.textContent = text; };
  show(`⏳ กำลังอัปเดตเป็นรุ่น ${version} — ระบบจะปิดสั้น ๆ แล้วกลับมาเอง อย่าปิดเครื่อง`);
  const tick = async () => {
    const sec = Math.round((Date.now() - startedAt) / 1000);
    let res = null;
    try { res = await fetch('/api/update/status', { cache: 'no-store' }); } catch { res = null; }
    if (res && res.status === 401) {
      localStorage.setItem('clinic_after_login', '/admin.html');
      localStorage.setItem('clinic_after_login_reason', 'update');
      location.href = '/login.html';
      return;
    }
    if (res && res.ok) {
      let st = null;
      try { st = await res.json(); } catch { st = null; }
      if (st && st.state === 'error') {
        localStorage.removeItem('clinic_update_started');
        show(`❌ ${st.message || 'อัปเดตไม่สำเร็จ'} — โปรแกรมยังเป็นรุ่นเดิม ใช้งานได้ตามปกติ`);
        return;
      }
    }
    if (Date.now() - startedAt > UPDATE_WATCH_TIMEOUT_MS) {
      show('⚠️ ผ่านไป 5 นาทีระบบยังไม่กลับมา — ดับเบิลคลิกไอคอน "เปิดระบบคลินิก" บนเดสก์ท็อป (ระบบจะตรวจและกู้รุ่นให้เอง) แล้วแจ้งผู้ดูแล');
      return;
    }
    show(res ? `⏳ กำลังอัปเดตเป็นรุ่น ${version} … (${sec} วินาที) อย่าปิดเครื่อง`
      : `⏳ ระบบปิดชั่วคราวเพื่อสลับเป็นรุ่น ${version} กำลังรอให้กลับมา… (${sec} วินาที) อย่าปิดเครื่อง`);
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

// แถบผลถาวรใต้ topbar (เขียว/แดง) — ผลอัปเดตต้อง "เห็น" ไม่ใช่ toast ที่หายใน 2 วิ
function renderUpdateResultBanner(kind, text) {
  let host = document.getElementById('sysBanners');
  if (!host) { host = document.createElement('div'); host.id = 'sysBanners'; document.body.prepend(host); }
  document.getElementById('updateResultBanner')?.remove();
  const banner = document.createElement('div');
  banner.className = `banner ${kind === 'ok' ? 'green' : 'red'}`; banner.id = 'updateResultBanner';
  banner.innerHTML = `${esc(text)} <button class="btn sm" type="button" id="updateResultClose">ปิด</button>`;
  host.appendChild(banner);
  document.getElementById('updateResultClose').onclick = () => banner.remove();
}

function toast(msg, isErr = false) {
  let host = document.getElementById('toast');
  if (!host) { host = document.createElement('div'); host.id = 'toast'; document.body.appendChild(host); }
  const m = document.createElement('div');
  m.className = 'm' + (isErr ? ' err' : '');
  m.textContent = msg;
  host.appendChild(m);
  setTimeout(() => m.remove(), isErr ? 5000 : 2500);
}

// เอกสารที่ออกแล้วเป็น append-only: ต้อง reserve แท็บภายใน user gesture ก่อน await
// ถ้า browser บล็อก popup ต้องมีลิงก์ค้างให้เปิดเอง เพื่อไม่ให้ผู้ใช้กดออกเอกสารซ้ำโดยไม่รู้ว่าใบแรกเกิดแล้ว
function reservePrintWindow() { const w = window.open('', '_blank'); return w; }
function closeReservedPrintWindow(printWindow) {
  if (printWindow && !printWindow.closed) { try { printWindow.close(); } catch {} }
}
function showPersistentPrintLink(url, label) {
  let host = document.getElementById('printFallbacks');
  if (!host) {
    host = document.createElement('div');
    host.id = 'printFallbacks';
    host.setAttribute('role', 'alert');
    document.body.appendChild(host);
  }
  const key = btoa(unescape(encodeURIComponent(url))).replace(/=+$/g, '').replace(/[^A-Za-z0-9]/g, '');
  let row = document.getElementById(`printFallback-${key}`);
  if (!row) {
    row = document.createElement('div');
    row.id = `printFallback-${key}`;
    row.className = 'print-fallback';
    row.innerHTML = `<span>ออกเอกสารแล้ว แต่เบราว์เซอร์ไม่เปิดแท็บให้</span>
      <a class="btn primary" target="_blank" rel="noopener">🔗 ${esc(label)}</a>
      <button class="btn sm" type="button" aria-label="ปิดข้อความ">ปิด</button>`;
    row.querySelector('a').href = url;
    row.querySelector('button').onclick = () => row.remove();
    host.appendChild(row);
  }
  toast(`ออกเอกสารแล้ว — กรุณากด “${label}” ที่แถบด้านบน`, true);
  return row;
}
function finishPrintWindow(printWindow, url, label) {
  if (printWindow && !printWindow.closed) {
    try { printWindow.location = url; return true; } catch {}
  }
  showPersistentPrintLink(url, label);
  return false;
}
function openPrintWindow(url, label) {
  const printWindow = reservePrintWindow();
  return finishPrintWindow(printWindow, url, label);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- modal กลาง: แทน prompt()/confirm() ของเบราว์เซอร์ทุกจุด (UAT C) ----------
function openModal(html) {
  let back = document.getElementById('modalBack');
  if (!back) {
    back = document.createElement('div');
    back.id = 'modalBack';
    back.addEventListener('click', e => { if (e.target === back) closeModal(); });
    document.body.appendChild(back);
  }
  back.innerHTML = `<div class="modal-box">${html}</div>`;
  back.classList.add('show');
}
function closeModal() { const b = document.getElementById('modalBack'); if (b) { b.classList.remove('show'); b.innerHTML = ''; } }
// ปุ่มลบสองจังหวะ: กดครั้งแรกเปลี่ยนเป็น "ยืนยันลบ?" กดซ้ำถึงทำจริง
function armDelete(btn, fn) {
  if (btn.dataset.arm !== '1') { btn.dataset.arm = '1'; btn.textContent = 'ยืนยันลบ?'; return; }
  fn();
}
// ฟอร์มถามข้อความสั้นใน modal (แทน prompt เดิม): openAsk({title, fields:[{id,label,value,type,placeholder}], okText, onOk})
function openAsk(opts) {
  const fields = opts.fields.map(f => `<label class="f"><span>${esc(f.label)}</span>
    ${f.type === 'textarea'
      ? `<textarea id="${f.id}" rows="2" style="width:100%">${esc(f.value || '')}</textarea>`
      : `<input id="${f.id}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" style="width:100%">`}
  </label>`).join('');
  openModal(`<h2>${opts.title}</h2>${opts.intro ? `<div class="muted" style="margin-bottom:6px">${opts.intro}</div>` : ''}
    <div class="stack">${fields}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary" id="mAskOk">${esc(opts.okText || 'บันทึก')}</button>
      <button class="btn" onclick="closeModal()">ยกเลิก</button></div>`);
  document.getElementById('mAskOk').onclick = () => {
    const values = {};
    for (const f of opts.fields) values[f.id] = document.getElementById(f.id).value;
    opts.onOk(values);
  };
  const first = document.getElementById(opts.fields[0].id);
  if (first) first.focus();
}
function baht(n) { return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 }); }
function ageOf(birthDate) {
  if (!birthDate) return '';
  const b = new Date(birthDate);
  if (isNaN(b)) return '';
  const a = Math.floor((Date.now() - b) / (365.25 * 86400000));
  return `${a} ปี`;
}
function thDate(sqlDt) {
  if (!sqlDt) return '';
  const [d, t] = sqlDt.split(' ');
  const [y, m, day] = d.split('-');
  return `${Number(day)}/${Number(m)}/${Number(y) + 543}${t ? ' ' + t.slice(0, 5) : ''}`;
}
function stateTH(s) {
  return { WAITING: 'รอตรวจ', IN_EXAM: 'กำลังตรวจ', DISPENSING: 'รอจ่ายยา/เงิน', COMPLETED: 'เสร็จสิ้น', CANCELLED: 'ยกเลิก' }[s] || s;
}

// ---------- ธีมพื้นหลัง (สว่าง/นวล/มืด) — จำต่อเครื่อง ไม่ผูกบัญชี ไม่แตะฐานข้อมูล (เจ้าของสั่ง 2026-08-16 "เผื่อแสบตา") ----------
// ค่าเริ่มต้น = สว่างเสมอ (ให้ตรงภาพในคู่มือ) · สีที่มีความหมายทางคลินิก (แดง/เหลือง/เขียว/น้ำเงิน) ไม่เปลี่ยนตามธีม · หน้าพิมพ์ขาวเสมอ (app.css @media print)
const THEMES = { light: 'สว่าง', soft: 'นวล', dark: 'มืด' };
function currentTheme() { const t = localStorage.getItem('clinic_theme'); return THEMES[t] ? t : 'light'; }
function applyTheme(t) { document.documentElement.setAttribute('data-theme', THEMES[t] ? t : 'light'); }
function setTheme(t) { const v = THEMES[t] ? t : 'light'; localStorage.setItem('clinic_theme', v); applyTheme(v); document.querySelectorAll('.theme-pick').forEach(el => { el.value = v; }); }
function themePickerHtml() {
  return `<select class="theme-pick" title="เลือกพื้นหลังให้สบายตา (จำเฉพาะเครื่องนี้)" aria-label="พื้นหลัง" onchange="setTheme(this.value)">${
    Object.entries(THEMES).map(([k, label]) => `<option value="${k}"${k === currentTheme() ? ' selected' : ''}>🌓 ${label}</option>`).join('')}</select>`;
}
applyTheme(currentTheme());
document.addEventListener('DOMContentLoaded', () => { document.querySelectorAll('.theme-pick').forEach(el => { el.value = currentTheme(); }); });

// ---------- topbar ----------
async function initPage(pageKey) {
  try { ME = await api('GET', '/api/me'); }
  catch { return null; }
  const nav = [
    ['front', 'หน้าคลินิก', '/', ['front', 'doctor']],
    ['exam', 'ห้องตรวจ', '/exam.html', ['doctor']],
    ['calendar', 'นัดหมาย', '/calendar.html', ['front', 'doctor']],
    ['stock', 'คลังยา', '/stock.html', ['front']],
    ['reports', 'รายงาน', '/reports.html', ['front', 'doctor']],
    ['admin', ME.role === 'admin' ? 'ตั้งค่า' : 'เกี่ยวกับโปรแกรม', '/admin.html', ['admin', 'doctor', 'front']],
  ];
  const bar = document.createElement('div');
  bar.className = 'topbar';
  bar.innerHTML = `<span class="brand" id="brandName">คลินิก</span>
    <nav>${nav.filter(n => n[3].includes(ME.role)).map(n =>
      `<a href="${n[2]}" class="${n[0] === pageKey ? 'on' : ''}">${n[1]}</a>`).join('')}</nav>
    <span class="who">${esc(ME.display_name)} (${{ doctor: 'แพทย์', front: 'หน้าคลินิก', admin: 'ผู้ดูแล' }[ME.role]})</span>
    ${themePickerHtml()}
    <a class="btn sm" id="supportReportBtn" href="/api/support-report" download
      title="รายงานไม่มีข้อมูลคนไข้ แต่ให้ตรวจและปิดชื่อผู้ใช้ ชื่อเครื่อง และที่อยู่โฟลเดอร์ก่อนแนบที่ github.com/mkungsuki/clinic-offline/issues ห้ามแนบข้อมูลคนไข้หรือกุญแจกู้">🆘 แจ้งปัญหา</a>
    <button class="logout" onclick="doLogout()">ออกจากระบบ</button>`;
  document.body.prepend(bar);
  // ความสูง topbar จริง → ตัวแปร CSS ให้แถบ sticky อื่น (หัวคนไข้ห้องตรวจ) เกาะใต้มันพอดี ไม่ว่าจะห่อบรรทัดหรือ scaling ใด (handoff เฟส 2)
  const setTopbarH = () => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
  setTopbarH();
  if (typeof ResizeObserver === 'function') new ResizeObserver(setTopbarH).observe(bar); else window.addEventListener('resize', setTopbarH);

  const banners = document.createElement('div');
  banners.id = 'sysBanners';
  bar.after(banners);
  if (ME.clock_error) {
    banners.innerHTML = `<div class="banner red">⛔ ${esc(ME.clock_error)} <button class="btn sm" type="button" onclick="recheckClock()">🕒 ตรวจนาฬิกาอีกครั้ง</button></div>`;
  }
  if (ME.setup_required) banners.innerHTML += `<div class="banner red">🔐 ยังใช้รหัสผู้ดูแลเริ่มต้นหรือยังไม่ยืนยันการตั้งระบบ — ไปหน้า “ตั้งค่า” แล้วเปลี่ยนรหัส admin ก่อนใช้ข้อมูลจริง</div>`;
  if (ME.demo_mode) banners.innerHTML += `<div class="banner amber">🧪 ฐานข้อมูลนี้เปิด Demo mode และมีบัญชี/ข้อมูลตัวอย่าง ห้ามใช้เป็นฐาน production</div>`;
  if (ME.role === 'admin') api('GET', '/api/update/status').then(renderUpdateBanner).catch(() => {});
  api('GET', '/api/settings').then(s => {
    if (s.clinic_name) document.getElementById('brandName').textContent = s.clinic_name;
  }).catch(() => {});
  if (ME.locked) showLock();
  startIdleWatch();
  return ME;
}

function renderBackupBanner(st) {
  const host = document.getElementById('backupBanner');
  if (!host) return;
  if (st && !st.ok) {
    host.innerHTML = `<div class="banner red">⚠️ ${st.age_hours == null ? 'ยังไม่เคยสำรองข้อมูลสำเร็จ' : 'ข้อมูลสำรองเก่ากว่า 1 วัน'} — ไปหน้า “รายงาน” แล้วกด “สำรองข้อมูลตอนนี้”</div>`;
  } else if (st && st.coverage === 'local_only') {
    host.innerHTML = `<div class="banner amber">⚠️ ข้อมูลสำรองยังอยู่ในคอมเครื่องนี้อย่างเดียว — เจ้าของคลินิกกรุณาไปหน้า “ตั้งค่า” เพื่อเก็บสำเนานอกเครื่อง</div>`;
  } else if (st && st.cloud && !st.cloud_key_exported) {
    host.innerHTML = `<div class="banner red">⚠️ ยังไม่มี USB สำหรับกู้ข้อมูลฉุกเฉิน — เจ้าของคลินิกกรุณาไปหน้า “ตั้งค่า” แล้วสร้าง Recovery Kit</div>`;
  } else if (st && st.cloud && st.cloud.state === 'encrypted_to_sync_folder') {
    host.innerHTML = `<div class="banner amber">☁️ ส่งสำเนาเข้าโฟลเดอร์คลาวด์แล้ว แต่ยังควรเปิด Google Drive/OneDrive ตรวจว่าส่งขึ้นเรียบร้อย</div>`;
  } else host.innerHTML = '';
}

function backupTargetText(t) {
  const name = t.kind === 'local' ? 'สำเนาในเครื่อง' : t.kind === 'cloud_sync' ? 'สำเนาบนคลาวด์' : 'สำเนานอกเครื่อง';
  const state = t.ok ? 'ตรวจแล้ว ใช้งานได้' : `ไม่สำเร็จ: ${t.error || 'กรุณาลองใหม่'}`;
  return `${t.ok ? '✅' : '❌'} ${name}: ${state}`;
}

function backupRunResultText(result) {
  const targets = result && Array.isArray(result.targets) ? result.targets : [];
  return targets.length ? targets.map(backupTargetText).join('\n') : 'ระบบไม่ได้รายงานปลายทาง Backup';
}

async function doLogout() {
  await api('POST', '/api/logout', {});
  location.href = '/login.html';
}

// ---------- lock overlay (plan A12: idle 10 นาที → PIN) ----------
let lockShown = false;
function showLock() {
  if (lockShown) return;
  lockShown = true;
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.id = 'lockOverlay';
  ov.innerHTML = `<div class="box">
    <h2>🔒 หน้าจอถูกล็อก</h2>
    <p class="muted">ใส่ PIN เพื่อปลดล็อก (ถ้าไม่ได้ตั้ง PIN ใช้รหัสผ่าน)</p>
    <input type="password" id="pinInput" autocomplete="off">
    <div class="mt"><button class="btn primary big" onclick="tryUnlock()">ปลดล็อก</button></div>
    <div class="mt"><a href="#" onclick="doLogout()" class="muted">ออกจากระบบ / สลับผู้ใช้</a></div>
  </div>`;
  document.body.appendChild(ov);
  const inp = ov.querySelector('#pinInput');
  inp.focus();
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
}
async function tryUnlock() {
  const pin = document.getElementById('pinInput').value;
  try {
    await api('POST', '/api/unlock', { pin });
    lockShown = false;
    document.getElementById('lockOverlay').remove();
    toast('ปลดล็อกแล้ว');
  } catch (e) { toast(e.status === 429 ? e.message : 'PIN ไม่ถูกต้อง', true); } // 429 = โดนหน่วงจากการผิดหลายครั้ง แสดงข้อความภาษาคนจาก server
}
// นาฬิกาเครื่องผิด (clock guard): หลังตั้งเวลาถูกแล้ว กดตรวจใหม่ได้เลยไม่ต้อง restart
async function recheckClock() {
  try {
    const r = await api('POST', '/api/system/clock-recheck', {});
    if (r.clock_error) toast('นาฬิกายังไม่ถูกต้อง — ตั้งเวลาเครื่องแล้วลองอีกครั้ง', true);
    else { toast('นาฬิกาถูกต้องแล้ว ระบบกลับมารับข้อมูลตามปกติ'); setTimeout(() => location.reload(), 800); }
  } catch (e) { toast(e.message, true); }
}
function startIdleWatch() {
  let last = Date.now();
  let lastReport = 0;
  const activity = () => {
    last = Date.now();
    // จำกัดไม่เกินนาทีละครั้ง ป้องกัน request ถี่จาก mouse/keyboard
    if (Date.now() - lastReport > 60000) {
      lastReport = Date.now();
      fetch('/api/session/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(r => { if (r.status === 423) showLock(); })
        .catch(() => {});
    }
  };
  ['mousedown', 'keydown', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, activity, { passive: true }));
  setInterval(() => { if (Date.now() - last > 10 * 60 * 1000) showLock(); }, 15000);
}

// ---------- poll (3 วิ ตาม plan A2; หยุดตอนแท็บไม่ active) ----------
function poll(fn, ms = 3000) {
  let timer = null;
  const tick = async () => { try { await fn(); } catch (e) { /* เงียบ — รอบหน้า retry */ } };
  const loop = () => { tick(); timer = setInterval(tick, ms); };
  loop();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearInterval(timer); }
    else loop();
  });
}

// ---------- generic item search dropdown (ยา/บริการ/คนไข้) ----------
function attachSearch(inputEl, fetcher, renderItem, onPick) {
  let dd = null, items = [], hl = -1, seq = 0;
  const close = () => { if (dd) { dd.remove(); dd = null; items = []; hl = -1; } };
  inputEl.addEventListener('input', async () => {
    const q = inputEl.value.trim();
    if (q.length < 1) { close(); return; }
    const mySeq = ++seq;
    const res = await fetcher(q).catch(() => []);
    if (mySeq !== seq) return;
    close();
    if (!res.length) return;
    items = res;
    dd = document.createElement('div');
    dd.className = 'dd';
    res.forEach((it, i) => {
      const el = document.createElement('div');
      el.className = 'it';
      el.innerHTML = renderItem(it);
      el.addEventListener('mousedown', e => { e.preventDefault(); close(); onPick(it); });
      dd.appendChild(el);
    });
    inputEl.parentElement.appendChild(dd);
  });
  inputEl.addEventListener('keydown', e => {
    if (!dd) return;
    const els = dd.querySelectorAll('.it');
    if (e.key === 'ArrowDown') { hl = Math.min(hl + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { hl = Math.max(hl - 1, 0); }
    else if (e.key === 'Enter') { e.preventDefault(); if (hl >= 0) { const it = items[hl]; close(); onPick(it); } return; }
    else if (e.key === 'Escape') { close(); return; }
    else return;
    e.preventDefault();
    els.forEach((el, i) => el.classList.toggle('hl', i === hl));
    if (els[hl]) els[hl].scrollIntoView({ block: 'nearest' });
  });
  inputEl.addEventListener('blur', () => setTimeout(close, 150));
}
