// IndexedDB จำลองขนาดเล็ก (เฉพาะเมธอดที่ posStore ใช้) — ทำงานแบบ async เหมือนของจริง และนับการเขียนเพื่อทดสอบ "เขียนเฉพาะที่เปลี่ยน"
function makeFakeIDB() {
  const data = { kv: new Map(), bills: new Map() };
  const keyPaths = { kv: null, bills: 'id' };
  const stats = { put: { kv: 0, bills: 0 }, del: 0, clear: 0 };
  const later = (fn) => setTimeout(fn, 0);
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));

  function storeApi(name, tx) {
    const req = (fn) => { const r = { result: undefined, onsuccess: null, onerror: null }; later(() => { try { r.result = fn(); r.onsuccess && r.onsuccess(); } catch (e) { r.error = e; r.onerror && r.onerror(); } }); return r; };
    return {
      put(value, key) { const k = keyPaths[name] ? value[keyPaths[name]] : key; data[name].set(k, clone(value)); stats.put[name]++; return req(() => k); },
      get(key) { return req(() => clone(data[name].get(key))); },
      getAll() { return req(() => [...data[name].values()].map(clone)); },
      delete(key) { data[name].delete(key); stats.del++; return req(() => undefined); },
      clear() { data[name].clear(); stats.clear++; return req(() => undefined); }
    };
  }
  const idb = {
    data, stats,
    open() {
      const r = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        r.result = {
          objectStoreNames: { contains: (n) => n in data },
          createObjectStore() {},
          transaction(names) {
            const tx = { oncomplete: null, onerror: null, onabort: null, objectStore: (n) => storeApi(n, tx) };
            later(() => later(() => tx.oncomplete && tx.oncomplete()));
            return tx;
          }
        };
        r.onupgradeneeded && r.onupgradeneeded();
        r.onsuccess && r.onsuccess();
      });
      return r;
    }
  };
  return idb;
}
module.exports = { makeFakeIDB };
