const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

test('todayKey ใช้เวลาไทย ไม่ใช่ UTC (บิลหลังเที่ยงคืนไทยต้องได้วันที่ใหม่)', () => {
  const { ctx } = createEnv();
  assert.equal(ctx.window.todayKey(new Date('2026-10-05T17:30:00Z')), '20261006'); // 00:30 น. ไทย
  assert.equal(ctx.window.todayKey(new Date('2026-10-05T16:59:00Z')), '20261005'); // 23:59 น. ไทย
});

test('getDeviceId คงที่และเป็น hex 6 ตัว', () => {
  const { ctx } = createEnv();
  const a = ctx.window.getDeviceId(), b = ctx.window.getDeviceId();
  assert.equal(a, b);
  assert.match(a, /^[0-9A-F]{6}$/);
});

test('calcCartTotals: ส่วนลดบาท/เปอร์เซ็นต์/เกินยอด และยอดล้านบาทไม่เพี้ยน', () => {
  const { ctx } = createEnv();
  const f = ctx.window.calcCartTotals;
  assert.deepEqual({ ...f([{ qty: 2, price: 50 }, { qty: 1, price: 30.5 }], '10', 'PERCENT') }, { subtotal: 130.5, discountAmt: 13.05, grandTotal: 117.45 });
  assert.equal(f([{ qty: 1, price: 100 }], '999', 'BAHT').grandTotal, 0);          // ส่วนลดเกินยอด -> ไม่ติดลบ
  assert.equal(f([{ qty: 1, price: 100 }], '-5', 'BAHT').discountAmt, 0);           // ส่วนลดติดลบ -> 0
  assert.equal(f([{ qty: 1, price: 1234567.89 }], '', 'BAHT').grandTotal, 1234567.89); // บั๊กเดิมอ่านได้ 1234
});

test('billRefundRatio: คืนเงินตามที่จ่ายจริง (หักสัดส่วนส่วนลด)', () => {
  const { ctx } = createEnv();
  const bill = { total: 900, items: [{ qty: 2, price: 500 }] };   // ราคาเต็ม 1000 ลด 100
  const r = ctx.window.billRefundRatio(bill);
  assert.equal(r, 0.9);
  assert.equal(Math.round(500 * r * 100) / 100, 450);              // คืน 1 ชิ้น = 450 ไม่ใช่ 500
  assert.equal(ctx.window.billRefundRatio({ total: 1000, items: [{ qty: 2, price: 500 }] }), 1);
  assert.equal(ctx.window.billRefundRatio({ total: 5, items: [] }), 1);
});

