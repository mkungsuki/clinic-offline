'use strict';
// Auth: scrypt password/PIN + session ใน memory ที่ persist ลงดิสก์ให้รอด server restart
// (เดิม in-memory ล้วน — incident 2026-08-24: server ล้มแล้ว supervisor ฟื้นใน 2 วิ แต่หมอโดนดีด login ทุกรอบ
//  เจ้าของเคาะ "ต้องไม่หลุด" — restart ธรรมดา session ต้องรอด · ยกเว้นรอบอัปเดตรุ่น: update-assistant ลบ
//  sessions.json ตอนหยุด server เพื่อคง invariant ของ health check (review 2026-08-15: ห้ามมีใครเขียนข้อมูล
//  ระหว่างตรวจนับหลังสลับรุ่น) — รอบอัปเดตจึง login ใหม่เหมือนเดิม พร้อมข้อความอธิบายบนหน้า login)
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, now, getSetting, setSetting, DATA_DIR } = require('./db');

const IDLE_LOCK_MS = Number(process.env.CLINIC_IDLE_LOCK_MS) || 10 * 60 * 1000; // test override ได้
const sessions = new Map(); // sid -> { userId, role, displayName, lastActivity, locked, createdAt }

// ---- persistence ----
// ไฟล์อยู่ใน data/ = ระดับความลับเดียวกับ clinic.db (เครื่อง host ถือทั้งคู่อยู่แล้ว), mode 0600, เขียน atomic
// อายุ session สูงสุด 20 ชม. — ข้ามคืนต้อง login ใหม่เสมอ (sid ไม่อมตะแม้ไฟล์ค้าง)
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_MAX_AGE_MS = Number(process.env.CLINIC_SESSION_MAX_AGE_MS) || 20 * 60 * 60 * 1000;
let sessionsDirty = false;

function saveSessionsNow() {
  try {
    const payload = JSON.stringify({ format: 1, saved_at: Date.now(), sessions: Object.fromEntries(sessions) });
    const tmp = `${SESSION_FILE}.tmp`;
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, SESSION_FILE);
    sessionsDirty = false;
  } catch {} // persist เป็นของแถม — เขียนไม่ได้ห้ามล้มระบบ (แค่กลับไปพฤติกรรม "restart = login ใหม่")
}
function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (raw.format !== 1 || typeof raw.sessions !== 'object') return;
    for (const [sid, s] of Object.entries(raw.sessions)) {
      if (!/^[0-9a-f]{36}$/.test(sid) || !s || typeof s.userId !== 'number') continue;
      if (!Number.isFinite(s.createdAt) || Date.now() - s.createdAt > SESSION_MAX_AGE_MS) continue;
      sessions.set(sid, { userId: s.userId, role: String(s.role || ''), displayName: String(s.displayName || ''),
        lastActivity: Number(s.lastActivity) || 0, locked: !!s.locked, createdAt: s.createdAt,
        remoteAddress: String(s.remoteAddress || '') });
    }
  } catch {}
}
loadSessions();
// lastActivity/lock เปลี่ยนบ่อย → เขียนแบบ debounce 5 วิ (crash เสีย activity ล่าสุด ≤5 วิ — แค่ล็อกจอเร็วขึ้นนิดเดียว)
setInterval(() => { if (sessionsDirty) saveSessionsNow(); }, 5000).unref();

// secret สำหรับเซ็น cookie — สร้างครั้งแรกแล้วเก็บใน settings
let SECRET = getSetting('cookie_secret', null);
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  setSetting('cookie_secret', SECRET);
}

function hashSecret(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifySecret(plain, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('hex').slice(0, 24);
}

function createSession(user, remoteAddress = '') {
  const sid = crypto.randomBytes(18).toString('hex');
  sessions.set(sid, {
    userId: user.id, role: user.role, displayName: user.display_name,
    lastActivity: Date.now(), locked: false, createdAt: Date.now(), remoteAddress: String(remoteAddress || ''),
  });
  saveSessionsNow();
  return `${sid}.${sign(sid)}`;
}

function getSession(cookieVal) {
  if (!cookieVal) return null;
  const [sid, sig] = cookieVal.split('.');
  if (!sid || sig !== sign(sid)) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) { sessions.delete(sid); saveSessionsNow(); return null; }
  if (Date.now() - s.lastActivity > IDLE_LOCK_MS && !s.locked) { s.locked = true; sessionsDirty = true; }
  return { sid, ...s };
}

function touchSession(sid) {
  const s = sessions.get(sid);
  if (s && !s.locked) { s.lastActivity = Date.now(); sessionsDirty = true; }
}

function unlockSession(sid, pin) {
  const s = sessions.get(sid);
  if (!s) return false;
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(s.userId);
  if (!user) return false;
  // ปลดล็อกด้วย PIN ถ้าตั้งไว้ ไม่งั้นใช้รหัสผ่านเต็ม
  const ok = user.pin_hash ? verifySecret(pin, user.pin_hash) : verifySecret(pin, user.pass_hash);
  if (ok) { s.locked = false; s.lastActivity = Date.now(); sessionsDirty = true; }
  return ok;
}

function destroySession(sid) { sessions.delete(sid); saveSessionsNow(); }

// คืนเฉพาะสรุปที่ใช้ตัดสินใจเลื่อนอัปเดต ห้ามส่ง sid/cookie/secret ออกไป
function activeSessionSummary({ excludeSid = '', withinMs = IDLE_LOCK_MS } = {}) {
  const cutoff = Date.now() - withinMs;
  const byRole = { admin: 0, doctor: 0, front: 0 };
  let total = 0;
  for (const [sid, session] of sessions) {
    if (sid === excludeSid || session.locked || session.lastActivity < cutoff) continue;
    total += 1;
    if (Object.hasOwn(byRole, session.role)) byRole[session.role] += 1;
  }
  return { total, by_role: byRole, within_ms: withinMs };
}

function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  if (!user || !verifySecret(password, user.pass_hash)) return null;
  return user;
}

function createUser({ username, displayName, displayNameEn, role, password, pin, medicalLicense, specialty }, createdBy) {
  if (!['doctor', 'front', 'admin'].includes(role)) throw Object.assign(new Error('บทบาทไม่ถูกต้อง'), { status: 400 });
  if (String(password || '').length < 8) throw Object.assign(new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร'), { status: 400 });
  if (pin && !/^\d{4,6}$/.test(String(pin))) throw Object.assign(new Error('PIN ต้องเป็นตัวเลข 4-6 หลัก'), { status: 400 });
  return db.prepare(`INSERT INTO users (username, display_name, display_name_en, role, pass_hash, pin_hash, active, created_at, medical_license, specialty)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`) 
    .run(String(username).trim(), displayName, displayNameEn || null, role, hashSecret(password), pin ? hashSecret(pin) : null, now(),
      medicalLicense || null, specialty || null);
}

module.exports = {
  hashSecret, verifySecret, login,
  createSession, getSession, touchSession, unlockSession, destroySession,
  createUser, activeSessionSummary, IDLE_LOCK_MS,
  saveSessionsNow, SESSION_FILE,
};
