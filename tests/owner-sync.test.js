// ทดสอบบั๊ก "ซิงค์ครั้งแรกล้ม เพราะสร้างเจ้าของซ้ำ" และการแสดงสาเหตุ error จริง — โค้ดจริงของแอป
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, dummy } = require('./app-env');

const SERVER_OWNER = '200b277e-94dd-49b2-809c-5452fc4500aa';

// Supabase จำลองที่จดทุกคำสั่ง upsert และเลียนแบบ unique index "มีเจ้าของได้คนเดียว" ของฐานข้อมูลจริง
function fakeSupabase({ serverOwnerId = SERVER_OWNER, failTable = null, failError = null } = {}) {
  const log = { upserts: [], rpc: [] };
  const appUsers = serverOwnerId ? [{ id: serverOwnerId, role: 'OWNER' }] : [];
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'auth-1' } } } }), signOut: async () => ({}) },
    rpc: async (name, args) => {
      log.rpc.push({ name, args });
      if (name === 'pos_schema_version') return { data: 3, error: null };
      if (name === 'bootstrap_first_owner') return { data: SERVER_OWNER, error: null };
      return { data: {}, error: null };
    },
    from: (table) => ({
      upsert: async (rows) => {
        log.upserts.push({ table, rows });
        if (failTable === table) return { error: failError };
        if (table === 'app_users') {              // จำลอง unique index idx_app_users_one_owner
          for (const r of rows) {
            if (r.role === 'OWNER' && appUsers.some((u) => u.role === 'OWNER' && u.id !== r.id)) {
              return { error: { message: 'duplicate key value violates unique constraint "idx_app_users_one_owner"', code: '23505', details: 'Key ((role = \'OWNER\'::text))=(t) already exists.' } };
            }
            if (!appUsers.some((u) => u.id === r.id)) appUsers.push({ id: r.id, role: r.role });
          }
        }
        return { error: null };
      },
      select: () => ({
        eq: (col, val) => ({ maybeSingle: async () => ({ data: appUsers.find((u) => u[col] === val) || null, error: null }) }),
        order: () => ({ then: undefined })
      })
    })
  };
  return { client, log, appUsers };
}

function setup(opts) {
  const env = boot();
  const fake = fakeSupabase(opts);
  env.ctx.window.getSupabaseClient = () => fake.client;
  env.ctx.window.getSupabase = () => fake.client;
  env.run(`
    db.users = [{ id: 'owner-local', name: 'เจ้าของ', role: 'OWNER', permissions: ['ALL'], pinHash: 'h' }];
    db.activeUser = db.users[0];
    db.bills = [{ id: 'B1', time: Date.now(), total: 10, cashierId: 'owner-local', items: [] }];
    db.shifts = [{ id: 'S1', startTime: 1, openedById: 'owner-local' }];
    db.syncQueue = [{ id: 'q', type: 'adjust', by: 'owner-local', status: 'pending', payload: {} }];
  `);
  return { env, fake };
}

test('ตั้งเจ้าของร้านครั้งแรก: ใช้ id ที่เซิร์ฟเวอร์ส่งกลับ และแก้ทุกที่ที่อ้างถึง id เดิม', async () => {
  const { env, fake } = setup({ serverOwnerId: null });
  env.els = env.els || {};
  const set = (id, v) => { env.els[id] = env.els[id] || dummy(); env.els[id].value = v; };
  // confirmBootstrapOwner อ่านค่าจากช่องกรอก
  const origGet = env.ctx.document.getElementById;
  const fields = { 'bootstrap-owner-name': { value: 'ร้าน ช.เจริญกิจ' }, 'bootstrap-owner-pin': { value: '4821' } };
  env.ctx.document.getElementById = (id) => fields[id] || origGet(id);
  await env.ctx.window.confirmBootstrapOwner();
  const owner = env.run("db.users.find(u => u.role === 'OWNER')");
  assert.equal(owner.id, SERVER_OWNER, 'ต้องใช้ id เดียวกับที่เซิร์ฟเวอร์สร้าง');
  assert.equal(env.run('toUUID(db.users[0].id)'), SERVER_OWNER);
  assert.equal(owner.name, 'ร้าน ช.เจริญกิจ');
  assert.equal(env.run('db.bills[0].cashierId'), SERVER_OWNER);
  assert.equal(env.run('db.shifts[0].openedById'), SERVER_OWNER);
  assert.equal(env.run('db.activeUser.id'), SERVER_OWNER);
  assert.equal(env.run('db.syncQueue[0].by'), SERVER_OWNER);
});

