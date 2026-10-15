// Service worker: ให้แอปเปิดได้เมื่อออฟไลน์
//  - ติดตั้ง: อ่าน pos-manifest จาก index.html แล้วเก็บ หน้าแอป + css + js ทุกไฟล์ + ไลบรารี CDN ที่ล็อกเวอร์ชันไว้
//  - ใช้งาน: ไฟล์ของแอปเอง network-first (ออนไลน์ได้ของใหม่เสมอ ออฟไลน์ใช้ของที่เก็บไว้), ไลบรารี CDN cache-first
//  - ไม่แคช API ของ Supabase / PromptPay (ข้อมูลธุรกรรมอยู่ใน IndexedDB + คิวซิงค์ของแอปอยู่แล้ว)
const CDN = [
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4'
];
const CDN_HOSTS = ['unpkg.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];
const SHELL = ['css/app.css', 'js/boot/error-box.js', 'js/boot/store.js', 'js/boot/loader.js'];

async function appFiles() {
  const html = await (await fetch('./', { cache: 'no-store' })).text();
  const m = html.match(/<script id="pos-manifest"[^>]*>([\s\S]*?)<\/script>/);
  const manifest = JSON.parse(m[1]);
  return { version: manifest.version, urls: ['./', ...SHELL, ...manifest.scripts.map((s) => s + '?v=' + encodeURIComponent(manifest.version))] };
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const { version, urls } = await appFiles();
    const cache = await caches.open('pos-' + version);
    await Promise.allSettled([
      ...urls.map((u) => cache.add(u)),
      ...CDN.map(async (u) => { const r = await fetch(u, { mode: 'no-cors' }); await cache.put(u, r); })
    ]);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const { version } = await appFiles().catch(() => ({ version: null }));
    for (const k of await caches.keys()) if (version && k !== 'pos-' + version) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { const c = r.clone(); caches.open('pos-cdn').then((x) => x.put(req, c)); return r; })));
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.keys().then((ks) => { const k = ks.find((n) => n.startsWith('pos-') && n !== 'pos-cdn'); if (k) caches.open(k).then((x) => x.put(req, c)); }); return r; })
      .catch(() => caches.match(req, { ignoreSearch: false }).then((hit) => hit || caches.match(req, { ignoreSearch: true })).then((hit) => hit || caches.match('./'))));
  }
});
