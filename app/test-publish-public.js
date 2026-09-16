'use strict';
// All destinations and synthetic source fixtures live in a disposable temp directory.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { publish, collect, checkContent, DEV_FILES } = require('./tools/publish-public');
const release = require('./lib/release-files');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-publish-test-'));
let passed = 0;
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
function test(name, fn) { fn(); passed++; console.log('✅ publish: ' + name); }
try {
  const root = path.join(tmp, 'source'), dest = path.join(tmp, 'checkout');
  fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
  const license = fs.readFileSync(path.join(__dirname, 'LICENSE'));
  write(path.join(root, 'LICENSE'), license); write(path.join(dest, 'LICENSE'), license);
  for (const file of [...release.APP_FILES, ...release.TOOL_FILES, ...DEV_FILES]) write(path.join(root, 'app', file), file === 'LICENSE' ? license : '// synthetic fixture');
  for (const dir of release.APP_DIRECTORIES) write(path.join(root, 'app', dir, 'fixture.js'), '// fixture');
  write(path.join(root, 'app/test-example.js'), '// test');
  write(path.join(root, 'app/data/clinic.db'), 'synthetic excluded');
  write(path.join(root, 'HANDOFF.md'), 'excluded');
  write(path.join(root, 'public-release/README.md'), '# Synthetic');
  test('inventory covers every installer allowlist entry and test, never data/history', () => {
    const result = publish(dest, { root });
    const rows = JSON.parse(fs.readFileSync(path.join(dest, '.git/clinic-public-inventory.json'))).files;
    assert.equal(rows.length, result.files);
    assert.deepEqual(rows.map(x => x.file), collect(root).map(x => x.file));
  for (const file of [...release.APP_FILES.filter(f=>f!==require('./lib/runtime').RELATIVE), ...release.TOOL_FILES]) assert(rows.some(x => x.file === 'app/' + file));
  assert(!rows.some(x=>x.file.endsWith('.exe')), 'public source snapshot excludes downloaded binaries');
  assert(rows.some(x=>x.file==='app/tools/fetch-runtime.js'), 'source users can fetch the hash-pinned runtime');
    for (const dir of release.APP_DIRECTORIES) assert(rows.some(x => x.file === 'app/' + dir + '/fixture.js'));
    assert(rows.some(x => x.file === 'app/test-example.js'));
    assert(!fs.existsSync(path.join(dest, 'app/data')));
    assert(!fs.existsSync(path.join(dest, 'HANDOFF.md')));
    assert(fs.readFileSync(path.join(dest, 'LICENSE')).equals(license));
    const actual = new Set(collect(path.resolve(__dirname, '..')).map(x => x.file));
    for (const rel of require('./tools/build-update-package').collectReleasePaths(__dirname, 'trial').filter(f=>f!==require('./lib/runtime').RELATIVE)) assert(actual.has('app/' + rel), 'missing release source: ' + rel);
  });
  test('repeat copies changed source, deletes only stale managed files', () => {
    write(path.join(root, 'app/public/fixture.js'), '// newer fixture');
    fs.unlinkSync(path.join(root, 'app/test-example.js'));
    publish(dest, { root });
    assert.equal(fs.readFileSync(path.join(dest, 'app/public/fixture.js'), 'utf8'), '// newer fixture');
    assert(!fs.existsSync(path.join(dest, 'app/test-example.js')));
  });
  test('local destination edits are preserved and publication refuses', () => {
    const file = path.join(dest, 'app/public/fixture.js'), before = fs.readFileSync(file);
    write(file, '// user edit'); assert.throws(() => publish(dest, { root }), /ถูกแก้เอง/);
    assert.equal(fs.readFileSync(file, 'utf8'), '// user edit'); write(file, before);
  });
  test('unknown checkout files are preserved and publication refuses', () => {
    const file = path.join(dest, 'notes.txt'); write(file, 'user note');
    assert.throws(() => publish(dest, { root }), /นอก inventory/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'user note'); fs.unlinkSync(file);
  });
  test('forbidden text fails before writes', () => {
    const file = path.join(root, 'public-release/README.md');
    write(file, String.fromCodePoint(107,97,110,112,105));
    assert.throws(() => publish(dest, { root }), /ข้อความต้องห้าม/);
    assert.equal(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), '# Synthetic');
    write(file, '# Synthetic');
    assert.throws(() => checkContent('docs/file.enc', Buffer.from('synthetic')), /ต้องห้าม/);
  });
  test('tampered inventory traversal cannot reach outside checkout', () => {
    const inv = path.join(dest, '.git/clinic-public-inventory.json'), before = fs.readFileSync(inv);
    write(inv, JSON.stringify({ format: 1, files: [{ file: 'app/../../outside.txt', sha256: 'a'.repeat(64) }] }));
    assert.throws(() => publish(dest, { root }), /ไม่ปลอดภัย|นอกปลายทาง/);
    write(inv, before);
  });
  test('destination junction is refused', () => {
    const outside = path.join(tmp, 'outside'), link = path.join(dest, 'extra');
    fs.mkdirSync(outside); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => publish(dest, { root }), /link|junction/);
    fs.unlinkSync(link);
  });
  test('LICENSE is never overwritten, different original license refuses', () => {
    write(path.join(dest, 'LICENSE'), Buffer.concat([license, Buffer.from('\nchanged')]));
    assert.throws(() => publish(dest, { root }), /LICENSE/);
    assert(fs.readFileSync(path.join(dest, 'LICENSE')).includes(Buffer.from('changed')));
    write(path.join(dest, 'LICENSE'), license);
  });
  test('copy failure restores files, unchanged inventory allows safe retry', () => {
    const inv = path.join(dest, '.git/clinic-public-inventory.json'), before = fs.readFileSync(inv);
    const file = path.join(dest, 'app/public/fixture.js'), fileBefore = fs.readFileSync(file);
    write(path.join(root, 'app/public/fixture.js'), '// next revision');
    let writes = 0;
    assert.throws(() => publish(dest, { root, beforeWrite() { if (++writes === 5) throw new Error('injected copy failure'); } }), /injected/);
    assert(fs.readFileSync(inv).equals(before)); assert(fs.readFileSync(file).equals(fileBefore));
    publish(dest, { root }); assert.equal(fs.readFileSync(file, 'utf8'), '// next revision');
  });
  console.log('PUBLIC PUBLISH PASS: ' + passed + '/9');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