test('บั๊กเดิม (เครื่องที่ตั้งเจ้าของไปแล้ว): ซิงค์เจอเจ้าของบนเซิร์ฟเวอร์ id ต่างกัน → ปรับ id ในเครื่องให้ตรง ไม่สร้างเจ้าของซ้ำ ซิงค์สำเร็จ', async () => {
  const { env, fake } = setup();                 // เซิร์ฟเวอร์มีเจ้าของ id = SERVER_OWNER, เครื่องใช้ 'owner-local'
  const ok = await env.ctx.window.syncProductsToSupabase(true);
  assert.equal(ok, true, 'ซิงค์ต้องสำเร็จ');
  const userUpsert = fake.log.upserts.find((u) => u.table === 'app_users');
  assert.equal(userUpsert.rows.length, 1);
  assert.equal(userUpsert.rows[0].id, SERVER_OWNER, 'ต้องส่งด้วย id ของเจ้าของที่มีอยู่แล้ว');
  assert.equal(fake.appUsers.length, 1, 'บนเซิร์ฟเวอร์ต้องมีเจ้าของคนเดียว');
  assert.equal(env.run('db.users[0].id'), SERVER_OWNER);
  assert.equal(env.run('db.bills[0].cashierId'), SERVER_OWNER);
});

test('ซิงค์ซ้ำหลังปรับแล้ว: ไม่เปลี่ยนอะไรอีก (idempotent)', async () => {
  const { env } = setup();
  assert.equal(await env.ctx.window.reconcileOwnerId(env.ctx.window.getSupabaseClient()), true);
  assert.equal(await env.ctx.window.reconcileOwnerId(env.ctx.window.getSupabaseClient()), false);
});

test('เซิร์ฟเวอร์ยังไม่มีเจ้าของ / อ่านไม่ได้: ไม่แตะ id ในเครื่อง', async () => {
  const { env } = setup({ serverOwnerId: null });
  assert.equal(await env.ctx.window.reconcileOwnerId(env.ctx.window.getSupabaseClient()), false);
  assert.equal(env.run('db.users[0].id'), 'owner-local');
});

test('describeError: รวมข้อความ รายละเอียด คำแนะนำ และรหัส', () => {
  const { env } = setup();
  const d = env.ctx.window.describeError;
  assert.equal(d({ message: 'duplicate key', details: 'Key exists', hint: 'ลองใหม่', code: '23505' }), 'duplicate key\nKey exists\nลองใหม่\nรหัส 23505');
  assert.equal(d(new Error('boom')), 'boom');
  assert.equal(d('ข้อความล้วน'), 'ข้อความล้วน');
  assert.equal(d(null), 'ไม่ทราบสาเหตุ');
});

test('ปุ่มซิงค์: เมื่อล้ม ต้องแสดง "สาเหตุจริง" (ชื่อ constraint/รหัส) ไม่ใช่ข้อความทั่วๆ ไปอย่างเดียว', async () => {
  const { env } = setup({ failTable: 'categories', failError: { message: 'permission denied for table categories', code: '42501', hint: 'ตรวจ RLS' } });
  env.run("db.categories = [{ id: 'c1', name: 'หมวด' }]");
  const alerts = [];
  env.ctx.window.showAlert = (t, m) => alerts.push(t + ' | ' + m);
  await env.ctx.window.forceSyncNow();
  assert.equal(alerts.length, 1, 'ต้องมีกล่องแจ้งเตือนเดียว (ไม่ถูกทับด้วยอีกกล่อง)');
  assert.match(alerts[0], /ซิงค์สินค้า\/หมวดหมู่\/ลูกค้า\/พนักงานไม่สำเร็จ/);
  assert.match(alerts[0], /permission denied for table categories/);
  assert.match(alerts[0], /รหัส 42501/);
  assert.match(alerts[0], /ตรวจ RLS/);
});
