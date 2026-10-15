/* =============================================================================
 * js/ui/common.js
 * ตัวช่วยหน้าจอกลาง: สแกนบาร์โค้ดด้วยกล้อง, เปิด/ปิด modal, แจ้งเตือน, toast, นาฬิกา
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * startCameraScan, _scanTargetId, stopCameraScan, closeModal, closeCustomAlert, showAlert,
 * showToast
 * ============================================================================= */

// CAMERA SCANNER
// Generalized to scan into any target input (defaults to the sale-page search box) —
// reused by the product form's barcode field for fast entry instead of typing by hand.
window.startCameraScan = function(targetInputId) {
  window._scanTargetId = targetInputId || 'search-product';
  document.getElementById('modal-camera').classList.remove('hidden');
  document.getElementById('modal-camera').classList.add('flex');
  if (!scanner) scanner = new Html5Qrcode("reader");
  scanner.start({ facingMode: "environment" }, { fps: 15, qrbox: 250 }, (text) => {
    window.stopCameraScan();
    const targetId = window._scanTargetId || 'search-product';
    const target = document.getElementById(targetId);
    if (target) target.value = text;
    if (targetId === 'search-product') {
      window.onSearchInput({ target: { value: text } });
    }
  }).catch(() => window.stopCameraScan());
};

window.stopCameraScan = function() {
  if (scanner) scanner.stop().catch(() => {});
  document.getElementById('modal-camera').classList.add('hidden');
};

window.closeModal = function(id) { 
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('hidden'); 
};

window.closeCustomAlert = function() { 
  document.getElementById('custom-alert-modal').classList.add('hidden'); 
};

window.showAlert = function(title, desc, isError = false) {
  document.getElementById('custom-alert-title').innerText = title;
  document.getElementById('custom-alert-desc').innerText = desc;
  document.getElementById('custom-alert-modal').classList.remove('hidden');
  document.getElementById('custom-alert-modal').classList.add('flex');
};

window.showToast = function(msg) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-message').innerText = msg;
  toast.style.transform = 'translateY(0)';
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.transform = 'translateY(-100px)'; toast.style.opacity = '0'; }, 2500);
};

setInterval(() => {
  const clock = document.getElementById('clock');
  if (clock) clock.innerText = new Date().toLocaleTimeString('th-TH');
}, 1000);

window.addEventListener('DOMContentLoaded', () => {
  window.renderSaleHome?.();
  window.refreshAuthStatus?.();
  // BUG FIX: syncCategoryBarOffset() used to only run on window 'resize', never on
  // initial load — the category bar and pagination bar (both position:sticky, set via
  // inline style.top computed here) never got a starting `top` value. Without it the two
  // bars can end up stacked on top of each other at the same position, with the
  // higher z-index category bar sitting over the pagination bar's ‹ › buttons and
  // silently swallowing every tap on them ("ปุ่มเปลี่ยนหน้าไม่ทำงาน/ล็อก"). Running it once
  // here (and again after every category/page render, below) keeps the offsets correct
  // from the very first paint.
  setTimeout(() => window.syncCategoryBarOffset?.(), 0);
});
