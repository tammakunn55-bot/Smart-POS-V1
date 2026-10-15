/* =============================================================================
 * js/settings/master-settings.js
 * ศูนย์ตั้งค่า: เปิดหน้า/สลับแท็บ, บันทึกตั้งค่าร้านค้า
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * openMasterSettingsModal, openSupplierManagerModal, switchSettingsTab, saveStoreSettings
 * ============================================================================= */

window.openMasterSettingsModal = function(tabKey) {
  document.getElementById('set-store-name').value = db.storeName;
  document.getElementById('set-store-address').value = db.storeAddress;
  document.getElementById('set-promptpay').value = db.promptPayId;
  document.getElementById('set-tax-id').value = db.taxId || '';
  const _pn = document.getElementById('set-prevent-negative'); if (_pn) _pn.checked = !!(db.settings && db.settings.preventNegativeStock);
  const _pe = document.getElementById('set-per-employee-auth'); if (_pe) _pe.checked = !!(db.settings && db.settings.perEmployeeAuth);
  document.getElementById('set-supabase-url').value = window.getConfiguredSupabaseUrl();
  document.getElementById('set-supabase-key').value = window.getConfiguredSupabaseAnonKey();

  window.renderSettingsSuppliers();
  window.renderSettingsCustomers();
  window.renderUserManagerList?.();
  window.refreshAuthStatus?.();
  window.switchSettingsTab(tabKey || 'STORE');
  document.getElementById('modal-master-settings').classList.remove('hidden');
  document.getElementById('modal-master-settings').classList.add('flex');
};

// เดิม "จัดการซัพพลายเออร์" เปิดเป็นหน้าต่างลอยแยกต่างหาก (modal-supplier-manager)
// ทำให้ไม่เหมือนเมนูอื่น (ลูกค้า/พนักงาน) ที่จัดการอยู่ในหน้าต่างตั้งค่าเดิมทั้งหมด —
// ตอนนี้เปิดหน้าต่างตั้งค่าเดิมแล้วสลับไปแท็บซัพพลายเออร์แทน ให้พฤติกรรมตรงกันทุกเมนู
window.openSupplierManagerModal = function() { window.openMasterSettingsModal('SUPPLIERS'); };

window.switchSettingsTab = function(tabKey) {
  document.querySelectorAll('.settings-tab-btn').forEach(btn => btn.classList.remove('active'));
  const tabBtn = document.getElementById(`set-tab-${tabKey}`);
  if (tabBtn) tabBtn.classList.add('active');

  document.querySelectorAll('#modal-master-settings [id^="set-panel-"]').forEach(panel => panel.classList.add('hidden'));
  const panelEl = document.getElementById(`set-panel-${tabKey}`);
  if (panelEl) panelEl.classList.remove('hidden');
};

window.saveStoreSettings = function() {
  db.storeName = document.getElementById('set-store-name').value.trim();
  db.storeAddress = document.getElementById('set-store-address').value.trim();
  db.promptPayId = document.getElementById('set-promptpay').value.trim();
  db.taxId = document.getElementById('set-tax-id').value.trim();
  db.settings = db.settings || {};
  db.settings.preventNegativeStock = !!document.getElementById('set-prevent-negative')?.checked;
  db.settings.perEmployeeAuth = !!document.getElementById('set-per-employee-auth')?.checked;
  document.getElementById('store-name-title').innerText = db.storeName;
  window.persist?.();
  window.showToast?.("บันทึกข้อมูลร้านค้าเรียบร้อยแล้ว");
};
