/* =============================================================================
 * js/sales/receivables-returns.js
 * หน้ายอดขาย/ลูกหนี้, รับชำระหนี้, คืนสินค้า
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * renderSalesAR, renderHistory, openReceivePaymentModal, confirmReceivePayment,
 * openReturnModal, updateReturnTotal, backToReturnSelect, reviewReturn, executeReturn
 * ============================================================================= */

// ==========================================
// SALES / RECEIVABLES / RETURNS (รวมขาย, ลูกหนี้, ยอดค้าง, ใบเสร็จ, คืนสินค้า)
// ==========================================
window.renderSalesAR = function() {
  // 1. Accounts receivable / outstanding balances
  const arEl = document.getElementById('ar-balance-list');
  if (arEl) {
    const debtors = Object.values(db.customers || {}).filter(c => (c.debt || 0) > 0);
    arEl.innerHTML = debtors.length ? debtors.map(c => `
            <div class="bg-rose-50 border border-rose-200 p-3 rounded-xl text-xs flex justify-between items-center">
              <div><b class="text-slate-800">${escapeHTML(c.name)}</b><span class="block text-[10px] text-slate-500">📞 ${escapeHTML(c.phone || '-')}</span></div>
              <div class="text-right">
                <span class="block font-black text-rose-600">${formatMoney(c.debt)}</span>
                <button onclick="window.openReceivePaymentModal('${c.id}')" class="text-[10px] text-indigo-600 font-bold underline">รับชำระหนี้</button>
              </div>
            </div>`).join('') : `<p class="text-center text-slate-400 font-bold py-6">ไม่มีลูกหนี้ค้างชำระ 🎉</p>`;
  }

  // 2. Bill / receipt history with return action
  const billsEl = document.getElementById('ar-bills-list');
  if (billsEl) {
    const q = (document.getElementById('ar-bills-search')?.value || '').trim().toLowerCase();
    let bills = (db.bills || []).slice().reverse();
    if (q) {
      bills = bills.filter(b => {
        const cName = (b.customerId && b.customerId !== 'GENERAL' && db.customers[b.customerId]) ? db.customers[b.customerId].name : 'ลูกค้าทั่วไป';
        return b.id.toLowerCase().includes(q) || cName.toLowerCase().includes(q);
      });
    }
    billsEl.innerHTML = bills.length ? bills.map(b => {
      const cName = (b.customerId && b.customerId !== 'GENERAL' && db.customers[b.customerId]) ? db.customers[b.customerId].name : 'ลูกค้าทั่วไป';
      const canReturn = !b.isRefunded;
      // Show how much (if anything) has been returned against this bill so far — the old
      // version only showed a boolean "fully returned" badge and said nothing about a
      // partial return, which looked identical to a bill nobody had touched.
      const returnedSoFar = (db.returns || []).filter(r => r.billId === b.id).reduce((s, r) => s + r.amount, 0);
      let statusBadge = '';
      if (b.isRefunded) statusBadge = '<span class="text-rose-500 font-bold">คืนสินค้าครบแล้ว</span>';
      else if (returnedSoFar > 0) statusBadge = `<span class="text-amber-600 font-bold">คืนแล้ว ${formatMoney(returnedSoFar)}</span>`;
      return `<div class="bg-slate-50 p-3 rounded-xl border text-xs space-y-1.5">
              <div class="flex justify-between items-center">
                <b class="text-indigo-600">${escapeHTML(b.id)}</b>
                <span class="font-black text-slate-800">${formatMoney(b.total)}</span>
              </div>
              <div class="text-[10px] text-slate-400 flex justify-between items-center">
                <span>${new Date(b.time).toLocaleString('th-TH')} | ${escapeHTML(cName)} | ${escapeHTML(b.method)}</span>
                ${statusBadge}
              </div>
              <div class="flex gap-2 pt-1">
                <button onclick='window.renderReceipt(db.bills.find(x=>x.id===${JSON.stringify(b.id)}))' class="flex-1 py-1.5 bg-white border rounded-lg font-bold btn-touch">🧾 ดูใบเสร็จ</button>
                ${canReturn ? `<button onclick="window.openReturnModal(${JSON.stringify(b.id)})" class="flex-1 py-1.5 bg-amber-100 text-amber-700 rounded-lg font-bold btn-touch">↩️ คืนสินค้า</button>` : ''}
              </div>
            </div>`;
    }).join('') : `<p class="text-center text-slate-400 font-bold py-6">ไม่พบประวัติการขาย</p>`;
  }
};
// Backward-compatible alias: some code paths (bridge script / loadDatabaseState) still call renderHistory().
window.renderHistory = window.renderSalesAR;

