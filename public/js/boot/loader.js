// ============================================================================
// js/boot/loader.js — ตัวโหลดแอป
// ลำดับ: (1) อ่านข้อมูลจาก IndexedDB (posStore.load) → (2) โหลดสคริปต์ของแอปตามลำดับใน <script id="pos-manifest">
//        → (3) เรียก DOMContentLoaded ที่สคริปต์ของแอปลงทะเบียนไว้ (เหตุการณ์จริงผ่านไปแล้วตอนรออ่านข้อมูล)
// แอปอ่านข้อมูลที่โหลดไว้จาก window.__POS_SAVED__ ตอนเริ่ม (js/auth/session.js)
// ============================================================================
(function () {
  'use strict';
  const store = window.posStore;
  const LS_KEY = 'pos_full_db_state';
  const manifest = JSON.parse(document.getElementById('pos-manifest').textContent);

  function loadLegacy() {
    try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src + '?v=' + encodeURIComponent(manifest.version);   // เปลี่ยน version ใน manifest เมื่อออกเวอร์ชันใหม่ → เบราว์เซอร์โหลดไฟล์ใหม่
      s.async = false;
      s.onload = resolve;
      s.onerror = () => reject(new Error('โหลดไฟล์ไม่สำเร็จ: ' + src));
      document.body.appendChild(s);
    });
  }

  function showFatal(message) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#fff;color:#7f1d1d;padding:24px;font:16px/1.6 sans-serif;overflow:auto';
    box.textContent = '⚠️ เปิดแอปไม่สำเร็จ — ' + message + '  (ถ้าเพิ่งติดตั้ง ให้เชื่อมต่ออินเทอร์เน็ตเปิดแอปครั้งแรกหนึ่งครั้งเพื่อเก็บไฟล์ไว้ใช้ออฟไลน์)';
    document.body.appendChild(box);
  }

  async function boot() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
    let saved = null;
    try {
      saved = await Promise.race([
        store.load(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('IndexedDB timeout')), 8000))
      ]);
    } catch (e) {
      console.warn(e); store.markFallback(); saved = loadLegacy();
    }
    window.__POS_SAVED__ = saved;

    // แอปเปิดซ้ำอีกแท็บ → แท็บที่สองเป็น "อ่านอย่างเดียว" (ไม่บันทึก) กันข้อมูลสองแท็บเขียนทับกัน
    try {
      if (navigator.locks && navigator.locks.request) {
        await new Promise((resolve) => {
          navigator.locks.request('pos-single-tab', { ifAvailable: true }, (lock) => {
            if (!lock) { store.setReadOnly(true); resolve(); return undefined; }
            resolve();
            return new Promise(() => {});          // ถือล็อกไว้จนกว่าจะปิดแท็บ
          });
        });
      }
    } catch (e) { /* ไม่มี Web Locks: ข้าม */ }
    if (store.readOnly) setTimeout(() => { alert('⚠️ แอปนี้เปิดอยู่ในอีกแท็บ/หน้าต่างหนึ่งแล้ว\n\nแท็บนี้จะ "ไม่บันทึกข้อมูล" เพื่อกันข้อมูลทับกัน — กรุณาปิดแท็บนี้แล้วใช้แท็บเดิม'); }, 500);

    // สคริปต์ของแอปลงทะเบียน DOMContentLoaded/load ไว้ — ตอนนี้เหตุการณ์ผ่านไปแล้ว จึงเก็บไว้แล้วเรียกเองหลังโหลดครบ
    const handlers = [];
    const origDoc = document.addEventListener, origWin = window.addEventListener;
    document.addEventListener = function (t, f, o) { if (t === 'DOMContentLoaded') { handlers.push(f); return; } return origDoc.call(this, t, f, o); };
    window.addEventListener = function (t, f, o) { if (t === 'DOMContentLoaded' || t === 'load') { handlers.push(f); return; } return origWin.call(this, t, f, o); };
    try {
      for (const src of manifest.scripts) await loadScript(src);
    } catch (e) {
      showFatal(e.message);
      return;
    } finally {
      document.addEventListener = origDoc; window.addEventListener = origWin;
    }
    handlers.forEach((h) => setTimeout(() => {
      try { h.call(document, new Event('DOMContentLoaded')); } catch (e) { console.error(e); }
    }, 0));
    setTimeout(() => { const splash = document.getElementById('sync-splash-screen'); if (splash) splash.remove(); }, 400);
  }

  boot();
  setTimeout(() => { const splash = document.getElementById('sync-splash-screen'); if (splash) splash.remove(); }, 8000);   // กันค้างถ้าบูตช้าผิดปกติ
})();
