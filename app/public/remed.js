'use strict';
// ใช้ร่วมกันระหว่างหน้าห้องตรวจและ regression test: เพิ่มยาเก่าโดยไม่ทับรายการปัจจุบัน
(function exposeRemed(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildRemedApi() {
  function drugKey(line) {
    if (!line || line.type !== 'drug') return null;
    if (line.ref_id !== undefined && line.ref_id !== null && String(line.ref_id) !== '') {
      return `ref:${String(line.ref_id)}`;
    }
    const name = String(line.name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    return name ? `name:${name}` : null;
  }

  function mergeRemedLines(currentLines, historicalLines) {
    const merged = Array.isArray(currentLines) ? currentLines.slice() : [];
    const seen = new Set(merged.map(drugKey).filter(Boolean));
    let added = 0;
    let skipped = 0;

    for (const source of Array.isArray(historicalLines) ? historicalLines : []) {
      const key = drugKey(source);
      if (!key) continue; // re-med เอาเฉพาะยา ไม่ลากค่าบริการ/ส่วนลดเก่ามา
      if (seen.has(key)) { skipped++; continue; }
      const copy = JSON.parse(JSON.stringify(source));
      delete copy._expanded;
      merged.push(copy);
      seen.add(key);
      added++;
    }
    return { lines: merged, added, skipped };
  }

  return { drugKey, mergeRemedLines };
});
