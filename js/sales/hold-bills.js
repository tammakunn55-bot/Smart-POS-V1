/* =============================================================================
 * js/sales/hold-bills.js
 * พักบิล / เรียกบิลที่พักกลับมา
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * holdCurrentBill, cart, renderHeldBillsCount, openHeldBillsModal, renderHeldBillsList,
 * resumeHeldBill, deleteHeldBill
 * ============================================================================= */

// ============================================================
// พักบิล (HOLD / PARK SALE) — เก็บตะกร้าปัจจุบันไว้ชั่วคราว แล้วเริ่มขายลูกค้ารายใหม่ได้
// ทันทีโดยไม่ต้องยกเลิกบิลที่กำลังทำอยู่ (เช่น ลูกค้าลืมกระเป๋าเงินไว้ในรถ, รอเช็คของเพิ่ม)
// เก็บเป็น local-only ในเครื่อง ไม่ sync ขึ้น Supabase เพราะยังไม่ใช่ธุรกรรมขายจริง
// ============================================================
window.holdCurrentBill = function() {
  if (!cart.length) return window.showAlert?.('ตะกร้าว่าง', 'ไม่มีสินค้าในตะกร้าให้พัก', true);
  db.heldBills = db.heldBills || [];
  db.heldBills.push({
    id: 'HOLD-' + Date.now(),
    time: Date.now(),
    cart: cart.map(i => ({ ...i })),
    customerId: document.getElementById('pay-customer-select')?.value || 'GENERAL',
    discountInput: document.getElementById('cart-discount-input')?.value || '',
    discountType: document.getElementById('cart-discount-type')?.value || 'BAHT',
    payMethod: activePayMethod,
    label: (document.getElementById('pay-customer-select')?.selectedOptions?.[0]?.textContent || 'ลูกค้าทั่วไป').trim()
  });
  cart = [];
  window.cart = cart;
  window.persist?.();
  window.updateCartUI?.();
  window.closeModal('modal-cart');
  window.renderHeldBillsCount();
  window.showToast?.('พักบิลไว้แล้ว — เริ่มขายบิลใหม่ได้เลย');
};

window.renderHeldBillsCount = function() {
  const n = (db.heldBills || []).length;
  const el = document.getElementById('held-bills-count');
  if (!el) return;
  el.textContent = n;
  el.classList.toggle('hidden', n === 0);
};

window.openHeldBillsModal = function() {
  window.renderHeldBillsList();
  const m = document.getElementById('modal-held-bills');
  m.classList.remove('hidden'); m.classList.add('flex');
};

window.renderHeldBillsList = function() {
  const list = document.getElementById('held-bills-list');
  if (!list) return;
  const held = (db.heldBills || []).slice().reverse();
  list.innerHTML = held.length ? held.map(h => {
    const total = h.cart.reduce((s, i) => s + (i.qty * i.price), 0);
    const itemsLabel = h.cart.map(i => `${escapeHTML(i.name)} ×${i.qty}`).join(', ');
    return `
          <div class="bg-slate-50 border rounded-xl p-3 text-xs">
            <div class="flex justify-between font-bold text-slate-800">
              <span>${escapeHTML(h.label)}</span><span class="text-indigo-600">${formatMoney(total)}</span>
            </div>
            <div class="text-[10px] text-slate-400 mt-0.5">${new Date(h.time).toLocaleString('th-TH')} • ${h.cart.length} รายการ</div>
            <div class="text-[10px] text-slate-500 mt-1 line-clamp-2">${itemsLabel}</div>
            <div class="flex gap-2 mt-2">
              <button onclick="window.resumeHeldBill('${h.id}')" class="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold btn-touch">↩️ เรียกคืน</button>
              <button onclick="window.deleteHeldBill('${h.id}')" class="px-3 py-2 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg font-bold btn-touch">🗑️</button>
            </div>
          </div>`;
  }).join('') : `<p class="text-center text-slate-400 font-bold py-8">ยังไม่มีบิลที่พักไว้</p>`;
};

window.resumeHeldBill = function(id) {
  const held = db.heldBills || [];
  const idx = held.findIndex(h => h.id === id);
  if (idx === -1) return;
  const h = held[idx];
  // ถ้าตะกร้าปัจจุบันมีของค้างอยู่ พักของเดิมไว้ก่อนสลับ กันข้อมูลหาย
  if (cart.length) window.holdCurrentBill();
  cart = h.cart.map(i => ({ ...i }));
  window.cart = cart;
  held.splice(idx, 1);
  window.persist?.();
  window.renderHeldBillsCount();
  window.closeModal('modal-held-bills');
  window.openCartModal();
  setTimeout(() => {
    const sel = document.getElementById('pay-customer-select');
    if (sel) sel.value = h.customerId;
    const di = document.getElementById('cart-discount-input');
    if (di) di.value = h.discountInput;
    const dt = document.getElementById('cart-discount-type');
    if (dt) dt.value = h.discountType;
    window.switchPayTab?.(h.payMethod || 'CASH');
    window.updateCartTotals?.();
  }, 0);
  window.showToast?.('เรียกบิลที่พักไว้กลับมาแล้ว');
};

window.deleteHeldBill = function(id) {
  if (!confirm('ลบบิลที่พักไว้? สินค้าในบิลนี้จะหายไป ต้องเริ่มเพิ่มใหม่ถ้าต้องการ')) return;
  db.heldBills = (db.heldBills || []).filter(h => h.id !== id);
  window.persist?.();
  window.renderHeldBillsCount();
  window.renderHeldBillsList();
};

document.addEventListener('DOMContentLoaded', () => { db.heldBills = db.heldBills || []; window.renderHeldBillsCount(); });
