'use strict';
// ZIP reader/writer ขนาดเล็กสำหรับ updater: Node built-ins เท่านั้น, ไม่ผ่าน PowerShell
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const UTF8_FLAG = 0x0800;
const MAX_COMMENT = 0xffff;
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 10000, maxCompressedBytes: 512 * 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024 * 1024, maxEntryBytes: 256 * 1024 * 1024 });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeZipPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) {
    throw zipError('ZIP_UNSAFE_PATH', 'พบชื่อไฟล์ใน ZIP ที่ไม่ปลอดภัย');
  }
  if (value !== value.normalize('NFC') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.endsWith('/')) {
    throw zipError('ZIP_UNSAFE_PATH', `ชื่อไฟล์ใน ZIP ไม่ปลอดภัย: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw zipError('ZIP_UNSAFE_PATH', `ชื่อไฟล์ใน ZIP ไม่ปลอดภัย: ${value}`);
  }
  for (const part of parts) {
    const base = part.split('.')[0].toUpperCase();
    if (/[\x00-\x1f:]/.test(part) || /[. ]$/.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) {
      throw zipError('ZIP_UNSAFE_PATH', `ชื่อไฟล์ใช้ไม่ได้บน Windows: ${value}`);
    }
  }
  return value;
}

function findEocd(buffer) {
  const start = Math.max(0, buffer.length - 22 - MAX_COMMENT);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw zipError('ZIP_FORMAT', 'ไม่พบส่วนปิดท้ายของ ZIP');
}

function parseZip(input, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const buffer = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  if (buffer.length > limits.maxCompressedBytes) throw zipError('ZIP_TOO_LARGE', 'ZIP มีขนาดเกินขีดจำกัด');
  if (buffer.length < 22) throw zipError('ZIP_FORMAT', 'ZIP ไม่สมบูรณ์');
  const eocd = findEocd(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralBytes = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentBytes = buffer.readUInt16LE(eocd + 20);
  if (disk || centralDisk || entriesOnDisk !== entryCount || entryCount === 0xffff
    || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    throw zipError('ZIP_UNSUPPORTED', 'ไม่รองรับ ZIP แบบหลายส่วนหรือ ZIP64');
  }
  if (entryCount > limits.maxEntries) throw zipError('ZIP_TOO_MANY_FILES', 'ZIP มีไฟล์มากเกินขีดจำกัด');
  if (eocd + 22 + commentBytes !== buffer.length || centralOffset + centralBytes !== eocd) {
    throw zipError('ZIP_FORMAT', 'โครงสร้าง ZIP ไม่ตรงกัน');
  }
  const entries = [];
  const names = new Set();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw zipError('ZIP_FORMAT', 'รายการกลาง ZIP เสียหาย');
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const bytes = buffer.readUInt32LE(cursor + 24);
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const entryCommentBytes = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameBytes + extraBytes + entryCommentBytes;
    if (end > eocd || diskStart !== 0 || (flags & ~UTF8_FLAG) !== 0 || !(flags & UTF8_FLAG)) {
      throw zipError('ZIP_UNSUPPORTED', 'ZIP ใช้รูปแบบหรือ flag ที่ไม่รองรับ');
    }
    if (method !== 0 && method !== 8) throw zipError('ZIP_UNSUPPORTED', 'ZIP ใช้วิธีบีบอัดที่ไม่รองรับ');
    const platform = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    if (platform === 3 && (unixMode & 0xf000) === 0xa000) throw zipError('ZIP_SYMLINK', 'ZIP มี symbolic link ซึ่งไม่อนุญาต');
    const name = safeZipPath(buffer.toString('utf8', cursor + 46, cursor + 46 + nameBytes));
    const folded = name.toLocaleLowerCase('en-US');
    if (names.has(folded)) throw zipError('ZIP_DUPLICATE_PATH', `ZIP มีชื่อไฟล์ซ้ำ: ${name}`);
    names.add(folded);
    if (bytes > limits.maxEntryBytes || totalUncompressed + bytes > limits.maxUncompressedBytes) {
      throw zipError('ZIP_TOO_LARGE', 'ข้อมูลเมื่อแตก ZIP มีขนาดเกินขีดจำกัด');
    }
    totalUncompressed += bytes;
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw zipError('ZIP_FORMAT', 'ส่วนข้อมูล ZIP เสียหาย');
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressed = buffer.readUInt32LE(localOffset + 18);
    const localBytes = buffer.readUInt32LE(localOffset + 22);
    const localNameBytes = buffer.readUInt16LE(localOffset + 26);
    const localExtraBytes = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameBytes + localExtraBytes;
    const dataEnd = dataStart + compressedBytes;
    const localName = buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameBytes);
    if (dataEnd > centralOffset || localFlags !== flags || localMethod !== method || localCrc !== expectedCrc
      || localCompressed !== compressedBytes || localBytes !== bytes || localName !== name) {
      throw zipError('ZIP_FORMAT', `ข้อมูล ZIP ของ ${name} ไม่ตรงกับรายการกลาง`);
    }
    entries.push({ name, method, expectedCrc, compressedBytes, bytes, dataStart, dataEnd });
    cursor = end;
  }
  if (cursor !== eocd) throw zipError('ZIP_FORMAT', 'รายการกลาง ZIP มีข้อมูลส่วนเกิน');
  return { buffer, entries, compressedBytes: buffer.length, uncompressedBytes: totalUncompressed };
}

function entryData(parsed, entry) {
  const compressed = parsed.buffer.subarray(entry.dataStart, entry.dataEnd);
  let data;
  try { data = entry.method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: entry.bytes }); }
  catch { throw zipError('ZIP_DEFLATE', `แตกไฟล์ ${entry.name} ไม่สำเร็จ`); }
  if (data.length !== entry.bytes || crc32(data) !== entry.expectedCrc) throw zipError('ZIP_CHECKSUM', `ไฟล์ ${entry.name} ตรวจ CRC ไม่ผ่าน`);
  return data;
}

function extractZipExact(zipFile, destination, inventory, options = {}) {
  const parsed = parseZip(zipFile, options);
  const expected = new Map();
  for (const item of inventory) {
    const name = safeZipPath(item.path);
    const folded = name.toLocaleLowerCase('en-US');
    if (expected.has(folded)) throw zipError('INVENTORY_DUPLICATE', `inventory มีชื่อซ้ำ: ${name}`);
    expected.set(folded, item);
  }
  if (parsed.entries.length !== expected.size) throw zipError('ZIP_INVENTORY', 'จำนวนไฟล์ใน ZIP ไม่ตรงกับ manifest');
  const decoded = [];
  for (const entry of parsed.entries) {
    const item = expected.get(entry.name.toLocaleLowerCase('en-US'));
    if (!item || item.path !== entry.name || item.bytes !== entry.bytes) throw zipError('ZIP_INVENTORY', `ไฟล์ ${entry.name} ไม่ตรงกับ manifest`);
    const data = entryData(parsed, entry);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash !== item.sha256) throw zipError('ZIP_CHECKSUM', `ไฟล์ ${entry.name} ตรวจ SHA-256 ไม่ผ่าน`);
    decoded.push({ name: entry.name, data });
  }
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  for (const item of decoded) {
    const target = path.resolve(root, ...item.name.split('/'));
    if (!target.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw zipError('ZIP_UNSAFE_PATH', 'ปลายทางแตก ZIP ไม่ปลอดภัย');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, item.data, { flag: 'wx' });
  }
  return { files: decoded.length, bytes: parsed.uncompressedBytes };
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return { time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    day: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff };
}

function writeZip(zipFile, entries, options = {}) {
  const sorted = [...entries].map(entry => ({ ...entry, name: safeZipPath(entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set();
  const chunks = [], central = [];
  let offset = 0;
  const fixedDate = options.date || new Date('2026-01-01T00:00:00Z');
  for (const entry of sorted) {
    const folded = entry.name.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw zipError('ZIP_DUPLICATE_PATH', `ชื่อไฟล์ซ้ำ: ${entry.name}`);
    seen.add(folded);
    const data = Buffer.isBuffer(entry.data) ? entry.data : fs.readFileSync(entry.source);
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const payload = deflated.length < data.length ? deflated : data;
    const method = payload === data ? 0 : 8;
    const { time, day } = dosDateTime(fixedDate);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, payload);
    central.push({ nameBytes, crc, compressedBytes: payload.length, bytes: data.length, method, time, day, offset });
    offset += local.length + nameBytes.length + payload.length;
  }
  if (central.length > 0xffff) throw zipError('ZIP_TOO_MANY_FILES', 'มีไฟล์มากเกินรูปแบบ ZIP v1');
  const centralStart = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_FLAG, 8); header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.time, 12); header.writeUInt16LE(entry.day, 14); header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressedBytes, 20); header.writeUInt32LE(entry.bytes, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28); header.writeUInt32LE(entry.offset, 42);
    chunks.push(header, entry.nameBytes); offset += header.length + entry.nameBytes.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12); eocd.writeUInt32LE(centralStart, 16);
  chunks.push(eocd);
  fs.writeFileSync(zipFile, Buffer.concat(chunks), { flag: 'wx' });
  return { files: sorted.length, bytes: fs.statSync(zipFile).size };
}

module.exports = { crc32, safeZipPath, parseZip, extractZipExact, writeZip, zipError, DEFAULT_LIMITS };
