'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { verifyAndParseManifest, checkManifestPolicy, MAX_MANIFEST_BYTES } = require('./update-manifest');
const { extractZipExact } = require('./zip');
const { SCHEMA_VERSION } = require('./schema-version');
const { atomicWriteJson, updateError, readApplyLock, removeTreeSync } = require('./update-core');

const MAX_SIGNATURE_BYTES = 4096;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function safeHttpsUrl(value, label) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw updateError('UPDATE_FEED_URL', `${label} ไม่ใช่ URL ที่อ่านได้`); }
  // ห้าม query string ด้วย: release เป็นไฟล์นิ่ง และ feed.href + '.sig' จะเพี้ยนถ้ามี ?query ต่อท้าย
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw updateError('UPDATE_FEED_URL', `${label} ต้องเป็น HTTPS ที่ไม่มีรหัสผ่าน คำถามท้าย URL หรือ fragment`);
  }
  return url;
}

// URL ที่ "ตั้งค่า" (feed/package) ต้องสะอาด (HTTPS ไม่มี query/credential) — แต่ปลายทางของ redirect ไม่ต้อง:
// GitHub Releases ส่งต่อไป objects.githubusercontent.com ด้วย signed URL ที่มี ?X-Amz-... เสมอ (พบ 2026-08-19 ก่อน release แรก —
// ถ้าเอา safeHttpsUrl ไปตรวจ redirect ด้วย updater จะไม่เคยดาวน์โหลดจาก GitHub ได้เลย) → hop ถัดไปตรวจแค่ต้องยังเป็น HTTPS
function fetchHttpsBuffer(value, limit, redirects = 3, requester = https.request) {
  return fetchHttpsBufferFrom(safeHttpsUrl(value, 'ที่อยู่ชุดอัปเดต'), limit, redirects, requester);
}
function fetchHttpsBufferFrom(url, limit, redirects, requester) {
  if (!(url instanceof URL) || url.protocol !== 'https:') return Promise.reject(updateError('UPDATE_REDIRECT', 'ไม่อนุญาตให้ redirect ออกจาก HTTPS'));
  return new Promise((resolve, reject) => {
    const request = requester(url, { method: 'GET', timeout: REQUEST_TIMEOUT_MS,
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'ClinicUpdater/1' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects <= 0 || !response.headers.location) return reject(updateError('UPDATE_REDIRECT', 'ชุดอัปเดต redirect มากเกินไป'));
        let next;
        try { next = new URL(response.headers.location, url); } catch { return reject(updateError('UPDATE_REDIRECT', 'ที่อยู่ redirect ไม่ถูกต้อง')); }
        if (next.protocol !== 'https:') return reject(updateError('UPDATE_REDIRECT', 'ไม่อนุญาตให้ redirect ออกจาก HTTPS'));
        fetchHttpsBufferFrom(next, limit, redirects - 1, requester).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); return reject(updateError('UPDATE_HTTP', `เซิร์ฟเวอร์อัปเดตตอบ ${response.statusCode}`)); }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared && declared > limit) { response.resume(); return reject(updateError('UPDATE_DOWNLOAD_SIZE', 'ไฟล์อัปเดตใหญ่เกินขนาดที่อนุญาต')); }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > limit) { request.destroy(updateError('UPDATE_DOWNLOAD_SIZE', 'ไฟล์อัปเดตใหญ่เกินขนาดที่อนุญาต')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(updateError('UPDATE_TIMEOUT', 'เชื่อมต่อเซิร์ฟเวอร์อัปเดตนานเกินไป')));
    request.on('error', reject);
    request.end();
  });
}

function readJson(file, message) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw updateError('UPDATE_PROFILE', message); }
}

