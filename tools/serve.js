// เซิร์ฟเวอร์ไฟล์สถิตสำหรับพัฒนา (ไม่ต้องติดตั้งอะไรเพิ่ม):  npm run dev   →  http://localhost:8080
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const ROOT = path.join(__dirname, '..', 'public'), PORT = process.env.PORT || 8080;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`Smart POS dev server: http://localhost:${PORT}   (กล้อง/service worker ใช้ได้บน localhost)`));
