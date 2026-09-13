'use strict';
// สร้าง app-only ZIP + strict manifest + detached Ed25519 signature
// private key ต้องส่งด้วย --key เป็น path ชัดเจน และจะไม่ถูกพิมพ์หรือคัดลอกเข้า output
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SCHEMA_VERSION } = require('../lib/schema-version');
const { writeZip } = require('../lib/zip');
const { validateManifest, signManifestBytes } = require('../lib/update-manifest');
const { APP_FILES, APP_DIRECTORIES, TOOL_FILES, TRIAL_SEED_FILES, FORBIDDEN_BASENAME,
  ALLOWED_RELEASE_EXTENSION } = require('../lib/release-files');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');

function sha256Buffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function sha256File(file) { return sha256Buffer(fs.readFileSync(file)); }

function collectDirectory(root, relative, result) {
  const dir = path.join(root, relative);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.posix.join(relative.replace(/\\/g, '/'), entry.name);
    const full = path.join(root, ...child.split('/'));
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`ไม่อนุญาต symbolic link ใน release: ${child}`);
    if (stat.isDirectory()) collectDirectory(root, child, result);
    else if (stat.isFile() && ALLOWED_RELEASE_EXTENSION.test(entry.name) && !FORBIDDEN_BASENAME.test(entry.name)) result.push(child);
  }
}

function collectReleasePaths(appRoot, variant) {
  const paths = [];
  for (const file of APP_FILES) if (fs.existsSync(path.join(appRoot, file))) paths.push(file);
  for (const directory of APP_DIRECTORIES) collectDirectory(appRoot, directory, paths);
  for (const file of TOOL_FILES) if (fs.existsSync(path.join(appRoot, ...file.split('/')))) paths.push(file);
  if (variant === 'trial') for (const file of TRIAL_SEED_FILES) paths.push(file);
  const unique = [...new Set(paths.map(item => item.replace(/\\/g, '/')))];
  unique.sort((a, b) => a.localeCompare(b));
  for (const item of unique) {
    const lower = item.toLowerCase();
    // ชุดทดลองยกเว้นไฟล์ seed จำลองที่อนุญาตไว้ชัด (เหมือน build-installer) — seed-mock-* ติด FORBIDDEN_BASENAME (พบตอนเซ็น trial 1.0.0 จริง 2026-08-19)
    const allowedTrialSeed = variant === 'trial' && TRIAL_SEED_FILES.includes(item);
    if (lower === 'data' || lower.startsWith('data/') || lower.startsWith('runtime/') || (!allowedTrialSeed && FORBIDDEN_BASENAME.test(path.posix.basename(item)))) {
      throw new Error(`ไฟล์ต้องห้ามหลุดเข้า release: ${item}`);
    }
  }
  return unique;
}

