/* =============================================================================
 * js/sync/client.js
 * ตั้งค่าและสร้าง Supabase client (URL/anon key เก็บในเครื่อง, session เก็บใน IndexedDB), ป้ายสถานะการเชื่อมต่อ
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * getConfiguredSupabaseUrl, getConfiguredSupabaseAnonKey, getSupabaseClient,
 * updateSupabaseBadge, saveSupabaseConfig, describeError
 * ============================================================================= */

// ==========================================
// SUPABASE HELPER FUNCTIONS & IMPLEMENTATION
// ==========================================
window.getConfiguredSupabaseUrl = function() {
  return localStorage.getItem('pos_supabase_url') || "";
};

window.getConfiguredSupabaseAnonKey = function() {
  return localStorage.getItem('pos_supabase_anon_key') || "";
};

let _supabaseClient = null;
window.getSupabaseClient = function() {
  if (_supabaseClient) return _supabaseClient;
  const url = window.getConfiguredSupabaseUrl();
  const key = window.getConfiguredSupabaseAnonKey();
  if (!url || !key) return null;
  if (typeof window.supabase !== 'undefined' && window.supabase.createClient) {
    _supabaseClient = window.supabase.createClient(url, key, { auth: { storage: window.posStore.authStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  }
  return _supabaseClient;
};

window.updateSupabaseBadge = function(isSynced) {
  const badge = document.getElementById('supabase-sync-badge');
  if (badge) {
    badge.innerText = isSynced ? "🟢 เชื่อมต่อ Supabase SQL" : "🔴 ขัดแย้ง/ออฟไลน์";
  }
};

window.saveSupabaseConfig = function() {
  const urlEl = document.getElementById('set-supabase-url');
  const keyEl = document.getElementById('set-supabase-key');
  const url = urlEl ? urlEl.value.trim() : '';
  const key = keyEl ? keyEl.value.trim() : '';

  if (!url || !key) {
    window.showAlert("ข้อมูลไม่ครบ", "กรุณากรอกทั้ง Project URL และ anon public key", true);
    return;
  }

  localStorage.setItem('pos_supabase_url', url);
  localStorage.setItem('pos_supabase_anon_key', key);
  _supabaseClient = null;

  window.showToast("บันทึกการเชื่อมต่อ Supabase เรียบร้อย");
  window.refreshAuthStatus();
};

// แปลง error (ของ Supabase หรือทั่วไป) เป็นข้อความที่อ่านเข้าใจ: ข้อความหลัก · รายละเอียด · คำแนะนำ · รหัส
// ใช้แสดงในกล่องแจ้งเตือนแทนข้อความทั่วๆ ไป เพื่อให้รู้สาเหตุจริงทันที
window.describeError = function(e) {
  if (!e) return 'ไม่ทราบสาเหตุ';
  const parts = [e.message || (typeof e === 'string' ? e : ''), e.details, e.hint, e.code ? 'รหัส ' + e.code : ''];
  const out = parts.filter(Boolean).join('\n');
  return out || String(e);
};
