'use strict';
// One-way publication snapshot. Never commits, pushes, follows links, or copies history.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const release = require('../lib/release-files');
const ROOT = path.resolve(__dirname, '../..');
const DEV_FILES = [
  '.gitignore', 'seed-mock.js', ...release.TRIAL_SEED_FILES, 'codex-redteam-verification.js',
  'tools/build-installer.js', 'tools/build-hotfix.js', 'tools/build-update-package.js',
  'tools/fetch-runtime.js', 'tools/build-trial-docs.js', 'tools/publish-public.js',
  'tools/verify-setup-package.js', 'tools/verify-prepared.cjs',
  'tools/owner-release.cjs', 'tools/sign-release.ps1',
];
// Private identifiers are represented as code points so the scanner can scan itself.
const BLOCKED = [[107,97,110,112,105], [84,104,101,119,105,110,122,122,122],
  [3627,3617,3629,3648,3611,3636,3604,32,99,108,105,110,105,99],
  [109,107,117,110,103,117,107,105,64], [3652,3621,3609,3660],
  [81,117,105,99,107,32,65,115,115,105,115,116]].map(a => String.fromCodePoint(...a));
const TEXT = /\.(js|cjs|json|html|css|md|txt|cmd|ps1|svg|yml|yaml)$/i;
const FORBIDDEN = /(?:^|\/)(?:data|\.ui-test-data|node_modules|\.git|_intake|output|dist)(?:\/|$)|recovery-key|private|\.(?:db(?:-wal|-shm)?|enc|key|log)$/i;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function inside(root, rel) {
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('ไม่รับ symbolic link/junction ที่ราก');
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.split('/').some(x => !x || x === '.' || x === '..' || /[:\x00-\x1f]/.test(x))) throw new Error('ชื่อไฟล์ในรายการไม่ปลอดภัย');
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('ไฟล์อยู่นอกปลายทาง');
  let p = root;
  for (const part of rel.split('/')) {
    p = path.join(p, part);
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('ไม่รับ symbolic link/junction');
  }
  return full;
}
function walk(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('ไม่รับ symbolic link/junction ที่ราก');
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink()) throw new Error('ไม่รับ symbolic link/junction ในต้นฉบับ');
    const rel = prefix + e.name;
    return e.isDirectory() ? walk(path.join(root, e.name), rel + '/') : [rel];
  });
}
function collect(root = ROOT) {
  const app = path.join(root, 'app');
  const rels = new Set([...release.APP_FILES.filter(file => file !== require('../lib/runtime').RELATIVE), ...release.TOOL_FILES, ...DEV_FILES]);
  for (const dir of release.APP_DIRECTORIES) for (const rel of walk(path.join(app, dir))) {
    if (release.ALLOWED_RELEASE_EXTENSION.test(rel) && !release.FORBIDDEN_BASENAME.test(path.basename(rel))) rels.add(dir + '/' + rel);
  }
  for (const name of fs.readdirSync(app)) if (/^test-[\w-]+\.js$/.test(name)) rels.add(name);
  const files = [...rels].map(rel => ({ file: 'app/' + rel, source: inside(app, rel) }));
  const content = path.join(root, 'public-release');
  for (const rel of walk(content)) {
    if (!/^(?:README\.md|CONTRIBUTING\.md|docs\/.+|\.github\/(?:ISSUE_TEMPLATE\/.+|PULL_REQUEST_TEMPLATE\.md))$/.test(rel)) throw new Error('ไฟล์นอก allowlist ใน public-release: ' + rel);
    files.push({ file: rel, source: inside(content, rel) });
  }
  return files.sort((a,b) => a.file.localeCompare(b.file));
}
function checkContent(file, bytes) {
  if (FORBIDDEN.test(file)) throw new Error('ไฟล์ต้องห้าม: ' + file);
  if (TEXT.test(file)) {
    const content = bytes.toString('utf8').toLowerCase();
    if (BLOCKED.some(word => content.includes(word.toLowerCase())) || /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(content.toUpperCase())) throw new Error('พบข้อความต้องห้ามใน ' + file);
  }
}
function publish(destination, { root = ROOT, beforeWrite = () => {} } = {}) {
  const dest = fs.realpathSync(destination);
  if (dest === fs.realpathSync(root)) throw new Error('ห้ามใช้ repo งานเป็นปลายทาง');
  if (!fs.lstatSync(path.join(dest, '.git')).isDirectory() || fs.lstatSync(path.join(dest, '.git')).isSymbolicLink()) throw new Error('ต้องเป็น checkout แยกที่มี .git เป็นโฟลเดอร์จริง');
  const license = fs.readFileSync(inside(dest, 'LICENSE'));
  if (!license.includes(Buffer.from('GNU AFFERO GENERAL PUBLIC LICENSE'))) throw new Error('ไม่พบ LICENSE เดิมของ repo public');
  const canonical = path.join(root, 'LICENSE');
  if (fs.existsSync(canonical) && !license.equals(fs.readFileSync(canonical))) throw new Error('LICENSE ปลายทางไม่ตรงต้นฉบับ — ไม่เขียนทับ');
  const inventoryPath = path.join(dest, '.git', 'clinic-public-inventory.json');
  const old = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) : { format: 1, files: [] };
  if (old.format !== 1 || !Array.isArray(old.files)) throw new Error('inventory ไม่ถูกต้อง');
  const managed = new Map();
  for (const row of old.files) {
    if (!row || !/^(?:app\/|docs\/|\.github\/|README\.md$|CONTRIBUTING\.md$)/.test(row.file) || FORBIDDEN.test(row.file) || !/^[a-f0-9]{64}$/.test(row.sha256) || managed.has(row.file)) throw new Error('inventory ไม่ปลอดภัย');
    const full = inside(dest, row.file);
    if (fs.existsSync(full) && hash(fs.readFileSync(full)) !== row.sha256) throw new Error('ไฟล์ปลายทางถูกแก้เอง — กรุณาตรวจ: ' + row.file);
    managed.set(row.file, row);
  }
  // Preflight every source and destination BEFORE changing any destination file.
  const incoming = collect(root).map(item => {
    const full = inside(dest, item.file);
    const bytes = fs.readFileSync(item.source);
    checkContent(item.file, bytes);
    if (fs.existsSync(full) && !managed.has(item.file)) throw new Error('ไม่เขียนทับไฟล์ที่ไม่ได้เป็นเจ้าของ: ' + item.file);
    return { ...item, bytes, sha256: hash(bytes), full };
  });
  // Reject unexpected checkout files; never silently publish stale or untracked data.
  for (const rel of walkCheckout(dest)) if (rel !== 'LICENSE' && !managed.has(rel)) throw new Error('พบไฟล์นอก inventory: ' + rel);
  const next = new Set(incoming.map(x => x.file));
  const previous = new Map([...new Set([...managed.keys(), ...next])].map(rel => {
    const file = inside(dest, rel); return [rel, fs.existsSync(file) ? fs.readFileSync(file) : null];
  }));
  try {
    for (const item of incoming) {
      beforeWrite(item.file);
      fs.mkdirSync(path.dirname(item.full), { recursive: true });
      fs.writeFileSync(item.full, item.bytes);
      if (hash(fs.readFileSync(item.full)) !== item.sha256) throw new Error('คัดลอกไม่ครบ: ' + item.file);
    }
    for (const [rel] of managed) if (!next.has(rel) && fs.existsSync(inside(dest, rel))) fs.unlinkSync(inside(dest, rel));
  } catch (error) {
    for (const [rel, bytes] of previous) {
      const file = inside(dest, rel);
      if (bytes === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
      else fs.writeFileSync(file, bytes);
    }
    throw error;
  }
  fs.writeFileSync(inventoryPath, JSON.stringify({ format: 1, files: incoming.map(({file,sha256}) => ({file,sha256})) }, null, 2) + '\n');
  if (!fs.readFileSync(path.join(dest, 'LICENSE')).equals(license)) throw new Error('LICENSE เปลี่ยนระหว่างทำงาน');
  for (const rel of walkCheckout(dest)) checkContent(rel, fs.readFileSync(inside(dest, rel)));
  return { files: incoming.length, forbiddenMatches: 0, destination: dest };
}
function walkCheckout(dest) {
  return fs.readdirSync(dest, { withFileTypes: true }).filter(e => e.name !== '.git').flatMap(e => {
    if (e.isSymbolicLink()) throw new Error('ไม่รับ symbolic link/junction ที่ปลายทาง');
    return e.isDirectory() ? walk(path.join(dest, e.name), e.name + '/') : [e.name];
  });
}
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('ใช้: node tools/publish-public.js <checkout-public>');
    const origin = execFileSync('git', ['-C', process.argv[2], 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true }).trim();
    if (!['https://github.com/mkungsuki/clinic-offline', 'https://github.com/mkungsuki/clinic-offline.git', 'git@github.com:mkungsuki/clinic-offline.git'].includes(origin)) throw new Error('ปลายทางต้องเป็น checkout ของ clinic-offline ที่แยกจาก repo งาน');
    const result = publish(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
    console.log(execFileSync('git', ['-C', result.destination, 'status', '--short'], { encoding: 'utf8', windowsHide: true }));
    console.log('สำเนาพร้อมตรวจ — ยังไม่ได้ commit หรือ push');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { publish, collect, checkContent, inside, DEV_FILES };
