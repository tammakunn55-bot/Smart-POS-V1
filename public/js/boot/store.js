
// ============================================================================
// js/boot/store.js — ที่เก็บข้อมูลในเครื่องแบบ IndexedDB (posStore)
// เดิมทั้งฐานข้อมูลถูก JSON.stringify เก็บใน localStorage ก้อนเดียว (จำกัด ~5MB, เขียนทั้งก้อนทุกครั้ง)
// ใหม่: เก็บ "ข้อมูลหลัก" (สินค้า/ลูกค้า/ตั้งค่า/คิวซิงค์ ...) เป็นระเบียนเดียวใน IndexedDB (structured clone)
//       ส่วน "บิล" แยกเป็นรายบิล เขียนเฉพาะบิลที่เปลี่ยนจริง → บิลสะสมหลายหมื่นใบก็ไม่ช้าลง
// IndexedDB อ่านแบบ async จึงต้องรอโหลดเสร็จก่อนแล้วค่อยรันสคริปต์ของแอป — ทำโดย js/boot/loader.js
// ============================================================================
(function () {
  'use strict';
  const DB_NAME = 'pos_yojionline', DB_VERSION = 1;
  const LS_KEY = 'pos_full_db_state', LS_LEGACY_KEY = 'pos_enterprise_state';
  const RECENT_MS = 7 * 86400000;           // บิลใน 7 วันล่าสุดตรวจการเปลี่ยนแปลงทุกครั้งที่บันทึก; เก่ากว่านี้เขียนเมื่อถูก touchBill เท่านั้น
  const hasIDB = typeof indexedDB !== 'undefined' && !!indexedDB;

  let dbPromise = null, fallback = !hasIDB;
  let latest = null, timer = null, running = null, again = false, cleared = false, readOnly = false;
  const sigs = new Map();                    // billId -> ลายเซ็น JSON (บิลล่าสุด) | null (เก่า/สะอาด)
  const touched = new Set();

  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = (tx) => new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('IndexedDB transaction aborted'));
  });
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('bills')) d.createObjectStore('bills', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('IndexedDB ถูกบล็อก (ปิดแท็บอื่นของแอปนี้แล้วลองใหม่)'));
    });
    return dbPromise;
  }

  const replacer = (k, v) => (k === 'activeUser' ? undefined : v);
  const sigOf = (b) => JSON.stringify(b);
  const isRecent = (b) => (Date.now() - (b.time || 0)) < RECENT_MS;

  function loadLegacy() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function splitDb(db) {
    const meta = {};
    Object.keys(db).forEach((k) => { if (k !== 'bills' && k !== 'activeUser') meta[k] = db[k]; });
    return meta;
  }

  // เขียนสแนปช็อตลง IndexedDB: meta 1 ระเบียน + เฉพาะบิลที่เปลี่ยน/ใหม่ + ลบบิลที่หายไป
  async function writeSnapshot(db, replaceAll) {
    const d = await open();
    const tx = d.transaction(['kv', 'bills'], 'readwrite');
    const kv = tx.objectStore('kv'), bs = tx.objectStore('bills');
    if (replaceAll) { bs.clear(); sigs.clear(); touched.clear(); }
    const meta = splitDb(db);
    try { kv.put(meta, 'meta'); }
    catch (e) { kv.put(JSON.parse(JSON.stringify(meta, replacer)), 'meta'); }   // มีค่าที่ clone ไม่ได้ → แปลงผ่าน JSON
    const seen = new Set();
    const pendingSigs = [];
    (db.bills || []).forEach((b) => {
      if (!b || b.id == null) return;
      seen.add(b.id);
      const known = sigs.has(b.id);
      let write = false, sg = null;
      if (!known || touched.has(b.id)) { write = true; }
      else if (isRecent(b)) { sg = sigOf(b); write = sg !== sigs.get(b.id); }
      if (write) {
        if (sg === null) sg = sigOf(b);
        try { bs.put(b); } catch (e) { bs.put(JSON.parse(sg)); }
        pendingSigs.push([b.id, isRecent(b) ? sg : null]);
      }
    });
    sigs.forEach((_, id) => { if (!seen.has(id)) { bs.delete(id); pendingSigs.push([id, undefined]); } });
    await txDone(tx);
    pendingSigs.forEach(([id, sg]) => { if (sg === undefined) sigs.delete(id); else sigs.set(id, sg); });
    touched.clear();
  }

  function primeSigs(bills) {
    sigs.clear();
    bills.forEach((b) => sigs.set(b.id, isRecent(b) ? sigOf(b) : null));
  }

  async function migrateLegacy(legacy) {
    await writeSnapshot(legacy, true);
    // เก็บสำเนาของเดิมไว้ใน IndexedDB ก่อนค่อยลบออกจาก localStorage (กันพลาด)
    const raw = localStorage.getItem(LS_KEY);
    const d = await open();
    const tx = d.transaction('kv', 'readwrite');
    if (raw) tx.objectStore('kv').put(raw, 'legacy_backup');
    await txDone(tx);
    try { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_LEGACY_KEY); } catch (e) { /* ignore */ }
  }

  const api = {
    onError: null,
    get fallback() { return fallback; },
    markFallback() { fallback = true; },
    setReadOnly(v) { readOnly = !!v; },

    async load() {
      if (fallback) return loadLegacy();
      try {
        const d = await open();
        const tx = d.transaction(['kv', 'bills'], 'readonly');
        const [meta, bills] = await Promise.all([reqP(tx.objectStore('kv').get('meta')), reqP(tx.objectStore('bills').getAll())]);
        if (!meta) {
          const legacy = loadLegacy();
          if (legacy) { await migrateLegacy(legacy); primeSigs(legacy.bills || []); return legacy; }
          return null;
        }
        bills.sort((a, b) => ((a.time || 0) - (b.time || 0)) || String(a.id).localeCompare(String(b.id)));
        primeSigs(bills);
        return Object.assign({}, meta, { bills });
      } catch (e) {
        console.warn('IndexedDB ใช้งานไม่ได้ — ถอยกลับไปใช้ localStorage', e);
        fallback = true;
        return loadLegacy();
      }
    },

    get readOnly() { return readOnly; },

    save(db) {
      if (cleared || readOnly || !db) return;
      latest = db;
      if (fallback) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(db, replacer)); }
        catch (e) { if (api.onError) api.onError(e); }
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => { api.flush(); }, 60);
    },

    flush() {
      clearTimeout(timer);
      if (cleared || readOnly || fallback || !latest) return Promise.resolve();
      if (running) { again = true; return running; }
      running = (async () => {
        try { await writeSnapshot(latest, false); }
        catch (e) { if (api.onError) api.onError(e); }
        finally {
          running = null;
          if (again) { again = false; api.flush(); }
        }
      })();
      return running;
    },

    touchBill(id) { touched.add(id); },

    async replaceAll(db) {
      if (fallback) { localStorage.setItem(LS_KEY, JSON.stringify(db, replacer)); return; }
      clearTimeout(timer);
      if (running) await running;
      await writeSnapshot(db, true);
    },

    async clear() {
      cleared = true; clearTimeout(timer); latest = null;
      try { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_LEGACY_KEY); } catch (e) { /* ignore */ }
      if (fallback) return;
      try {
        if (running) await running;
        const d = await open();
        const tx = d.transaction(['kv', 'bills'], 'readwrite');
        tx.objectStore('kv').clear(); tx.objectStore('bills').clear();
        await txDone(tx);
      } catch (e) { console.warn('clear failed', e); }
    },

    // ที่เก็บ session ของ Supabase Auth (แทน localStorage) — supabase-js รองรับ storage แบบ async
    authStorage: {
      async getItem(k) {
        if (fallback) return localStorage.getItem('sb:' + k);
        const d = await open();
        const v = await reqP(d.transaction('kv').objectStore('kv').get('auth:' + k));
        return v == null ? null : v;
      },
      async setItem(k, v) {
        if (fallback) { localStorage.setItem('sb:' + k, v); return; }
        const d = await open();
        const tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(String(v), 'auth:' + k);
        await txDone(tx);
      },
      async removeItem(k) {
        if (fallback) { localStorage.removeItem('sb:' + k); return; }
        const d = await open();
        const tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete('auth:' + k);
        await txDone(tx);
      }
    }
  };
  window.posStore = api;

  // บันทึกให้ทันก่อนปิด/ซ่อนแท็บ
  window.addEventListener('pagehide', () => { api.flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') api.flush(); });
})();
