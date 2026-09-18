'use strict';

// All values from the server become text nodes. Detail requests never write data.
const AuditView = (() => {
  const categories = { patient: 'คนไข้', stock: 'ยาและสต็อก', money: 'เงิน', document: 'เอกสาร', account: 'บัญชีผู้ใช้', backup: 'สำรองข้อมูล' };
  const quickCategories = { adjust: 'stock', price: 'stock', void: 'money', patient: 'patient' };
  const dateValue = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  function dates(period, now = new Date()) {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    from.setDate(from.getDate() - (period === '30' ? 29 : period === 'today' ? 0 : 6));
    return { from: dateValue(from), to: dateValue(now) };
  }
  function dateText(value) {
    if (!value) return 'ไม่ระบุเวลา';
    const text = String(value);
    const date = new Date(/^\d{4}-\d\d-\d\d \d\d:/.test(text) ? text.replace(' ', 'T') : text);
    if (!Number.isFinite(date.getTime())) return 'ไม่ระบุเวลา';
    return date.toLocaleString('th-TH', { year: 'numeric', month: 'short', day: 'numeric', ...(/[:T]/.test(text) ? { hour: '2-digit', minute: '2-digit' } : {}) });
  }
  function query(state) {
    const params = new URLSearchParams({ category: Object.hasOwn(categories, state.category) ? state.category : 'all', limit: String(Math.min(1000, Math.max(50, Number(state.limit) || 50))) });
    if (state.q.trim()) params.set('q', state.q.trim());
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    params.set('important', state.important ? '1' : '0');
    if (Object.hasOwn(quickCategories, state.quick)) params.set('quick', state.quick);
    return params.toString();
  }
  function safeLink(value) {
    if (typeof value !== 'string' || !/^\/(?!\/)/.test(value) || /[\\\x00-\x20]/.test(value)) return null;
    return value;
  }
  function valueText(value) {
    if (value === null || value === undefined || value === '') return 'ไม่ได้ระบุ';
    if (typeof value === 'boolean') return value ? 'เปิด' : 'ปิด';
    // The API translates field values; never expose a serialized object on screen.
    if (typeof value === 'object') return 'ดูข้อมูลในรายการที่เกี่ยวข้อง';
    return String(value);
  }
  function restoreVisible(category, restore) {
    return !!restore && (category === 'backup' || (category === 'all' && ['pending', 'rolled-back'].includes(restore.state)));
  }
  function mount({ onAccount = () => {}, request = (url) => api('GET', url) } = {}) {
    const root = document.getElementById('auditView');
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = 'true';
    const el = id => document.getElementById(id);
    const make = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = String(text);
      if (className) node.className = className;
      return node;
    };
    const button = (text, action, className = 'btn') => {
      const node = make('button', text, className); node.type = 'button'; node.addEventListener('click', action); return node;
    };
    const initial = new URLSearchParams(location.search).get('category');
    const state = { category: Object.hasOwn(categories, initial) ? initial : 'all', q: '', period: '7', quick: '', important: true, limit: 50, ...dates('7') };
    let requestNumber = 0;
    let detailNumber = 0;
    let accountLoaded = false;
    function controls() {
      for (const node of root.querySelectorAll('[data-audit-category]')) node.setAttribute('aria-pressed', String(node.dataset.auditCategory === state.category));
      for (const node of root.querySelectorAll('[data-audit-period]')) node.setAttribute('aria-pressed', String(node.dataset.auditPeriod === state.period));
      for (const node of root.querySelectorAll('[data-audit-quick]')) node.setAttribute('aria-pressed', String(node.dataset.auditQuick === state.quick));
      el('auditCategories').querySelector('[data-audit-category="all"]').textContent = state.important ? 'ทุกหมวด — รายการสำคัญ' : 'ทุกหมวด';
      el('auditQuery').value = state.q;
      el('auditFrom').value = state.from; el('auditTo').value = state.to;
      el('auditCustomDates').hidden = state.period !== 'custom';
      el('auditIncludeRoutine').checked = !state.important;
      el('auditAccountSummary').hidden = state.category !== 'account';
      if (state.category === 'account' && !accountLoaded) { accountLoaded = true; onAccount(); }
    }
    function readInputs() {
      state.q = el('auditQuery').value.trim();
      if (state.period === 'custom') { state.from = el('auditFrom').value; state.to = el('auditTo').value; }
    }
    function error(message, retry) {
      const box = el('auditError'); box.hidden = false; box.replaceChildren(make('p', message));
      if (retry) box.append(button('ลองค้นอีกครั้ง', () => load(true)));
    }
    function switchCategory(category, keepQuick = false) {
      readInputs(); state.category = category; state.limit = 50;
      if (!keepQuick) state.quick = '';
      load(true);
    }
    function appendFacts(target, facts) {
      const list = make('dl', undefined, 'audit-facts');
      for (const [label, value] of facts) { list.append(make('dt', label), make('dd', valueText(value))); }
      target.append(list);
    }
    function detailRow(row, generation) {
      const detail = make('details', undefined, 'audit-row'); detail.dataset.key = row.key;
      const summary = make('summary');
      const headline = make('span', undefined, 'audit-row-head');
      headline.append(make('span', row.summary || 'รายการที่บันทึกไว้', 'audit-sentence'));
      const meta = [dateText(row.time), row.actor || 'ไม่ระบุผู้ทำ', row.station || 'ไม่ระบุเครื่อง'];
      if (row.actorCurrent) meta.push('ใช้ชื่อบัญชีปัจจุบัน');
      headline.append(make('span', meta.join(' · '), 'audit-row-meta'));
      if (row.reference) headline.append(make('span', row.reference, 'audit-reference'));
      summary.append(headline, make('span', 'ดูรายละเอียด', 'audit-open-hint'));
      if (row.outcome && !['ok', 'success', 'สำเร็จ', 'บันทึกแล้ว'].includes(row.outcome)) headline.append(make('span', ({failed:'ไม่สำเร็จ',fail:'ไม่สำเร็จ',pending:'ยังไม่เสร็จ',void:'ยกเลิกแล้ว'})[row.outcome] || row.outcome, 'audit-outcome'));
      const body = make('div', undefined, 'audit-detail'); body.id = `auditDetail${++detailNumber}`;
      body.setAttribute('role', 'region'); body.setAttribute('aria-label', 'รายละเอียดรายการ'); summary.setAttribute('aria-controls', body.id);
      detail.append(summary, body);
      let loaded = false, loading = false;
      const fetchDetail = async () => {
        if (loaded || loading || generation !== requestNumber) return;
        loading = true; body.replaceChildren(make('p', 'กำลังอ่านรายละเอียด…')); body.setAttribute('aria-busy', 'true');
        try {
          const data = await request('/api/admin/audit-detail?key=' + encodeURIComponent(row.key));
          if (generation !== requestNumber || !detail.isConnected) return;
          body.replaceChildren(make('h4', data.title || 'รายละเอียดรายการ'));
          appendFacts(body, [['เมื่อไร', dateText(data.time)], ['ผู้ทำ', data.actor || 'ไม่ระบุผู้ทำ'], ['เครื่องที่ทำ', data.station || 'ไม่ระบุเครื่อง']]);
          if (data.changes?.length) {
            const changes = make('div', undefined, 'audit-changes');
            for (const change of data.changes) {
              const line = make('section', undefined, 'audit-change');
              line.append(make('h5', change.label || 'ข้อมูลที่เปลี่ยน'));
              appendFacts(line, [['ก่อน', change.before], ['หลัง', change.after]]); changes.append(line);
            }
            body.append(changes);
          } else body.append(make('p', 'รายการนี้ไม่มีรายละเอียดก่อน–หลังที่บันทึกไว้'));
          if (data.reason) appendFacts(body, [['เหตุผล', data.reason]]);
          const href = safeLink(data.link?.href);
          if (href) { const link = make('a', data.link.label || 'เปิดรายการที่เกี่ยวข้อง', 'btn'); link.href = href; body.append(link); }
          loaded = true;
        } catch {
          if (generation !== requestNumber || !detail.isConnected) return;
          const message = make('p', 'ยังอ่านรายละเอียดไม่ได้ กรุณาลองอีกครั้ง'); message.setAttribute('role', 'alert');
          body.replaceChildren(message, button('ลองอ่านรายละเอียดอีกครั้ง', fetchDetail));
        } finally { loading = false; body.setAttribute('aria-busy', 'false'); }
      };
      detail.addEventListener('toggle', () => { if (detail.open) fetchDetail(); });
      return detail;
    }
    function render(data, generation) {
      const result = el('auditResults');
      const keys = state.category === 'all' ? Object.keys(categories) : [state.category];
      let shown = 0;
      const sections = keys.map(key => {
        const group = (data.groups || []).find(item => item.key === key) || {rows:[],total:0,hidden:0};
        const section = make('section', undefined, 'audit-group'); section.dataset.category = key;
        const heading = make('div', undefined, 'audit-group-heading');
        heading.append(make('h3', categories[key]), make('span', `${Math.max(0, (Number(group.total) || 0) - (Number(group.hidden) || 0))} รายการ`)); section.append(heading);
        const rows = state.category === 'all' ? (group.rows || []).slice(0, 3) : (group.rows || []);
        shown += rows.length;
        if (rows.length) rows.forEach(row => section.append(detailRow(row, generation)));
        else section.append(make('p', 'ไม่พบรายการที่ตรงเงื่อนไขในหมวดนี้', 'audit-empty'));
        if (state.category === 'all') section.append(button('ดูทั้งหมดในหมวดนี้', () => switchCategory(key)));
        return section;
      });
      // Replace the result set on every fetch, including Show more. Never append an offset page.
      result.replaceChildren(...sections);
      const hidden = Number(data.hidden) || 0, total = Math.max(0, (Number(data.total) || 0) - hidden);
      el('auditCounts').textContent = `แสดง ${shown} จาก ${total} รายการที่ตรงเงื่อนไข${state.category === 'all' ? ' · ตัวอย่างล่าสุดไม่เกิน 3 รายการต่อหมวด' : ''}`;
      el('auditHiddenCount').textContent = state.important ? `(ซ่อนไว้ ${hidden} รายการ)` : '(แสดงอยู่)';
      el('auditMore').hidden = state.category === 'all' || shown >= total || state.limit >= 1000;
      el('auditMore').disabled = false;
      if (state.category !== 'all' && shown < total && state.limit >= 1000) el('auditCounts').textContent += ' — มีอีกหลายรายการ กรุณาเลือกช่วงวันให้แคบลงหรือเพิ่มคำค้น';
      el('auditSince').textContent = data.since ? `เริ่มเก็บประวัติการแก้ไขเพิ่มเติมตั้งแต่ ${dateText(data.since)} · รายการก่อนหน้านี้อาจไม่ครบ` : 'ยังไม่มีวันที่เริ่มเก็บประวัติการแก้ไขเพิ่มเติม · รายการย้อนหลังอาจไม่ครบ';
      const candidates = el('auditCandidates'); candidates.replaceChildren(); candidates.hidden = !data.candidates?.length;
      if (data.candidates?.length) {
        candidates.append(make('p', 'พบชื่อคนไข้ตรงกันหลายคน กรุณาเลือก HN ที่ต้องการ'));
        const choices = make('div', undefined, 'audit-buttons');
        for (const candidate of data.candidates) choices.append(button(String(candidate.label).includes(candidate.hn) ? candidate.label : `${candidate.label} · HN ${candidate.hn}`, () => { state.q = String(candidate.hn); state.limit = 50; load(true); }));
        candidates.append(choices);
      }
      renderHealth(data.logHealth);
      renderRestore(data.restore);
      if (data.searchNotice) { candidates.hidden = false; candidates.append(make('p', data.searchNotice)); }
      el('auditStatus').textContent = `ค้นแล้ว ${total} รายการ · ${dateText(state.from)} ถึง ${dateText(state.to)} · อัปเดตผล ${new Date().toLocaleTimeString('th-TH', {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
    }
    function renderHealth(health) {
      const box = el('auditLogHealth'); box.replaceChildren(); box.hidden = true;
      if (!health) return;
      // This is a since-start counter, not a promise that all historical records exist.
      const count = Number(health.write_failures_since_boot || 0);
      if (count > 0) { box.hidden = false; box.append(make('p', `ตั้งแต่เปิดโปรแกรมครั้งนี้ มีประวัติการเข้าใช้ที่บันทึกไม่สำเร็จ ${count} ครั้ง รายการอาจไม่ครบ`)); }
    }
    function renderRestore(restore) {
      const box = el('auditRestore'); box.replaceChildren();
      box.hidden = !restoreVisible(state.category, restore);
      if (box.hidden) return;
      box.append(make('h3', 'ผลการกู้ที่ตัวช่วยบันทึกไว้'), make('p', restore.message || 'ยังยืนยันผลการกู้ไม่ได้'));
      if (restore.backupCreatedAt) box.append(make('p', 'วันที่สร้างสำเนา: ' + dateText(restore.backupCreatedAt)));
      else if (restore.dateNotice) box.append(make('p', restore.dateNotice));
      if (restore.actor) box.append(make('p', 'ผู้ดำเนินการ: ' + restore.actor));
      box.append(make('p', restore.caveat || 'ข้อมูลนี้เป็นผลที่ตัวช่วยบันทึกไว้ ยังใช้ยืนยันที่มาของข้อมูลปัจจุบันไม่ได้'));
    }
    function showResult(id) {
      // Do not take focus away if the user has already started typing the next query.
      if (document.activeElement === el('auditQuery') && el('auditQuery').value.trim() !== state.q) return;
      el(id).focus({preventScroll:true}); el(id).scrollIntoView({block:'start'});
    }
    async function load(focusResults = false) {
      const generation = ++requestNumber;
      controls();
      el('auditError').hidden = true;
      el('auditResults').replaceChildren(); el('auditCandidates').hidden = true;
      el('auditCounts').textContent = ''; el('auditHiddenCount').textContent = '';
      el('auditMore').hidden = true; el('auditRestore').hidden = true;
      if (!state.from || !state.to || state.from > state.to) {
        el('auditResults').setAttribute('aria-busy', 'false'); el('auditStatus').textContent = 'ยังไม่ได้ค้นด้วยช่วงวันที่นี้';
        error('กรุณาเลือกวันเริ่มต้นและวันสิ้นสุด โดยวันสิ้นสุดต้องไม่อยู่ก่อนวันเริ่มต้น', false);
        if (focusResults) showResult('auditError'); return;
      }
      el('auditResults').setAttribute('aria-busy', 'true'); el('auditStatus').textContent = 'กำลังค้นประวัติ…';
      try {
        const data = await request('/api/admin/audit?' + query(state));
        if (generation !== requestNumber) return;
        render(data, generation);
        if (focusResults) showResult('auditStatus');
      } catch {
        if (generation !== requestNumber) return;
        el('auditStatus').textContent = 'ยังค้นประวัติไม่สำเร็จ';
        error('ยังติดต่อเพื่ออ่านประวัติไม่ได้ กรุณาลองอีกครั้ง หากออกจากระบบแล้วให้เข้าสู่ระบบใหม่', true);
        if (focusResults) showResult('auditError');
      } finally { if (generation === requestNumber) el('auditResults').setAttribute('aria-busy', 'false'); }
    }
    el('auditSearchForm').addEventListener('submit', event => { event.preventDefault(); readInputs(); state.limit = 50; load(true); });
    el('auditClear').addEventListener('click', () => { Object.assign(state, {category:'all',q:'',period:'7',quick:'',important:true,limit:50}, dates('7')); load(); el('auditQuery').focus(); });
    for (const node of root.querySelectorAll('[data-audit-period]')) node.addEventListener('click', () => {
      readInputs(); state.period = node.dataset.auditPeriod; state.limit = 50;
      if (state.period === 'custom') { controls(); el('auditFrom').focus(); }
      else { Object.assign(state, dates(state.period)); load(true); }
    });
    for (const node of root.querySelectorAll('[data-audit-category]')) node.addEventListener('click', () => switchCategory(node.dataset.auditCategory));
    for (const node of root.querySelectorAll('[data-audit-quick]')) node.addEventListener('click', () => { state.quick = node.dataset.auditQuick; switchCategory(quickCategories[state.quick], true); });
    el('auditIncludeRoutine').addEventListener('change', () => { readInputs(); state.important = !el('auditIncludeRoutine').checked; state.limit = 50; load(true); });
    el('auditMore').addEventListener('click', () => { state.limit = Math.min(1000, state.limit + 50); el('auditMore').disabled = true; load(true); });
    load();
    return { load };
  }
  return { mount, dates, dateText, query, safeLink, valueText, restoreVisible };
})();
if (typeof module !== 'undefined') module.exports = AuditView;