function buildUpdatePackage(options) {
  const variant = options.variant || 'production';
  const channel = options.channel || 'pilot';
  if (!['production', 'trial'].includes(variant)) throw new Error('--variant ต้องเป็น production หรือ trial');
  if (!['pilot', 'stable'].includes(channel)) throw new Error('--channel ต้องเป็น pilot หรือ stable');
  if (!options.keyFile) throw new Error('ต้องระบุ --key <path private Ed25519 key> อย่างชัดเจน');
  if (!options.minFrom) throw new Error('ต้องระบุ --min-from x.y.z');
  if (!options.baseUrl) throw new Error('ต้องระบุ --base-url https://...');
  const packageJson = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
  if (options.version && options.version !== packageJson.version) throw new Error('--version ต้องตรงกับ version ใน app/package.json เพื่อไม่ให้ manifest กับโค้ดคนละรุ่น');
  const version = packageJson.version;
  const minRuntime = options.minRuntime || String(packageJson.engines?.node || '>=22.5.0').replace(/^[^0-9]*/, '').replace(/^(\d+\.\d+)$/, '$1.0');
  const outDir = path.resolve(options.out || path.join(REPO_ROOT, 'dist', 'updates'));
  if (outDir.toLowerCase().startsWith(path.join(APP_ROOT, 'data').toLowerCase())) throw new Error('ห้าม build release ลง app/data');
  fs.mkdirSync(outDir, { recursive: true });
  const packageFile = `ClinicApp-${version}-${variant}-${channel}.zip`;
  const manifestFile = `latest-${variant}-${channel}.json`;
  const signatureFile = `${manifestFile}.sig`;
  const auditFile = `ClinicApp-${version}-${variant}-${channel}.audit.json`;
  for (const name of [packageFile, manifestFile, signatureFile, auditFile]) {
    if (fs.existsSync(path.join(outDir, name))) throw new Error(`ไฟล์ output มีอยู่แล้ว: ${name}`);
  }

  const paths = collectReleasePaths(APP_ROOT, variant);
  const entries = paths.map(item => ({ name: item, source: path.join(APP_ROOT, ...item.split('/')) }));
  const inventory = entries.map(entry => {
    const stat = fs.lstatSync(entry.source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`ไฟล์ release ไม่ปลอดภัย: ${entry.name}`);
    return { path: entry.name, bytes: stat.size, sha256: sha256File(entry.source) };
  });
  const obsolete = options.obsolete || [];
  const zipPath = path.join(outDir, packageFile);
  const keyBytes = fs.readFileSync(path.resolve(options.keyFile));
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(keyBytes);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('private key ต้องเป็น Ed25519');
    writeZip(zipPath, entries);
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'https:') throw new Error('--base-url ต้องเป็น HTTPS');
    const packageUrl = new URL(encodeURIComponent(packageFile), base.href.endsWith('/') ? base : new URL(base.href + '/')).href;
    const manifest = validateManifest({
      format: 1,
      product: 'clinic-offline',
      edition: options.edition || 'standard',
      version,
      variant,
      channel,
      min_from_version: options.minFrom,
      min_runtime: minRuntime,
      expected_schema: SCHEMA_VERSION,
      created_at: (options.createdAt ? new Date(options.createdAt) : new Date()).toISOString(),
      package: { url: packageUrl, file: packageFile, bytes: fs.statSync(zipPath).size, sha256: sha256File(zipPath) },
      files: inventory,
      obsolete,
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const signatureBytes = signManifestBytes(manifestBytes, privateKey);
    fs.writeFileSync(path.join(outDir, manifestFile), manifestBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(outDir, signatureFile), signatureBytes, { flag: 'wx' });
    const audit = { version, variant, channel, expected_schema: SCHEMA_VERSION,
      manifest: { file: manifestFile, sha256: sha256Buffer(manifestBytes) },
      signature: { file: signatureFile, sha256: sha256Buffer(signatureBytes) },
      package: { file: packageFile, bytes: manifest.package.bytes, sha256: manifest.package.sha256 }, files: inventory };
    fs.writeFileSync(path.join(outDir, auditFile), JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    for (const name of [packageFile, manifestFile, signatureFile, auditFile]) { try { fs.unlinkSync(path.join(outDir, name)); } catch {} }
    throw error;
  } finally { keyBytes.fill(0); }
  return { outDir, packageFile, manifestFile, signatureFile, auditFile, version, variant, channel, files: inventory.length };
}

function argValue(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
if (require.main === module) {
  const args = process.argv.slice(2);
  const obsoleteFile = argValue(args, '--obsolete');
  const result = buildUpdatePackage({
    out: argValue(args, '--out'), keyFile: argValue(args, '--key'), minFrom: argValue(args, '--min-from'),
    baseUrl: argValue(args, '--base-url'), variant: argValue(args, '--variant') || 'production',
    channel: argValue(args, '--channel') || 'pilot', edition: argValue(args, '--edition') || 'standard',
    version: argValue(args, '--version'), minRuntime: argValue(args, '--min-runtime'),
    obsolete: obsoleteFile ? JSON.parse(fs.readFileSync(obsoleteFile, 'utf8')) : [],
  });
  console.log(`สร้างชุดอัปเดต ${result.version} (${result.variant}/${result.channel}) แล้ว`);
  console.log(`ไฟล์โปรแกรม ${result.files} รายการ · output: ${result.outDir}`);
}

module.exports = { buildUpdatePackage, collectReleasePaths };
