'use strict';
// Read-only enhancement of reports.html. No new clinical entry workflow.
(() => {
  const card = document.createElement('div');
  card.className = 'card'; card.id = 'drugMonthCard'; card.style.minWidth = '0';
  card.style.scrollMarginTop = '90px';
  card.innerHTML = `<details id="drugMonthDetails">
    <summary class="sec-sum"><h2 style="display:inline">💊 บริหารยารายเดือน</h2></summary>
    <div class="row" style="margin:10px 0;flex-wrap:wrap">
      <label>เดือน <input type="month" id="drugMonth" style="width:170px"></label>
      <label>เรียงตาม <select id="drugMonthSort"><option value="qty">จำนวนตามบิล</option><option value="profit">ส่วนต่างมากไปน้อย</option><option value="name">ชื่อยา</option></select></label>
      <button class="btn sm" id="drugMonthRetry">โหลดใหม่</button>
    </div>
    <p class="muted">ยอดขายจากใบเสร็จที่ยังไม่ยกเลิก ตามเดือนออกใบ ไม่ใช่เงินสดสุทธิหรือยอดยื่นภาษี
      · ส่วนลดทั้งบิลแบ่งตามสัดส่วนราคายาและบริการ เป็นค่าประมาณเพื่อบริหาร</p>
    <div id="drugMonthStatus" role="status" aria-live="polite"></div>
    <div style="overflow-x:auto;max-width:100%" tabindex="0" aria-label="ตารางบริหารยา เลื่อนแนวนอนเพื่อดูคอลัมน์เพิ่มเติม">
      <table class="t" id="drugMonthTable"></table>
    </div>
    <p class="muted">ส่วนต่าง = ยอดหลังส่วนลด − ทุนที่บันทึกตอนออกใบ ไม่ใช่ต้นทุนแยกล็อต และยังไม่หักค่าเช่า ค่าแรง หรือยาสูญเสีย
      · ข้อมูลต้นทุนขาดหรือมีแก้บิล/คืนเงินจะแสดงว่า “ต้องตรวจ” แทนการเดากำไร</p>
    <p class="muted">สต็อกและวันหมดอายุเป็นข้อมูลปัจจุบัน ไม่ใช่ยอดสิ้นเดือนที่เลือก
      · วันหมดอายุคือล็อตที่ยังไม่ปิด ต้องตรวจของจริง ระบบยังบอกจำนวนคงเหลือแยกล็อตไม่ได้</p>
  </details>`;
  document.querySelector('.cols > .stack').appendChild(card);
  const month = document.getElementById('drugMonth');
  const status = document.getElementById('drugMonthStatus');
  const table = document.getElementById('drugMonthTable');
  const sort = document.getElementById('drugMonthSort');
  let data = null, sequence = 0;
  const date = new Date();
  month.value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const amount = n => n == null ? 'ต้องตรวจ' : baht(n);
  function render() {
    if (!data) return;
    const rows = [...data.rows].sort((a, b) => sort.value === 'name' ? a.name.localeCompare(b.name, 'th')
      : sort.value === 'profit' ? (a.profit == null) - (b.profit == null) || (b.profit ?? 0) - (a.profit ?? 0)
      : b.qty - a.qty);
    table.innerHTML = `<thead><tr><th>ยา / หน่วย</th><th class="num">จำนวนตามบิล</th><th class="num">ก่อนลด</th><th class="num">ส่วนลดแบ่ง</th><th class="num">หลังลด</th><th class="num">ทุนตามบิล</th><th class="num">ส่วนต่าง</th><th class="num">คงเหลือตอนนี้</th><th>วันหมดอายุที่ต้องตรวจ</th></tr></thead><tbody>` +
      rows.map(r => `<tr><td>${esc(r.name)}<br><span class="muted">${esc(r.unit)}${r.drug_id != null ? ` · #${r.drug_id}` : ' · รายการเก่า'}</span>
        ${r.unknown_cost_lines ? '<br><span class="danger">ข้อมูลต้นทุนไม่ครบ</span>' : ''}
        ${r.review_receipts ? '<br><span class="danger">มีแก้บิล/ยกเลิก/คืนเงิน ต้องตรวจ</span>' : ''}
        ${r.allocation_incomplete ? '<br><span class="danger">ยอดกับรายการไม่ตรง ต้องตรวจ</span>' : ''}</td>
        <td class="num">${r.qty}</td><td class="num">${amount(r.gross)}</td><td class="num">${amount(r.discount)}</td>
        <td class="num">${amount(r.net)}</td><td class="num">${amount(r.cost)}</td><td class="num">${amount(r.profit)}</td>
        <td class="num">${r.stock_now == null ? 'เทียบหน่วยไม่ได้' : r.stock_now}</td>
        <td>${r.expiry_date ? esc(thDate(r.expiry_date)) : 'ไม่มีล็อตที่ระบุวัน'}</td></tr>`).join('') +
      (rows.length ? '' : '<tr><td colspan="9">ไม่มีรายการยาในเดือนนี้หรือในคลัง</td></tr>') + '</tbody>';
  }
  async function loadDrugMonth() {
    const request = ++sequence;
    data = null; table.innerHTML = ''; // never show old-month values under a new heading
    status.textContent = 'กำลังโหลดรายงานยา…';
    if (!month.value) { status.textContent = 'เลือกเดือนและปีก่อนดูรายงาน'; return; }
    try {
      const result = await api('GET', `/api/reports/drugs-monthly?month=${encodeURIComponent(month.value)}`);
      if (request !== sequence) return;
      data = result;
      status.textContent = `เดือน ${result.month} · ${result.issued_receipts} ใบที่ยังไม่ยกเลิก · ข้อมูล ณ ${result.as_of}${result.void_receipts ? ` · มีใบยกเลิกที่เกี่ยวข้อง ${result.void_receipts} ใบ ไม่ได้นำมาหักเป็นเงินคืนอัตโนมัติ` : ''}`;
      render();
    } catch (e) {
      if (request !== sequence) return;
      status.textContent = `โหลดรายงานไม่สำเร็จ: ${e.message} — กด “โหลดใหม่” เพื่อลองอีกครั้ง`;
    }
  }
  month.addEventListener('change', loadDrugMonth);
  sort.addEventListener('change', render);
  document.getElementById('drugMonthRetry').addEventListener('click', loadDrugMonth);
  document.getElementById('drugMonthDetails').addEventListener('toggle', e => {
    if (e.target.open && !data) loadDrugMonth();
  });
})();
