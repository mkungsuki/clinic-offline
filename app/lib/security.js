'use strict';
// Security round 1 (spec: _intake/security-round-1-spec.md, A-refined ของ codex)
//  - จำกัดความพยายาม login/ปลดล็อก PIN ต่อเครื่อง (remote) และต่อ (remote, ผู้ใช้) — ห้ามล็อกทั้งระบบ
//  - บันทึก auth_events / access_log (append-only) — ห้ามเก็บรหัส/PIN ที่พิมพ์ผิดเด็ดขาด
//  - Host/Origin allowlist ของ server หลัก กัน DNS rebinding / CSRF ข้ามเว็บจากเบราว์เซอร์เครื่องหมอ
const os = require('node:os');
const { db, now } = require('./db');

// ---------- station ----------
function isLoopbackAddress(value) {
  const address = String(value || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function stationOf(remoteAddress) { return isLoopbackAddress(remoteAddress) ? 'host' : 'lan'; }
function normalizeRemote(remoteAddress) {
  const a = String(remoteAddress || '').toLowerCase();
  return a.startsWith('::ffff:') ? a.slice(7) : a || 'unknown';
}

// ---------- rate limiter (in-memory; รีสตาร์ท = เริ่มนับใหม่ ยอมรับได้) ----------
const WINDOW_MS = 15 * 60 * 1000;      // นับความล้มเหลวย้อนหลัง 15 นาที
const BLOCK_MS = 15 * 60 * 1000;       // เกินโควตา → ปฏิเสธ 15 นาที (เฉพาะ key นั้น)
const MAX_FAILS = 10;                  // ต่อ window
const BACKOFF_AFTER = 3;               // เริ่มหน่วงหลังผิดครั้งที่ 3
const BACKOFF_CAP_MS = 60 * 1000;

const attempts = new Map(); // key -> { fails: number[], blockedUntil: number, nextAllowedAt: number, lockedLogged: boolean }

function limits(loopback) {
  // เครื่อง host เอง (หน้าร้าน) หลวมกว่า 2 เท่า — คนพิมพ์ PIN ผิดหน้าเคาน์เตอร์ต้องไม่ถูกล็อกง่ายเกิน
  const m = loopback ? 2 : 1;
  return { maxFails: MAX_FAILS * m, backoffAfter: BACKOFF_AFTER * m };
}
function entry(key) {
  let e = attempts.get(key);
  if (!e) { e = { fails: [], blockedUntil: 0, nextAllowedAt: 0, lockedLogged: false }; attempts.set(key, e); }
  const cutoff = Date.now() - WINDOW_MS;
  e.fails = e.fails.filter(t => t >= cutoff);
  return e;
}
// คืน { allowed:true } หรือ { allowed:false, retryAfterSec, reason:'blocked'|'backoff' }
function checkKey(key, loopback) {
  const e = entry(key);
  const t = Date.now();
  if (e.blockedUntil > t) return { allowed: false, retryAfterSec: Math.ceil((e.blockedUntil - t) / 1000), reason: 'blocked' };
  if (e.nextAllowedAt > t) return { allowed: false, retryAfterSec: Math.ceil((e.nextAllowedAt - t) / 1000), reason: 'backoff' };
  return { allowed: true };
}
// backoff (หน่วงทวีคูณ) ใช้เฉพาะ key ต่อ (เครื่อง, ผู้ใช้) — key ต่อเครื่องใช้แค่เพดานรวม → บล็อก 15 นาที
// เพื่อให้ผู้ใช้คนอื่นบนเครื่องเดียวกันไม่โดนหน่วงจากคนที่พิมพ์ผิดไม่กี่ครั้ง (spec: ห้ามล็อกทั้งเครื่อง/ทั้งระบบง่ายๆ)
function failKey(key, loopback, { backoff }) {
  const e = entry(key);
  const t = Date.now();
  const { maxFails, backoffAfter } = limits(loopback);
  e.fails.push(t);
  let becameBlocked = false;
  if (e.fails.length >= maxFails) {
    if (!e.blockedUntil || e.blockedUntil <= t) becameBlocked = true;
    e.blockedUntil = t + BLOCK_MS;
  } else if (backoff && e.fails.length >= backoffAfter) {
    e.nextAllowedAt = t + Math.min(BACKOFF_CAP_MS, 1000 * 2 ** (e.fails.length - backoffAfter));
  }
  return becameBlocked;
}
function successKey(key) { attempts.delete(key); }

// scope: 'login' | 'unlock' — key ต่อเครื่อง และต่อ (เครื่อง, ผู้ใช้)
function keysFor(scope, remoteAddress, subject) {
  const remote = normalizeRemote(remoteAddress);
  return { ipKey: `${scope}:ip:${remote}`, subjectKey: `${scope}:subject:${remote}|${String(subject || '').trim().toLowerCase()}` };
}
function humanRetry(sec) {
  if (sec >= 90) return `ลองใหม่ได้ในอีก ${Math.ceil(sec / 60)} นาที`;
  return `ลองใหม่ได้ในอีก ${sec} วินาที`;
}
// ก่อนตรวจรหัส: ถ้าติดหน่วง/บล็อก คืน error 429 (ไม่นับเป็นความล้มเหลวซ้ำ)
function precheck(scope, remoteAddress, subject) {
  const loopback = isLoopbackAddress(remoteAddress);
  const { ipKey, subjectKey } = keysFor(scope, remoteAddress, subject);
  for (const key of [ipKey, subjectKey]) {
    const r = checkKey(key, loopback);
    if (!r.allowed) {
      const what = scope === 'unlock' ? 'ปลดล็อก' : 'เข้าสู่ระบบ';
      const msg = r.reason === 'blocked'
        ? `${what}ผิดหลายครั้งเกินไป — ${humanRetry(r.retryAfterSec)} (เครื่องอื่นยังใช้งานได้ตามปกติ)`
        : `กรุณารอสักครู่ก่อน${what}อีกครั้ง — ${humanRetry(r.retryAfterSec)}`;
      return { ok: false, status: 429, retryAfterSec: r.retryAfterSec, message: msg };
    }
  }
  return { ok: true };
}
// หลังตรวจรหัสไม่ผ่าน: นับ + บันทึก event; คืน true ถ้าเพิ่งกลายเป็น blocked (จะบันทึก locked_out เพิ่ม)
function noteFailure(scope, remoteAddress, subject) {
  const loopback = isLoopbackAddress(remoteAddress);
  const { ipKey, subjectKey } = keysFor(scope, remoteAddress, subject);
  const a = failKey(subjectKey, loopback, { backoff: true });
  const b = failKey(ipKey, loopback, { backoff: false });
  return a || b;
}
function noteSuccess(scope, remoteAddress, subject) {
  const { ipKey, subjectKey } = keysFor(scope, remoteAddress, subject);
  successKey(subjectKey);
  successKey(ipKey);
}
function resetLimiter() { attempts.clear(); } // test-only (route มี test guard)

// ---------- auth_events / access_log ----------
const AUTH_EVENTS = new Set(['login_ok', 'login_fail', 'unlock_ok', 'unlock_fail', 'logout', 'locked_out', 'clock_override']);
function recordAuthEvent(event, { remoteAddress, username = null, userId = null } = {}) {
  if (!AUTH_EVENTS.has(event)) throw new Error(`auth event ไม่รู้จัก: ${event}`);
  try {
    db.prepare(`INSERT INTO auth_events (event, username, user_id, station, remote, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(event, username ? String(username).slice(0, 64) : null, userId, stationOf(remoteAddress), normalizeRemote(remoteAddress), now());
  } catch (e) { console.error('auth_events:', e.message); } // best-effort — ห้ามทำให้ login พัง
}
const ACCESS_ACTIONS = new Set(['view_patient', 'view_history', 'view_documents', 'export', 'print']);
function recordAccess(action, { session, remoteAddress, ref }) {
  if (!ACCESS_ACTIONS.has(action) || !session) return;
  try {
    db.prepare(`INSERT INTO access_log (user_id, role, station, action, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(session.userId, session.role, stationOf(remoteAddress), action, String(ref || '').slice(0, 64), now());
  } catch (e) { console.error('access_log:', e.message); }
}

// สรุปสำหรับหน้า admin — ไม่มีรหัส/PIN/cookie
function authSummary({ hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const sinceTs = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())} ${pad(since.getHours())}:${pad(since.getMinutes())}:${pad(since.getSeconds())}`;
  const fails = db.prepare(`SELECT remote, station, COUNT(*) c, MAX(created_at) last_at
    FROM auth_events WHERE event IN ('login_fail','unlock_fail') AND created_at >= ? GROUP BY remote, station ORDER BY c DESC LIMIT 20`).all(sinceTs);
  const lockouts = db.prepare(`SELECT remote, station, created_at FROM auth_events WHERE event = 'locked_out' AND created_at >= ? ORDER BY id DESC LIMIT 20`).all(sinceTs);
  const totals = db.prepare(`SELECT event, COUNT(*) c FROM auth_events WHERE created_at >= ? GROUP BY event`).all(sinceTs)
    .reduce((acc, r) => { acc[r.event] = r.c; return acc; }, {});
  const lastLogins = db.prepare(`SELECT a.username, a.station, a.remote, a.created_at, u.display_name
    FROM auth_events a LEFT JOIN users u ON u.id = a.user_id WHERE a.event = 'login_ok' ORDER BY a.id DESC LIMIT 10`).all();
  const worst = fails[0] ? fails[0].c : 0;
  return { hours, since: sinceTs, totals, fails, lockouts, last_logins: lastLogins,
    level: worst >= 50 || lockouts.length ? 'bad' : worst >= 10 ? 'warn' : 'ok' };
}
function accessSearch({ ref = '', userId = null, dateFrom = '', dateTo = '', limit = 200 } = {}) {
  const where = [], args = [];
  if (ref) { where.push('a.ref = ?'); args.push(String(ref)); }
  if (userId) { where.push('a.user_id = ?'); args.push(Number(userId)); }
  if (dateFrom) { where.push('a.created_at >= ?'); args.push(`${dateFrom} 00:00:00`); }
  if (dateTo) { where.push('a.created_at <= ?'); args.push(`${dateTo} 23:59:59`); }
  const sql = `SELECT a.id, a.user_id, u.display_name, a.role, a.station, a.action, a.ref, a.created_at
    FROM access_log a LEFT JOIN users u ON u.id = a.user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(Math.max(Number(limit) || 200, 1), 1000));
}

// ---------- Host / Origin allowlist ----------
// hostname ที่ยอมรับ = localhost, loopback, ชื่อเครื่อง, IP ทุกใบของเครื่องนี้ (+ CLINIC_EXTRA_HOSTS) — ไม่สน port
// (DNS rebinding: เว็บร้ายชี้ evil.com → IP คลินิก แล้วเบราว์เซอร์เครื่องหมอส่ง Host: evil.com → ต้องถูกปฏิเสธ)
let hostCache = { at: 0, set: new Set() };
function allowedHostnames() {
  const t = Date.now();
  if (t - hostCache.at < 60 * 1000) return hostCache.set;
  const set = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
  try { const h = os.hostname().toLowerCase(); if (h) { set.add(h); set.add(`${h}.local`); } } catch {}
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) if (ni && ni.address) set.add(String(ni.address).toLowerCase().replace(/%.*$/, ''));
    }
  } catch {}
  for (const extra of String(process.env.CLINIC_EXTRA_HOSTS || '').split(',')) {
    const v = extra.trim().toLowerCase(); if (v) set.add(v);
  }
  hostCache = { at: t, set };
  return set;
}
function hostnameOf(hostHeader) {
  const raw = String(hostHeader || '').trim();
  if (!raw) return null;
  try { return new URL(`http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return null; }
}
function hostAllowed(hostHeader) {
  const h = hostnameOf(hostHeader);
  return !!h && allowedHostnames().has(h);
}
// Origin: ถ้ามี (เบราว์เซอร์ส่งเมื่อ POST หรือข้าม origin) ต้องเป็นเครื่องเรา; ไม่มี = client ที่ไม่ใช่เบราว์เซอร์ (curl/tool) ผ่าน
function originAllowed(originHeader) {
  const raw = String(originHeader || '').trim();
  if (!raw || raw === 'null') return !raw; // 'null' origin (sandbox/file://) ไม่รับ
  try { return allowedHostnames().has(new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '')); } catch { return false; }
}

module.exports = {
  isLoopbackAddress, stationOf, normalizeRemote,
  precheck, noteFailure, noteSuccess, resetLimiter,
  recordAuthEvent, recordAccess, authSummary, accessSearch,
  hostAllowed, originAllowed, allowedHostnames,
  LIMITS: { WINDOW_MS, BLOCK_MS, MAX_FAILS, BACKOFF_AFTER, BACKOFF_CAP_MS },
};