class UpdateService {
  constructor(options = {}) {
    this.appRoot = path.resolve(options.appRoot || path.join(__dirname, '..'));
    this.installRoot = path.resolve(options.installRoot || path.join(this.appRoot, '..'));
    this.updateRoot = path.join(this.installRoot, 'update');
    this.dataStateDir = path.join(path.resolve(options.dataDir || path.join(this.appRoot, 'data')), 'update');
    this.stateFile = path.join(this.dataStateDir, 'service-state.json');
    this.publicKeyFile = path.resolve(options.publicKeyFile || path.join(this.appRoot, 'update-public-key.pem'));
    this.feedUrl = options.feedUrl === undefined ? this.readFeedUrl() : options.feedUrl;
    this.fetchBuffer = options.fetchBuffer || fetchHttpsBuffer;
    this.spawnApply = options.spawnApply || (requestFile => this.spawnAssistant(requestFile));
    this.busy = false;
    this.applying = false;
  }

  readFeedUrl() {
    if (process.env.CLINIC_UPDATE_FEED_URL) return process.env.CLINIC_UPDATE_FEED_URL.trim();
    const file = path.join(this.updateRoot, 'feed-url.txt');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  }

  policy() {
    const profile = readJson(path.join(this.updateRoot, 'install-profile.json'), 'ไม่พบข้อมูลชนิดชุดติดตั้ง กรุณาใช้ตัวติดตั้งเต็ม');
    const pkg = readJson(path.join(this.appRoot, 'package.json'), 'อ่าน version ปัจจุบันไม่ได้');
    return { currentVersion: pkg.version, variant: profile.variant, channel: profile.channel,
      edition: profile.edition, port: profile.port, expectedSchema: SCHEMA_VERSION, runtimeVersion: process.versions.node };
  }

  publicStatus({ host = false } = {}) {
    // ไม่มี install-profile (เครื่อง dev / ติดตั้งมือ) ต้องไม่ล้มทั้ง route — หน้า admin ยังต้องอ่านรุ่นปัจจุบัน/ผลล่าสุดได้ และบอกว่าอัปเดตอัตโนมัติใช้ไม่ได้เพราะอะไร
    let policy, profileError = null;
    try { policy = this.policy(); }
    catch (error) {
      profileError = error.message;
      let version = '0.0.0';
      try { version = readJson(path.join(this.appRoot, 'package.json'), 'อ่าน version ปัจจุบันไม่ได้').version; } catch {}
      policy = { currentVersion: version };
    }
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch {}
    let journal = null;
    for (const file of [path.join(this.updateRoot, 'active-journal.json'), path.join(this.updateRoot, 'active-journal.json.previous')]) {
      try { journal = JSON.parse(fs.readFileSync(file, 'utf8')); break; } catch {}
    }
    return {
      configured: !profileError && !!this.feedUrl && fs.existsSync(this.publicKeyFile),
      host,
      current_version: policy.currentVersion,
      state: journal && !['committed', 'rolled-back'].includes(journal.state) ? 'applying' : (stored.state || 'idle'),
      available_version: stored.available_version || null,
      checked_at: stored.checked_at || null,
      message: profileError || stored.message || (!this.feedUrl ? 'ยังไม่ได้ตั้งแหล่งอัปเดต ใช้ตัวติดตั้งเต็มสำหรับรุ่นนี้' : null),
      last_result: journal ? { state: journal.state, version: journal.new_version || null, finished_at: journal.finished_at || journal.updated_at || null } : null,
    };
  }

  saveState(value) {
    const clean = { format: 1, state: value.state, available_version: value.available_version || null,
      checked_at: new Date().toISOString(), message: value.message || null,
      manifest_file: value.manifest_file || null, signature_file: value.signature_file || null,
      request_file: value.request_file || null };
    atomicWriteJson(this.stateFile, clean);
    return clean;
  }

