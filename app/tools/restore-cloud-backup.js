'use strict';
// Compatibility CLI for technicians. The same recovery core is used by the
// Admin drill and the standalone Recovery Assistant.
const path = require('node:path');
const { restoreToNewDirectory } = require('../lib/recovery-core');

function fail(message) {
  console.error(`restore ไม่สำเร็จ: ${message}`);
  process.exitCode = 1;
}

const [sourceArg, keyArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !keyArg || !outputArg) {
  fail('ใช้: node tools/restore-cloud-backup.js <cloud-folder> <recovery-key.txt> <output-folder>');
} else {
  try {
    const result = restoreToNewDirectory({
      sourceDir: path.resolve(sourceArg),
      keyFile: path.resolve(keyArg),
      outputDir: path.resolve(outputArg),
    });
    console.log(`restore ตรวจสอบสำเร็จ · ข้อมูลถึงเวลา ${result.backupCreatedAt}`);
    console.log('ยังไม่ได้แทนข้อมูลจริง: โฟลเดอร์นี้เป็นผลซ้อมกู้ที่ตรวจแล้ว');
  } catch (error) { fail(error.message); }
}
