// ทดสอบโค้ดจริงของแอป (processPaymentRequest / executeReturn / confirmReceivePayment) ใน vm ด้วย DOM จำลอง
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');


const { boot, sell, dummy } = require('./app-env');



test('ขาย (โค้ดจริง): บิลเก็บส่วนลด/ยอดก่อนลด, เลขบิลมีรหัสเครื่อง, ตัดสต็อก, เข้าคิว create_sale', () => {
  const env = boot();
  sell(env);
  const bill = env.run('db.bills[0]');
  assert.match(bill.id, /^POS-\d{8}-[0-9A-F]{6}-001$/);
  assert.equal(bill.subtotal, 1000);
  assert.equal(bill.discount, 100);
  assert.equal(bill.total, 900);
  assert.equal(bill._rpcPending, true);
  assert.equal(env.run('db.products["p-1"].variants[0].stock'), 8);
  const q = env.run('db.syncQueue');
  assert.equal(q.length, 1);
  assert.equal(q[0].type, 'sale');
  assert.equal(q[0].payload.billId, bill.id);
});

test('ขาย 2 บิลติดกัน: เลขบิลไม่ซ้ำ', () => {
  const env = boot();
  sell(env); sell(env);
  const ids = env.run('db.bills.map(b => b.id)');
  assert.equal(new Set(ids).size, 2);
  assert.match(ids[1], /-002$/);
});

test('ยอดล้านบาทไม่เพี้ยน (บั๊กเดิมอ่านจากข้อความบนจอ)', () => {
  const env = boot();
  sell(env, { discount: '', qty: 1, price: 1234567.89 });
  assert.equal(env.run('db.bills[0].total'), 1234567.89);
});

test('ป้องกันสต็อกติดลบ: เปิดแล้วขายเกินสต็อกไม่ได้ / ปิดอยู่ขายได้ (พฤติกรรมเดิม)', () => {
  const env = boot();
  env.run('db.settings = { preventNegativeStock: true }');
  sell(env, { qty: 11, discount: '' });
  assert.equal(env.run('db.bills.length'), 0, 'ต้องไม่สร้างบิล');
  assert.equal(env.run('db.products["p-1"].variants[0].stock'), 10);
  env.run('db.settings = { preventNegativeStock: false }');
  sell(env, { qty: 11, discount: '' });
  assert.equal(env.run('db.bills.length'), 1);
  assert.equal(env.run('db.products["p-1"].variants[0].stock'), -1);
});

test('ขายเชื่อ: เกินวงเงินถูกบล็อก, ไม่เกินเพิ่มหนี้ในเครื่องและเข้าคิว', () => {
  const env = boot();
  sell(env, { method: 'CREDIT', customer: 'c-1', qty: 20, price: 500, discount: '' });   // 10,000 > 5,000
  assert.equal(env.run('db.bills.length'), 0);
  sell(env, { method: 'CREDIT', customer: 'c-1', qty: 2, price: 500, discount: '' });     // 1,000
  assert.equal(env.run('db.customers["c-1"].debt'), 1000);
  assert.equal(env.run('db.syncQueue.length'), 1);
});

test('คืนสินค้า (โค้ดจริง): คืนตามราคาหลังหักส่วนลด, คืนสต็อก, ledger ไม่ถูกส่งซ้ำ, เข้าคิว return', () => {
  const env = boot();
  sell(env);                                           // 2 ชิ้น x 500 ลด 10% = 900
  env.run("returnTempBillId = db.bills[0].id");
  env.els['return-qty-0'] = dummy(); env.els['return-qty-0'].value = '1';
  env.ctx.window.executeReturn();
  assert.equal(env.run('db.returns[0].amount'), 450);   // เดิมจะได้ 500
  assert.equal(env.run('db.products["p-1"].variants[0].stock'), 9);
  const led = env.run('db.cashLedger[0]');
  assert.equal(led.type, 'expense-refund');
  assert.equal(led.expense, 450);
  assert.equal(led._viaRpc, true);
  const q = env.run('db.syncQueue.find(o => o.type === "return")');
  assert.equal(q.payload.refund, 450);
  assert.equal(q.payload.items[0].quantity, 1);
  assert.match(q.payload.returnRef, /^CN-\d{8}-[0-9A-F]{6}-001$/);
  assert.equal(q.payload.restock[0].qty, 1);
});

test('รับชำระหนี้ (โค้ดจริง): หนี้ลด, ledger ติดธง _viaRpc, เข้าคิว payment พร้อม opRef', () => {
  const env = boot();
  env.run('db.customers["c-1"].debt = 1000');
  env.els['rp-customer-id'] = dummy(); env.els['rp-customer-id'].value = 'c-1';
  env.els['rp-amount'] = dummy(); env.els['rp-amount'].value = '400';
  env.ctx.window.confirmReceivePayment();
  assert.equal(env.run('db.customers["c-1"].debt'), 600);
  const led = env.run('db.cashLedger[0]');
  assert.equal(led._viaRpc, true);
  const q = env.run('db.syncQueue[0]');
  assert.equal(q.type, 'payment');
  assert.equal(q.payload.opRef, led.id);
  assert.equal(q.payload.amount, 400);
});

test('สิทธิ์: ยังไม่ล็อกอินหลังตั้ง PIN แล้ว = ไม่มีสิทธิ์ (เดิมถือเป็นเจ้าของ), แคชเชียร์สำรอง/ล้างเครื่องไม่ได้', () => {
  const env = boot();
  env.run("db.users.push({ id: 'o', name: 'เจ้าของ', role: 'OWNER', permissions: ['ALL'], pinHash: 'h' }); db.activeUser = null;");
  assert.equal(env.ctx.window.canDo('ALL'), false);
  env.run('db.activeUser = db.users[0]');   // แคชเชียร์
  env.ctx.__alerts.length = 0;
  let threw = false;
  try { env.ctx.window.factoryReset(); env.ctx.window.exportFullBackup(); } catch (e) { threw = true; }
  assert.equal(threw, false);
  assert.equal(env.run('db.bills.length'), 0);
  assert.ok(env.run('db.users.length') >= 2, 'ข้อมูลต้องไม่ถูกล้าง');
});
