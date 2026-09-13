'use strict';
// Smoke test refuses to run until the target proves it is an isolated test
// instance. Always launch through test-http.js; never point this at production.
const fs = require('node:fs');
const BASE = process.argv[2];
const TEST_TOKEN = process.env.CLINIC_TEST_INSTANCE_TOKEN;
if (!BASE || !TEST_TOKEN) {
  console.error('SMOKE REFUSED: use `node test-http.js`; an explicit isolated URL and test token are required');
  process.exit(2);
}

let passed = 0, failed = 0;
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

function client(base = BASE) {
  let cookie = '';
  return async function call(method, path, body, expectStatus) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), cookie },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setC = res.headers.get('set-cookie');
    if (setC) cookie = setC.split(';')[0];
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = null; }
    if (expectStatus && res.status !== expectStatus) {
      throw new Error(`${method} ${path} → ${res.status} (คาด ${expectStatus}): ${JSON.stringify(data)}`);
    }
    return { status: res.status, data, text };
  };
}

(async () => {
  const guard = await fetch(BASE + '/api/test-instance', { headers: { 'X-Clinic-Test-Token': TEST_TOKEN } });
  if (guard.status !== 200 || !(await guard.json()).isolated) throw new Error('target did not prove it is an isolated test instance');
  const front = client(), doctor = client(), anon = client();

  console.log('--- auth ---');
  ok((await anon('GET', '/api/queue')).status === 401, 'ไม่ login → 401');
  await front('POST', '/api/login', { username: 'front', password: 'front123' }, 200);
  await doctor('POST', '/api/login', { username: 'doctor', password: 'doctor123' }, 200);
  ok((await front('POST', '/api/login', { username: 'front', password: 'wrong' })).status === 401, 'รหัสผิด → 401');
  if (process.env.SMOKE_FAST_IDLE === '1') {
    const idle = client(); await idle('POST', '/api/login', { username: 'doctor', password: 'doctor123' }, 200);
    await new Promise(r => setTimeout(r, 200)); await idle('GET', '/api/queue', undefined, 200);
    await new Promise(r => setTimeout(r, 200)); await idle('GET', '/api/queue', undefined, 200);
    await new Promise(r => setTimeout(r, 200));
    ok((await idle('GET', '/api/queue')).status === 423, 'polling GET ไม่ต่ออายุ idle session');
    if (process.env.SMOKE_IDLE_ONLY === '1') {
      console.log(`\n=== ผล idle lock: ${passed} ผ่าน / ${failed} ตก ===`);
      process.exit(failed ? 1 : 0);
    }
    // การรอทดสอบ idle ทำให้ session หลักหมดอายุด้วย จึง login ใหม่ก่อน flow ถัดไป
    await front('POST', '/api/login', { username: 'front', password: 'front123' }, 200);
    await doctor('POST', '/api/login', { username: 'doctor', password: 'doctor123' }, 200);
  }

  console.log('--- register + queue ---');
  for (const [label, roleClient] of [['front', front], ['doctor', doctor]]) {
    const me = await roleClient('GET', '/api/me', undefined, 200);
    ok(me.data.app_version === require('./package.json').version, label + ' อ่านรุ่นได้');
    ok((await roleClient('GET', '/api/users')).status === 403, label + ' ยังไม่มีสิทธิ์ผู้ดูแล');
  }
  const reg = await front('POST', '/api/patients', {
    first_name: 'สมชาย', last_name: 'ทดสอบดี', sex: 'M', birth_date: '1990-05-01',
    phone: '081-234-5678', allergies: 'Penicillin', chronic: 'HT',
    emergency_name: 'สมศรี (ภรรยา)', emergency_phone: '089-999-8888',
  }, 201);
  const hn = reg.data.hn;
  ok(/^\d{2}-\d{4}$/.test(hn), `HN format ถูก (${hn})`);
  const pat = (await front('GET', `/api/patients/${hn}`, undefined, 200)).data;
  ok(pat.allergies.length === 1 && pat.allergies[0].substance === 'Penicillin', 'บันทึกแพ้ยาตอน register');
  ok(pat.emergency_name === 'สมศรี (ภรรยา)' && pat.emergency_phone === '089-999-8888', 'บันทึกผู้ติดต่อฉุกเฉิน');
  const s1 = (await front('GET', '/api/patients/search?q=สมชาย', undefined, 200)).data;
  ok(s1.some(p => p.hn === hn), 'ค้นด้วยชื่อเจอ');
  const s2 = (await front('GET', '/api/patients/search?q=0812345678', undefined, 200)).data;
  ok(s2.some(p => p.hn === hn), 'ค้นด้วยเบอร์ (normalize ขีด) เจอ');
  ok((await front('POST', `/api/patients/${hn}/attachments`, {
    filename: 'unsafe.html', mime: 'text/html', data_base64: Buffer.from('<script>x</script>').toString('base64'),
  })).status === 400, 'ปฏิเสธไฟล์แนบ HTML ที่อาจรัน script');

  const visit = await front('POST', '/api/visits', { hn, vitals: { weight_kg: 70, bp_sys: 145, bp_dia: 92 } }, 201);
  const vid = visit.data.id;
  ok(visit.data.queue_no >= 1, `ได้เลขคิว ${visit.data.queue_no}`);
  ok((await front('POST', '/api/visits', { hn })).status === 400, 'เข้าคิวซ้ำขณะมีคิวค้าง → block');

  console.log('--- state machine guards ---');
  ok((await front('POST', `/api/visits/${vid}/call`)).status === 403, 'front เรียกตรวจไม่ได้ (role)');
  ok((await doctor('POST', `/api/visits/${vid}/finish-exam`)).status === 409, 'ข้าม state (WAITING→จบตรวจ) → 409');
  ok((await front('POST', `/api/visits/${vid}/pay`, { order_version_id: 1, pay_method: 'cash' })).status !== 201, 'จ่ายเงินก่อนตรวจ → ไม่ผ่าน');

  console.log('--- exam ---');
  await doctor('POST', `/api/visits/${vid}/call`, {}, 200);
  const drugs = (await doctor('GET', '/api/items/search?q=Para', undefined, 200)).data;
  const para = drugs.find(d => d.type === 'drug');
  const svc = (await doctor('GET', '/api/items/search?q=ค่าตรวจ', undefined, 200)).data.find(d => d.type === 'service');
  const finish1 = await doctor('POST', `/api/visits/${vid}/finish-exam`, {
    note: { cc: 'ปวดหัว มีไข้ 2 วัน', hpi: 'ไข้ต่ำๆ ไอ เจ็บคอ', pe: 'pharynx injected', dx_text: 'URI', icd10: 'J06.9', note: 'ดื่มน้ำมากๆ พัก' },
    lines: [
      { type: 'drug', ref_id: para.id, qty: 10 },
      { type: 'service', ref_id: svc.id, qty: 1 },
    ], base_version_id: null,
  }, 200);
  const ov1 = { data: finish1.data.order };
  const vAfter = (await doctor('GET', `/api/visits/${vid}`, undefined, 200)).data;
  ok(vAfter.state === 'DISPENSING', 'จบตรวจ → DISPENSING');
  ok(vAfter.note_versions.length === 1 && vAfter.note_versions[0].dx_text === 'URI', 'draft ถูก promote เป็นเวชระเบียน version 1');
  ok(vAfter.note_versions[0].vitals_json.includes('145'), 'vitals snapshot เข้า note');
  ok(vAfter.draft === null, 'draft ถูกล้างหลัง promote');

  console.log('--- front แก้ order + pay ---');
  const staleId = ov1.data.id;
  ok((await front('POST', `/api/visits/${vid}/orders`, {
    lines: ov1.data.lines.map(l => l.type === 'drug' ? { ...l, qty: 20 } : l),
    base_version_id: staleId, edit_reason: 'ลองเพิ่มเกินคำสั่ง',
  })).status === 403, 'front เพิ่มจำนวนยาเกินคำสั่งแพทย์ไม่ได้');
  const ov2 = await front('POST', `/api/visits/${vid}/orders`, {
    lines: ov1.data.lines.map(l => l.type === 'drug' ? { ...l, qty: 5 } : l),
    base_version_id: staleId, edit_reason: 'จ่ายได้บางส่วน (ทดสอบ)',
  }, 201);
  ok((await front('POST', `/api/visits/${vid}/pay`, { order_version_id: staleId, pay_method: 'cash' })).status === 409,
    'จ่ายด้วย order version เก่า → 409 (เงินตรงใบเสร็จเสมอ)');
  const qtyBefore = (await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id).qty_on_hand;
  const payBody = { order_version_id: ov2.data.id, discount: 20, discount_reason: 'ลูกค้าประจำ', pay_method: 'cash',
    op_id: 'ab12ab12-0000-4000-8000-000000000001' }; // exactly-once (1.0.4): op ต่อความพยายามเก็บเงิน
  const pay = await front('POST', `/api/visits/${vid}/pay`, payBody, 201);
  const receiptNo = pay.data.receiptNo;
  ok(/^RC\d{4}-\d{5}$/.test(receiptNo), `เลขใบเสร็จถูก format (${receiptNo})`);
  ok(pay.data.total === pay.data.subtotal - 20, 'total = subtotal - discount');
  const qtyAfter = (await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id).qty_on_hand;
  ok(qtyBefore - qtyAfter === 5, `stock ตัด 5 ตอนจ่ายเงิน (${qtyBefore}→${qtyAfter})`);
  ok((await front('GET', `/api/visits/${vid}`, undefined, 200)).data.state === 'COMPLETED', 'จ่ายแล้ว → COMPLETED');
  ok((await front('POST', `/api/visits/${vid}/pay`, payBody, 201)).data.receiptNo === receiptNo,
    'กดซ้ำ op เดิม → ได้ใบเสร็จเดิม ไม่เก็บเงินซ้ำ (exactly-once)');
  ok((await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id).qty_on_hand === qtyAfter,
    'กดซ้ำแล้วสต็อกไม่ถูกตัดเพิ่ม');
  const payDup = await front('POST', `/api/visits/${vid}/pay`, { order_version_id: ov2.data.id, pay_method: 'cash' });
  ok(payDup.status === 409 && !/UNIQUE|constraint/i.test(payDup.data.error) && payDup.data.error.includes(receiptNo),
    'จ่ายซ้ำ (ไม่มี op) → 409 ภาษาคน + ชี้เลขใบเสร็จเดิม (กันเก็บเงินสองรอบ)');

  console.log('--- ack ---');
  const acks = (await doctor('GET', '/api/pending-acks', undefined, 200)).data;
  ok(acks.some(a => a.id === ov2.data.id), 'รายการที่ front แก้ขึ้นคิว ack ของหมอ');
  await doctor('POST', `/api/orders/${ov2.data.id}/ack`, {}, 200);
  ok(!(await doctor('GET', '/api/pending-acks', undefined, 200)).data.some(a => a.id === ov2.data.id), 'ack แล้วหายจากคิว');

  console.log('--- void-reissue ---');
  const re = await front('POST', `/api/receipts/${receiptNo}/void-reissue`, {
    new_lines: [{ type: 'drug', ref_id: para.id, qty: 3 }, { type: 'service', ref_id: svc.id, qty: 1 }],
    returned_stock: true, void_reason: 'คีย์จำนวนผิด', pay_method: 'cash',
  }, 201);
  const oldR = (await front('GET', `/api/receipts/${receiptNo}`, undefined, 200)).data;
  ok(oldR.status === 'VOID', 'ใบเดิม → VOID');
  const newR = (await front('GET', `/api/receipts/${re.data.receiptNo}`, undefined, 200)).data;
  ok(newR.status === 'ISSUED', 'ใบใหม่ ISSUED ใน txn เดียวกัน');
  const qtyAfterReissue = (await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id).qty_on_hand;
  ok(qtyAfterReissue === qtyBefore - 3, `void คืน 5 + จ่ายใหม่ 3 → สุทธิ -3 (${qtyAfterReissue})`);
  ok((await front('POST', `/api/receipts/${receiptNo}/refund`, { reason: 'x', returned_stock: false })).status === 409,
    'refund ใบที่ VOID ไปแล้ว → 409');

  console.log('--- คนไข้คนที่ 2: cancel + refund ---');
  const reg2 = await front('POST', '/api/patients', { first_name: 'สมหญิง', sex: 'F' }, 201);
  const v2 = await front('POST', '/api/visits', { hn: reg2.data.hn }, 201);
  await front('POST', `/api/visits/${v2.data.id}/cancel`, { reason: 'คนไข้กลับก่อน' }, 200);
  ok((await front('GET', `/api/visits/${v2.data.id}`, undefined, 200)).data.state === 'CANCELLED', 'cancel จาก WAITING');
  ok((await front('POST', `/api/visits/${v2.data.id}/cancel`, { reason: 'ซ้ำ' })).status === 409, 'cancel ซ้ำ → 409');

  const v3 = await front('POST', '/api/visits', { hn: reg2.data.hn }, 201);
  await doctor('POST', `/api/visits/${v3.data.id}/call`, {}, 200);
  await doctor('POST', `/api/visits/${v3.data.id}/requeue`, {}, 200);
  ok((await doctor('GET', `/api/visits/${v3.data.id}`, undefined, 200)).data.state === 'WAITING', 'คืนคิว → WAITING');
  await doctor('POST', `/api/visits/${v3.data.id}/call`, {}, 200);
  await doctor('POST', `/api/visits/${v3.data.id}/finish-exam`, {
    note: { dx_text: 'ทดสอบ' }, lines: [{ type: 'service', ref_id: svc.id, qty: 1 }], base_version_id: null,
  }, 200);
  const v3o = (await front('GET', `/api/visits/${v3.data.id}`, undefined, 200)).data;
  const pay3 = await front('POST', `/api/visits/${v3.data.id}/pay`, { order_version_id: v3o.order.id, pay_method: 'transfer' }, 201);
  const rf = await front('POST', `/api/receipts/${pay3.data.receiptNo}/refund`, { reason: 'คนไข้ขอคืน', returned_stock: false }, 200);
  ok(rf.data.refund_amount === pay3.data.total, 'refund เต็มจำนวน');
  ok((await front('GET', `/api/visits/${v3.data.id}`, undefined, 200)).data.state === 'CANCELLED', 'refund → CANCELLED');

  // ตัวช่วยตั้งค่ากระดาษใบเสร็จ/ใบนัด (ใช้ session admin แยกต่างหาก)
  const admin0 = client(); await admin0('POST', '/api/login', { username: 'admin', password: 'admin1234' }, 200);
  const admin0Settings = async (slip) => admin0('POST', '/api/settings', { slip_paper: slip }, 200);
  console.log('--- med cert + amend note ---');
  const mcBody = { diagnosis_text: 'ป่วยจริง', rest_days: '2',
    op_id: 'ab12ab12-0000-4000-8000-000000000002' }; // exactly-once (1.0.4): visit เดียวออกหลายใบได้ ต้องพึ่ง op
  const mc = await doctor('POST', `/api/visits/${vid}/medcert`, mcBody, 201);
  ok(/^MC\d{4}-\d{4}$/.test(mc.data.cert_no), `เลขใบรับรอง (${mc.data.cert_no})`);
  ok((await doctor('POST', `/api/visits/${vid}/medcert`, mcBody, 201)).data.cert_no === mc.data.cert_no,
    'กดซ้ำ op เดิม → ได้ใบรับรองเลขเดิม ไม่ออกใบซ้ำ (exactly-once)');
  const mcEdited = await doctor('POST', `/api/visits/${vid}/medcert`, { ...mcBody, rest_days: '3' });
  ok(mcEdited.status === 409 && mcEdited.data.already_issued && mcEdited.data.already_issued.cert_no === mc.data.cert_no,
    'แก้ฟอร์มแล้วกดซ้ำ → 409 ชี้ใบเดิม (already_issued) ไม่ออกใบใหม่');
  ok((await doctor('GET', `/api/visits/${vid}`, undefined, 200)).data.med_certs.length === 1,
    'ผ่านทุกท่ากดซ้ำ ใบรับรองยังใบเดียว');
  const printCert = await fetch(`${BASE}/print/medcert/${mc.data.cert_no}`);
  ok(printCert.status === 401 || printCert.status === 200, 'print cert endpoint ตอบ');
  // หมอ feedback 17 ส.ค.: ใบรับรองธรรมดา A4 เต็มแผ่น · ใบเสร็จ/ใบนัด อยู่ครึ่งบน A4 มีรอยประ · ไม่มีหัว/ท้ายกระดาษของเบราว์เซอร์ (margin 0)
  const certHtml = (await doctor('GET', `/print/medcert/${mc.data.cert_no}`, undefined, 200)).text;
  ok(/@page \{ size: A4; margin: 0; \}/.test(certHtml) && !/size: A5/.test(certHtml), 'ใบรับรองแพทย์ค่าเริ่มต้นพิมพ์ A4 เต็มแผ่น ไม่มีขอบเบราว์เซอร์');
  const rcHtml = (await front('GET', `/print/receipt/${receiptNo}`, undefined, 200)).text;
  ok(/size: A4; margin: 0/.test(rcHtml) && /class="cutline"/.test(rcHtml) && /receipt-half/.test(rcHtml), 'ใบเสร็จค่าเริ่มต้น = A4 ครึ่งบน + รอยประฉีกแบ่ง');
  await admin0Settings('A5');
  const rcA5 = (await front('GET', `/print/receipt/${receiptNo}`, undefined, 200)).text;
  ok(/size: A5/.test(rcA5) && !/class="cutline"/.test(rcA5), 'เลือก A5 ในหน้าตั้งค่า → ใบเสร็จกลับเป็น A5 ไม่มีรอยประ');
  await admin0Settings('A4-half');
  // เจ้าของ 17 ส.ค.: "เอาตามที่จะเกิดได้ทุกรูปแบบ" — กระดาษแยกรายเอกสาร (receipt_paper/appointment_paper) + สลิปความร้อน + ตัวอย่าง + override ต่อครั้ง
  ok(/<div class="half">/.test(rcHtml) && /bottom: 0; border-top: 1px dashed/.test(rcHtml), 'A4 ครึ่งบน: รอยประอยู่ในกล่องครึ่งบน (จอ = กระดาษ ไม่ล้นเพราะปุ่มพิมพ์ดัน)');
  const paperSet = body => admin0('POST', '/api/settings', body, 200);
  const apptForPrint = await doctor('POST', `/api/visits/${vid}/appointment`, { days: 7, note: 'ทดสอบกระดาษ' }, 201);
  const apptPrintId = apptForPrint.data.id;
  await paperSet({ receipt_paper: 'R80' });
  const rcR80 = (await front('GET', `/print/receipt/${receiptNo}`, undefined, 200)).text;
  ok(/size: 80mm 150mm/.test(rcR80) && /class="sheet receipt-thermal thermal"/.test(rcR80) && !/class="cutline"/.test(rcR80) && /×/.test(rcR80), 'ใบเสร็จตั้งเป็นสลิป 80 มม. → หน้ากว้าง 80 ยาวตามเนื้อหา รายการแบบ 2 บรรทัด ไม่มีรอยประ');
  const apptStill = (await front('GET', `/print/appointment/${apptPrintId}`, undefined, 200)).text;
  ok(/size: A4; margin: 0/.test(apptStill) && /class="cutline"/.test(apptStill), 'ใบนัดไม่ผูกกับใบเสร็จอีกต่อไป — ยังเป็น A4 ครึ่งบนตามค่าเดิม');
  await paperSet({ appointment_paper: 'A5' });
  const apptA5 = (await front('GET', `/print/appointment/${apptPrintId}`, undefined, 200)).text;
  ok(/size: A5/.test(apptA5) && !/class="cutline"/.test(apptA5), 'ตั้งใบนัดเป็น A5 แยกจากใบเสร็จได้');
  const rcOverride = (await front('GET', `/print/receipt/${receiptNo}?paper=A4`, undefined, 200)).text;
  ok(/size: A4; margin: 0/.test(rcOverride) && !/class="cutline"/.test(rcOverride) && /receipt-a4/.test(rcOverride), '?paper=A4 พิมพ์แบบอื่นเฉพาะครั้งนี้ (ค่าตั้งยัง R80)');
  const rcBad = (await front('GET', `/print/receipt/${receiptNo}?paper=B7`, undefined, 200)).text;
  ok(/size: 80mm 150mm/.test(rcBad), 'ค่ากระดาษที่ไม่รู้จักถูกเมิน → ใช้ค่าตั้ง');
  const sampleRc = (await admin0('GET', '/print/sample/receipt?paper=R58', undefined, 200)).text;
  ok(/size: 58mm 150mm/.test(sampleRc) && /ตัวอย่าง/.test(sampleRc) && /RC0000-SAMPLE/.test(sampleRc), 'ตัวอย่างใบเสร็จสลิป 58 มม. (ข้อมูลสมมติ ประทับ "ตัวอย่าง")');
  const sampleAp = (await admin0('GET', '/print/sample/appointment?paper=A4-half', undefined, 200)).text;
  ok(/class="cutline"/.test(sampleAp) && /ตัวอย่าง/.test(sampleAp) && /ทดลองพิมพ์/.test(sampleAp), 'ตัวอย่างใบนัด A4 ครึ่งบน');
  // ขนาดตัวอักษรใบรับรอง (1.0.5 — หมอ feedback 2026-08-31 "ตัวอักษรเล็กไปนิด"): ตัวอย่าง + ปุ่มปรับเอง
  const sampleMc = (await admin0('GET', '/print/sample/medcert?paper=A5', undefined, 200)).text;
  ok(/size: A5/.test(sampleMc) && /ตัวอย่าง/.test(sampleMc) && /MC0000-SAMPLE/.test(sampleMc) && /medcert-general-a5/.test(sampleMc),
    'ตัวอย่างใบรับรองแพทย์ A5 (ข้อมูลสมมติ ประทับ "ตัวอย่าง")');
  const sampleMc100 = (await admin0('GET', '/print/sample/medcert?paper=A4&scale=100', undefined, 200)).text;
  const sampleMc125 = (await admin0('GET', '/print/sample/medcert?paper=A4&scale=125', undefined, 200)).text;
  ok(sampleMc100 !== sampleMc125 && /font-size:\d+(\.\d+)?px/.test(sampleMc125), 'scale=125 ให้ตัวอักษรใหญ่กว่ามาตรฐานจริง');
  ok((await admin0('GET', '/print/sample/medcert?paper=A4&scale=999', undefined, 200)).text === sampleMc100,
    'ค่า scale ที่ไม่รู้จักถูกเมิน → เท่ามาตรฐาน');
  await admin0('POST', '/api/settings', { medcert_font_scale: '125' }, 200);
  ok((await admin0('GET', '/print/sample/medcert?paper=A4', undefined, 200)).text === sampleMc125,
    'บันทึก medcert_font_scale = 125 แล้ว การพิมพ์ที่ไม่ส่ง scale ใช้ค่าที่ตั้งไว้');
  await admin0('POST', '/api/settings', { medcert_font_scale: '100' }, 200);
  // ขนาดตัวอักษรใบเสร็จ (หมอ feedback 2026-08-31 "ใบเสร็จก็เล็กไป") — A4 เต็มหน้าขยายได้จริง, ครึ่งบนถูก cap ที่ 112
  const sampleRc100 = (await admin0('GET', '/print/sample/receipt?paper=A4&scale=100', undefined, 200)).text;
  const sampleRc125 = (await admin0('GET', '/print/sample/receipt?paper=A4&scale=125', undefined, 200)).text;
  ok(sampleRc100 !== sampleRc125, 'ใบเสร็จ A4 scale=125 ตัวอักษรใหญ่กว่ามาตรฐานจริง');
  const rcHalf112 = (await admin0('GET', '/print/sample/receipt?paper=A4-half&scale=112', undefined, 200)).text;
  const rcHalf125 = (await admin0('GET', '/print/sample/receipt?paper=A4-half&scale=125', undefined, 200)).text;
  ok(rcHalf112 === rcHalf125, 'ครึ่งบนมีรอยประเป็นเส้นตาย → 125 ถูก cap เท่า 112 (เอกสารต้องจบเหนือรอยประ)');
  await admin0('POST', '/api/settings', { receipt_font_scale: '112' }, 200);
  ok((await admin0('GET', '/print/sample/receipt?paper=A4-half', undefined, 200)).text === rcHalf112,
    'บันทึก receipt_font_scale แล้ว การพิมพ์ที่ไม่ส่ง scale ใช้ค่าที่ตั้งไว้');
  await admin0('POST', '/api/settings', { receipt_font_scale: '100' }, 200);
  // ใบนัดก็ปรับขนาดได้ (ครบทุกเอกสาร — เจ้าของ 2026-08-31 "อย่าเหมารวม") · ครึ่งบน cap 112 เท่าใบเสร็จ
  const ap100 = (await admin0('GET', '/print/sample/appointment?paper=A4&scale=100', undefined, 200)).text;
  ok((await admin0('GET', '/print/sample/appointment?paper=A4&scale=125', undefined, 200)).text !== ap100,
    'ใบนัด A4 scale=125 ตัวอักษรใหญ่กว่ามาตรฐานจริง');
  ok((await admin0('GET', '/print/sample/appointment?paper=A4-half&scale=125', undefined, 200)).text
    === (await admin0('GET', '/print/sample/appointment?paper=A4-half&scale=112', undefined, 200)).text,
    'ใบนัดครึ่งบนถูก cap ที่ 112 (รอยประ = เส้นตาย — วัดจริงกับ footer ยาว)');
  await admin0('GET', '/print/sample/nothing', undefined, 404);
  await front('GET', '/print/receipt/RC0000-SAMPLE', undefined, 404);
  ok(true, 'ตัวอย่างไม่บันทึกลงฐาน (เลขที่ตัวอย่างไม่มีจริง)');
  await paperSet({ receipt_paper: '', appointment_paper: '' });
  const rcBack = (await front('GET', `/print/receipt/${receiptNo}`, undefined, 200)).text;
  ok(/class="cutline"/.test(rcBack), 'ล้างค่าใหม่ → กลับไปใช้ค่าเดิม (slip_paper/ค่าเริ่มต้น A4 ครึ่งบน)');
  await doctor('POST', `/api/visits/${vid}/amend-note`, { cc: 'แก้ไข', dx_text: 'URI (updated)' }, 201);
  const vFinal = (await doctor('GET', `/api/visits/${vid}`, undefined, 200)).data;
  ok(vFinal.note_versions.length === 2, 'amend = version ใหม่ (เก่าไม่หาย)');

  console.log('--- พิมพ์ที่หน้าร้าน (เครื่องพิมพ์อยู่หน้าร้านเครื่องเดียว) ---');
  ok((await front('GET', '/api/me', undefined, 200)).data.is_host === true, 'เครื่องที่รัน server (loopback) = เครื่องหน้าร้านที่มีเครื่องพิมพ์');
  const lanDoctor = client(process.env.SMOKE_LAN_BASE);
  await lanDoctor('POST', '/api/login', { username: 'doctor', password: 'doctor123' }, 200);
  ok((await lanDoctor('GET', '/api/me', undefined, 200)).data.is_host === false, 'เครื่องห้องตรวจผ่าน LAN = ไม่มีเครื่องพิมพ์');
  const pendingOf = async () => ((await front('GET', '/api/queue', undefined, 200)).data.queue
    .find(x => x.id === vid) || {}).pending_docs || [];
  ok((await pendingOf()).some(d => d.doc_ref === mc.data.cert_no), 'ใบที่หมอออกขึ้น "รอพิมพ์" บนการ์ดคิวของหน้าร้าน');
  await lanDoctor('POST', '/api/documents/print-event', { doc_type: 'medcert', doc_ref: mc.data.cert_no, visit_id: vid }, 201);
  const viewed = (await pendingOf()).find(d => d.doc_ref === mc.data.cert_no);
  ok(viewed && viewed.viewed_at, 'หมอเปิดดูจากเครื่อง LAN → ยังรอพิมพ์อยู่ แต่บอกได้ว่าเปิดดูแล้ว');
  const printed = await front('POST', '/api/documents/print-event', { doc_type: 'medcert', doc_ref: mc.data.cert_no, visit_id: vid }, 201);
  ok(printed.data.station === 'host', 'สั่งพิมพ์จากเครื่องหน้าร้านบันทึกเป็น station host');
  ok(!(await pendingOf()).some(d => d.doc_ref === mc.data.cert_no), 'พิมพ์ที่หน้าร้านแล้วป้ายรอพิมพ์หาย');
  const visitDocs = (await front('GET', `/api/visits/${vid}`, undefined, 200)).data;
  ok(visitDocs.print_events.filter(e => e.doc_ref === mc.data.cert_no).length === 2, 'ประวัติการพิมพ์เก็บครบทั้งสองเครื่อง');
  ok((await anon('POST', '/api/documents/print-event', { doc_type: 'medcert', doc_ref: mc.data.cert_no, visit_id: vid })).status === 401,
    'ผู้ไม่ได้ login บันทึกการพิมพ์ไม่ได้');
  ok((await front('POST', '/api/documents/print-event', { doc_type: 'ใบอื่น', doc_ref: 'x', visit_id: vid })).status === 400,
    'ชนิดเอกสารนอกรายการถูกปฏิเสธ');

  console.log('--- duplicate + history + reports + backup ---');
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'admin1234' }, 200);
  const lanAdmin = client(process.env.SMOKE_LAN_BASE);
  await lanAdmin('POST', '/api/login', { username: 'admin', password: 'admin1234' }, 200);
  ok((await lanAdmin('POST', '/api/update/apply', {})).status === 403, 'เครื่องที่สองผ่าน LAN สั่งอัปเดตไม่ได้');
  ok((await admin('POST', '/api/update/apply', {})).status === 409, 'มี session เครื่องอื่นใช้งานอยู่ → เลื่อนอัปเดต');
  ok((await admin('POST', '/api/visits', { hn })).status === 403, 'admin ไม่ได้สิทธิ์หน้าคลินิกโดยปริยาย');
  ok((await doctor('GET', '/api/users')).status === 403, 'แพทย์อ่าน/จัดการบัญชีผู้ใช้ไม่ได้');
  await admin('POST', '/api/settings', { clinic_name: 'คลินิกทดสอบ', document_footer: 'เอกสารทดสอบ' }, 200);
  const adminSettings = (await admin('GET', '/api/settings', undefined, 200)).data;
  const doctorSettings = (await doctor('GET', '/api/settings', undefined, 200)).data;
  ok(adminSettings.document_footer === 'เอกสารทดสอบ' && !('backup_dest_1' in doctorSettings), 'settings ส่วนผู้ดูแลไม่รั่วไป role อื่น');
  const logo = await admin('POST', '/api/settings/logo', {
    mime: 'image/png', data_base64: Buffer.from('test-png-content').toString('base64'),
  }, 200);
  ok(/^clinic-logo-.*\.png$/.test(logo.data.file), 'อัปโหลดโลโก้เก็บเป็นชื่อ hash');
  const recovery = await admin('GET', '/api/backup/recovery-key', undefined, 410);
  ok(!recovery.data.key && /Recovery Kit/.test(recovery.data.error), 'ไม่ส่ง Recovery Key ผ่าน browser/API');
  const recoveryHealth = await admin('GET', '/api/recovery/health', undefined, 200);
  ok(recoveryHealth.data.state === 'action', 'สถานะกู้ข้อมูลบอก action ภาษาคน');
  const adminUser = (await admin('GET', '/api/users', undefined, 200)).data.find(u => u.username === 'admin');
  await admin('PATCH', `/api/users/${adminUser.id}`, { password: 'Changed-admin-123' }, 200);
  ok((await admin('GET', '/api/me', undefined, 200)).data.setup_required === false, 'เปลี่ยนรหัส admin แล้วปิด setup warning');
  const hist = (await doctor('GET', `/api/patients/${hn}/history`, undefined, 200)).data;
  ok(hist.length >= 1 && hist[0].note, 'history มี note');
  const rpt = (await front('GET', '/api/reports/daily', undefined, 200)).data;
  // เหลือ ISSUED ใบเดียว (ใบแรกโดน void-reissue, ใบสามโดน refund) ยอด = 3×2 + 100 = 106
  ok(rpt.money.receipts === 1 && rpt.money.total === 106, `รายงานนับเฉพาะ ISSUED: ${rpt.money.receipts} ใบ ยอด ${rpt.money.total}`);
  ok(rpt.voids.length >= 2, 'รายงานแสดง void');
  const recon = (await front('GET', '/api/stock/reconcile', undefined, 200)).data;
  ok(recon.length === 0, 'stock cache ตรง ledger ทุกตัว');
  ok((await anon('POST', '/api/backup/run', {})).status === 401, 'ผู้ไม่ login สั่ง backup ไม่ได้');
  const frontBk = await front('POST', '/api/backup/run', {}, 200);
  ok(frontBk.data.ok === 1, 'หน้าคลินิกสั่ง backup ได้');
  // ชื่อ snapshot ละเอียดถึงวินาที จึงเว้นให้แต่ละ role ได้ทดสอบไฟล์คนละชื่อ
  await new Promise(resolve => setTimeout(resolve, 1100));
  const doctorBk = await doctor('POST', '/api/backup/run', {}, 200);
  ok(doctorBk.data.ok === 1, 'แพทย์สั่ง backup ได้');
  await new Promise(resolve => setTimeout(resolve, 1100));
  const adminBk = await admin('POST', '/api/backup/run', {}, 200);
  ok(adminBk.data.ok === 1, 'ผู้ดูแลสั่ง backup ได้');
  const csv = await fetch(`${BASE}/api/export/receipts`, { headers: { cookie: '' } });
  ok(csv.status === 401, 'export ต้อง login');

  console.log('--- security round 1: HTTPS LAN / Host-Origin / limiter / access log ---');
  // A-refined: HTTP เปิดเฉพาะ loopback — LAN ผ่าน HTTP ต้องต่อไม่ติด, LAN ผ่าน HTTPS ต้องใช้ได้และ cookie ติด Secure
  let lanHttpRefused = false;
  try { await fetch(process.env.SMOKE_LAN_HTTP_BASE + '/api/me', { signal: AbortSignal.timeout(3000) }); } catch { lanHttpRefused = true; }
  ok(lanHttpRefused, 'LAN ผ่าน HTTP ต่อไม่ได้ (server ผูกเฉพาะ 127.0.0.1)');
  const lanLoginRes = await fetch(process.env.SMOKE_LAN_BASE + '/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'front', password: 'front123' }) });
  ok(lanLoginRes.status === 200, 'LAN ผ่าน HTTPS login ได้');
  ok(/;\s*Secure/i.test(lanLoginRes.headers.get('set-cookie') || ''), 'cookie บน HTTPS ติด Secure');
  const loopLoginRes = await fetch(BASE + '/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'front', password: 'front123' }) });
  ok(!/Secure/i.test(loopLoginRes.headers.get('set-cookie') || ''), 'cookie บน HTTP loopback ไม่ติด Secure (localhost ต้องใช้ได้)');
  ok((await fetch(process.env.SMOKE_LAN_BASE + '/api/system/prepare-restore', { method: 'POST' })).status === 403, 'prepare-restore จาก LAN (HTTPS) ยังโดน 403');
  // Host allowlist: Host แปลกหน้า (DNS rebinding) → 403 ทั้ง API และหน้าเว็บ; Origin เว็บอื่น → 403
  // fetch ของ Node ไม่ยอมให้ตั้ง Host เอง → ใช้ http.request ตรง
  const rawStatus = (hostHeader, urlPath) => new Promise((resolve, reject) => {
    const u = new URL(BASE);
    const req = require('node:http').request({ host: u.hostname, port: u.port, path: urlPath, method: 'GET', headers: { Host: hostHeader } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  ok((await rawStatus('evil.example:80', '/api/me')) === 403, 'Host ที่ไม่ใช่เครื่องนี้ → 403 (กัน DNS rebinding)');
  ok((await rawStatus('evil.example', '/login.html')) === 403, 'หน้าเว็บก็ไม่เสิร์ฟให้ Host แปลกหน้า');
  ok((await rawStatus(`${process.env.SMOKE_LAN_IP}:${new URL(BASE).port}`, '/api/me')) !== 403, 'Host เป็น IP ของเครื่องนี้ → ผ่าน');
  ok((await rawStatus(`${require('node:os').hostname()}:${new URL(BASE).port}`, '/api/me')) !== 403, 'Host เป็นชื่อเครื่องนี้ → ผ่าน');
  ok((await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ username: 'front', password: 'front123' }) })).status === 403, 'Origin เว็บอื่น → 403 (กัน CSRF)');
  ok((await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ username: 'front', password: 'front123' }) })).status === 200, 'Origin เครื่องนี้ → ผ่าน');
  const hdr = await fetch(BASE + '/api/me');
  ok(hdr.headers.get('x-frame-options') === 'DENY' && hdr.headers.get('x-content-type-options') === 'nosniff'
    && (hdr.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'") && hdr.headers.get('cache-control') === 'no-store',
    'security headers ครบทุก response ของ API');
  ok((await fetch(BASE + '/login.html')).headers.get('x-frame-options') === 'DENY', 'หน้าเว็บ static ก็มี security headers');
  // limiter: จากเครื่อง host (loopback) เพดานหลวม 2 เท่า = เริ่มหน่วงหลังผิด 6 ครั้ง (LAN = 3 ครั้ง)
  // → ผิด 6 ครั้ง (ชื่อผู้ใช้เดียวกัน) แล้วครั้งถัดไปโดน 429 พร้อมข้อความภาษาคน; ผู้ใช้ถูกต้องคนอื่นจากเครื่องเดียวกันยังเข้าได้
  const badLogin = () => fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nobody-limiter', password: 'wrong-pass' }) });
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await badLogin()).status);
  ok(codes.every(c => c === 401), 'ผิด 6 ครั้งแรกจากเครื่อง host ตอบ 401 ตามปกติ (ยังไม่หน่วง)');
  const limited = await badLogin();
  const limitedBody = await limited.json();
  ok(limited.status === 429 && /ลองใหม่ได้ในอีก/.test(limitedBody.error) && limited.headers.get('retry-after'), `ครั้งถัดไปโดนหน่วง 429 + ข้อความภาษาคน (${limitedBody.error})`);
  ok((await front('GET', '/api/me', undefined, 200)).data.role === 'front', 'ผู้ใช้ที่ login ถูกต้องอยู่แล้วไม่กระทบ');
  const otherOk = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'doctor', password: 'doctor123' }) });
  ok(otherOk.status === 200, 'ผู้ใช้อื่นจากเครื่องเดียวกันยัง login ได้ (ไม่ล็อกทั้งเครื่องจากการผิดไม่กี่ครั้ง)');
  const summary = (await admin('GET', '/api/admin/auth-summary', undefined, 200)).data;
  ok(summary.totals.login_fail >= 3 && summary.fails.some(f => f.c >= 3), 'หน้า admin เห็นจำนวน login ล้มเหลวและเครื่องต้นทาง');
  ok((await front('GET', '/api/admin/auth-summary')).status === 403, 'auth-summary เฉพาะ admin');
  ok(!JSON.stringify(summary).includes('wrong-pass'), 'สรุปไม่มีรหัสผ่านที่พิมพ์ผิด');
  const access = (await admin('GET', `/api/admin/access-log?ref=${hn}`, undefined, 200)).data;
  ok(access.some(a => a.action === 'view_history') && access.some(a => a.action === 'view_patient' || a.action === 'view_documents'), 'access_log บันทึกว่าใครเปิดดูประวัติคนไข้');
  ok((await doctor('GET', `/api/admin/access-log?ref=${hn}`)).status === 403, 'access-log เฉพาะ admin');
  ok((await front('POST', '/api/system/clock-recheck', {}, 200)).data.clock_error === null, 'ตรวจนาฬิกาอีกครั้งได้โดยไม่ต้อง restart');
  // ล้างตัวนับ (test-only route มี guard) เพื่อไม่ให้รอบทดสอบถัดไปติดหน่วงจาก IP เดียวกัน
  ok((await fetch(BASE + '/api/test-limiter-reset', { method: 'POST', headers: { 'X-Clinic-Test-Token': TEST_TOKEN } })).status === 200, 'ล้าง limiter ผ่าน test guard');
  ok((await fetch(BASE + '/api/test-limiter-reset', { method: 'POST' })).status === 403, 'ล้าง limiter โดยไม่มี test token ไม่ได้');

  console.log('--- exactly-once ลงทะเบียน (op_id — codex NO-GO 2026-08-24) ---');
  const { randomUUID } = require('node:crypto');
  const opId = randomUUID();
  const onceBody = { first_name: 'อ๊อปไอดี', last_name: 'ทดสอบซ้ำ', sex: 'F', op_id: opId, queue: true, cc: 'ทดสอบ exactly-once' };
  const once1 = await front('POST', '/api/patients', onceBody, 201);
  ok(once1.data.hn && once1.data.queue_no > 0 && once1.data.visit_id > 0, 'ลงทะเบียน+เข้าคิวสำเร็จในคำขอเดียว (txn เดียว)');
  const once2 = await front('POST', '/api/patients', onceBody, 201);
  ok(once2.data.hn === once1.data.hn && once2.data.queue_no === once1.data.queue_no,
    'ส่งซ้ำด้วย op_id เดิม (จำลองกดซ้ำหลัง connection ขาด) → ได้ผลเดิมเป๊ะ ไม่สร้างใหม่');
  const onceSearch = await front('GET', `/api/patients/search?q=${encodeURIComponent('อ๊อปไอดี')}`, undefined, 200);
  ok(onceSearch.data.length === 1, 'คนไข้มีคนเดียว ไม่มี HN เบิ้ล');
  const onceToday = await front('GET', '/api/queue', undefined, 200);
  ok((onceToday.data.queue || []).filter(v => v.hn === once1.data.hn).length === 1, 'คิวของคนไข้นี้มีใบเดียว');
  // codex NO-GO รอบ 2: คนจริงแก้ช่อง/สลับปุ่มก่อนกดซ้ำ — 409 ต้องพากลับไปหาคนไข้ที่บันทึกแล้ว ห้ามชวนไปลงทะเบียนใหม่
  const onceEdited = await front('POST', '/api/patients', { ...onceBody, first_name: 'อ๊อปไอดีแก้ชื่อ' });
  ok(onceEdited.status === 409 && onceEdited.data?.already_registered?.hn === once1.data.hn
    && /ไม่ต้องลงทะเบียนซ้ำ/.test(onceEdited.data?.error || ''),
    'แก้ข้อมูลแล้วกดซ้ำ → 409 คืน HN เดิม + ข้อความพาไปที่คนไข้ที่บันทึกแล้ว');
  const onceSwitched = await front('POST', '/api/patients', { ...onceBody, queue: undefined, cc: undefined });
  ok(onceSwitched.status === 409 && onceSwitched.data?.already_registered?.hn === once1.data.hn,
    'สลับปุ่ม (เข้าคิว→บันทึกอย่างเดียว) แล้วกดซ้ำ → 409 คืน HN เดิมเช่นกัน');
  const onceRecheck = await front('GET', `/api/patients/search?q=${encodeURIComponent('อ๊อปไอดี')}`, undefined, 200);
  ok(onceRecheck.data.length === 1, 'ผ่านทุกท่ากดซ้ำแล้ว คนไข้ยังมีคนเดียว');
  ok((await front('POST', '/api/patients', { first_name: 'ไม่มีอ๊อปไอดี', sex: 'M' })).status === 201,
    'ไม่ส่ง op_id ก็ยังลงทะเบียนได้ (ทางเดิมไม่พัง)');

  console.log('--- exactly-once รับยาเข้า (op_id — failure-injection 2026-08-25) ---');
  const rcQty0 = (await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id).qty_on_hand;
  const rcBody = { qty: 10, cost: 2.5, reason: 'รับยาเข้า', op_id: randomUUID() };
  await front('POST', `/api/drugs/${para.id}/receive`, rcBody, 200);
  await front('POST', `/api/drugs/${para.id}/receive`, rcBody, 200); // จำลองกดซ้ำหลัง connection ขาด
  const rcDrug = (await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id);
  ok(rcDrug.qty_on_hand - rcQty0 === 10, `กดซ้ำ op เดิม → รับเข้าครั้งเดียว (${rcQty0}→${rcDrug.qty_on_hand})`);
  ok(rcDrug.cost === 2.5, 'ทุนถูกบันทึกพร้อมยอดใน txn เดียวกัน');
  const rcEdited = await front('POST', `/api/drugs/${para.id}/receive`, { ...rcBody, qty: 12 });
  ok(rcEdited.status === 409 && !!rcEdited.data.already_received, 'op เดิมแต่แก้จำนวน → 409 ชี้รอบที่บันทึกไปแล้ว');
  await front('POST', `/api/drugs/${para.id}/receive`, { ...rcBody, op_id: randomUUID() }, 200);
  ok((await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id).qty_on_hand - rcQty0 === 20,
    'เปิดกล่องใหม่ (op ใหม่) = ตั้งใจรับอีกรอบ รับเพิ่มได้จริง');

  console.log('--- ยาหมดอายุรายลอต (v13 — หมอขอ 2026-08-31 สองรอบ: กรอกทุก lot ระบบดึงตัวใกล้สุดเตือนเอง) ---');
  await front('POST', `/api/drugs/${para.id}/receive`, { qty: 5, expiry_date: '2027-06-30', lot_label: 'LOT-A', expiry_warn_days: 120, reason: 'รับยาเข้า', op_id: randomUUID() }, 200);
  const paraExp = (await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id);
  ok(paraExp.expiry_date === '2027-06-30' && paraExp.active_lots === 1, 'รับเข้าพร้อมวันหมดอายุ = lot แรก โผล่เป็นตัวเตือน');
  ok(paraExp.expiry_warn_days === 120, 'เกณฑ์เตือนรายยา (supplier แต่ละยาต่างกัน) เก็บมากับรอบรับเข้า');
  await front('POST', `/api/drugs/${para.id}/receive`, { qty: 5, expiry_date: '2027-03-31', lot_label: 'LOT-B', reason: 'รับยาเข้า', op_id: randomUUID() }, 200);
  const paraTwoLots = (await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id);
  ok(paraTwoLots.expiry_date === '2027-03-31' && paraTwoLots.active_lots === 2,
    'lot ที่สองใกล้หมดกว่า → ระบบสลับตัวเตือนให้เอง (เก็บแยกทุก lot ไม่เขียนทับ)');
  const lots = (await front('GET', `/api/drugs/${para.id}/lots`, undefined, 200)).data;
  ok(lots.length === 2 && lots[0].lot_label === 'LOT-B' && lots[1].lot_label === 'LOT-A',
    'รายการ lot เรียงตามวันหมดอายุ (ตัวใกล้สุดขึ้นก่อน)');
  const mv = (await front('GET', `/api/drugs/${para.id}/movements`, undefined, 200)).data;
  ok(mv.some(m => /LOT-B/.test(m.reason || '') && /หมดอายุ 2027-03-31/.test(m.reason || '')),
    'ประวัติรับเข้า (append-only) ฝังเลข lot + วันหมดอายุ ย้อนตรวจได้เสมอ');
  await front('POST', `/api/lots/${lots[0].id}/clear`, { reason: 'เก็บทำลาย' }, 200);
  const paraAfterClear = (await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id);
  ok(paraAfterClear.expiry_date === '2027-06-30' && paraAfterClear.active_lots === 1,
    'ปิด lot ที่ใกล้หมด → lot ถัดไปเลื่อนขึ้นมาเป็นตัวเตือนเอง (หัวใจที่หมอขอ)');
  ok((await front('POST', `/api/lots/${lots[0].id}/clear`, {})).status === 409, 'ปิด lot ซ้ำ → 409');
  ok((await front('PATCH', `/api/lots/${lots[0].id}`, { expiry_date: '2027-04-30' })).status === 409, 'แก้ lot ที่ปิดแล้วไม่ได้');
  await front('PATCH', `/api/lots/${lots[1].id}`, { expiry_date: '2027-05-31', lot_label: 'LOT-A2' }, 200);
  ok((await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id).expiry_date === '2027-05-31',
    'แก้ lot ที่คีย์ผิดได้ ตัวเตือนตามวันใหม่');
  await front('POST', `/api/drugs/${para.id}/lots`, { expiry_date: '2027-02-28', lot_label: 'ค้างในตู้' }, 201);
  ok((await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id).expiry_date === '2027-02-28',
    'เพิ่ม lot ย้อนหลัง (ของที่อยู่ในตู้ก่อนเริ่มใช้ระบบ) ได้โดยไม่แตะยอดสต็อก');
  const lotsAll = (await front('GET', `/api/drugs/${para.id}/lots?all=1`, undefined, 200)).data;
  ok(lotsAll.length === 3 && lotsAll.filter(l => l.cleared_at).length === 1, 'lot ที่ปิดแล้วยังอยู่ในประวัติ (?all=1) ไม่ถูกลบ');
  ok((await front('POST', `/api/drugs/${para.id}/receive`, { qty: 1, expiry_date: '31/01/2027', reason: 'x', op_id: randomUUID() })).status === 400,
    'รูปแบบวันหมดอายุผิด → 400 (บอกให้เลือกจากปฏิทิน)');
  ok((await front('POST', `/api/drugs/${para.id}/receive`, { qty: 1, expiry_warn_days: 0, reason: 'x', op_id: randomUUID() })).status === 400,
    'เกณฑ์เตือนรายยา 0 วัน → 400');
  ok((await anon('POST', `/api/lots/${lots[1].id}/clear`, {})).status === 401, 'ไม่ login ปิด lot ไม่ได้');
  const paraKeep = { name: paraExp.name, unit: paraExp.unit, price: paraExp.price, cost: paraExp.cost,
    reorder_level: paraExp.reorder_level, default_instructions: paraExp.default_instructions, dose_mode: paraExp.dose_mode };
  await front('PATCH', `/api/drugs/${para.id}`, paraKeep, 200);
  ok((await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id).expiry_warn_days === 120,
    'client ที่ไม่ส่ง field (เช่น import CSV) ไม่ล้างเกณฑ์รายยาเดิม');
  await front('PATCH', `/api/drugs/${para.id}`, { ...paraKeep, expiry_warn_days: '' }, 200);
  ok((await front('GET', '/api/drugs', undefined, 200)).data.find(d => d.id === para.id).expiry_warn_days === null,
    'ส่งค่าว่างจากฟอร์มแก้ยา = ตั้งใจล้าง (กลับไปใช้ค่ากลาง)');
  // เกณฑ์เตือนเป็นของหมอแต่ละคลินิก (เจ้าของ 2026-08-31: ห้าม fix ขึ้นกับ supplier) — ปรับได้จากหน้า stock ไม่ต้องเป็น admin
  await front('POST', '/api/stock/expiry-warning', { days: 45 }, 200);
  ok((await front('GET', '/api/settings', undefined, 200)).data.stock_expiry_warn_days === '45',
    'front ตั้งเกณฑ์เตือน 45 วันแล้วอ่านค่ากลับได้ (ใช้วาดแถบเตือนหน้า stock)');
  ok((await front('POST', '/api/stock/expiry-warning', { days: 0 })).status === 400, 'เกณฑ์ 0 วัน → 400');
  ok((await anon('POST', '/api/stock/expiry-warning', { days: 30 })).status === 401, 'ไม่ login ตั้งเกณฑ์ไม่ได้');

  console.log('--- 🆘 รายงานปัญหา (incident 2026-08-24: หลักฐานต้องได้จากการกดปุ่มเดียว) ---');
  ok((await fetch(process.env.SMOKE_LAN_BASE + '/api/support-report')).status === 401,
    'ยังไม่ login จากเครื่องอื่น (LAN) → 401 พร้อมข้อความภาษาคน');
  const reportAnon = await fetch(BASE + '/api/support-report');
  const reportAnonBytes = Buffer.from(await reportAnon.arrayBuffer());
  ok(reportAnon.status === 200, 'เครื่องหลัก (loopback) ดาวน์โหลดได้แม้ยังไม่ login (กรณีเข้าระบบไม่ได้)');
  // เช็คระดับไบต์ — res.text() ตัด BOM ทิ้งตามสเปค WHATWG จึงมองไม่เห็น
  ok(reportAnonBytes[0] === 0xEF && reportAnonBytes[1] === 0xBB && reportAnonBytes[2] === 0xBF
    && reportAnonBytes.toString('utf8').includes('รายงานปัญหาระบบคลินิก'), 'ไฟล์เป็น UTF-8 BOM (Notepad เปิดไทยไม่เพี้ยน) + หัวรายงานครบ');
  ok(/attachment/.test(reportAnon.headers.get('content-disposition') || '')
    && /%E0%B8%A3%E0%B8%B2%E0%B8%A2%E0%B8%87%E0%B8%B2%E0%B8%99/.test(reportAnon.headers.get('content-disposition') || ''),
    'ดาวน์โหลดเป็นไฟล์ชื่อไทย "รายงานปัญหา-..."');
  // กดรัว/ดับเบิลคลิก → ต้องได้ไฟล์ดีทุกคลิก (cache 5 วิ) — ห้ามคลิกเงียบ (blind test 2026-08-24: 429 เดิมทำให้กดแล้วไม่ได้อะไร)
  const reportAgain = await fetch(BASE + '/api/support-report');
  ok(reportAgain.status === 200 && Buffer.from(await reportAgain.arrayBuffer()).equals(reportAnonBytes),
    'กดรัวติดกัน → ได้รายงานเดิมจาก cache ไม่มีคลิกที่เงียบหาย');
  // ห้ามมีข้อมูลคนไข้: ลงทะเบียนชื่อเฉพาะแล้วรายงานต้องไม่มีชื่อนั้น (กฎเหล็กข้อ 2 — ไฟล์นี้ออกนอกเครื่องไม่เข้ารหัส)
  // รอเกินอายุ cache เพื่อให้รายงานรอบถัดไปเป็นของสด (สร้างหลังลงทะเบียนคนไข้ลับ)
  await front('POST', '/api/patients', { first_name: 'ผู้ป่วยลับเฉพาะรายงาน', last_name: 'ห้ามรั่ว', sex: 'F' }, 201);
  await new Promise(resolve => setTimeout(resolve, 5100));
  const report = await front('GET', '/api/support-report', undefined, 200);
  ok(!report.text.includes('ผู้ป่วยลับเฉพาะรายงาน') && !report.text.includes('ห้ามรั่ว'), 'รายงานไม่มีชื่อคนไข้');
  ok(report.text.includes('ไม่มีข้อมูลคนไข้'), 'รายงานประกาศตัวเองว่าไม่มีข้อมูลคนไข้');
  ok(/login_ok/.test(report.text), 'รายงานมีลำดับเวลาการเข้าใช้ (auth_events) สำหรับไล่ว่า server หายตอนไหน');
  ok(/boot: clinic .+ node v/.test(report.text), 'รายงานมี log ของ server (บรรทัด boot รุ่น+Node)');
  ok(report.text.includes('Windows Error Reporting') || report.text.includes('Application Error'),
    'รายงานพยายามดึง crash record จาก Windows Event Log');

  console.log('--- 413 ไฟล์แนบใหญ่เกิน: browser ต้องเห็นคำตอบ ไม่ใช่ "ติดต่อเครื่องหลักไม่ได้" ---');
  // ก่อนแก้ (1.0.2): server destroy socket ทันที → fetch reject → ผู้ใช้เข้าใจว่าระบบล่ม (เจอจริง 2026-08-24 ระหว่างไล่ incident)
  const oversized = await front('POST', `/api/patients/${hn}/attachments`,
    { filename: 'big.bin', mime: 'application/octet-stream', data_base64: 'A'.repeat(31 * 1024 * 1024) });
  ok(oversized.status === 413 && /ใหญ่เกิน/.test(oversized.data?.error || ''),
    `ไฟล์เกินเพดาน → ได้ 413 + ข้อความภาษาคน (ไม่ใช่ connection หลุด) (${oversized.status})`);
  ok((await front('GET', `/api/patients/${hn}`, undefined, 200)).data.hn === hn, 'connection หลังโดน 413 ยังใช้งานต่อได้');

  console.log('--- เครื่องห้องตรวจ: การ์ดใน Admin (สถานะ 4 ขั้น + ปุ่มเรียกตัวช่วย "ทีหลัง") ---');
  // 2026-08-16: ตัวช่วยเคยมีแต่ตอนติดตั้ง/ไฟล์ใน C:\clinic* → เจ้าของกดตัวในโฟลเดอร์ ZIP; การ์ดนี้คือทางหลักสำหรับทำทีหลัง
  const lan = (await admin('GET', '/api/admin/lan-status', undefined, 200)).data;
  ok(lan.host === true && lan.https_listening === true && lan.cert && Array.isArray(lan.current_ips) && lan.current_ips.includes(process.env.SMOKE_LAN_IP),
    `สถานะเครื่องห้องตรวจ: host/HTTPS/ใบรับรอง/IP ปัจจุบันครบ (${lan.headline})`);
  ok(lan.setup === null && lan.headline === 'cert_only' && lan.helper_available === true, 'ยังไม่เคยกดตั้งค่า → บอกว่า "ยังไม่ได้ตั้งค่าให้เครื่องอื่นเข้า" และมีตัวช่วยพร้อมกด');
  ok(!JSON.stringify(lan).match(/pfx|passphrase|\.pass/i), 'สถานะไม่มีอะไรเกี่ยวกับกุญแจลับ/รหัสใบรับรอง');
  ok((await lanAdmin('GET', '/api/admin/lan-status', undefined, 200)).data.host === false, 'admin จากเครื่องอื่น (LAN) เห็นสถานะได้แต่ระบบบอกว่าไม่ใช่เครื่องหน้าร้าน');
  ok((await front('GET', '/api/admin/lan-status')).status === 403, 'lan-status เฉพาะ admin');
  ok((await lanAdmin('POST', '/api/admin/lan-setup', {})).status === 403, 'กดตั้งค่าเครื่องห้องตรวจจากเครื่องอื่น (LAN) ไม่ได้');
  ok((await front('POST', '/api/admin/lan-setup', {})).status === 403, 'role อื่นกดตั้งค่าเครื่องห้องตรวจไม่ได้');
  ok((await admin('POST', '/api/admin/lan-open-folder', {})).status === 404, 'ยังไม่เคยตั้งค่า → เปิดโฟลเดอร์ส่งไปเครื่องหมอไม่ได้ พร้อมบอกให้ตั้งค่าก่อน');
  const marker = process.env.SMOKE_LAN_HELPER_MARKER;
  ok(!!marker && !fs.existsSync(marker), 'harness เตรียมตัวช่วยปลอมไว้ (marker ยังไม่ถูกสร้าง)');
  const launched = await admin('POST', '/api/admin/lan-setup', {}, 200);
  ok(launched.data.ok === true && /กล่อง/.test(launched.data.message), 'ปุ่มตั้งค่าเรียกตัวช่วยและบอกผู้ใช้ให้ทำตามกล่องบนหน้าจอ');
  let markerSeen = false;
  for (let i = 0; i < 40 && !markerSeen; i++) { await new Promise(r => setTimeout(r, 250)); markerSeen = fs.existsSync(marker); }
  ok(markerSeen, 'ตัวช่วย (สคริปต์ .cmd) ถูกรันจริงแบบแยก process จาก server');

  console.log(`\n=== ผล: ${passed} ผ่าน / ${failed} ตก ===`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
