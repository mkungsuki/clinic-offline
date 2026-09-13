'use strict';

function bahtText(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('จำนวนเงินไม่ถูกต้อง');
  const satangTotal = Math.round(amount * 100);
  if (!Number.isSafeInteger(satangTotal)) throw new Error('จำนวนเงินมากเกินกว่าที่รองรับ');
  const baht = Math.floor(satangTotal / 100);
  const satang = satangTotal % 100;
  const bahtWords = readInteger(String(baht));
  return `${bahtWords}บาท${satang ? `${readInteger(String(satang))}สตางค์` : 'ถ้วน'}`;
}

const DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const UNITS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

function readInteger(raw) {
  const value = String(raw).replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(value)) throw new Error('จำนวนเงินไม่ถูกต้อง');
  if (value === '0') return DIGITS[0];
  if (value.length <= 6) return readGroup(value);
  const head = value.slice(0, -6), tail = value.slice(-6);
  // มีหลักล้านนำหน้าเสมอเมื่อถึงกิ่งนี้ ดังนั้นเลข 1 หลักหน่วยของกลุ่มท้ายอ่านว่า "เอ็ด" (เช่น 1,000,001 = หนึ่งล้านเอ็ด)
  const tailWords = readGroup(tail, true);
  return `${readInteger(head)}ล้าน${tailWords}`;
}

function readGroup(value, hasHigherPart = false) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const digit = Number(value[i]);
    if (!digit) continue;
    const position = value.length - i - 1;
    if (position === 1) {
      if (digit === 1) out += 'สิบ';
      else if (digit === 2) out += 'ยี่สิบ';
      else out += `${DIGITS[digit]}สิบ`;
    } else if (position === 0 && digit === 1 && (hasHigherPart || /[1-9]/.test(value.slice(0, -1)))) {
      out += 'เอ็ด';
    } else {
      out += `${DIGITS[digit]}${UNITS[position]}`;
    }
  }
  return out;
}

module.exports = { bahtText, readInteger };
