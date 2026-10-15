// ทดสอบ posStore (IndexedDB) + ตัวโหลดแอป โดยรันโค้ดจริงจาก public/index.html ใน vm กับ IndexedDB จำลอง
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readJs } = require('./harness');
const { makeFakeIDB } = require('./fake-idb');

const STORE_JS = readJs('js/boot/store.js');
const LOADER_JS = readJs('js/boot/loader.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env({ idb, ls = {}, apps = [], locks } = {}) {
  const lsStore = { ...ls };
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    JSON, Math, Date, Object, Array, Map, Set, Promise, String, Number, Error, Event, structuredClone,
    setTimeout, clearTimeout,
    indexedDB: idb,
    navigator: { storage: { persist: async () => true }, locks },
    alert: (m) => { (globalThis.__alerts = globalThis.__alerts || []).push(m); },
    localStorage: {
      getItem: (k) => (k in lsStore ? lsStore[k] : null), setItem: (k, v) => { lsStore[k] = String(v); }, removeItem: (k) => { delete lsStore[k]; }
    },
  };
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  const docListeners = {};
  ctx.document = {
    visibilityState: 'visible',
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
    getElementById: (id) => (id === 'pos-manifest' ? { textContent: JSON.stringify({ version: 't', scripts: apps.map((_, i) => 'js/t' + i + '.js') }) } : null),
    createElement: () => ({ src: '', onload: null, onerror: null }),
    body: {
      appendChild: (s) => {                       // จำลองเบราว์เซอร์: โหลดไฟล์ → รันโค้ด → เรียก onload
        const i = Number(/js\/t(\d+)\.js/.exec(s.src)[1]);
        setTimeout(() => { vm.runInContext(apps[i], ctx); s.onload && s.onload(); }, 0);
      }
    },
  };
  vm.createContext(ctx);
  vm.runInContext(STORE_JS, ctx);
  vm.runInContext(LOADER_JS, ctx);
  return { ctx, lsStore, docListeners, store: ctx.posStore };
}

const day = 86400000;
const mkBill = (n, ageDays = 0) => ({ id: 'B' + n, time: Date.now() - ageDays * day - (100 - n), total: n * 10, items: [{ qty: 1 }] });
const mkDb = (bills) => ({ products: { p1: { id: 'p1', name: 'ท่อ' } }, customers: {}, syncQueue: [], settings: {}, activeUser: { id: 'secret' }, bills });

test('บันทึกแล้วโหลดกลับ: meta แยกจากบิล, ไม่เก็บ activeUser, บิลเรียงตามเวลา', async () => {
  const idb = makeFakeIDB();
  const a = env({ idb });
  await sleep(30);                                   // รอ boot() ของตัวโหลดจบ
  assert.equal(await a.store.load(), null);
  a.store.save(mkDb([mkBill(2), mkBill(1), mkBill(3)]));
  await a.store.flush();
  assert.equal(idb.data.bills.size, 3);
  const meta = idb.data.kv.get('meta');
  assert.equal(meta.bills, undefined);
  assert.equal(meta.activeUser, undefined);
  assert.equal(meta.products.p1.name, 'ท่อ');

  const b = env({ idb });
  const saved = await b.store.load();
  assert.equal(saved.bills.length, 3);
  assert.deepEqual(saved.bills.map((x) => x.id).sort(), ['B1', 'B2', 'B3']);
  assert.ok(saved.bills[0].time <= saved.bills[1].time && saved.bills[1].time <= saved.bills[2].time);
  assert.equal(saved.products.p1.id, 'p1');
});

test('เขียนเฉพาะบิลที่เปลี่ยน (บิลล่าสุดเทียบลายเซ็น, บิลเก่าเขียนเมื่อ touchBill เท่านั้น)', async () => {
  const idb = makeFakeIDB();
  const bills = [mkBill(1, 100), mkBill(2, 1), mkBill(3, 0)];       // เก่า 100 วัน / เมื่อวาน / วันนี้
  const w = env({ idb });
  await sleep(30);
  w.store.save(mkDb(bills)); await w.store.flush();
  assert.equal(idb.stats.put.bills, 3);

  const r = env({ idb });
  const saved = await r.store.load();                                // เครื่องใหม่โหลดแล้ว prime ลายเซ็น
  idb.stats.put.bills = 0;
  r.store.save(saved); await r.store.flush();
  assert.equal(idb.stats.put.bills, 0, 'ไม่มีอะไรเปลี่ยน ต้องไม่เขียนบิลซ้ำ');

  saved.bills.find((x) => x.id === 'B3').total = 999;                // แก้บิลล่าสุด
  r.store.save(saved); await r.store.flush();
  assert.equal(idb.stats.put.bills, 1);
  assert.equal(idb.data.bills.get('B3').total, 999);

  saved.bills.find((x) => x.id === 'B1').total = 777;                // แก้บิลเก่า 100 วัน โดยไม่ touch → ไม่ถูกเขียน
  r.store.save(saved); await r.store.flush();
  assert.notEqual(idb.data.bills.get('B1').total, 777);
  r.store.touchBill('B1');                                           // touch แล้วจึงเขียน
  r.store.save(saved); await r.store.flush();
  assert.equal(idb.data.bills.get('B1').total, 777);
});

test('บิลที่ถูกลบออกจาก db.bills ถูกลบใน IndexedDB ด้วย', async () => {
  const idb = makeFakeIDB();
  const a = env({ idb }); await sleep(30);
  const db = mkDb([mkBill(1), mkBill(2)]);
  a.store.save(db); await a.store.flush();
  db.bills = db.bills.filter((b) => b.id !== 'B1');
  a.store.save(db); await a.store.flush();
  assert.deepEqual([...idb.data.bills.keys()], ['B2']);
});