// --- Receive customer payment against outstanding debt ---
window.openReceivePaymentModal = function(customerId) {
  const c = db.customers[customerId];
  if (!c) return;
  document.getElementById('rp-customer-id').value = customerId;
  document.getElementById('rp-customer-name').textContent = c.name;
  document.getElementById('rp-customer-debt').textContent = formatMoney(c.debt || 0);
  document.getElementById('rp-amount').value = '';
  document.getElementById('modal-receive-payment').classList.remove('hidden');
  document.getElementById('modal-receive-payment').classList.add('flex');
};

window.confirmReceivePayment = function() {
  const cid = document.getElementById('rp-customer-id').value;
  const c = db.customers[cid];
  if (!c) return;
  const amount = roundAmt(parseFloat(document.getElementById('rp-amount').value) || 0);
  if (amount <= 0) return window.showAlert("จำนวนเงินไม่ถูกต้อง", "กรุณาระบุจำนวนเงินที่รับชำระ", true);
  if (amount > c.debt) return window.showAlert("จำนวนเงินเกินยอดหนี้", `ยอดหนี้คงเหลือมีเพียง ${formatMoney(c.debt)}`, true);

  c.debt = roundAmt(c.debt - amount);
  db.cashLedger = db.cashLedger || [];
  const _payId = 'CL-' + Date.now() + '-' + window.getDeviceId();
  db.cashLedger.push({ id: _payId, _viaRpc: true, type: 'cash-in-ar', income: amount, description: `รับชำระหนี้จาก ${c.name}`, refId: cid, shiftId: db.currentShift?.id || null, time: Date.now() });

  window.enqueueSync({ type: 'payment', payload: { customerId: cid, amount, shiftId: db.currentShift?.id || null, opRef: _payId } });
  window.persist?.();
  window.closeModal('modal-receive-payment');
  window.renderSalesAR();
  window.showToast(`บันทึกรับชำระหนี้ ${formatMoney(amount)} เรียบร้อย`);
};

// --- Return / refund workflow ---
// Two-step flow: (1) pick items/quantities to return, (2) review — shows the exact
// cash-refund or debt-reduction amount and a clear explanation of which one applies —
// and nothing is actually executed (stock restored, cash logged, debt reduced) until the
// user explicitly confirms on the review step.
let returnTempBillId = null;

window.openReturnModal = function(billId) {
  const bill = db.bills.find(b => b.id === billId);
  if (!bill) return;
  if (bill.isRefunded) return window.showAlert("คืนสินค้าแล้ว", "บิลนี้ถูกคืนสินค้าครบทุกรายการแล้ว", true);

  returnTempBillId = billId;
  document.getElementById('return-bill-id').textContent = bill.id;
  document.getElementById('return-items-list').innerHTML = bill.items.map((item, idx) => {
    const already = item.returnedQty || 0;
    const maxQty = roundStock(item.qty - already);
    if (maxQty <= 0) return '';
    return `<div class="flex justify-between items-center bg-slate-50 p-2.5 rounded-xl border text-xs">
            <div class="flex-1 pr-2"><b class="text-slate-800">${escapeHTML(item.name)}</b><span class="block text-[10px] text-slate-400">@${formatMoney(item.price)} (คืนได้สูงสุด ${maxQty})</span></div>
            <input type="number" min="0" max="${maxQty}" step="any" value="0" id="return-qty-${idx}" oninput="window.updateReturnTotal()" class="w-16 border rounded-lg text-center py-1.5 font-bold outline-none">
          </div>`;
  }).join('');
  window.updateReturnTotal();

  // Always reopen on step 1, even if a previous session was left mid-review.
  document.getElementById('return-step-select').classList.remove('hidden');
  document.getElementById('return-step-review').classList.add('hidden');

  document.getElementById('modal-return').classList.remove('hidden');
  document.getElementById('modal-return').classList.add('flex');
};

