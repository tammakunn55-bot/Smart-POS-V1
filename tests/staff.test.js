// ทดสอบฝั่งแอปของล็อกอินรายพนักงาน (โมดูล v11 + คิวซิงค์ v10) — โค้ดจริงจาก public/index.html
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const cashier = { id: 'u-1', name: 'แคชเชียร์', role: 'CASHIER' };
const U = (env, id) => env.run(`toUUID('${id}')`);

function ok(role = 'CASHIER', id = 'u-1') {
  return () => ({ data: { token_hash: 'th-1', email: 'e@x', user: { id: 'srv-' + id, role, name: 'N' } }, error: null });
}
function err(body, status = 401) {
  return () => ({ data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { json: async () => body, status } } });
}

test('ปิดโหมดรายพนักงาน (ค่าเริ่มต้น): ทำงานแบบเดิม ไม่เรียกเซิร์ฟเวอร์ ส่งได้ทุกรายการ', async () => {
  const env = createEnv({ functions: { 'pin-login': ok() } });
  await env.ctx.window.afterLocalLogin(cashier, '4821');
  assert.equal(env.calls.invoke.length, 0);
  assert.equal(env.ctx.window.canFlushOp({ type: 'adjust', by: 'someone' }), true);
  assert.equal(env.ctx.window.serverIsManager(), true);
});

test('เปิดโหมดรายพนักงาน: ใส่ PIN ถูก → เรียก pin-login ด้วย id (UUID) + PIN แล้ว verifyOtp(magiclink) ได้ session ของพนักงาน', async () => {
  const env = createEnv({ functions: { 'pin-login': ok('CASHIER', 'u-1') } });
  env.run('db.settings.perEmployeeAuth = true');
  await env.ctx.window.afterLocalLogin(cashier, '4821');
  assert.equal(env.calls.invoke.length, 1);
  assert.equal(env.calls.invoke[0].name, 'pin-login');
  assert.equal(env.calls.invoke[0].body.user_id, U(env, 'u-1'));
  assert.equal(env.calls.invoke[0].body.pin, '4821');
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls.verifyOtp)), [{ token_hash: 'th-1', type: 'magiclink' }]);
  assert.equal(env.ctx.window._serverUser.role, 'CASHIER');
  assert.equal(env.ctx.window.serverIsManager(), true, 'นโยบายสิทธิ์เท่ากัน: ทุกบัญชีที่ล็อกอินได้สิทธิ์เท่ากัน');
});

test('สิทธิ์ส่งคิว: นโยบายสิทธิ์เท่ากัน ทุกบัญชีส่งได้ทุกรายการ, ไม่มี session = ส่งไม่ได้', async () => {
  const env = createEnv();
  env.run('db.settings.perEmployeeAuth = true');
  const w = env.ctx.window;
  w._serverUser = { appUserId: U(env, 'u-1'), role: 'CASHIER', name: 'N' };
  assert.equal(w.canFlushOp({ type: 'sale', by: 'u-1' }), true);
  assert.equal(w.canFlushOp({ type: 'sale', by: 'u-2' }), true);
  assert.equal(w.canFlushOp({ type: 'sale', by: null }), true);            // รายการเก่าก่อนมีฟิลด์ by
  for (const t of ['adjust', 'receive', 'delete', 'closeShift']) assert.equal(w.canFlushOp({ type: t, by: 'u-1' }), true);
  w._serverUser = { appUserId: 'srv-m', role: 'MANAGER', name: 'M' };
  assert.equal(w.canFlushOp({ type: 'sale', by: 'u-2' }), true);
  assert.equal(w.canFlushOp({ type: 'adjust', by: 'u-2' }), true);
  assert.equal(w.serverIsManager(), true);
  w._serverUser = null;
  assert.equal(w.canFlushOp({ type: 'sale', by: 'u-1' }), false, 'ไม่มี session บนเซิร์ฟเวอร์ = ส่งอะไรไม่ได้');
});

function queueTwoSales(env) {
  env.run(`
    db.users = [{ id: 'u-1', name: 'A', role: 'CASHIER', pinHash: 'x' }, { id: 'u-2', name: 'B', role: 'CASHIER', pinHash: 'x' }];
    db.bills = [
      { id: 'BILL-A', total: 100, method: 'CASH', customerId: 'GENERAL', cashierId: 'u-1', items: [{ id: 'p', variantId: 'v', name: 'x', qty: 1, price: 100 }], _rpcPending: true },
      { id: 'BILL-B', total: 200, method: 'CASH', customerId: 'GENERAL', cashierId: 'u-2', items: [{ id: 'p', variantId: 'v', name: 'x', qty: 1, price: 200 }], _rpcPending: true }
    ];
    db.syncQueue = [
      { id: 'q1', type: 'sale', payload: { billId: 'BILL-A' }, status: 'pending', tries: 0, by: 'u-1' },
      { id: 'q2', type: 'sale', payload: { billId: 'BILL-B' }, status: 'pending', tries: 0, by: 'u-2' }
    ];
  `);
}

