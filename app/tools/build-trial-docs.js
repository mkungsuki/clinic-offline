'use strict';
// แปลง Markdown คู่มือสำหรับหมอ/หน้าร้านและแบบทดลองเป็น PDF ด้วย Edge headless
// ไม่มี dependency เพิ่มในโปรแกรมคลินิก ไฟล์ HTML ชั่วคราวอยู่ tmp/trial-docs
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DOC_ROOT = fs.existsSync(path.join(REPO_ROOT, 'public-release', 'docs'))
  ? path.join(REPO_ROOT, 'public-release', 'docs')
  : fs.existsSync(path.join(REPO_ROOT, 'docs')) ? path.join(REPO_ROOT, 'docs') : REPO_ROOT;
const TMP_DIR = path.join(REPO_ROOT, 'tmp', 'trial-docs');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const DOCS = [
  { source: 'คู่มือฉบับเต็ม-สำหรับหมอ.md', output: 'คู่มือฉบับเต็ม-สำหรับหมอ.pdf', kind: 'guide' },
  { source: 'คู่มือฉบับเต็ม-สำหรับหน้าร้านและผู้ดูแล.md', output: 'คู่มือฉบับเต็ม-สำหรับหน้าร้านและผู้ดูแล.pdf', kind: 'guide' },
  { source: 'แบบทดลองใช้-สำหรับหมอ.md', output: 'แบบทดลองใช้-สำหรับหมอ.pdf', kind: 'form' },
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fileUri(relativePath) {
  const absolute = path.resolve(DOC_ROOT, relativePath).replace(/\\/g, '/');
  if (!fs.existsSync(path.resolve(DOC_ROOT, relativePath))) throw new Error(`ไม่พบภาพ: ${relativePath}`);
  return encodeURI(`file:///${absolute}`);
}
function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) =>
    `<figure><img src="${fileUri(src)}" alt="${escapeHtml(alt)}"><figcaption>${escapeHtml(alt)}</figcaption></figure>`);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  return out;
}
function isTableDivider(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}
function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(v => v.trim());
}
function collectHeadings(lines, kind) {
  const headingsByLine = new Map();
  const tocItems = [];
  let sequence = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[lineIndex]);
    if (!heading || heading[1].length === 1) continue;
    const level = heading[1].length;
    const item = { id: `section-${++sequence}`, level, title: heading[2] };
    headingsByLine.set(lineIndex, item);
    if (level === 2 || (kind === 'guide' && level === 3)) tocItems.push(item);
  }
  return { headingsByLine, tocItems };
}
function tocHtml(items) {
  if (!items.length) return '';
  return `<nav class="toc" aria-label="สารบัญ">
<div class="toc-title">สารบัญ - กดชื่อหัวข้อเพื่อเปิดดู</div>
<div class="toc-note">เมื่อเปิดใน Edge หรือโปรแกรมอ่าน PDF ให้กดหัวข้อด้านล่างเพื่อข้ามไปยังส่วนนั้นได้ทันที</div>
<ol>${items.map(item => `<li class="toc-level-${item.level}"><a href="#${item.id}">${inline(item.title)}</a></li>`).join('')}</ol>
</nav>`;
}
function markdownToHtml(markdown, kind = 'guide') {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const { headingsByLine, tocItems } = collectHeadings(lines, kind);
  const out = [];
  let i = 0;
  let firstHeading = true;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.trim() === '[[toc]]') { out.push(tocHtml(tocItems)); i++; continue; }
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(line.trim())) { out.push(inline(line.trim())); i++; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const meta = headingsByLine.get(i);
      const id = meta ? ` id="${meta.id}"` : '';
      out.push(`<h${level}${id}${firstHeading ? ' class="document-title"' : ''}>${inline(heading[2])}</h${level}>`);
      firstHeading = false; i++; continue;
    }
    if (/^---+$/.test(line.trim())) { out.push('<hr>'); i++; continue; }
    if (line.startsWith('> ')) {
      const parts = [];
      while (i < lines.length && lines[i].startsWith('> ')) parts.push(inline(lines[i++].slice(2)));
      out.push(`<blockquote>${parts.join('<br>')}</blockquote>`); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const head = cells(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(row => '<tr>' + row.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    const ul = /^\s*[-+]\s+(.+)$/.exec(line);
    if (ul) {
      const items = [];
      while (i < lines.length) {
        const m = /^\s*[-+]\s+(.+)$/.exec(lines[i]); if (!m) break;
        items.push(`<li>${inline(m[1])}</li>`); i++;
      }
      out.push(`<ul>${items.join('')}</ul>`); continue;
    }
    const ol = /^\s*(\d+)\.\s+(.+)$/.exec(line);
    if (ol) {
      const items = [];
      const start = Number(ol[1]);
      while (i < lines.length) {
        const m = /^\s*(\d+)\.\s+(.+)$/.exec(lines[i]); if (!m) break;
        items.push(`<li>${inline(m[2])}</li>`); i++;
      }
      out.push(`<ol${start === 1 ? '' : ` start="${start}"`}>${items.join('')}</ol>`); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !lines[i].startsWith('> ') &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]))) {
      paragraph.push(lines[i++]);
    }
    out.push(`<p>${paragraph.map(v => inline(v.replace(/\s{2}$/, ''))).join('<br>')}</p>`);
  }
  return out.join('\n');
}