window.updateReturnTotal = function() {
  const bill = db.bills.find(b => b.id === returnTempBillId);
  if (!bill) return;
  let total = 0;
  bill.items.forEach((item, idx) => {
    const el = document.getElementById(`return-qty-${idx}`);
    const already = item.returnedQty || 0;
    const maxQty = roundStock(item.qty - already);
    let q = el ? (parseFloat(el.value) || 0) : 0;
    if (q < 0) q = 0;
    if (q > maxQty) q = maxQty;
    if (el) el.value = q;
    total += q * item.price * window.billRefundRatio(bill);   // หักสัดส่วนส่วนลดของบิลเดิม
  });
  document.getElementById('return-total-display').textContent = formatMoney(total);
};

window.backToReturnSelect = function() {
  document.getElementById('return-step-review').classList.add('hidden');
  document.getElementById('return-step-select').classList.remove('hidden');
};

// STEP 2: compute exactly what will happen and show it for explicit confirmation —
// does not touch stock, cash, or debt yet.
window.reviewReturn = function() {
  const bill = db.bills.find(b => b.id === returnTempBillId);
  if (!bill) return;

  const lines = [];
  let total = 0, _g = 0;
  bill.items.forEach((item, idx) => {
    const el = document.getElementById(`return-qty-${idx}`);
    const q = el ? (parseFloat(el.value) || 0) : 0;
    if (q <= 0) return;
    const lineTotal = roundAmt(q * item.price * window.billRefundRatio(bill));
    _g += q * item.price;
    total = roundAmt(_g * window.billRefundRatio(bill));
    lines.push({ name: item.name, qty: q, price: item.price, lineTotal });
  });

  if (!lines.length) return window.showAlert("ไม่มีรายการคืน", "กรุณาระบุจำนวนที่ต้องการคืนอย่างน้อย 1 รายการ", true);

  document.getElementById('return-review-items').innerHTML = lines.map(l => `
          <div class="flex justify-between bg-slate-50 p-2 rounded-lg border">
            <span>${escapeHTML(l.name)} × ${l.qty}</span>
            <b class="text-slate-700">${formatMoney(l.lineTotal)}</b>
          </div>
        `).join('');

  const isCredit = bill.method === 'CREDIT';
  const msgEl = document.getElementById('return-review-message');
  const labelEl = document.getElementById('return-review-total-label');
  if (isCredit) {
    msgEl.className = 'p-3 rounded-xl border text-xs leading-relaxed mb-3 bg-indigo-50 border-indigo-200 text-indigo-800';
    msgEl.innerHTML = `📋 บิลนี้เป็น <b>เงินเชื่อ (ค้างชำระ)</b> — <b>ไม่ต้องคืนเงินสด</b> ระบบจะ<b>หักยอดหนี้ค้างชำระของลูกค้าลง ${formatMoney(total)}</b> แทนเมื่อกดยืนยัน`;
    labelEl.textContent = 'ยอดหักหนี้:';
  } else {
    msgEl.className = 'p-3 rounded-xl border text-xs leading-relaxed mb-3 bg-rose-50 border-rose-200 text-rose-800';
    msgEl.innerHTML = `💵 บิลนี้ชำระด้วย <b>${escapeHTML(bill.method)}</b> — กรุณา<b>คืนเงินสด ${formatMoney(total)} ให้ลูกค้าจริงก่อน</b> แล้วจึงกดยืนยัน (การกดยืนยันจะบันทึกว่าได้คืนเงินแล้ว)`;
    labelEl.textContent = 'ยอดคืนเงินสด:';
  }
  document.getElementById('return-review-total-display').textContent = formatMoney(total);

  document.getElementById('return-step-select').classList.add('hidden');
  document.getElementById('return-step-review').classList.remove('hidden');
};

