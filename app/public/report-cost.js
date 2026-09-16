'use strict';
// Presentation only: unknown receipt-time costs must never become numeric zero.
globalThis.ReportCost = Object.freeze({
  amount(value, unknown = false) {
    return unknown || value == null
      ? '<span class="muted cost-unavailable" role="img" aria-label="ยังไม่มีข้อมูลต้นทุนครบสำหรับยอดนี้">—</span>'
      : baht(value);
  },
  note(stats, { drugOnly = false } = {}) {
    const drug = stats.unknown_drug_cost_lines ?? (drugOnly ? stats.unknown_cost_lines : 0);
    const service = drugOnly ? 0 : (stats.unknown_service_cost_lines || 0);
    const total = stats.unknown_cost_lines ?? (drug + service);
    if (!total) return '';
    const parts = [];
    const links = [];
    if (drug) {
      parts.push(`ยา ${Number(drug)} รายการ`);
      links.push('<a href="/stock.html#drugTable">ตั้งต้นทุนยาสำหรับบิลใหม่</a>');
    }
    if (service) {
      parts.push(`บริการ / หัตถการ ${Number(service)} รายการ`);
      links.push('<a href="/stock.html#serviceCard">ตั้งต้นทุนบริการสำหรับบิลใหม่</a>');
    }
    const items = (stats.unknown_cost_items || []).map(item => `<li>${esc(item.name || 'ไม่ระบุชื่อ')} · ${item.line_type === 'drug' ? 'ยา' : 'บริการ / หัตถการ'} ${Number(item.lines)} รายการในใบเสร็จ</li>`).join('');
    return `<strong>ข้อมูลต้นทุนของใบเสร็จ</strong>
      <p>${parts.length ? parts.join(' · ') : `${Number(total)} รายการ`} ยังไม่มีต้นทุนที่บันทึกตอนออกใบเสร็จ (นับเป็นรายการในใบเสร็จ) รายรับยังแสดงตามปกติ</p>
      <p>ช่อง “—” หมายถึงยังแสดงต้นทุนรวมและส่วนต่างของยอดนั้นไม่ได้ ไม่ใช่ 0 บาท</p>
      ${items ? `<details class="cost-details"><summary>ดูรายการที่ไม่ได้บันทึกต้นทุน</summary><ul>${items}</ul></details>` : ''}
      <div class="cost-links">${links.join(' ')}</div>
      <p class="muted">ต้นทุนที่ตั้งใหม่ใช้กับบิลครั้งต่อไป บิลเก่าคงเดิม</p>`;
  },
});