test('ย้ายข้อมูลเดิมจาก localStorage: ย้ายครบ, เก็บสำเนาไว้ใน IndexedDB, ลบคีย์เก่าออก', async () => {
  const idb = makeFakeIDB();
  const legacy = JSON.stringify({ products: { p9: { id: 'p9' } }, bills: [mkBill(1), mkBill(2)], customers: {}, settings: {} });
  const a = env({ idb, ls: { pos_full_db_state: legacy, pos_supabase_url: 'https://x.supabase.co' } });
  await sleep(50);
  const saved = a.ctx.__POS_SAVED__;
  assert.equal(saved.bills.length, 2);
  assert.equal(idb.data.bills.size, 2);
  assert.equal(idb.data.kv.get('legacy_backup'), legacy);
  assert.equal(a.lsStore.pos_full_db_state, undefined, 'ต้องลบของเก่าเพื่อคืนโควตา');
  assert.equal(a.lsStore.pos_supabase_url, 'https://x.supabase.co', 'คีย์อื่นไม่ถูกแตะ');
});

test('ไม่มี IndexedDB (เช่นโหมดส่วนตัวบางตัว): ถอยกลับไปใช้ localStorage และยังบันทึกได้', async () => {
  const a = env({ idb: undefined });
  await sleep(30);
  assert.equal(a.store.fallback, true);
  a.store.save(mkDb([mkBill(1)]));
  const raw = JSON.parse(a.lsStore.pos_full_db_state);
  assert.equal(raw.bills.length, 1);
  assert.equal(raw.activeUser, undefined);
});

test('replaceAll (กู้คืนไฟล์สำรอง) แทนที่ทั้งหมด, clear (ล้างเครื่อง) ล้างแล้วไม่เขียนกลับ', async () => {
  const idb = makeFakeIDB();
  const a = env({ idb }); await sleep(30);
  a.store.save(mkDb([mkBill(1), mkBill(2)])); await a.store.flush();
  await a.store.replaceAll({ products: { z: { id: 'z' } }, bills: [mkBill(7)], customers: {}, settings: {} });
  assert.deepEqual([...idb.data.bills.keys()], ['B7']);
  assert.ok(idb.data.kv.get('meta').products.z);

  const dbRef = mkDb([mkBill(8)]);
  a.store.save(dbRef);                 // มีงานค้างในตัวหน่วง
  await a.store.clear();
  a.store.save(dbRef); await a.store.flush(); await sleep(100);
  assert.equal(idb.data.bills.size, 0);
  assert.equal(idb.data.kv.get('meta'), undefined, 'หลังล้างเครื่องต้องไม่ถูกเขียนกลับ');
});

test('authStorage: เก็บ/อ่าน/ลบ session ใน IndexedDB ได้', async () => {
  const idb = makeFakeIDB();
  const a = env({ idb }); await sleep(30);
  const s = a.store.authStorage;
  assert.equal(await s.getItem('sb-token'), null);
  await s.setItem('sb-token', '{"a":1}');
  assert.equal(await s.getItem('sb-token'), '{"a":1}');
  await s.removeItem('sb-token');
  assert.equal(await s.getItem('sb-token'), null);
});

test('ตัวโหลดแอป: รอข้อมูลก่อน, รันสคริปต์ของแอปตามลำดับ, เรียก DOMContentLoaded ที่แอปลงทะเบียนไว้ย้อนหลัง', async () => {
  const idb = makeFakeIDB();
  const seed = env({ idb }); await sleep(30);
  seed.store.save(mkDb([mkBill(1)])); await seed.store.flush();

  const apps = [
    'window.__order = ["A"]; window.__sawSaved = window.__POS_SAVED__ && window.__POS_SAVED__.bills.length; document.addEventListener("DOMContentLoaded", () => { window.__order.push("DCL-A"); });',
    'window.__order.push("B"); window.addEventListener("load", () => { window.__order.push("LOAD-B"); });'
  ];
  const a = env({ idb, apps });
  await sleep(150);
  assert.deepEqual([...a.ctx.__order], ['A', 'B', 'DCL-A', 'LOAD-B']);
  assert.equal(a.ctx.__sawSaved, 1, 'สคริปต์แอปต้องเห็นข้อมูลที่โหลดแล้วตั้งแต่บรรทัดแรก');
});

test('เปิดสองแท็บ: แท็บที่สองเป็นอ่านอย่างเดียว ไม่เขียนทับข้อมูลของแท็บแรก', async () => {
  const idb = makeFakeIDB();
  let held = false;
  const locks = { request: (name, opts, cb) => { if (held) return cb(null); held = true; return cb({ name }); } };   // แท็บแรกได้ล็อก แท็บสองไม่ได้
  const first = env({ idb, locks }); await sleep(30);
  const second = env({ idb, locks }); await sleep(30);
  assert.equal(first.store.readOnly, false);
  assert.equal(second.store.readOnly, true);
  first.store.save(mkDb([mkBill(1)])); await first.store.flush();
  const before = idb.stats.put.kv;
  second.store.save(mkDb([mkBill(9)])); await second.store.flush(); await sleep(100);
  assert.equal(idb.stats.put.kv, before, 'แท็บที่สองต้องไม่เขียน');
  assert.equal(idb.data.bills.has('B9'), false);
});