test('PIN: PBKDF2 ผ่าน/ไม่ผ่าน, salt สุ่มต่างกัน, รองรับ hash เก่า, ปฏิเสธ PIN เดาง่าย', async () => {
  const { ctx } = createEnv();
  const h1 = await ctx.window.makePinHash('4821'), h2 = await ctx.window.makePinHash('4821');
  assert.match(h1, /^pbkdf2\$150000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(h1, h2);
  assert.equal(await ctx.window.verifyPinHash('4821', h1), true);
  assert.equal(await ctx.window.verifyPinHash('4822', h1), false);
  const legacy = await ctx.window.hashPin('7391');
  assert.equal(await ctx.window.verifyPinHash('7391', legacy), true);
  assert.equal(await ctx.window.verifyPinHash('7392', legacy), false);
  assert.equal(await ctx.window.verifyPinHash('1234', ''), false);
  for (const w of ['0000', '1234', '1111']) assert.ok(ctx.window.WEAK_PINS.includes(w));
});

function seedSale(env, over = {}) {
  const { ctx, run } = env;
  run(`
    db.users = [{ id: 'u-1', name: 'แคชเชียร์', role: 'CASHIER', pinHash: 'x', permissions: [] }];
    db.shifts = [{ id: 'SHIFT-1', startTime: 1700000000000, endTime: null, openingCash: 500 }];
    db.customers = { 'c-1': { id: 'c-1', name: 'ลูกค้า', debt: 1500, creditLimit: 5000 } };
    db.bills = [{ id: 'POS-20261006-ABC123-001', total: 900, subtotal: 1000, discount: 100, method: 'CASH',
      customerId: 'GENERAL', cashierId: 'u-1', shiftId: 'SHIFT-1', _rpcPending: true,
      items: [{ id: 'p-1', variantId: 'v-1', fractionId: null, name: 'ท่อ PVC', qty: 2, price: 500, multiplier: 1 }] }];
    db.products = { 'p-1': { id: 'p-1', name: 'ท่อ PVC', variants: [{ id: 'v-1', stock: 8, cost: 300, price: 500 }] } };
  `);
  ctx.window.enqueueSync({ type: 'sale', payload: { billId: 'POS-20261006-ABC123-001' } }, true);
}

test('ขาย: ส่งส่วนลดและยอดคาดหวังไป create_sale และตั้งธงสำเร็จ', async () => {
  const env = createEnv({ rpc: { create_sale: () => ({ data: { bill_id: 'srv-bill-1', duplicate: false }, error: null }) } });
  seedSale(env);
  const res = await env.ctx.window.flushSyncQueue();
  assert.deepEqual({ ...res }, { pending: 0, failed: 0 });
  const call = env.calls.rpc.find(c => c.name === 'create_sale').args;
  assert.equal(call.p_bill_number, 'POS-20261006-ABC123-001');
  assert.equal(call.p_discount_amount, 100);
  assert.equal(call.p_expected_total, 900);
  assert.equal(call.p_payment_method, 'CASH');
  assert.equal(call.p_allow_negative, true);   // ค่าเริ่มต้น: ไม่ป้องกันสต็อกติดลบ
  assert.equal(call.p_items[0].quantity, 2);
  assert.match(call.p_items[0].variant_id, /^[0-9a-f-]{36}$/);
  const bill = env.run('db.bills[0]');
  assert.equal(bill._syncedViaRPC, true);
  assert.equal(bill._rpcPending, undefined);
  assert.equal(bill._serverBillId, 'srv-bill-1');
  assert.ok(env.calls.upsert.some(u => u.table === 'shifts'), 'ต้องส่งกะขึ้นก่อน กัน FK ล้ม');
});

test('ขาย: เปิดป้องกันสต็อกติดลบ -> ส่ง p_allow_negative=false', async () => {
  const env = createEnv();
  seedSale(env);
  env.run('db.settings.preventNegativeStock = true');
  await env.ctx.window.flushSyncQueue();
  assert.equal(env.calls.rpc.find(c => c.name === 'create_sale').args.p_allow_negative, false);
});

test('ออฟไลน์: รายการค้างในคิว ไม่หาย ไม่ถูกตีว่าล้มเหลว', async () => {
  const env = createEnv({ rpc: { create_sale: () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } }) } });
  seedSale(env);
  const res = await env.ctx.window.flushSyncQueue();
  assert.deepEqual({ ...res }, { pending: 1, failed: 0 });
  assert.equal(env.run('db.bills[0]._rpcPending'), true);
  assert.equal(env.calls.syncProducts, 0, 'ออฟไลน์ไม่ต้องไปซิงค์แคตตาล็อกซ้ำ');
});

test('เซิร์ฟเวอร์ปฏิเสธ (เช่นเกินวงเงิน): ซิงค์แคตตาล็อก 1 ครั้งแล้วลองใหม่ ถ้ายังไม่ผ่านติด failed และไม่บล็อกรายการถัดไป', async () => {
  const env = createEnv({ rpc: {
    create_sale: () => ({ data: null, error: { message: 'ยอดหนี้รวมจะเกินวงเงินเครดิต' } }),
    receive_customer_payment: () => ({ data: { applied: 100 }, error: null })
  } });
  seedSale(env);
  env.ctx.window.enqueueSync({ type: 'payment', payload: { customerId: 'c-1', amount: 100, shiftId: 'SHIFT-1', opRef: 'CL-1' } }, true);
  const res = await env.ctx.window.flushSyncQueue();
  assert.deepEqual({ ...res }, { pending: 0, failed: 1 });          // pending = รายการที่ยังรอส่ง (ไม่นับที่ failed) ส่วนรับชำระผ่านและออกจากคิวแล้ว
  assert.equal(env.calls.rpc.filter(c => c.name === 'create_sale').length, 2);   // ลองใหม่หลังซิงค์แคตตาล็อก
  assert.equal(env.calls.syncProducts, 1);
  const q = env.run('db.syncQueue');
  assert.equal(q.length, 1);
  assert.equal(q[0].status, 'failed');
  assert.match(q[0].lastError, /เกินวงเงิน/);
  assert.match(env.ctx.window.describeSyncFailures(), /บิลขาย/);
  assert.equal(env.run('db.bills[0]._rpcPending'), true);            // บิลยังถูกทำเครื่องหมายว่ารอ ไม่ถูกข้าม
});

