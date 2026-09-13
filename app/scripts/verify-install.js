'use strict';
// Installer-only integrity check; never opens a database.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
try {
  const root = fs.realpathSync(process.argv[2]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'setup-manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('ไม่มีรายการตรวจไฟล์');
  for (const row of manifest.files) {
    if (!row.file || row.file.includes('\\') || row.file.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error('ชื่อไฟล์ไม่ปลอดภัย');
    const full = path.resolve(root, row.file);
    if (!full.startsWith(root + path.sep) || fs.lstatSync(full).isSymbolicLink()) throw new Error('ไฟล์อยู่นอกชุด');
    const bytes = fs.readFileSync(full);
    if (bytes.length !== row.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new Error('ไฟล์ไม่ครบ: ' + row.file);
  }
  console.log('ตรวจไฟล์หลังติดตั้งตรงกับชุดต้นฉบับแล้ว');
} catch (error) { console.error('ตรวจชุดติดตั้งไม่สำเร็จ: ' + error.message); process.exitCode = 1; }
