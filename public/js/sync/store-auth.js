/* =============================================================================
 * js/sync/store-auth.js
 * ล็อกอินระดับร้าน (อีเมล/รหัสผ่านเจ้าของ), ตั้งเจ้าของร้านคนแรก, สถานะการล็อกอิน
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * storeSignUp, storeSignIn, checkAndBootstrapOwner, confirmBootstrapOwner, storeSignOut,
 * refreshAuthStatus
 * ============================================================================= */

// ==========================================
// STORE-LEVEL SUPABASE AUTH (Tier 1 of the login design)
// ==========================================
// The anon key alone only grants Postgres the `anon` role. Every RLS policy in the
// schema is `TO authenticated`, so without an actual signed-in session, every read/write
// to Supabase is silently rejected — this is what makes signing in mandatory, not optional.
// Cashiers still just use a 4-digit PIN (see the employee login screen below); only the
// store owner needs this real email/password account, and only once per device (the
// Supabase JS client persists the session in localStorage and auto-refreshes it).
// เพิ่มขึ้นมา: เดิมมีแค่ storeSignIn (signInWithPassword) ซึ่งใช้ได้เฉพาะกับบัญชีที่มีอยู่แล้ว
// เท่านั้น — ร้านที่เพิ่งเริ่มใช้แอปนี้ครั้งแรกไม่มีทางสร้างบัญชีแรกได้เลยจากในแอป (ต้องไปสร้าง
// เองใน Supabase Dashboard ซึ่งไม่มีเอกสารบอกไว้ที่ไหนเลย) ฟังก์ชันนี้ปิดช่องโหว่นั้น
window.storeSignUp = async function() {
  const client = window.getSupabaseClient();
  if (!client) return window.showAlert("ยังไม่ได้ตั้งค่า", "กรุณากรอก Project URL และ anon key แล้วบันทึกก่อน", true);
  const email = document.getElementById('store-auth-email').value.trim();
  const password = document.getElementById('store-auth-password').value;
  if (!email || !password) return window.showAlert("ข้อมูลไม่ครบ", "กรุณากรอกอีเมลและรหัสผ่าน", true);
  if (password.length < 6) return window.showAlert("รหัสผ่านสั้นเกินไป", "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร", true);
  try {
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    document.getElementById('store-auth-password').value = '';
    if (data.session) {
      // โปรเจกต์ที่ปิดการยืนยันอีเมลไว้ — ล็อกอินได้ทันทีหลังสมัคร ไปต่อ bootstrap ได้เลย
      window.showToast("สมัครบัญชีสำเร็จ — เข้าสู่ระบบให้อัตโนมัติ");
      await window.refreshAuthStatus();
      await window.checkAndBootstrapOwner?.();
      window.forceSyncNow?.();
    } else {
      // ค่าเริ่มต้นของ Supabase คือต้องกดยืนยันอีเมลก่อนถึงจะมี session — แจ้งให้ชัดเจน
      // กันคนงงว่าทำไมสมัครแล้วแต่ยังเข้าระบบไม่ได้ทันที
      window.showAlert("สมัครบัญชีสำเร็จ", "กรุณาตรวจอีเมล " + email + " แล้วกดลิงก์ยืนยันตัวตนก่อน จากนั้นค่อยกลับมา \"เข้าสู่ระบบร้านค้า\" อีกครั้ง (ถ้าอีเมลไม่มาภายในไม่กี่นาที เช็คโฟลเดอร์สแปมด้วย)", false);
    }
  } catch (err) {
    window.showAlert("สมัครบัญชีไม่สำเร็จ", err.message || String(err), true);
  }
};

window.storeSignIn = async function() {
  const client = window.getSupabaseClient();
  if (!client) return window.showAlert("ยังไม่ได้ตั้งค่า", "กรุณากรอก Project URL และ anon key แล้วบันทึกก่อน", true);
  const email = document.getElementById('store-auth-email').value.trim();
  const password = document.getElementById('store-auth-password').value;
  if (!email || !password) return window.showAlert("ข้อมูลไม่ครบ", "กรุณากรอกอีเมลและรหัสผ่าน", true);
  try {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    document.getElementById('store-auth-password').value = '';
    window.showToast("เข้าสู่ระบบร้านค้าสำเร็จ");
    await window.refreshAuthStatus();
    await window.checkAndBootstrapOwner?.();
    window.forceSyncNow?.();
  } catch (err) {
    window.showAlert("เข้าสู่ระบบไม่สำเร็จ", err.message || "อีเมลหรือรหัสผ่านไม่ถูกต้อง", true);
  }
};

// First-time setup: this schema ties OWNER/MANAGER-level database permissions
// (is_owner()/is_manager()) to app_users.auth_user_id matching the signed-in Supabase
// session — there is no owner account until bootstrap_first_owner() has been called once
// for this project. Safe to attempt on every sign-in: the RPC itself refuses (harmlessly)
// if an owner already exists, so this only ever prompts when one genuinely doesn't yet.
window.checkAndBootstrapOwner = async function() {
  const client = window.getSupabaseClient();
  if (!client) return;
  try {
    const { data: { session } } = await client.auth.getSession();
    if (!session?.user) return;
    const { data: existing } = await client.from('app_users').select('id').eq('auth_user_id', session.user.id).maybeSingle();
    if (existing) return; // already bootstrapped on a previous sign-in

    document.getElementById('bootstrap-owner-name').value = db.storeName || '';
    document.getElementById('bootstrap-owner-pin').value = '';
    document.getElementById('modal-bootstrap-owner').classList.remove('hidden');
    document.getElementById('modal-bootstrap-owner').classList.add('flex');
  } catch (e) {
    // RLS hides app_users entirely from a not-yet-bootstrapped session, so this SELECT
    // failing/returning nothing is expected and not itself an error worth surfacing.
  }
};