// Only actually runs after explicit confirmation on the review step.
window.executeReturn = function() {
  const bill = db.bills.find(b => b.id === returnTempBillId);
  if (!bill) return;

  let refundTotal = 0;
  let anyReturned = false;
  const rpcItems = []; // BUG FIX (#1): เก็บไว้ส่งขึ้น process_return RPC ด้วย
  const _restock = [];
  let _gross = 0;
  const _ratio = window.billRefundRatio(bill);

  bill.items.forEach((item, idx) => {
    const el = document.getElementById(`return-qty-${idx}`);
    const already = item.returnedQty || 0;
    const maxQty = roundStock(item.qty - already);
    let returnQty = el ? (parseFloat(el.value) || 0) : 0;
    if (returnQty <= 0 || maxQty <= 0) return;
    returnQty = Math.min(returnQty, maxQty);

    anyReturned = true;
    item.returnedQty = roundStock(already + returnQty);
    _gross += returnQty * item.price;

    // Restock: reverse of the deduction done at checkout time (item.multiplier converts
    // the sold fraction/unit back into base stock units, matching processPaymentRequest).
    const p = db.products[item.id];
    const v = p?.variants?.find(x => x.id === item.variantId);
    if (v) v.stock = roundStock((+v.stock || 0) + returnQty * (item.multiplier || 1));
    _restock.push({ variantId: item.variantId, qty: returnQty * (item.multiplier || 1) });

    rpcItems.push({
      variant_id: item.variantId || null,
      fraction_id: item.fractionId || null,
      quantity: returnQty,
      unit_price: item.price
    });
  });

  if (!anyReturned) return window.showAlert("ไม่มีรายการคืน", "กรุณาระบุจำนวนที่ต้องการคืนอย่างน้อย 1 รายการ", true);
  refundTotal = roundAmt(_gross * _ratio);   // คืนตามที่ลูกค้าจ่ายจริง (หักส่วนลดแล้ว) — ตรงกับ process_return บนเซิร์ฟเวอร์

  const fullyReturned = bill.items.every(item => roundStock(item.returnedQty || 0) >= roundStock(item.qty));
  bill.isRefunded = fullyReturned;
  window.posStore?.touchBill(bill.id);   // v11: บิลเก่ากว่า 7 วันถูกแก้ ต้องสั่งให้เขียนใหม่

  db.returns = db.returns || [];
  const creditNoteNo = window.getCreditNoteNumber();
  const isCredit = bill.method === 'CREDIT';
  db.returns.push({ id: creditNoteNo, billId: bill.id, amount: refundTotal, method: bill.method, isDebtReduction: isCredit, time: Date.now() });

  // Credit sale: reduce the customer's outstanding debt instead of handing back cash.
  // Otherwise: log a cash refund out of the drawer/ledger.
  if (isCredit && bill.customerId && db.customers[bill.customerId]) {
    db.customers[bill.customerId].debt = roundAmt(Math.max(0, db.customers[bill.customerId].debt - refundTotal));
  } else {
    db.cashLedger = db.cashLedger || [];
    db.cashLedger.push({ id: 'CL-' + Date.now() + '-' + window.getDeviceId(), _viaRpc: true, type: 'expense-refund', expense: refundTotal, description: 'คืนสินค้าบิล ' + bill.id, refId: bill.id, shiftId: db.currentShift?.id || null, time: Date.now() });
  }

  window.closeModal('modal-return');
  window.persist?.();
  window.renderSalesAR();
  window.renderStockTable?.();
  window.showToast(isCredit
    ? `บันทึกใบลดหนี้ ${creditNoteNo} เรียบร้อย: หักยอดหนี้ ${formatMoney(refundTotal)}`
    : `บันทึกใบลดหนี้ ${creditNoteNo} เรียบร้อย: คืนเงิน ${formatMoney(refundTotal)}`);

  // BUG FIX (#1): เดิมจบแค่ตรงนี้ — สถานะบิล/สต็อกที่คืนไม่เคยไปถึง Supabase เลยถ้าบิลนั้น
  // เคย sync ผ่าน RPC ไปแล้ว (ติดธง _syncedViaRPC ถาวร) เรียก process_return แบบ
  // fire-and-forget เหมือนแพทเทิร์นเดียวกับ syncBillToSupabaseRPC — ถ้าออฟไลน์/พลาด ข้อมูล
  // ก็ยังถูกต้องในเครื่องเหมือนเดิม แค่รอ sync รอบถัดไปไม่ได้ (ไม่มี batch fallback สำหรับ
  // การคืนสินค้าในตอนนี้ เพราะต้องรู้ bill server-side id ก่อน — ปล่อยให้กดซิงค์ใหม่ได้จาก
  // ปุ่ม forceSyncNow ถ้าพลาดจริง)
  window.enqueueSync({ type: 'return', payload: { billId: bill.id, items: rpcItems.map(i => ({ variant_id: i.variant_id, fraction_id: i.fraction_id, quantity: i.quantity })), restock: _restock, returnRef: creditNoteNo, shiftId: db.currentShift?.id || null, isCredit, customerId: bill.customerId, refund: refundTotal, fully: fullyReturned } });
};