test('retryFailedSyncOps คืนสถานะ failed เป็น pending', async () => {
  const env = createEnv({ rpc: { create_sale: () => ({ data: null, error: { message: 'x' } }) } });
  seedSale(env);
  await env.ctx.window.flushSyncQueue();
  assert.equal(env.run('db.syncQueue[0].status'), 'failed');
  env.ctx.window.retryFailedSyncOps();
  assert.equal(env.run('db.syncQueue[0].status'), 'pending');
});

test('คืนสินค้า: ต้องมีบิลบนเซิร์ฟเวอร์ก่อน และส่ง ref/shift/จำนวนที่ถูกต้อง', async () => {
  const env = createEnv({ rpc: { process_return: () => ({ data: { refund_total: 450 }, error: null }) } });
  seedSale(env);
  env.run('db.syncQueue = []');
  env.ctx.window.enqueueSync({ type: 'return', payload: { billId: 'POS-20261006-ABC123-001', items: [{ variant_id: 'v-1', fraction_id: null, quantity: 1 }], restock: [{ variantId: 'v-1', qty: 1 }], returnRef: 'CN-20261006-ABC123-001', shiftId: 'SHIFT-1', isCredit: false, refund: 450 } }, true);
  let res = await env.ctx.window.flushSyncQueue();
  assert.equal(res.failed, 1, 'บิลยังไม่ถูกส่งขึ้นเซิร์ฟเวอร์ -> ต้องไม่ส่งคืนสินค้าแบบเดาไอดี');
  env.ctx.window.retryFailedSyncOps();
  env.run("db.bills[0]._serverBillId = 'srv-bill-1'; db.bills[0]._syncedViaRPC = true;");
  res = await env.ctx.window.flushSyncQueue();
  assert.deepEqual({ ...res }, { pending: 0, failed: 0 });
  const a = env.calls.rpc.filter(c => c.name === 'process_return').pop().args;
  assert.equal(a.p_bill_id, 'srv-bill-1');
  assert.equal(a.p_return_ref, 'CN-20261006-ABC123-001');
  assert.equal(a.p_items[0].quantity, 1);
  assert.ok(a.p_shift_id);
});

test('seed สต็อก/หนี้: หักรายการที่ค้างในคิวออก กันนับซ้ำ', async () => {
  const env = createEnv();
  seedSale(env);   // ขาย 2 ชิ้น (เครื่องหักสต็อกไปแล้วเหลือ 8) ยังไม่ขึ้นเซิร์ฟเวอร์
  await env.ctx.window._seedStock(env.client, Object.values(env.run('db.products')));
  const stockSeed = env.calls.rpc.find(c => c.name === 'seed_variant_stock').args.p_items[0];
  assert.equal(stockSeed.stock, 10, 'ต้องส่งยอดก่อนขาย (8+2) เพราะ create_sale จะหัก 2 ให้เอง');
  assert.equal(env.run('db.products["p-1"].variants[0]._seeded'), true);

  // ขายเชื่อค้างในคิว 500 บาท หนี้ในเครื่อง 1,500 (รวมบิลนี้แล้ว) -> seed 1,000
  env.run("db.bills.push({ id: 'B2', total: 500, method: 'CREDIT', customerId: 'c-1', items: [], _rpcPending: true })");
  env.ctx.window.enqueueSync({ type: 'sale', payload: { billId: 'B2' } }, true);
  await env.ctx.window._seedDebts(env.client, Object.values(env.run('db.customers')));
  const debtSeed = env.calls.rpc.find(c => c.name === 'seed_customer_debt').args.p_items[0];
  assert.equal(debtSeed.debt, 1000);
});

test('seed ไม่ทับซ้ำ: ตัวที่ seeded แล้วไม่ถูกส่งอีก', async () => {
  const env = createEnv();
  seedSale(env);
  await env.ctx.window._seedStock(env.client, Object.values(env.run('db.products')));
  await env.ctx.window._seedStock(env.client, Object.values(env.run('db.products')));
  assert.equal(env.calls.rpc.filter(c => c.name === 'seed_variant_stock').length, 1);
});

test('ถ้ายังไม่ได้รัน migration (RPC ไม่พบ) ไม่ทำให้ซิงค์สินค้าล้มทั้งชุด แต่ทำเครื่องหมายไว้', async () => {
  const env = createEnv({ rpc: { seed_variant_stock: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) } });
  seedSale(env);
  await env.ctx.window._seedStock(env.client, Object.values(env.run('db.products')));
  assert.equal(env.ctx.window._schemaOutdated, true);
});
