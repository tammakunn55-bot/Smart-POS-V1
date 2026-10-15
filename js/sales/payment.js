/* =============================================================================
 * js/sales/payment.js
 * ชำระเงิน (สด/โอน/เชื่อ), เงินทอน, ออกเลขบิล, บันทึกบิล + ตัดสต็อก + เข้าคิวซิงค์
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * switchPayTab, selectQuickBanknote, calcChange, getGoodsReceiptNumber, getCreditNoteNumber,
 * currentCartTotal, getAutoSku, processPaymentRequest
 * ============================================================================= */

// ==========================================
// PAYMENT PROCESSING
// ==========================================
window.switchPayTab = function(tab) {
  activePayMethod = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');

  document.querySelectorAll('.pay-view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`pay-view-${tab}`).classList.remove('hidden');

  if (tab === 'TRANSFER') {
    const grandTotalStr = String(window.currentCartTotal());
    const grandTotal = parseFloat(grandTotalStr) || 0;
    document.getElementById('pay-pp-id-disp').innerText = db.promptPayId;
    document.getElementById('pay-promptpay-qr-img').src = `https://promptpay.io/${db.promptPayId}/${grandTotal}.png`;
  }
};

window.selectQuickBanknote = function(val) {
  const grandTotalStr = String(window.currentCartTotal());
  const total = parseFloat(grandTotalStr) || 0;
  const input = document.getElementById('pay-cash-received');
  if (val === 'MATCH') {
    input.value = total;
  } else {
    let cur = parseFloat(input.value) || 0;
    input.value = roundAmt(cur + val);
  }
  window.calcChange();
};

window.calcChange = function() {
  const grandTotalStr = String(window.currentCartTotal());
  const total = parseFloat(grandTotalStr) || 0;
  const received = parseFloat(document.getElementById('pay-cash-received')?.value) || 0;
  const change = roundAmt(received - total);
  if (document.getElementById('pay-cash-change')) {
    document.getElementById('pay-cash-change').innerText = formatMoney(change > 0 ? change : 0);
  }
};

// Shared running-number generator for any document type (bills, goods-receipt notes,
// credit notes, purchase orders, ...). Format: PREFIX-YYYYMMDD-NNN, resetting to 001 each
// new day. Counter state lives in db.counters so it persists locally and across reloads.
function getRunningDocNumber(prefix, dateKey, numKey, withDevice) {
  const today = window.todayKey();   // วันที่เวลาไทย ไม่ใช่ UTC
  db.counters = db.counters || {};
  if (db.counters[dateKey] !== today) {
    db.counters[dateKey] = today;
    db.counters[numKey] = 1;
  } else {
    db.counters[numKey]++;
  }
  const dev = withDevice ? window.getDeviceId() + '-' : '';   // กันเลขบิลซ้ำข้ามเครื่อง
  return `${prefix}-${today}-${dev}${db.counters[numKey].toString().padStart(3, '0')}`;
}

function getDailyBillId() {
  return getRunningDocNumber('POS', 'lastBillDate', 'dailyBillNum', true);
}

// Auto-numbering for documents the user CAN type their own reference for (e.g. the
// supplier's own delivery-note number) — these are only used as a fallback when the
// field is left blank, never overriding something the user actually typed in.
window.getGoodsReceiptNumber = function() { return getRunningDocNumber('GR', 'lastGRDate', 'dailyGRNum', true); };
window.getCreditNoteNumber = function() { return getRunningDocNumber('CN', 'lastCNDate', 'dailyCNNum', true); };
window.currentCartTotal = function() { return window.calcCartTotals(cart, document.getElementById('cart-discount-input')?.value, document.getElementById('cart-discount-type')?.value).grandTotal; };
window.getAutoSku = function() { return getRunningDocNumber('SKU', 'lastSKUDate', 'dailySKUNum'); };

window.processPaymentRequest = function() {
  if (cart.length === 0) return alert("ตะกร้าสินค้าว่างเปล่า");

  const grandTotalStr = String(window.currentCartTotal());
  const total = parseFloat(grandTotalStr) || 0;
  const cid = document.getElementById('pay-customer-select').value;

  if (activePayMethod === 'CREDIT' && cid === 'GENERAL') {
    return alert("กรณีค้างชำระ จำเป็นต้องเลือกชื่อลูกค้าก่อนบันทึก");
  }

  // Credit-limit check — this schema's create_sale RPC does not enforce credit_limit
  // itself (it only carries the column), so this client-side check is the only
  // enforcement there is; per the manual's "ตรวจสอบวงเงินเครดิต" description, previously
  // this wasn't enforced client-side at all either, so bills could exceed a customer's
  // credit_limit before the background sync
  // ever reached Supabase).
  if (activePayMethod === 'CREDIT' && db.customers[cid]) {
    const limit = db.customers[cid].creditLimit ?? 0;
    if (roundAmt(db.customers[cid].debt + total) > limit) {
      return window.showAlert
        ? window.showAlert("วงเงินเครดิตไม่พอ", `ยอดหนี้รวมจะเกินวงเงินเครดิตที่กำหนดไว้ (${formatMoney(limit)})`, true)
        : alert(`ยอดหนี้รวมจะเกินวงเงินเครดิตที่กำหนดไว้ (${formatMoney(limit)})`);
    }
  }

  // ป้องกันสต็อกติดลบ (เปิด/ปิดที่ ตั้งค่า > ร้านค้า) — เดิมไม่มีการเช็คสต็อกก่อนขายเลย
  if (window.isPreventNegativeStock()) {
    const need = {};
    cart.forEach(i => { const k = i.id + '|' + i.variantId; need[k] = (need[k] || 0) + i.qty * (i.multiplier || 1); });
    for (const k of Object.keys(need)) {
      const [pid, vid] = k.split('|');
      const pv = db.products[pid]?.variants?.find(x => x.id === vid);
      if (pv && roundStock((+pv.stock || 0) - need[k]) < 0) {
        return window.showAlert("สินค้าคงเหลือไม่พอ", `"${db.products[pid].name}" คงเหลือ ${roundStock(+pv.stock || 0)} แต่ต้องการ ${roundStock(need[k])} (ปิดการป้องกันได้ที่ ตั้งค่า > ร้านค้า)`, true);
      }
    }
  }

  const _tot = window.calcCartTotals(cart, document.getElementById('cart-discount-input')?.value, document.getElementById('cart-discount-type')?.value);
  const billId = getDailyBillId();
  const bill = {
    id: billId,
    time: Date.now(),
    items: cart.map(i => ({ ...i })),
    total: total,
    subtotal: _tot.subtotal,        // ยอดก่อนลด
    discount: _tot.discountAmt,     // ส่วนลด (เดิมไม่เคยถูกบันทึก/ส่งขึ้นเซิร์ฟเวอร์)
    deviceId: window.getDeviceId(),
    _rpcPending: true,              // รอส่งผ่าน create_sale (ดูคิวซิงค์)
    method: activePayMethod,
    customerId: cid,
    cashierId: db.activeUser?.id || null,
    cashierName: db.activeUser?.name || null,
    // BUG FIX: เดิมบิลไม่เก็บว่าขายตอนกะไหน ทำให้โค้ด sync ต้องเดาโดยอ่าน db.currentShift
    // ณ เวลาที่ sync รัน (ซึ่งอาจเป็นกะใหม่ไปแล้ว หรือร้านปิดไปแล้วก็ได้ null) เก็บตรงนี้
    // ทันทีตอนขาย ให้เป็น source of truth เดียวสำหรับทุกจุดที่ sync ขึ้น Supabase
    shiftId: db.currentShift?.id || null
  };

  db.bills.push(bill);

  // Deduct Stock
  cart.forEach(item => {
    const p = db.products[item.id];
    if (p) {
      const v = p.variants.find(x => x.id === item.variantId);
      if (v) v.stock = roundStock(v.stock - (item.qty * item.multiplier));
    }
  });

  // Handle Credit Debt
  if (activePayMethod === 'CREDIT' && db.customers[cid]) {
    db.customers[cid].debt = roundAmt(db.customers[cid].debt + total);
  }

  // Reset — clears cart, discount, cash-received, payment tab, and customer selection
  // so nothing carries over ("ค้าง") into the next sale.
  window.resetCartState();
  window.closeModal('modal-cart');
  window.persist?.(); // save the completed sale locally right away (offline-safe)
  window.showToast("บันทึกการขายสำเร็จ!");
  window.renderReceipt(bill);

  // Best-effort authoritative write to Supabase via the atomic RPC (create_sale):
  // re-checks credit limit, re-deducts stock with row locking, and records unit_cost server-side.
  // Runs in the background so the cashier flow above never blocks on network; if it's offline or
  // unconfigured this silently no-ops and the periodic/forced sync (syncTransactionsToSupabase)
  // remains the offline fallback described in the manual.
  window.enqueueSync({ type: 'sale', payload: { billId: bill.id } });
};

// (v10) การส่งบิลขึ้นเซิร์ฟเวอร์ย้ายไปที่คิวซิงค์ — ดู window.enqueueSync / runSale ในโมดูล v10 ท้ายไฟล์