test('flush ในโหมดรายพนักงาน: ทุกบัญชีส่งบิลค้างคิวได้ทุกใบ (สิทธิ์เท่ากัน)', async () => {
  const env = createEnv({ rpc: { create_sale: () => ({ data: { bill_id: 'srv' }, error: null }) } });
  env.run('db.settings.perEmployeeAuth = true');
  queueTwoSales(env);
  env.ctx.window._serverUser = { appUserId: U(env, 'u-1'), role: 'CASHIER', name: 'A' };
  let res = await env.ctx.window.flushSyncQueue();
  assert.deepEqual({ ...res }, { pending: 0, failed: 0 });
  assert.deepEqual(env.calls.rpc.filter((c) => c.name === 'create_sale').map((c) => c.args.p_bill_number), ['BILL-A', 'BILL-B']);
});

test('ในโหมดรายพนักงานไม่มี session เซิร์ฟเวอร์ → ไม่ยิง RPC, ไม่ถือว่าล้มเหลว (รอ)', async () => {
  const env = createEnv();    // appUserRow ไม่มี → resolveServerUser ได้ null
  env.run('db.settings.perEmployeeAuth = true');
  queueTwoSales(env);
  const res = await env.ctx.window.flushSyncQueue();
  assert.deepEqual({ ...res }, { pending: 2, failed: 0 });
  assert.equal(env.calls.rpc.length, 0);
});

test('resolveServerUser: owner ที่ล็อกอินอีเมล/รหัสผ่านอยู่แล้ว → รู้บทบาทจาก app_users', async () => {
  const env = createEnv({ appUserRow: { id: 'srv-owner', role: 'OWNER', name: 'เจ้าของ' } });
  const su = await env.ctx.window.resolveServerUser();
  assert.equal(su.role, 'OWNER');
  env.run('db.settings.perEmployeeAuth = true');
  assert.equal(env.ctx.window.serverIsManager(), true);
});

test('PIN ถูกในเครื่องแต่เซิร์ฟเวอร์ปฏิเสธ / ถูกพัก: แจ้งเตือน ใช้งานในเครื่องต่อได้ ไม่มี session', async () => {
  for (const [body, status, re] of [[{ error: 'invalid_credentials' }, 401, /ยังไม่ตรงกับเซิร์ฟเวอร์/], [{ error: 'locked', retry_after_s: 30 }, 429, /พักชั่วคราว/]]) {
    const env = createEnv({ functions: { 'pin-login': err(body, status) } });
    const alerts = []; env.ctx.window.showAlert = (t, m) => alerts.push(t + ' ' + m);
    env.run('db.settings.perEmployeeAuth = true');
    await env.ctx.window.afterLocalLogin(cashier, '4821');
    assert.equal(env.ctx.window._serverUser, null);
    assert.equal(env.calls.verifyOtp.length, 0);
    assert.match(alerts.join('\n'), re);
  }
});

test('ออฟไลน์ตอนล็อกอิน: จำไว้ในหน่วยความจำ เมื่อกลับมาออนไลน์จึงล็อกอินเซิร์ฟเวอร์ให้อัตโนมัติ (ไม่เก็บ PIN ลงดิสก์)', async () => {
  let online = false;
  const env = createEnv({ functions: { 'pin-login': (b) => (online ? ok('CASHIER', 'u-1')(b) : { data: null, error: { message: 'Failed to fetch' } }) } });
  env.run("db.settings.perEmployeeAuth = true; db.users = [{ id: 'u-1', name: 'A', role: 'CASHIER' }]; db.activeUser = db.users[0];");
  await env.ctx.window.afterLocalLogin(cashier, '4821');
  assert.equal(env.ctx.window._serverUser, null);
  assert.ok(!JSON.stringify(env.run('db')).includes('4821'), 'PIN ดิบต้องไม่อยู่ใน db');
  online = true;
  await env.fire('online');
  assert.equal(env.ctx.window._serverUser.role, 'CASHIER');
  assert.equal(env.calls.verifyOtp.length, 1);
});

test('ล็อกเครื่อง: ตัด session ของพนักงานทิ้ง (signOut แบบ local) และล้างตัวตนบนเซิร์ฟเวอร์', async () => {
  const env = createEnv({ functions: { 'pin-login': ok() } });
  env.run('db.settings.perEmployeeAuth = true');
  await env.ctx.window.afterLocalLogin(cashier, '4821');
  env.ctx.window.lockPOS();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(env.calls.signOut, 1);
  assert.equal(env.ctx.window._serverUser, null);
});

