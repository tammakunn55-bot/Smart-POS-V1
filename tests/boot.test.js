// ทดสอบเส้นทางบูตจริงทั้งชุด: store.js + loader.js โหลดโมดูลทุกไฟล์ตาม pos-manifest (ไฟล์จริงบนดิสก์) ใน vm
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { manifest, readJs } = require('./harness');
const { dummy } = require('./dom-stub');
const { makeFakeIDB } = require('./fake-idb');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bootApp({ idb, ls = {} } = {}) {
  const lsStore = { ...ls };
  const els = {};
  const loaded = [];
  const mf = manifest();
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    Intl, Date, Math, JSON, Array, Object, Number, String, parseFloat, parseInt, isFinite, isNaN, Uint8Array, TextEncoder,
    Promise, Set, Map, RegExp, Error, TypeError, Event, structuredClone, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0,
    indexedDB: idb,
    navigator: { onLine: true, userAgent: 'node', storage: { persist: async () => true } },
    localStorage: { getItem: (k) => (k in lsStore ? lsStore[k] : null), setItem: (k, v) => { lsStore[k] = String(v); }, removeItem: (k) => { delete lsStore[k]; } },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    crypto: require('node:crypto').webcrypto, location: { protocol: 'http:', hostname: 'x', href: 'http://x/' },
    alert: () => {}, confirm: () => true, prompt: () => '', fetch: async () => ({ ok: false, json: async () => ({}) }),
    XLSX: {}, Image: function () {}, FileReader: function () {}, Blob: function () {}, URL: { createObjectURL: () => '' },
    supabase: { createClient: () => null }
  };
  ctx.window = ctx; ctx.self = ctx;
  ctx.addEventListener = () => {}; ctx.removeEventListener = () => {}; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  ctx.document = {
    visibilityState: 'visible',
    getElementById: (id) => (id === 'pos-manifest' ? { textContent: JSON.stringify(mf) } : (els[id] = els[id] || dummy())),
    querySelector: () => dummy(), querySelectorAll: () => [], addEventListener: () => {},
    createElement: () => ({ src: '', onload: null, onerror: null, style: {}, appendChild() {} }),
    body: {
      appendChild: (s) => {
        if (!s.src) return;
        const rel = s.src.split('?')[0];
        setTimeout(() => {
          try { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', rel), 'utf8'), ctx, { filename: rel }); loaded.push(rel); s.onload && s.onload(); }
          catch (e) { ctx.__loadError = rel + ': ' + e.message; s.onerror && s.onerror(); }
        }, 0);
      }
    },
    documentElement: dummy(), head: dummy(), title: ''
  };
  vm.createContext(ctx);
  vm.runInContext(readJs('js/boot/store.js'), ctx);
  vm.runInContext(readJs('js/boot/loader.js'), ctx);
  return { ctx, loaded, lsStore, run: (c) => vm.runInContext(c, ctx), mf };
}

async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}

test('บูตจริง: โหลดโมดูลครบทุกไฟล์ตามลำดับใน manifest และฟังก์ชันหลักพร้อมใช้งาน', async () => {
  const app = bootApp({ idb: makeFakeIDB() });
  const ok = await waitFor(() => app.loaded.length === app.mf.scripts.length || app.ctx.__loadError);
  assert.equal(app.ctx.__loadError, undefined, 'โหลดไฟล์ล้มเหลว: ' + app.ctx.__loadError);
  assert.ok(ok, 'โหลดไม่ครบ');
  assert.deepEqual(app.loaded, app.mf.scripts);
  for (const fn of ['processPaymentRequest', 'executeReturn', 'confirmReceivePayment', 'enqueueSync', 'flushSyncQueue', 'verifyEmployeePin', 'forceSyncNow', 'loadDatabaseState', 'persist', 'handleOpeningStockFile']) {
    assert.equal(typeof app.ctx[fn], 'function', fn + ' ต้องเป็นฟังก์ชัน');
  }
});

test('บูตจริง: เรียก DOMContentLoaded ที่แอปลงทะเบียนไว้ → สร้างเจ้าของตั้งต้น (ไม่มี PIN 0000) และบันทึกลง IndexedDB', async () => {
  const idb = makeFakeIDB();
  const app = bootApp({ idb });
  await waitFor(() => app.loaded.length === app.mf.scripts.length);
  const ready = await waitFor(() => app.run('(window.db && db.users && db.users.length) || 0') >= 1, 3000);
  assert.ok(ready, 'ensure() ต้องถูกเรียกหลังโหลดครบ');
  const owner = app.run("db.users.find(u => u.role === 'OWNER')");
  assert.equal(owner.needsPinSetup, true);
  assert.equal(owner.pinHash, undefined);
  app.ctx.persist ? app.ctx.persist() : app.ctx.window.persist();
  await app.ctx.posStore.flush();
  assert.ok(idb.data.kv.get('meta'), 'ต้องมี meta ใน IndexedDB');
  assert.ok(idb.data.kv.get('meta').users.some((u) => u.role === 'OWNER'));
});

test('บูตซ้ำจากข้อมูลที่บันทึกไว้: ข้อมูลเดิมกลับมาครบ (สินค้า + บิล) และไม่มีผู้ล็อกอินค้างอยู่', async () => {
  const idb = makeFakeIDB();
  const a = bootApp({ idb });
  await waitFor(() => a.run('(window.db && db.users && db.users.length) || 0') >= 1);
  a.run("db.products['p-1'] = { id: 'p-1', name: 'ท่อ PVC', variants: [{ id: 'v-1', stock: 5, price: 100, cost: 50, fractions: [] }] }; db.bills.push({ id: 'POS-X-001', time: Date.now(), total: 100, items: [] }); db.activeUser = db.users[0];");
  a.ctx.window.persist(); await a.ctx.posStore.flush();

  const b = bootApp({ idb });
  await waitFor(() => b.run('(window.db && db.users && db.users.length) || 0') >= 1);
  assert.equal(b.run("db.products['p-1'].name"), 'ท่อ PVC');
  assert.equal(b.run('db.bills.length'), 1);
  assert.equal(b.run('db.activeUser == null'), true, 'ห้ามกู้ผู้ล็อกอินจากดิสก์');
});

test('ถ้าไฟล์โมดูลหาย: แสดงข้อความผิดพลาดที่อ่านเข้าใจ ไม่ค้างหน้าขาว', async () => {
  const app = bootApp({ idb: makeFakeIDB() });
  const body = app.ctx.document.body;
  const orig = body.appendChild;
  body.appendChild = (s) => { if (s.src && s.src.includes('sales/payment.js')) { setTimeout(() => s.onerror && s.onerror(), 0); return; } return orig(s); };
  let fatal = null;
  app.ctx.document.createElement = () => ({ src: '', onload: null, onerror: null, style: {}, appendChild() {}, set textContent(v) { fatal = v; }, get textContent() { return fatal; } });
  // กล่อง fatal ถูกสร้างด้วย createElement('div') แล้ว appendChild — ตรวจผ่านข้อความที่ถูกตั้ง
  await waitFor(() => fatal && /โหลดไฟล์ไม่สำเร็จ/.test(fatal), 3000);
  assert.match(fatal || '', /sales\/payment\.js/);
});
