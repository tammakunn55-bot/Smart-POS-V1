// ตรวจโครงสร้างหน้าบ้าน (ใช้ใน CI และก่อน commit):  node tools/check_syntax.js
//  1) ทุกไฟล์ใน pos-manifest มีอยู่จริง และ syntax ผ่าน   2) ไม่มีไฟล์ js/ ที่ตกหล่นจาก manifest (ยกเว้น js/boot/)
//  3) index.html ไม่มีสคริปต์ inline (นอกจาก manifest)       4) css/app.css, sw.js พร้อมใช้
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
let bad = 0;
const fail = (m) => { bad++; console.error('❌ ' + m); };

const m = html.match(/<script id="pos-manifest"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { fail('ไม่พบ <script id="pos-manifest"> ใน index.html'); process.exit(1); }
const manifest = JSON.parse(m[1]);
if (!manifest.version) fail('manifest ไม่มี version');

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const onDisk = walk(path.join(PUBLIC, 'js')).filter((f) => f.endsWith('.js')).map((f) => path.relative(PUBLIC, f).split(path.sep).join('/'));
const listed = new Set(manifest.scripts);
if (listed.size !== manifest.scripts.length) fail('manifest มีไฟล์ซ้ำ');
manifest.scripts.forEach((s) => { if (!fs.existsSync(path.join(PUBLIC, s))) fail('manifest อ้างไฟล์ที่ไม่มี: ' + s); });
onDisk.filter((f) => !f.startsWith('js/boot/') && !listed.has(f)).forEach((f) => fail('ไฟล์ ' + f + ' ไม่อยู่ใน manifest (ลืมเพิ่ม?)'));

for (const f of [...onDisk, 'sw.js']) {
  const r = spawnSync(process.execPath, ['--check', path.join(PUBLIC, f)], { encoding: 'utf8' });
  if (r.status !== 0) fail('syntax ผิดพลาดใน ' + f + '\n' + r.stderr.split('\n').slice(0, 6).join('\n'));
}
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].filter((x) => x[1].trim());
if (inline.length) fail('index.html มีสคริปต์ inline ' + inline.length + ' ก้อน (ควรอยู่ใน js/)');
if (!fs.existsSync(path.join(PUBLIC, 'css/app.css'))) fail('ไม่พบ css/app.css');
if (/<style[\s>]/.test(html)) fail('index.html มี <style> inline (ควรอยู่ใน css/app.css)');

console.log(`${manifest.scripts.length} โมดูลใน manifest · ${onDisk.length} ไฟล์ JS · ผิดพลาด ${bad}`);
process.exit(bad ? 1 : 0);