window.confirmBootstrapOwner = async function() {
  const client = window.getSupabaseClient();
  if (!client) return;
  const name = document.getElementById('bootstrap-owner-name').value.trim();
  const pin = document.getElementById('bootstrap-owner-pin').value.trim();
  if (!name) return window.showAlert("ข้อมูลไม่ครบ", "กรุณากรอกชื่อเจ้าของร้าน", true);
  if (!/^\d{4}$/.test(pin)) return window.showAlert("ข้อมูลไม่ถูกต้อง", "PIN ต้องเป็นตัวเลข 4 หลัก", true);
  try {
    const pinHash = await window.makePinHash(pin);
    const { data, error } = await client.rpc('bootstrap_first_owner', { p_name: name, p_pin: pinHash });
    if (error) throw error;

    // Mirror the new owner into the local PIN roster so the login screen on this device
    // includes them immediately, without waiting for a separate pull/sync round-trip.
    db.users = db.users || [];
    const localOwner = db.users.find(u => u.role === 'OWNER');
    if (localOwner) {
      localOwner.name = name;
      localOwner.pinHash = pinHash;
      delete localOwner.needsPinSetup;
      // ใช้ id เดียวกับแถวที่เซิร์ฟเวอร์เพิ่งสร้าง (ไม่งั้นซิงค์ครั้งแรกจะพยายามสร้างเจ้าของซ้ำแล้วล้ม)
      if (typeof data === 'string') window.adoptServerUserId(localOwner, data);
    } else {
      db.users.unshift({ id: (typeof data === 'string' ? data : 'owner-' + Date.now()), name, role: 'OWNER', permissions: ['ALL'], pinHash });
    }
    window.persist?.();
    window.renderEmployeeLoginScreen?.();

    window.closeModal('modal-bootstrap-owner');
    window.showToast(`ตั้งค่า "${name}" เป็นเจ้าของร้านสำเร็จ`);
  } catch (err) {
    if (String(err.message || '').includes('มี OWNER อยู่แล้ว')) {
      window.showAlert("มีเจ้าของร้านอยู่แล้ว", "ฐานข้อมูลนี้มีบัญชีเจ้าของร้านตั้งไว้แล้ว ถ้าต้องการสิทธิ์เต็ม กรุณาติดต่อเจ้าของร้านคนเดิม", true);
      window.closeModal('modal-bootstrap-owner');
    } else {
      window.showAlert("ตั้งค่าไม่สำเร็จ", err.message || String(err), true);
    }
  }
};

window.storeSignOut = async function() {
  const client = window.getSupabaseClient();
  if (!client) return;
  await client.auth.signOut();
  window.showToast("ออกจากระบบร้านค้าแล้ว");
  window.refreshAuthStatus();
};

window.refreshAuthStatus = async function() {
  const statusEl = document.getElementById('store-auth-status');
  const formEl = document.getElementById('store-auth-form');
  const signoutBtn = document.getElementById('store-auth-signout-btn');
  if (!statusEl) return;
  const client = window.getSupabaseClient();
  if (!client) {
    statusEl.className = 'p-3 rounded-xl border text-xs font-bold bg-slate-50 text-slate-500';
    statusEl.innerText = 'ยังไม่ได้เชื่อมต่อ Supabase (กรอก URL/Key ด้านบนก่อน)';
    formEl?.classList.remove('hidden');
    signoutBtn?.classList.add('hidden');
    window.updateSupabaseBadge(false);
    return;
  }
  try {
    const { data: { session } } = await client.auth.getSession();
    if (session?.user) {
      statusEl.className = 'p-3 rounded-xl border text-xs font-bold bg-emerald-50 border-emerald-200 text-emerald-700';
      statusEl.innerText = `✅ เข้าสู่ระบบแล้ว: ${session.user.email}`;
      formEl?.classList.add('hidden');
      signoutBtn?.classList.remove('hidden');
      window.updateSupabaseBadge(true);
    } else {
      statusEl.className = 'p-3 rounded-xl border text-xs font-bold bg-amber-50 border-amber-200 text-amber-700';
      statusEl.innerText = '⚠️ เชื่อมต่อฐานข้อมูลแล้ว แต่ยังไม่ได้เข้าสู่ระบบร้านค้า — การซิงค์จะไม่ทำงาน';
      formEl?.classList.remove('hidden');
      signoutBtn?.classList.add('hidden');
      window.updateSupabaseBadge(false);
    }
  } catch (err) {
    statusEl.className = 'p-3 rounded-xl border text-xs font-bold bg-rose-50 border-rose-200 text-rose-700';
    statusEl.innerText = '❌ ตรวจสอบสถานะไม่สำเร็จ: ' + (err.message || '');
  }
};
