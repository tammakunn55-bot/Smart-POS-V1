/* =============================================================================
 * js/sales/cart-ui.js
 * แสดงตะกร้า/ยอดรวม/ส่วนลด, เลือกลูกค้า, เปิดหน้าชำระเงิน
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * updateCartQty, cart, updateCartUI, updateCartTotals, resetCartState, populateCustomerSelect,
 * openCartModal
 * ============================================================================= */

window.updateCartQty = function(key, change) {
  const item = cart.find(x => x.cartKey === key);
  if (!item) return;
  item.qty += change;
  if (item.qty <= 0) {
    cart = cart.filter(x => x.cartKey !== key);
  }
  window.cart = cart;
  window.updateCartUI();
};

window.updateCartUI = function() {
  const count = cart.reduce((sum, item) => sum + item.qty, 0);
  const badge = document.getElementById('header-cart-count');
  if (badge) {
    badge.innerText = count;
    badge.classList.remove('cart-badge-bump');
    void badge.offsetWidth; // restart animation
    badge.classList.add('cart-badge-bump');
  }

  const list = document.getElementById('cart-items-list');
  if (list) {
    list.innerHTML = cart.length ? cart.map(item => `
            <div class="cart-item-pop flex justify-between items-center bg-slate-50 hover:bg-slate-100 p-2.5 rounded-2xl border border-slate-100 text-xs text-slate-800 transition-colors">
              <div class="flex-1 min-w-0 pr-2">
                <span class="font-bold block truncate">${escapeHTML(item.name)}</span>
                <span class="text-[10px] text-slate-400">@${formatMoney(item.price)}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <button onclick="window.updateCartQty('${item.cartKey}', -1)" class="cart-stepper-btn w-7 h-7 rounded-full bg-white border border-slate-200 text-rose-500 font-bold shadow-sm btn-touch">−</button>
                <span class="font-black text-xs w-5 text-center">${item.qty}</span>
                <button onclick="window.updateCartQty('${item.cartKey}', 1)" class="cart-stepper-btn w-7 h-7 rounded-full bg-white border border-slate-200 text-indigo-600 font-bold shadow-sm btn-touch">+</button>
                <span class="w-14 text-right font-bold text-indigo-600">${formatMoney(item.qty * item.price)}</span>
              </div>
            </div>
          `).join('') : `
            <div class="flex flex-col items-center justify-center py-8 text-slate-300">
              <span class="text-4xl cart-empty-float">🛒</span>
              <span class="text-xs font-bold mt-2 text-slate-400">ตะกร้าว่างเปล่า เลือกสินค้าเพื่อเริ่มขาย</span>
            </div>`;
  }

  window.updateCartTotals();
};

window.updateCartTotals = function() {
  const _tot = window.calcCartTotals(cart, document.getElementById('cart-discount-input')?.value, document.getElementById('cart-discount-type')?.value);
  const subtotal = _tot.subtotal, discountAmt = _tot.discountAmt, grandTotal = _tot.grandTotal;

  if (document.getElementById('cart-subtotal')) document.getElementById('cart-subtotal').innerText = formatMoney(subtotal);
  if (document.getElementById('cart-discount-disp')) document.getElementById('cart-discount-disp').innerText = `-฿${discountAmt.toFixed(2)}`;
  const grandEl = document.getElementById('cart-grand-total');
  if (grandEl) {
    grandEl.innerText = formatMoney(grandTotal);
    grandEl.classList.remove('cart-total-glow');
    void grandEl.offsetWidth;
    grandEl.classList.add('cart-total-glow');
  }

  window.calcChange();
};

// Clears everything tied to the current sale (cart, discount, cash-received, payment
// method, chosen customer) so nothing "leftover" carries into the next transaction.
// Previously only `cart` itself was reset after checkout — the discount amount and the
// cash-received figure stayed in their input fields, so the next sale could silently
// start with a stale discount applied or show an incorrect change amount.
window.resetCartState = function() {
  cart = [];
  window.cart = cart;

  const discountInput = document.getElementById('cart-discount-input');
  if (discountInput) discountInput.value = '';
  const discountType = document.getElementById('cart-discount-type');
  if (discountType) discountType.value = 'BAHT';
  const cashReceived = document.getElementById('pay-cash-received');
  if (cashReceived) cashReceived.value = '';
  const custSelect = document.getElementById('pay-customer-select');
  if (custSelect) custSelect.value = 'GENERAL';

  window.switchPayTab('CASH');
  window.updateCartUI();
};

// BUG FIX: called from loadDatabaseState() via optional chaining but never defined —
// silently no-op'd, so the cart's customer dropdown never reflected customers freshly
// pulled from Supabase until the cart happened to be reopened (which repopulates it itself).
window.populateCustomerSelect = function() {
  const custSelect = document.getElementById('pay-customer-select');
  if (custSelect) {
    const cur = custSelect.value;
    custSelect.innerHTML = `<option value="GENERAL">ลูกค้าทั่วไป (ไม่ระบุ)</option>` +
      Object.values(db.customers || {}).map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');
    if (cur && db.customers[cur]) custSelect.value = cur;
  }
};

window.openCartModal = function() {
  window.populateCustomerSelect();
  window.updateCartUI();
  document.getElementById('modal-cart').classList.remove('hidden');
  document.getElementById('modal-cart').classList.add('flex');
};