const CSS = `
@page { size: A4; margin: 16mm 14mm 18mm; }
* { box-sizing: border-box; }
html { color: #19343d; font-family: "Leelawadee UI", "Tahoma", "Segoe UI", sans-serif; font-size: 10.5pt; line-height: 1.58; }
body { margin: 0; padding: 0; background: white; }
h1.document-title { color: #0b626b; font-size: 25pt; line-height: 1.22; margin: 0 0 6mm; padding: 9mm 8mm; background: linear-gradient(135deg,#e5f3f3,#f9fcfc); border-left: 6pt solid #0b7c83; border-radius: 4mm; }
h1 { color: #0b626b; font-size: 21pt; margin: 8mm 0 4mm; }
h2 { color: #0b626b; font-size: 16pt; margin: 8mm 0 3mm; padding-bottom: 1.4mm; border-bottom: 1pt solid #bcd4d8; break-after: avoid-page; page-break-after: avoid; }
h3 { color: #2a5d66; font-size: 12.5pt; margin: 5mm 0 2mm; break-after: avoid-page; page-break-after: avoid; }
body.guide h2 { break-before: auto; page-break-before: auto; }
nav.toc { margin: 5mm 0 7mm; padding: 6mm 7mm; background: #f4f9fa; border: 1pt solid #b8d5d9; border-left: 5pt solid #13828a; border-radius: 3mm; }
.toc-title { color: #0b626b; font-size: 17pt; font-weight: 700; line-height: 1.3; margin-bottom: 1.5mm; }
.toc-note { color: #526b73; font-size: 9pt; margin-bottom: 4mm; }
.toc ol { columns: 2; column-gap: 9mm; list-style: none; margin: 0; padding: 0; }
.toc li { break-inside: avoid; margin: 0 0 1.7mm; line-height: 1.35; }
.toc li.toc-level-3 { padding-left: 4mm; font-size: 9pt; }
.toc a { color: #174e58; text-decoration: none; border-bottom: .5pt dotted #7aa6ad; }
body.guide nav.toc { break-before: page; page-break-before: always; break-after: page; page-break-after: always; }
p { margin: 0 0 3mm; orphans: 3; widows: 3; }
strong { color: #143e47; }
code { font-family: Consolas, monospace; font-size: 9pt; background: #edf3f5; border-radius: 1mm; padding: .5mm 1.2mm; }
ul,ol { margin: 1.5mm 0 4mm 6mm; padding-left: 5mm; }
li { margin: 1mm 0; }
blockquote { margin: 4mm 0; padding: 4mm 5mm; background: #fff5cc; border-left: 4pt solid #d5a516; border-radius: 2mm; break-inside: avoid; }
table { width: 100%; border-collapse: collapse; margin: 3mm 0 5mm; font-size: 9.3pt; break-inside: auto; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { background: #0d7078; color: white; font-weight: 700; text-align: left; padding: 2.6mm 2.8mm; border: .5pt solid #0b626b; }
td { vertical-align: top; padding: 2.5mm 2.8mm; border: .5pt solid #bfcfd4; }
tbody tr:nth-child(even) td { background: #f3f8f9; }
figure { margin: 4mm auto 6mm; break-inside: avoid; text-align: center; }
figure img { display: block; max-width: 100%; max-height: 185mm; margin: auto; border: .7pt solid #b8cbd0; border-radius: 2.5mm; }
figcaption { color: #58717a; font-size: 8.5pt; margin-top: 1.5mm; }
hr { border: 0; border-top: 1.2pt solid #c8dadd; margin: 8mm 0; }
body.form h3 { background: #edf6f7; border-left: 4pt solid #13828a; padding: 2.5mm 3mm; border-radius: 1.5mm; }
body.form p { margin-bottom: 3mm; }
body.form ol { margin-bottom: 2mm; }
body.form nav.toc { margin: 3mm 0 4mm; padding: 4mm 5mm; }
body.form .toc-title { font-size: 14pt; margin-bottom: 1mm; }
body.form .toc-note { display: none; }
body.form .toc li { font-size: 8.8pt; margin-bottom: .8mm; }
body.form hr { break-after: page; border: 0; margin: 0; }
body.form h2 { break-before: auto; page-break-before: auto; }
`;

function htmlDocument(title, body, kind) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body class="${kind}">${body}</body></html>`;
}

function edgePath() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('ไม่พบ Microsoft Edge สำหรับสร้าง PDF');
  return found;
}

function buildDoc(doc) {
  const source = path.join(DOC_ROOT, doc.source);
  const markdown = fs.readFileSync(source, 'utf8');
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] || path.basename(doc.source, '.md');
  const html = htmlDocument(title, markdownToHtml(markdown, doc.kind), doc.kind);
  const htmlFile = path.join(TMP_DIR, doc.output.replace(/\.pdf$/i, '.html'));
  const pdfFile = path.join(DIST_DIR, doc.output);
  fs.writeFileSync(htmlFile, html, 'utf8');
  if (fs.existsSync(pdfFile)) fs.rmSync(pdfFile);
  const url = `file:///${htmlFile.replace(/\\/g, '/')}`;
  const result = spawnSync(edgePath(), ['--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
    '--no-pdf-header-footer', `--print-to-pdf=${pdfFile}`, url], { encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0 || !fs.existsSync(pdfFile) || fs.statSync(pdfFile).size < 1000) {
    throw new Error(`สร้าง PDF ไม่สำเร็จ: ${doc.output}\n${result.stderr || result.stdout || ''}`);
  }
  return { source, htmlFile, pdfFile, bytes: fs.statSync(pdfFile).size };
}

function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const built = DOCS.map(buildDoc);
  for (const item of built) console.log(`สร้าง ${item.pdfFile} (${item.bytes.toLocaleString()} bytes)`);
  return built;
}

if (require.main === module) main();
module.exports = { main, markdownToHtml };
