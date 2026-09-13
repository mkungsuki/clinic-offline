'use strict';
const crypto = require('node:crypto');
const { safeZipPath } = require('./zip');

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const TOP_FIELDS = ['format', 'product', 'edition', 'version', 'variant', 'channel', 'min_from_version',
  'min_runtime', 'expected_schema', 'created_at', 'package', 'files', 'obsolete'];
const PACKAGE_FIELDS = ['url', 'file', 'bytes', 'sha256'];
const FILE_FIELDS = ['path', 'bytes', 'sha256'];
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH_RE = /^[a-f0-9]{64}$/;

function manifestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw manifestError('MANIFEST_FORMAT', `${label} ต้องเป็น object`);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    throw manifestError('MANIFEST_UNKNOWN_FIELD', `${label} มี field ขาดหรือเกิน: ${keys.join(', ')}`);
  }
}

function versionParts(value, label = 'version') {
  const match = VERSION_RE.exec(String(value || ''));
  if (!match) throw manifestError('MANIFEST_VERSION', `${label} ต้องเป็นเลข x.y.z`);
  return match.slice(1).map(Number);
}

function compareVersions(a, b) {
  const av = versionParts(a, 'version แรก'), bv = versionParts(b, 'version ที่สอง');
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] < bv[i] ? -1 : 1;
  return 0;
}

function positiveInteger(value, label, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw manifestError('MANIFEST_FORMAT', `${label} ไม่ถูกต้อง`);
}

function validateHash(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw manifestError('MANIFEST_HASH', `${label} ไม่ใช่ SHA-256`);
}

function validateManifest(manifest) {
  exactFields(manifest, TOP_FIELDS, 'manifest');
  if (manifest.format !== 1) throw manifestError('MANIFEST_FORMAT', 'ไม่รองรับรูปแบบ manifest นี้');
  if (manifest.product !== 'clinic-offline') throw manifestError('MANIFEST_PRODUCT', 'package นี้ไม่ใช่ระบบคลินิกที่รองรับ');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(manifest.edition)) throw manifestError('MANIFEST_EDITION', 'edition ไม่ถูกต้อง');
  versionParts(manifest.version);
  versionParts(manifest.min_from_version, 'min_from_version');
  versionParts(manifest.min_runtime, 'min_runtime');
  if (!['production', 'trial'].includes(manifest.variant)) throw manifestError('MANIFEST_VARIANT', 'variant ไม่ถูกต้อง');
  if (!['pilot', 'stable'].includes(manifest.channel)) throw manifestError('MANIFEST_CHANNEL', 'channel ไม่ถูกต้อง');
  positiveInteger(manifest.expected_schema, 'expected_schema');
  if (typeof manifest.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.created_at)
    || Number.isNaN(Date.parse(manifest.created_at))) throw manifestError('MANIFEST_DATE', 'created_at ไม่ถูกต้อง');

  exactFields(manifest.package, PACKAGE_FIELDS, 'package');
  let url;
  try { url = new URL(manifest.package.url); } catch { throw manifestError('MANIFEST_URL', 'URL ของ package ไม่ถูกต้อง'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw manifestError('MANIFEST_URL', 'URL ของ package ต้องเป็น HTTPS ที่ไม่มี credential คำถามท้าย URL หรือ fragment');
  if (typeof manifest.package.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.zip$/.test(manifest.package.file)) {
    throw manifestError('MANIFEST_PACKAGE', 'ชื่อไฟล์ package ไม่ถูกต้อง');
  }
  if (decodeURIComponent(url.pathname.split('/').pop()) !== manifest.package.file) throw manifestError('MANIFEST_URL', 'URL กับชื่อ package ไม่ตรงกัน');
  positiveInteger(manifest.package.bytes, 'package.bytes');
  validateHash(manifest.package.sha256, 'package.sha256');

  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 10000) {
    throw manifestError('MANIFEST_FILES', 'รายการไฟล์ใน manifest ไม่ถูกต้อง');
  }
  const paths = new Set();
  for (const item of manifest.files) {
    exactFields(item, FILE_FIELDS, 'files[]');
    const safe = safeZipPath(item.path);
    if (safe !== item.path || safe.toLowerCase().startsWith('data/') || safe.toLowerCase() === 'data') {
      throw manifestError('MANIFEST_PATH', `path ไม่อนุญาต: ${item.path}`);
    }
    const folded = safe.toLocaleLowerCase('en-US');
    if (paths.has(folded)) throw manifestError('MANIFEST_DUPLICATE', `path ซ้ำ: ${safe}`);
    paths.add(folded);
    positiveInteger(item.bytes, `bytes ของ ${safe}`, true);
    validateHash(item.sha256, `sha256 ของ ${safe}`);
  }
  if (!Array.isArray(manifest.obsolete) || manifest.obsolete.length > 10000) throw manifestError('MANIFEST_OBSOLETE', 'obsolete ไม่ถูกต้อง');
  const obsolete = new Set();
  for (const item of manifest.obsolete) {
    const safe = safeZipPath(item);
    const folded = safe.toLocaleLowerCase('en-US');
    if (paths.has(folded) || obsolete.has(folded) || folded === 'data' || folded.startsWith('data/')) {
      throw manifestError('MANIFEST_OBSOLETE', `obsolete ไม่ปลอดภัยหรือซ้ำ: ${item}`);
    }
    obsolete.add(folded);
  }
  return manifest;
}

