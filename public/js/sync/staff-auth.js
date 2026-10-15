/* =============================================================================
 * js/sync/staff-auth.js
 * ล็อกอินรายพนักงานบนเซิร์ฟเวอร์ (เรียก Edge Function pin-login), สิทธิ์ส่งคิวตามบทบาท
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * _serverUser, isPerEmployeeAuth, serverIsManager, canFlushOp, serverLoginWithPin,
 * resolveServerUser, afterLocalLogin, serverLogoutLocal, lockPOS, refreshAuthStatus
 * ============================================================================= */


// ============================================================================
// v11 — ล็อกอินรายพนักงาน (per-employee Supabase session)
// เปิดใช้ที่ ตั้งค่า > ร้านค้า > "ใช้บัญชีรายพนักงานบนเซิร์ฟเวอร์" (db.settings.perEmployeeAuth) — ปิดอยู่ = ทำงานแบบ v10 เดิม
// เมื่อเปิด: ใส่ PIN ถูก (ตรวจในเครื่องก่อน เพื่อให้ออฟไลน์ใช้ได้) → ถ้าออนไลน์เรียก Edge Function `pin-login`
// ตรวจ PIN ซ้ำฝั่งเซิร์ฟเวอร์ → ได้ session ของ "พนักงานคนนั้น" → RLS/สิทธิ์บนฐานข้อมูลมีผลรายคน
// ============================================================================
(function () {
  'use strict';
  const client = () => (window.getSupabaseClient ? window.getSupabaseClient() : null);
  const MANAGER_ROLES = ['OWNER', 'MANAGER'];
  const MANAGER_ONLY_OPS = [];   // นโยบาย: ทุกคนทำได้ทุกอย่างเท่ากัน
  const isNet = (e) => /Failed to fetch|NetworkError|Network request failed|Load failed|timeout|ERR_INTERNET/i.test(String((e && e.message) || e || '')) ||
    (typeof navigator !== 'undefined' && navigator.onLine === false);

  window._serverUser = null;           // { appUserId, role, name } ของ session ที่ใช้อยู่จริงบนเซิร์ฟเวอร์
  let pendingLogin = null;             // { userId, pin, at } เก็บในหน่วยความจำเท่านั้น (ไม่เขียนลงดิสก์) เพื่อลองใหม่เมื่อกลับมาออนไลน์

  window.isPerEmployeeAuth = function () { return !!(window.db && db.settings && db.settings.perEmployeeAuth); };
  window.serverIsManager = function () {
    if (!window.isPerEmployeeAuth()) return true;                 // โหมดเดิม: เครื่องใช้บัญชีเจ้าของร้านอยู่แล้ว
    return !!window._serverUser;   // ทุกบัญชีที่ล็อกอินบนเซิร์ฟเวอร์ได้สิทธิ์เท่ากัน
  };

  // รายการในคิวนี้ session ปัจจุบันส่งได้ไหม
  //  - ผู้จัดการ/เจ้าของ: ส่งได้ทุกรายการ
  //  - แคชเชียร์: ส่งได้เฉพาะรายการที่ตัวเองสร้าง และไม่ใช่งานของผู้จัดการ (ปรับสต็อก/รับของ/ลบ)
  window.canFlushOp = function (op) {
    if (!window.isPerEmployeeAuth()) return true;
    const su = window._serverUser;
    if (!su) return false;
    return true;   // ทุกคนส่งรายการในคิวได้ทุกรายการ
    if (MANAGER_ONLY_OPS.includes(op.type)) return false;
    return !op.by || toUUID(op.by) === su.appUserId;
  };

  async function readErrorBody(error) {
    try { const c = error && error.context; if (c && typeof c.json === 'function') return await c.json(); } catch (e) { /* ignore */ }
    return null;
  }

  // ---------- ล็อกอินฝั่งเซิร์ฟเวอร์ด้วย PIN ----------
  window.serverLoginWithPin = async function (user, pin) {
    const c = client();
    if (!c) return { status: 'no_client' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { status: 'offline' };
    try {
      const { data, error } = await c.functions.invoke('pin-login', { body: { user_id: toUUID(user.id), pin: String(pin) } });
      if (error) {
        const body = await readErrorBody(error);
        if (body && body.error) return { status: body.error, retryAfter: body.retry_after_s, attemptsLeft: body.attempts_left };
        return { status: isNet(error) ? 'offline' : 'error', message: error.message };
      }
      const { error: vErr } = await c.auth.verifyOtp({ token_hash: data.token_hash, type: 'magiclink' });
      if (vErr) return { status: 'error', message: vErr.message };
      window._serverUser = { appUserId: data.user.id, role: data.user.role, name: data.user.name };
      return { status: 'ok' };
    } catch (e) {
      return { status: isNet(e) ? 'offline' : 'error', message: String((e && e.message) || e) };
    }
  };

  // session ที่มีอยู่แล้ว (เช่นเจ้าของล็อกอินด้วยอีเมล/รหัสผ่านตอนตั้งค่า) → หาว่าเป็น app_user คนไหน
  window.resolveServerUser = async function () {
    const c = client();
    if (!c) return null;
    try {
      const s = await c.auth.getSession();
      if (!(s && s.data && s.data.session)) { window._serverUser = null; return null; }
      const { data } = await c.from('app_users').select('id,name,role').eq('auth_user_id', s.data.session.user.id).maybeSingle();
      window._serverUser = data ? { appUserId: data.id, role: data.role, name: data.name } : null;
      return window._serverUser;
    } catch (e) { return window._serverUser; }
  };

  // เรียกหลังใส่ PIN ถูกในเครื่อง (ไม่บล็อกหน้าจอ)
  window.afterLocalLogin = async function (user, pin) {
    window._serverUser = null; pendingLogin = null;
    if (!window.isPerEmployeeAuth()) return;
    const r = await window.serverLoginWithPin(user, pin);
    if (r.status === 'ok') {
      window.showToast && window.showToast('เชื่อมต่อเซิร์ฟเวอร์ในนาม ' + user.name);
      window.refreshSyncBadge && window.refreshSyncBadge();
      if (window.flushSyncQueue) await window.flushSyncQueue(true);
    } else if (r.status === 'offline' || r.status === 'no_client') {
      pendingLogin = { userId: user.id, pin: String(pin), at: Date.now() };   // ลองใหม่เมื่อกลับมาออนไลน์ (เก็บในหน่วยความจำ ไม่เขียนดิสก์)
    } else if (r.status === 'locked') {
      window.showAlert && window.showAlert('บัญชีถูกพักชั่วคราว', `ใส่ PIN ผิดหลายครั้งบนเซิร์ฟเวอร์ — ลองใหม่ได้ในอีก ${r.retryAfter || '?'} วินาที (หรือให้ผู้จัดการปลดล็อก) ใช้งานในเครื่องได้ตามปกติ แต่ข้อมูลจะยังไม่ถูกส่งขึ้นคลาวด์`, true);
    } else if (r.status === 'invalid_credentials') {
      window.showAlert && window.showAlert('PIN ยังไม่ตรงกับเซิร์ฟเวอร์', 'ในเครื่องนี้ PIN ถูกต้อง แต่เซิร์ฟเวอร์ไม่รู้จัก PIN นี้ (อาจเพิ่งเปลี่ยน/เพิ่มพนักงาน ให้ผู้จัดการกดซิงค์ก่อน) — ใช้งานในเครื่องได้ แต่ข้อมูลจะยังไม่ถูกส่งขึ้นคลาวด์', true);
    } else {
      window.showAlert && window.showAlert('เชื่อมต่อบัญชีพนักงานไม่สำเร็จ', r.message || r.status, true);
    }
  };

  window.serverLogoutLocal = async function () {
    window._serverUser = null; pendingLogin = null;
    const c = client();
    if (c && window.isPerEmployeeAuth()) { try { await c.auth.signOut({ scope: 'local' }); } catch (e) { /* ignore */ } }
  };

  window.addEventListener('online', async () => {
    if (!pendingLogin || !window.isPerEmployeeAuth()) return;
    if (Date.now() - pendingLogin.at > 12 * 3600 * 1000) { pendingLogin = null; return; }
    const u = (db.users || []).find((x) => x.id === pendingLogin.userId);
    if (!u || !db.activeUser || db.activeUser.id !== u.id) { pendingLogin = null; return; }
    const r = await window.serverLoginWithPin(u, pendingLogin.pin);
    if (r.status === 'ok') { pendingLogin = null; if (window.flushSyncQueue) window.flushSyncQueue(true); }
  });

  // ล็อกเครื่อง → ตัด session ของพนักงานคนนั้นทิ้ง (คนถัดไปต้องใส่ PIN ของตัวเอง)
  const origLock = window.lockPOS;
  if (typeof origLock === 'function') {
    window.lockPOS = function () { const r = origLock.apply(this, arguments); window.serverLogoutLocal(); return r; };
  }

  // หลังตรวจสถานะล็อกอินร้านค้า (เจ้าของใช้อีเมล/รหัสผ่านตอนตั้งค่าเครื่อง) ให้รู้ว่าใครคือ session นี้
  const origRefresh = window.refreshAuthStatus;
  if (typeof origRefresh === 'function') {
    window.refreshAuthStatus = async function () {
      const r = await origRefresh.apply(this, arguments);
      if (window.isPerEmployeeAuth() && !window._serverUser) await window.resolveServerUser();
      return r;
    };
  }
})();
