'use strict';
// รัน backup ด้วยกลไกเดียวกับปุ่มในระบบ แล้วปิด DB handle
const { db } = require('../lib/db');
const backup = require('../lib/backup');
try {
  const result = backup.runBackup();
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally { db.close(); }
