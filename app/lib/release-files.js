'use strict';
// แหล่งจริงชุดเดียวของไฟล์โปรแกรมที่ส่งถึงเครื่องคลินิก
// ทั้ง installer และ update builder ต้องใช้รายการนี้ร่วมกัน เพื่อไม่ให้ชุดติดตั้งกับชุดอัปเดตแยกทางกัน

// update-public-key.pem = กุญแจสาธารณะตรวจลายเซ็นชุดอัปเดต — ต้องติดไปทุกเครื่อง ไม่งั้น updater "ยังไม่ได้ตั้งค่า" (พบตอนซ้อมอัปเดตจริง 2026-08-19: ปุ่มตรวจหารุ่นใหม่กดไม่ได้)
const APP_FILES = [require('./runtime').RELATIVE, 'vendor/NODE-LICENSE.txt', 'package.json', 'LICENSE', 'server.js', 'seed.js', 'recovery-assistant.js', 'update-assistant.js', 'RUNBOOK.md', 'update-public-key.pem'];
const APP_DIRECTORIES = ['lib', 'public', 'launch', 'scripts'];
const TOOL_FILES = [
  'tools/pre-upgrade-snapshot.js',
  'tools/migrate-and-verify.js',
  'tools/run-backup.js',
  'tools/restore-cloud-backup.js',
];
const TRIAL_SEED_FILES = ['seed-mock-day.js', 'seed-mock-clinic.js', 'seed-appointment-followup.js'];
const FORBIDDEN_BASENAME = /^(test-|codex-|seed-mock)|recovery-key|\.(db|db-wal|db-shm|enc|key)$/i;
const ALLOWED_RELEASE_EXTENSION = /\.(?:js|html|css|json|png|jpe?g|svg|ico|webp|cmd|ps1)$/i;

module.exports = {
  APP_FILES,
  APP_DIRECTORIES,
  TOOL_FILES,
  TRIAL_SEED_FILES,
  FORBIDDEN_BASENAME,
  ALLOWED_RELEASE_EXTENSION,
};
