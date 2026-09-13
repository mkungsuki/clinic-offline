'use strict';

const CERTIFICATE_TEMPLATES = Object.freeze({
  general: { key: 'general', version: 2, language: 'th', label: 'ใบรับรองทั่วไปของคลินิก' },
  tmc_health_th: { key: 'tmc_health_th', version: 1, language: 'th', label: 'ใบรับรองการตรวจสุขภาพ (แพทยสภา)' },
  tmc_driving_th: { key: 'tmc_driving_th', version: 1, language: 'th', label: 'ใบรับรองสำหรับใบอนุญาตขับรถ' },
  tmc_driving_en: { key: 'tmc_driving_en', version: 1, language: 'en', label: 'Medical Certificate (Driving Licence)' },
});

function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
function text(value, max = 2000) { return String(value ?? '').trim().slice(0, max); }
function bool(value, label) {
  if (typeof value !== 'boolean') invalid(`กรุณายืนยันช่อง “${label}”`);
  return value;
}
function confirmed(value, label) {
  if (value !== true) invalid(`กรุณายืนยันช่อง “${label}”`);
  return true;
}
function date(value, label, required = false) {
  const result = text(value, 10);
  if (!result && !required) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(new Date(`${result}T00:00:00`).getTime())) {
    invalid(`${label}ไม่ถูกต้อง`);
  }
  return result;
}
function historyItem(raw, label) {
  const has = bool(raw && raw.has, label);
  const detail = text(raw && raw.detail, 500);
  if (has && !detail) invalid(`กรุณาระบุรายละเอียด${label}`);
  return { has, detail };
}

function sanitizeCertificate(raw) {
  const key = text(raw && raw.template_type, 40) || 'sick_leave'; // client รุ่นเดิมไม่ส่งชนิดแบบ
  if (key === 'sick_leave') return sanitizeLegacySick(raw); // compatibility สำหรับ client เก่า
  if (key === 'health_exam') return sanitizeLegacyHealth(raw); // compatibility สำหรับหน้าจอ/เครื่องลูกที่ยังไม่ refresh
  const template = CERTIFICATE_TEMPLATES[key];
  if (!template) invalid('ไม่รู้จักแบบใบรับรองแพทย์ กรุณาเลือกแบบใหม่อีกครั้ง');
  if (key === 'general') return { ...sanitizeGeneral(raw), template_type: key, template_version: template.version, language: template.language };
  return { ...sanitizeTmc(raw, key), template_type: key, template_version: template.version, language: template.language };
}

function sanitizeLegacyHealth(raw) {
  return {
    template_type: 'health_exam', template_version: 1, language: 'th',
    patient_declaration: text(raw.patient_declaration, 1000),
    general_normal: raw.general_normal !== false,
    findings: text(raw.findings, 1500),
    fit_for_work: raw.fit_for_work !== false,
    recommendation: text(raw.recommendation, 1500),
  };
}

function sanitizeLegacySick(raw) {
  const days = raw.rest_days === '' || raw.rest_days == null ? null : Math.floor(Number(raw.rest_days));
  if (days != null && (!Number.isFinite(days) || days < 0 || days > 365)) invalid('จำนวนวันพักไม่ถูกต้อง');
  return {
    template_type: 'sick_leave', template_version: 1, language: 'th',
    diagnosis_text: text(raw.diagnosis_text), rest_days: days || '',
    rest_from: date(raw.rest_from, 'วันที่เริ่มพัก'), rest_to: date(raw.rest_to, 'วันที่สิ้นสุดพัก'),
    remark: text(raw.remark),
  };
}

function sanitizeGeneral(raw) {
  const purpose = ['attendance', 'sick_leave', 'work_school', 'return_to_work'].includes(raw.purpose) ? raw.purpose : 'sick_leave';
  const fitness = ['not_stated', 'fit', 'fit_with_restrictions', 'unfit'].includes(raw.fitness) ? raw.fitness : 'not_stated';
  const restFrom = date(raw.rest_from, 'วันที่เริ่มพัก');
  const restTo = date(raw.rest_to, 'วันที่สิ้นสุดพัก');
  if (!!restFrom !== !!restTo) invalid('กรุณาระบุวันเริ่มและวันสิ้นสุดพักให้ครบ');
  if (restFrom && restTo && restTo < restFrom) invalid('วันที่สิ้นสุดพักต้องไม่ก่อนวันที่เริ่มพัก');
  const restrictions = text(raw.restrictions, 1000);
  if (fitness === 'fit_with_restrictions' && !restrictions) invalid('กรุณาระบุข้อจำกัดในการทำงานหรือเรียน');
  return {
    purpose, diagnosis_text: text(raw.diagnosis_text), rest_from: restFrom, rest_to: restTo,
    fitness, restrictions, review_date: date(raw.review_date, 'วันที่ทบทวน'), remark: text(raw.remark),
    doctor_confirmed: confirmed(raw.doctor_confirmed, 'แพทย์ตรวจและยืนยันข้อความแล้ว'),
  };
}

function sanitizeTmc(raw, key) {
  const declaration = raw.declaration || {};
  const driving = key.startsWith('tmc_driving_');
  const language = key.endsWith('_en') ? 'en' : 'th';
  const result = {
    declaration: {
      chronic: historyItem(declaration.chronic, 'โรคประจำตัว'),
      accident_surgery: historyItem(declaration.accident_surgery, 'อุบัติเหตุหรือการผ่าตัด'),
      admitted: historyItem(declaration.admitted, 'ประวัติเข้ารักษาในโรงพยาบาล'),
      other: historyItem(declaration.other, 'ประวัติสำคัญอื่น'),
      applicant_confirmed: confirmed(declaration.applicant_confirmed, 'ผู้ขอรับรองว่าข้อมูลประวัติสุขภาพถูกต้อง'),
    },
    general_normal: bool(raw.general_normal, 'สภาพร่างกายทั่วไป'),
    abnormal_detail: text(raw.abnormal_detail, 1000),
    standard_exam_confirmed: confirmed(raw.standard_exam_confirmed, 'แพทย์ตรวจตามหัวข้อมาตรฐานแล้ว'),
    other_conditions: text(raw.other_conditions, 1000),
    physician_opinion: text(raw.physician_opinion, 1500),
    recommendation: text(raw.recommendation, 1500),
    patient_name_en: text(raw.patient_name_en, 200),
    patient_address_en: text(raw.patient_address_en, 1000),
  };
  if (!result.general_normal && !result.abnormal_detail) invalid('กรุณาระบุความผิดปกติของสภาพร่างกายทั่วไป');
  if (!result.physician_opinion) invalid('กรุณาระบุสรุปความเห็นของแพทย์');
  if (driving) result.declaration.seizure = historyItem(declaration.seizure, 'โรคลมชัก');
  if (language === 'en' && (!result.patient_name_en || !result.patient_address_en)) {
    invalid('แบบภาษาอังกฤษต้องมีชื่อและที่อยู่ผู้รับการตรวจเป็นภาษาอังกฤษ');
  }
  return result;
}

function certificateMeta(content) {
  const key = content && content.template_type;
  const template = CERTIFICATE_TEMPLATES[key];
  if (template) return template;
  if (key === 'health_exam') return { key, version: 1, language: 'th', label: 'ใบรับรองการตรวจสุขภาพ (แบบเดิม)' };
  return { key: key || 'sick_leave', version: Number(content && content.template_version) || 1, language: 'th', label: 'ใบรับรองแพทย์ (แบบเดิม)' };
}

module.exports = { CERTIFICATE_TEMPLATES, sanitizeCertificate, certificateMeta };