test('คิวเก็บ "ใครเป็นผู้สร้างรายการ" (by) จากผู้ใช้ที่ล็อกอินอยู่', () => {
  const env = createEnv();
  env.run("db.activeUser = { id: 'u-7', name: 'X', role: 'CASHIER' }");
  env.ctx.window.enqueueSync({ type: 'adjust', payload: {} }, true);
  assert.equal(env.run('db.syncQueue[0].by'), 'u-7');
});

// ---------- ปิดกะผ่าน RPC close_shift (คิวซิงค์ชนิด closeShift) ----------
function queueCloseShift(env, extra = '') {
  env.run(`
    db.shifts = [{ id: 'SH-1', startTime: 1000, endTime: 5000, openingCash: 1000, cashOnHand: 0, openedById: 'u-1',
                   summary: { expectedCash: 1500 } }];
    db.currentShift = null;
    ${extra}
    db.syncQueue = [{ id: 'q1', type: 'closeShift', status: 'pending', tries: 0, by: 'u-1',
                      payload: { shiftId: 'SH-1', actualCash: 0, note: 'นับไม่ครบ', manualIn: 50, manualOut: 20 } }];
  `);
}

test('closeShift: upsert กะเป็น OPEN ก่อน แล้วเรียก close_shift ด้วยยอดนับจริง (0 บาทต้องไม่กลายเป็น null) และตั้ง _closedOnServer', async () => {
  const env = createEnv({ rpc: { close_shift: () => ({ data: { expected_cash: 1500, variance: -1500 }, error: null }) } });
  env.ctx.window._serverUser = { appUserId: 'srv-1', role: 'CASHIER', name: 'A' };
  env.ctx.window.showAlert = () => {};
  queueCloseShift(env);
  const res = await env.ctx.window.flushSyncQueue();
  assert.deepEqual({ ...res }, { pending: 0, failed: 0 });

  const shiftUpsert = env.calls.upsert.find((c) => c.table === 'shifts');
  assert.ok(shiftUpsert, 'ต้องมีแถวกะบนเซิร์ฟเวอร์ก่อนปิด');
  assert.equal(shiftUpsert.rows[0].status, 'OPEN', 'ห้ามส่ง CLOSED ผ่าน upsert ปกติ');
  assert.equal(shiftUpsert.rows[0].closing_cash, null);

  const call = env.calls.rpc.find((c) => c.name === 'close_shift');
  assert.equal(call.args.p_shift_id, U(env, 'SH-1'));
  assert.equal(call.args.p_actual_cash, 0);
  assert.equal(call.args.p_manual_in, 50);
  assert.equal(call.args.p_manual_out, 20);
  assert.equal(call.args.p_note, 'นับไม่ครบ');
  assert.equal(env.run('db.shifts[0]._closedOnServer'), true);
});

test('closeShift: หลังเซิร์ฟเวอร์ปิดแล้ว _shiftRow ส่ง CLOSED และ closing_cash = 0 (ไม่ใช่ null)', async () => {
  const env = createEnv();
  env.ctx.window._serverUser = { appUserId: 'srv-1', role: 'CASHIER', name: 'A' };
  const row = env.run(`_shiftRow({ id: 'SH-1', startTime: 1000, endTime: 5000, openingCash: 1000, cashOnHand: 0, _closedOnServer: true })`);
  assert.equal(row.status, 'CLOSED');
  assert.equal(row.closing_cash, 0);
});

test('closeShift: กะปิดไปแล้วบนเซิร์ฟเวอร์ ("ปิดไปแล้ว") ถือว่าสำเร็จ ไม่ค้างคิว', async () => {
  const env = createEnv({ rpc: { close_shift: () => ({ data: null, error: { message: 'กะนี้ปิดไปแล้ว' } }) } });
  env.ctx.window._serverUser = { appUserId: 'srv-1', role: 'CASHIER', name: 'A' };
  queueCloseShift(env);
  const res = await env.ctx.window.flushSyncQueue();
  assert.deepEqual({ ...res }, { pending: 0, failed: 0 });
  assert.equal(env.run('db.shifts[0]._closedOnServer'), true);
});

test('closeShift: เซิร์ฟเวอร์ปฏิเสธ (เช่น ยอดไม่ตรงแต่ไม่มีหมายเหตุ) → คิวไม่หาย และกะยังไม่ถูกตั้งว่าปิด', async () => {
  const env = createEnv({ rpc: { close_shift: () => ({ data: null, error: { message: 'ยอดไม่ตรง กรุณาระบุสาเหตุ' } }) } });
  env.ctx.window._serverUser = { appUserId: 'srv-1', role: 'CASHIER', name: 'A' };
  queueCloseShift(env);
  const res = await env.ctx.window.flushSyncQueue();
  assert.equal(res.pending + res.failed, 1);
  assert.notEqual(env.run('db.shifts[0]._closedOnServer'), true);
});