  async check() {
    if (this.busy) throw updateError('UPDATE_BUSY', 'กำลังตรวจหรือดาวน์โหลดอัปเดตอยู่ กรุณารอสักครู่');
    if (!this.feedUrl) throw updateError('UPDATE_NOT_CONFIGURED', 'ยังไม่ได้ตั้งแหล่งอัปเดต กรุณาใช้ตัวติดตั้งเต็ม');
    if (!fs.existsSync(this.publicKeyFile)) throw updateError('UPDATE_KEY_MISSING', 'เครื่องนี้ยังไม่มี public key สำหรับตรวจชุดอัปเดต กรุณาใช้ตัวติดตั้งเต็ม');
    this.busy = true;
    try {
      const feed = safeHttpsUrl(this.feedUrl, 'แหล่งอัปเดต');
      const signatureUrl = new URL(feed.href + '.sig');
      const [manifestBytes, signatureBytes] = await Promise.all([
        this.fetchBuffer(feed, MAX_MANIFEST_BYTES),
        this.fetchBuffer(signatureUrl, MAX_SIGNATURE_BYTES),
      ]);
      const publicKey = fs.readFileSync(this.publicKeyFile);
      const manifest = verifyAndParseManifest(manifestBytes, signatureBytes, publicKey);
      const policy = this.policy();
      try { checkManifestPolicy(manifest, policy); }
      catch (error) {
        if (error.code === 'POLICY_DOWNGRADE') return this.saveState({ state: 'up_to_date', message: 'โปรแกรมเป็นรุ่นล่าสุดแล้ว' });
        throw error;
      }
      // scheduler ยิง check ทุกวัน/ตอนบูต — ถ้าเขียนทับ ready_to_apply ที่ยังใช้ได้
      // ผู้ใช้จะโหลดชุดเดิมซ้ำทั้งก้อน และ downloads/<id> เดิมกลายเป็นขยะค้างเครื่อง
      let stored = null;
      try { stored = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch {}
      if (stored?.state === 'ready_to_apply' && stored.available_version === manifest.version
        && stored.request_file && fs.existsSync(stored.request_file)) return stored;
      const feedDir = path.join(this.updateRoot, 'feed-cache');
      fs.mkdirSync(feedDir, { recursive: true });
      const base = `${policy.variant}-${policy.channel}`;
      const manifestFile = path.join(feedDir, `${base}.json`), signatureFile = `${manifestFile}.sig`;
      fs.writeFileSync(manifestFile, manifestBytes);
      fs.writeFileSync(signatureFile, signatureBytes);
      return this.saveState({ state: 'available', available_version: manifest.version,
        message: `มีรุ่น ${manifest.version} พร้อมดาวน์โหลด`, manifest_file: manifestFile, signature_file: signatureFile });
    } catch (error) {
      this.saveState({ state: 'error', message: error.message });
      throw error;
    } finally { this.busy = false; }
  }

  async stage() {
    let state;
    try { state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { state = null; }
    if (!state || state.state !== 'available') state = await this.check();
    if (state.state === 'up_to_date') return state;
    if (this.busy) throw updateError('UPDATE_BUSY', 'กำลังตรวจหรือดาวน์โหลดอัปเดตอยู่ กรุณารอสักครู่');
    this.busy = true;
    let checkRoot = null;
    try {
      const manifestBytes = fs.readFileSync(state.manifest_file), signatureBytes = fs.readFileSync(state.signature_file);
      const manifest = verifyAndParseManifest(manifestBytes, signatureBytes, fs.readFileSync(this.publicKeyFile));
      checkManifestPolicy(manifest, this.policy());
      if (manifest.package.bytes > MAX_PACKAGE_BYTES) throw updateError('UPDATE_DOWNLOAD_SIZE', 'ชุดอัปเดตใหญ่เกินขนาดที่อนุญาต');
      const packageBytes = await this.fetchBuffer(safeHttpsUrl(manifest.package.url, 'ไฟล์อัปเดต'), Math.min(MAX_PACKAGE_BYTES, manifest.package.bytes));
      if (packageBytes.length !== manifest.package.bytes || sha256(packageBytes) !== manifest.package.sha256) {
        throw updateError('UPDATE_PACKAGE_HASH', 'ไฟล์อัปเดตตรวจ SHA-256 ไม่ผ่าน');
      }
      const id = crypto.randomUUID();
      const downloadDir = path.join(this.updateRoot, 'downloads', id);
      fs.mkdirSync(downloadDir, { recursive: true });
      const manifestFile = path.join(downloadDir, 'manifest.json'), signatureFile = `${manifestFile}.sig`;
      const packageFile = path.join(downloadDir, manifest.package.file);
      fs.writeFileSync(manifestFile, manifestBytes, { flag: 'wx' });
      fs.writeFileSync(signatureFile, signatureBytes, { flag: 'wx' });
      fs.writeFileSync(packageFile, packageBytes, { flag: 'wx' });
      checkRoot = path.join(this.updateRoot, 'stage-check', id);
      extractZipExact(packageFile, checkRoot, manifest.files);
      removeTreeSync(checkRoot); checkRoot = null;
      const policy = this.policy();
      const requestDir = path.join(this.updateRoot, 'requests'); fs.mkdirSync(requestDir, { recursive: true });
      const requestFile = path.join(requestDir, `${id}.json`);
      atomicWriteJson(requestFile, { format: 1, id, manifest_file: manifestFile, signature_file: signatureFile,
        package_file: packageFile, variant: policy.variant, channel: policy.channel, edition: policy.edition,
        current_version: policy.currentVersion, port: policy.port });
      return this.saveState({ state: 'ready_to_apply', available_version: manifest.version,
        message: `ดาวน์โหลดและตรวจรุ่น ${manifest.version} แล้ว พร้อมอัปเดต`, request_file: requestFile });
    } catch (error) {
      if (checkRoot) try { removeTreeSync(checkRoot); } catch {}
      this.saveState({ state: 'error', message: error.message });
      throw error;
    } finally { this.busy = false; }
  }

  // กดปุ่มซ้ำ/สอง request ต้องไม่ spawn assistant ตัวที่สองมาสลับไฟล์ทับตัวแรก
  assertNotApplying() {
    if (this.applying) throw updateError('UPDATE_IN_PROGRESS', 'กำลังอัปเดตอยู่ กรุณารอให้รอบนี้จบก่อน (ประมาณ 1–2 นาที)');
    if (readApplyLock(this.installRoot)?.alive) {
      throw updateError('UPDATE_IN_PROGRESS', 'กำลังอัปเดตอยู่ กรุณารอให้รอบนี้จบก่อน (ประมาณ 1–2 นาที)');
    }
    for (const file of [path.join(this.updateRoot, 'active-journal.json'), path.join(this.updateRoot, 'active-journal.json.previous')]) {
      let journal = null;
      try { journal = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (journal && !['committed', 'rolled-back'].includes(journal.state)) {
        throw updateError('UPDATE_IN_PROGRESS', 'มีการอัปเดตค้างอยู่ กรุณาปิดแล้วเปิดระบบคลินิกใหม่หนึ่งครั้งเพื่อให้ระบบจัดการให้เรียบร้อยก่อน');
      }
      break;
    }
  }

  async apply() {
    this.assertNotApplying();
    this.applying = true;
    try { return await this.applyLocked(); }
    finally { this.applying = false; }
  }

  async applyLocked() {
    let state;
    try { state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { state = null; }
    if (!state || state.state !== 'ready_to_apply') state = await this.stage();
    if (state.state === 'up_to_date') return { ok: true, state: 'up_to_date' };
    this.saveState({ state: 'starting', available_version: state.available_version,
      message: 'กำลังเริ่มอัปเดต ระบบจะกลับมาเองใน 1–2 นาที', request_file: state.request_file });
    this.spawnApply(state.request_file);
    return { ok: true, state: 'starting', version: state.available_version };
  }

  spawnAssistant(requestFile) {
    const logDir = path.join(this.updateRoot, 'logs'); fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, 'latest.log'), 'a');
    const child = spawn(process.execPath, ['--no-warnings', path.join(this.appRoot, 'update-assistant.js'), '--request', requestFile], {
      cwd: this.appRoot, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    child.unref(); fs.closeSync(log);
  }

  startScheduler() {
    if (!this.feedUrl || !fs.existsSync(this.publicKeyFile)) return null;
    const run = () => this.check().catch(() => {});
    const first = setTimeout(run, 5000); first.unref();
    const daily = setInterval(run, 24 * 60 * 60 * 1000); daily.unref();
    return daily;
  }
}

function entitlementAllowsUpdate() { return { allowed: true, reason: null }; }

module.exports = { UpdateService, fetchHttpsBuffer, safeHttpsUrl, entitlementAllowsUpdate,
  MAX_SIGNATURE_BYTES, MAX_PACKAGE_BYTES };
