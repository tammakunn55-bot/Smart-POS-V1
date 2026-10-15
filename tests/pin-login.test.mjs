// ทดสอบ Edge Function pin-login (handler.ts / pin.ts) ด้วย Node — deps จำลองแทน Supabase Admin API
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { handle, MAX_ATTEMPTS } from '../supabase/functions/pin-login/handler.ts';
import { verifyPin } from '../supabase/functions/pin-login/pin.ts';

const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
async function pbkdf2Hash(pin, iter = 1000) {   // รูปแบบเดียวกับที่ public/index.html สร้าง (ลดรอบเพื่อให้เทสต์เร็ว)
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${iter}$${hex(salt)}$${hex(new Uint8Array(bits))}`;
}
const sha256Hex = async (pin) => hex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(pin))));

const UID = '11111111-2222-3333-4444-555555555555';

async function makeDeps(userOver = {}) {
  const state = {
    user: { id: UID, name: 'สมชาย', pin: await pbkdf2Hash('4821'), role: 'CASHIER', is_active: true, auth_user_id: null, login_email: null, failed_pin_attempts: 0, locked_until: null, ...userOver },
    created: [], tokens: [], updates: [], now: Date.parse('2026-10-10T08:00:00Z'), authEmails: { 'auth-owner': 'owner@shop.com' }
  };
  const deps = {
    now: () => state.now,
    staffEmailDomain: 'staff.pos.invalid',
    getAppUser: async (id) => (state.user && id === state.user.id ? { ...state.user } : null),
    updateAppUser: async (id, patch) => { state.updates.push(patch); Object.assign(state.user, patch); },
    getAuthEmail: async (aid) => state.authEmails[aid] ?? null,
    createAuthUser: async (email, password, appUserId) => { state.created.push({ email, password, appUserId }); return 'auth-new-1'; },
    generateToken: async (email) => { state.tokens.push(email); return 'hash-for-' + email; },
    randomPassword: () => 'random-pw'
  };
  return { state, deps };
}
const call = (deps, body, method = 'POST') => handle(new Request('http://x/pin-login', { method, body: method === 'POST' ? JSON.stringify(body) : undefined }), deps);

test('verifyPin: PBKDF2 / SHA-256 รุ่นเก่า / รูปแบบที่ไม่รู้จัก / จำกัดจำนวนรอบ', async () => {
  assert.equal(await verifyPin('4821', await pbkdf2Hash('4821')), true);
  assert.equal(await verifyPin('4822', await pbkdf2Hash('4821')), false);
  assert.equal(await verifyPin('7391', await sha256Hex('7391')), true);
  assert.equal(await verifyPin('7392', await sha256Hex('7391')), false);
  assert.equal(await verifyPin('1234', 'abc'), false);
  assert.equal(await verifyPin('1234', ''), false);
  assert.equal(await verifyPin('1234', 'pbkdf2$99999999$aa$' + 'b'.repeat(64)), false, 'รอบมากเกินไป = ปฏิเสธ (กันถูกใช้โจมตี CPU)');
});

test('คำขอไม่ถูกต้อง / method อื่น / CORS', async () => {
  const { deps } = await makeDeps();
  assert.equal((await call(deps, { user_id: 'nope', pin: '4821' })).status, 400);
  assert.equal((await call(deps, { user_id: UID, pin: 'abcd' })).status, 400);
  assert.equal((await call(deps, { user_id: UID, pin: '123' })).status, 400);
  assert.equal((await call(deps, null, 'GET')).status, 405);
  const o = await call(deps, null, 'OPTIONS');
  assert.equal(o.status, 200);
  assert.equal(o.headers.get('Access-Control-Allow-Origin'), '*');
});

test('PIN ถูก (พนักงานใหม่): สร้าง auth user ครั้งแรก ผูกกับ app_users แล้วคืน token_hash', async () => {
  const { state, deps } = await makeDeps();
  const r = await call(deps, { user_id: UID, pin: '4821' });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.user.role, 'CASHIER');
  assert.equal(b.email, `staff-${UID}@staff.pos.invalid`);
  assert.equal(b.token_hash, 'hash-for-' + b.email);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].appUserId, UID);
  assert.equal(state.user.auth_user_id, 'auth-new-1');
  assert.equal(state.user.login_email, b.email);
  // ล็อกอินครั้งที่สอง: ใช้บัญชีเดิม ไม่สร้างซ้ำ
  const r2 = await call(deps, { user_id: UID, pin: '4821' });
  assert.equal(r2.status, 200);
  assert.equal(state.created.length, 1);
});

test('เจ้าของที่มีบัญชีอีเมลจริงอยู่แล้ว: ใช้อีเมลนั้น ไม่สร้างบัญชีใหม่', async () => {
  const { state, deps } = await makeDeps({ role: 'OWNER', auth_user_id: 'auth-owner', login_email: null });
  const r = await call(deps, { user_id: UID, pin: '4821' });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.email, 'owner@shop.com');
  assert.equal(b.user.role, 'OWNER');
  assert.equal(state.created.length, 0);
});

test('PIN ผิด: นับครั้ง, ครบ 5 ครั้งถูกพัก, ระหว่างพักแม้ PIN ถูกก็เข้าไม่ได้, หมดเวลาแล้วเข้าได้และล้างตัวนับ', async () => {
  const { state, deps } = await makeDeps();
  let last;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    last = await call(deps, { user_id: UID, pin: '0000' });
    assert.equal(last.status, 401);
  }
  assert.equal((await last.json()).attempts_left, 0);
  assert.ok(state.user.locked_until);
  const locked = await call(deps, { user_id: UID, pin: '4821' });      // PIN ถูก แต่ถูกพัก
  assert.equal(locked.status, 429);
  assert.ok((await locked.json()).retry_after_s > 0);
  state.now += 31_000;                                                 // พัก 30 วินาทีแรกผ่านไป
  const ok = await call(deps, { user_id: UID, pin: '4821' });
  assert.equal(ok.status, 200);
  assert.equal(state.user.failed_pin_attempts, 0);
  assert.equal(state.user.locked_until, null);
});

test('ผิดซ้ำหลังพัก: เวลาพักเพิ่มเป็นสองเท่า (สูงสุด 15 นาที)', async () => {
  const { state, deps } = await makeDeps({ failed_pin_attempts: 5, locked_until: null });
  await call(deps, { user_id: UID, pin: '0000' });                     // ครั้งที่ 6 → 60 วินาที
  assert.equal(Date.parse(state.user.locked_until) - state.now, 60_000);
  state.user.locked_until = null; state.user.failed_pin_attempts = 20;
  await call(deps, { user_id: UID, pin: '0000' });
  assert.equal(Date.parse(state.user.locked_until) - state.now, 15 * 60_000);
});

test('พนักงานที่ถูกปิดใช้งาน / ไม่มีผู้ใช้: ตอบเหมือนกัน (ไม่เผยว่ามีหรือไม่)', async () => {
  const { deps } = await makeDeps({ is_active: false });
  const a = await call(deps, { user_id: UID, pin: '4821' });
  const b = await call(deps, { user_id: '99999999-2222-3333-4444-555555555555', pin: '4821' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json());
});

test('รองรับ PIN แบบ SHA-256 รุ่นเก่า (ยังไม่ได้อัปเกรด)', async () => {
  const { deps } = await makeDeps({ pin: await sha256Hex('7391') });
  assert.equal((await call(deps, { user_id: UID, pin: '7391' })).status, 200);
  assert.equal((await call(deps, { user_id: UID, pin: '7392' })).status, 401);
});
