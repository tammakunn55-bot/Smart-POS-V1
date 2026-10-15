// ทดสอบ "ตรวจความพร้อมก่อนใช้งานจริง" (ฟังก์ชันล้วน computeReadiness) — โค้ดจริงจาก public/js/settings/readiness.js
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readJs } = require('./harness');

const ctx = { window: {}, Object, Array, Number, JSON, Promise };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(readJs('js/settings/readiness.js'), ctx);
const compute = (d, c) => JSON.parse(JSON.stringify(ctx.computeReadiness(d, c)));
const levels = (items) => items.map((i) => i.level + ':' + i.title);
const has = (items, level, re) => items.some((i) => i.level === level && re.test(i.title));

const goodDb = () => ({
  products: { a: { variants: [{ cost: 10, price: 20, stock: 5 }] } },
  users: [{ name: 'เจ้าของ', pinHash: 'h' }], settings: { preventNegativeStock: true }
});

test('ข้อมูลครบ + คลาวด์พร้อม → ไม่มีข้อผิดพลาดหรือคำเตือน', () => {
  const r = compute(goodDb(), { cloudConfigured: true, signedIn: true, schemaVersion: 3, queue: { pending: 0, failed: 0 } });
  assert.ok(r.length >= 5);
  assert.deepEqual(r.filter((i) => i.level !== 'ok'), []);
});

test('ร้านใหม่ที่เพิ่งนำเข้า: ไม่มีทุน/สต็อก 0/ราคา 0 → แจ้งตรงจุด', () => {
  const d = goodDb();
  d.products = { a: { variants: [{ cost: 0, price: 0, stock: 0 }, { cost: 0, price: 50, stock: 0 }] } };
  const r = compute(d, {});
  assert.ok(has(r, 'warn', /ยังไม่มีราคาทุน 2/));
  assert.ok(has(r, 'fail', /ราคาขายเป็น 0 บาท 1/));
  assert.ok(has(r, 'warn', /สต็อกทุกรายการเป็น 0/));
});

test('ไม่มีสินค้า / ยังไม่ตั้ง PIN เจ้าของ → fail', () => {
  const r = compute({ products: {}, users: [{ name: 'เจ้าของร้าน', needsPinSetup: true }], settings: {} }, {});
  assert.ok(has(r, 'fail', /ยังไม่มีสินค้า/));
  assert.ok(has(r, 'fail', /ยังไม่ตั้ง PIN: เจ้าของร้าน/));
});

test('คลาวด์: ยังไม่ล็อกอิน / schema เก่า / มีคิวล้มเหลว / มีคิวรอส่ง', () => {
  const base = { cloudConfigured: true, signedIn: false, schemaVersion: 2, queue: { pending: 3, failed: 1 } };
  const r = compute(goodDb(), base);
  assert.ok(has(r, 'fail', /ยังไม่ได้ล็อกอินร้านค้า/));
  assert.ok(has(r, 'fail', /เวอร์ชัน 2/));
  assert.ok(has(r, 'fail', /เซิร์ฟเวอร์ปฏิเสธ 1/));
  const r2 = compute(goodDb(), { ...base, signedIn: true, schemaVersion: 3, queue: { pending: 3, failed: 0 } });
  assert.ok(has(r2, 'warn', /รอส่งขึ้นเซิร์ฟเวอร์ 3/));
  const r3 = compute(goodDb(), { ...base, signedIn: true, schemaVersion: null, queue: { pending: 0, failed: 0 } });
  assert.ok(has(r3, 'warn', /ตรวจเวอร์ชันฐานข้อมูลไม่ได้/));
});

test('คำแนะนำการตั้งค่า: หลายพนักงานแต่ยังใช้บัญชีร่วม / มีสต็อกแต่ไม่ป้องกันติดลบ', () => {
  const d = goodDb();
  d.users.push({ name: 'แคชเชียร์', pinHash: 'h2' });
  d.settings = {};
  const r = compute(d, { cloudConfigured: true, signedIn: true, schemaVersion: 3, queue: { pending: 0, failed: 0 } });
  assert.ok(has(r, 'warn', /ยังไม่เปิดบัญชีรายพนักงาน/));
  assert.ok(has(r, 'warn', /ยังไม่เปิด "ป้องกันสต็อกติดลบ"/));
});

test('ไม่ได้เชื่อมคลาวด์ → เตือน (ไม่ใช่ fail) ใช้เครื่องเดียวได้', () => {
  const r = compute(goodDb(), { cloudConfigured: false });
  assert.ok(has(r, 'warn', /ยังไม่ได้เชื่อมต่อ Supabase/));
  assert.equal(r.some((i) => i.level === 'fail'), false);
});

test('รายงานบนหน้าจอ: จัดเรียงข้อผิดพลาดขึ้นก่อน และสรุปหัวเรื่องถูกต้อง', async () => {
  let shown = null;
  ctx.window.db = { products: {}, users: [{ name: 'A', needsPinSetup: true }], settings: {} };
  ctx.window.getSupabaseClient = () => null;
  ctx.window.showAlert = (title, text, isError) => { shown = { title, text, isError }; };
  await ctx.showReadinessReport();
  assert.match(shown.title, /ต้องแก้ \d+ ข้อก่อนใช้งานจริง/);
  assert.equal(shown.isError, true);
  assert.ok(shown.text.split('\n')[0].startsWith('❌'), 'บรรทัดแรกต้องเป็นข้อที่ต้องแก้');
});