function decodeSignature(signatureBytes) {
  const text = Buffer.isBuffer(signatureBytes) ? signatureBytes.toString('ascii').trim() : String(signatureBytes).trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) throw manifestError('MANIFEST_SIGNATURE', 'รูปแบบลายเซ็นไม่ถูกต้อง');
  const signature = Buffer.from(text, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== text) throw manifestError('MANIFEST_SIGNATURE', 'รูปแบบลายเซ็นไม่ถูกต้อง');
  return signature;
}

function verifyAndParseManifest(manifestBytes, signatureBytes, publicKey) {
  const bytes = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes);
  if (!bytes.length || bytes.length > MAX_MANIFEST_BYTES) throw manifestError('MANIFEST_SIZE', 'manifest มีขนาดไม่ถูกต้อง');
  const signature = decodeSignature(signatureBytes);
  let verified = false;
  try { verified = crypto.verify(null, bytes, publicKey, signature); }
  catch { throw manifestError('MANIFEST_KEY', 'public key สำหรับตรวจอัปเดตไม่ถูกต้อง'); }
  if (!verified) throw manifestError('MANIFEST_SIGNATURE', 'ลายเซ็นอัปเดตไม่ผ่าน');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw manifestError('MANIFEST_JSON', 'manifest ไม่ใช่ JSON ที่อ่านได้'); }
  return validateManifest(parsed);
}

function signManifestBytes(manifestBytes, privateKey) {
  const bytes = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes);
  const signature = crypto.sign(null, bytes, privateKey);
  if (signature.length !== 64) throw manifestError('MANIFEST_KEY', 'signing key ไม่ใช่ Ed25519');
  return Buffer.from(signature.toString('base64') + '\n', 'ascii');
}

function checkManifestPolicy(manifest, policy) {
  validateManifest(manifest);
  const required = ['currentVersion', 'variant', 'channel', 'edition'];
  for (const field of required) if (typeof policy[field] !== 'string') throw manifestError('POLICY_FORMAT', `policy.${field} หายไป`);
  if (manifest.variant !== policy.variant) throw manifestError('POLICY_VARIANT', 'ชุดอัปเดตคนละชนิดกับโปรแกรมนี้');
  if (manifest.channel !== policy.channel) throw manifestError('POLICY_CHANNEL', 'ชุดอัปเดตคนละช่องทางกับโปรแกรมนี้');
  if (manifest.edition !== policy.edition) throw manifestError('POLICY_EDITION', 'ชุดอัปเดตคนละรุ่นสิทธิ์กับโปรแกรมนี้');
  if (compareVersions(manifest.version, policy.currentVersion) <= 0) throw manifestError('POLICY_DOWNGRADE', 'รุ่นอัปเดตต้องใหม่กว่ารุ่นปัจจุบัน');
  if (compareVersions(policy.currentVersion, manifest.min_from_version) < 0) {
    throw manifestError('POLICY_FULL_INSTALL_REQUIRED', 'รุ่นปัจจุบันเก่าเกินกว่าจะอัปเดตอัตโนมัติ ต้องใช้ตัวติดตั้งเต็ม');
  }
  const runtime = String(policy.runtimeVersion || process.versions.node).replace(/^v/, '').split('-')[0];
  if (compareVersions(runtime, manifest.min_runtime) < 0) {
    throw manifestError('POLICY_RUNTIME', 'Node runtime เก่าเกินไป ต้องใช้ตัวติดตั้งเต็ม');
  }
  if (policy.expectedSchema != null && manifest.expected_schema < policy.expectedSchema) {
    throw manifestError('POLICY_SCHEMA', 'ชุดอัปเดตคาด schema เก่ากว่าโปรแกรมปัจจุบัน');
  }
  return { ok: true, version: manifest.version };
}

module.exports = { validateManifest, verifyAndParseManifest, signManifestBytes, checkManifestPolicy,
  compareVersions, manifestError, MAX_MANIFEST_BYTES };
