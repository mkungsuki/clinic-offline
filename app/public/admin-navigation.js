'use strict';

// Each category has its own URL/document navigation; the legacy field template
// remains shared so installation helpers and document previews keep their IDs.
const ADMIN_SECTIONS = {
  clinic: 'ข้อมูลคลินิก', printing: 'เอกสารและการพิมพ์', users: 'ผู้ใช้งาน',
  connections: 'เชื่อมต่อเครื่องอื่น', backup: 'สำรองและกู้ข้อมูล',
  audit: 'ประวัติการทำรายการ', system: 'อัปเดตและเกี่ยวกับโปรแกรม', advanced: 'เครื่องมือขั้นสูง',
};
let adminSection = 'clinic';
let adminReady = false;
let adminSaving = false;
let adminLeaving = false;
const adminBaseline = new Map();

function setAdminFieldValue(el, value) {
  if (!el || value == null) return;
  const text = String(value);
  // An old installation can return empty values for optional settings. Keep
  // the template's valid select/time default; assigning '' deselects every
  // option and would send invalid paper/font values on the first save.
  if (el.tagName === 'SELECT' && ![...el.options].some(option => option.value === text)) return;
  if (el.type === 'time' && !text) return;
  if (el.type === 'number' && !text && el.defaultValue) return;
  el.value = text;
}

function adminFields() {
  return [...document.querySelectorAll('#adminPage input, #adminPage select, #adminPage textarea')]
    .filter(el => /^(s_|u_)/.test(el.id) && el.type !== 'file');
}
function adminFieldValue(el) { return el.type === 'checkbox' ? String(el.checked) : el.value; }
function syncDocumentVisibility() {
  for (const group of document.querySelectorAll('.document-choice')) {
    const value = document.getElementById(group.dataset.setting).value;
    for (const button of group.querySelectorAll('button[data-value]')) button.setAttribute('aria-pressed', String(button.dataset.value === value));
  }
}
function chooseDocumentVisibility(button) {
  const group = button.closest('.document-choice');
  const field = document.getElementById(group.dataset.setting);
  field.value = button.dataset.value;
  syncDocumentVisibility();
  field.dispatchEvent(new Event('change', { bubbles: true }));
}
function adminIsDirty() {
  return adminReady && adminFields().some(el => adminBaseline.get(el.id) !== adminFieldValue(el));
}
function updateAdminDirty() {
  const status = document.getElementById('adminSaveState');
  if (status) status.textContent = adminSaving ? 'กำลังบันทึก…' : adminIsDirty() ? 'มีข้อมูลที่ยังไม่ได้บันทึก' : 'ไม่มีข้อมูลค้างบันทึก';
}
function rememberAdminFields() {
  adminBaseline.clear();
  for (const el of adminFields()) adminBaseline.set(el.id, adminFieldValue(el));
  adminReady = true;
  updateAdminDirty();
}
function markAdminSaved(body) {
  for (const [key, value] of Object.entries(body)) {
    if (adminBaseline.has('s_' + key)) adminBaseline.set('s_' + key, String(value));
  }
  updateAdminDirty();
}
function adminSettingsPayload(scope) {
  if (!['clinic', 'printing', 'backup'].includes(scope) || scope !== adminSection) {
    throw new Error('กรุณาเปิดหมวดที่ต้องการบันทึกก่อน');
  }
  const body = {};
  for (const key of SKEYS) {
    const el = document.getElementById('s_' + key);
    if (el && el.closest('[data-admin-section]')?.dataset.adminSection === scope) body[key] = el.value;
  }
  return body;
}
function setupAdminNavigation() {
  const requested = new URLSearchParams(location.search).get('section');
  adminSection = Object.hasOwn(ADMIN_SECTIONS, requested) ? requested : 'clinic';
  if (requested !== adminSection) history.replaceState(null, '', '/admin.html?section=' + adminSection);
  document.title = ADMIN_SECTIONS[adminSection] + ' — ดูแลคลินิก';
  const page = document.getElementById('adminPage');
  document.getElementById('adminPageTitle').textContent = ADMIN_SECTIONS[adminSection];
  document.getElementById('adminNav').innerHTML = Object.entries(ADMIN_SECTIONS).map(([key, label]) =>
    `<a href="/admin.html?section=${key}" ${key === adminSection ? 'aria-current="page"' : ''}>${label}</a>`).join('');
  // Move existing controls, never clone IDs or introduce another source of truth.
  const printing = document.querySelector('[data-admin-section="printing"] .stack');
  for (const el of document.querySelectorAll('[data-admin-move="printing"]')) printing.append(el);
  const advanced = document.getElementById('profileTools');
  for (const el of document.querySelectorAll('[data-admin-move="advanced"]')) advanced.append(el);
  for (const card of document.querySelectorAll('[data-admin-section]')) {
    if (card.dataset.adminSection === adminSection) {
      page.append(card);
      card.classList.remove('hidden');
    }
  }
  const save = document.getElementById('adminSave');
  save.hidden = !['clinic', 'printing', 'backup'].includes(adminSection);
  save.textContent = 'บันทึก' + ADMIN_SECTIONS[adminSection];
  document.getElementById('adminControls').classList.remove('hidden');
  page.addEventListener('input', updateAdminDirty);
  page.addEventListener('change', updateAdminDirty);
  window.addEventListener('beforeunload', e => {
    if (!adminLeaving && (adminSaving || adminIsDirty())) { e.preventDefault(); e.returnValue = ''; }
  });
  // Category links and logout get a Thai explanation. Browser Back/reload is
  // covered by beforeunload; its native prompt wording belongs to the browser.
  document.addEventListener('click', e => {
    const target = e.target.closest('a[href], button.logout');
    if (!target || target.target === '_blank' || target.hasAttribute('download') || e.ctrlKey || e.metaKey || e.shiftKey || e.button > 0) return;
    if (target.matches('a') && !target.getAttribute('href').startsWith('/')) return;
    if (adminSaving) { e.preventDefault(); e.stopImmediatePropagation(); toast('กำลังบันทึก กรุณารอสักครู่', true); return; }
    if (!adminIsDirty()) return;
    if (!confirm('มีข้อมูลที่ยังไม่ได้บันทึก ต้องการออกจากหน้านี้โดยไม่บันทึกหรือไม่?')) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    adminLeaving = true;
  }, true);
  window.addEventListener('pageshow', e => {
    adminLeaving = false;
    if (e.persisted) { adminReady = false; location.reload(); } // re-check role and settings after Back
  });
}
