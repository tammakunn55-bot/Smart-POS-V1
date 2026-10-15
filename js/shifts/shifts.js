/* =============================================================================
 * js/shifts/shifts.js
 * เปิด/ปิดกะ, เงินเข้า-ออกลิ้นชัก, สรุปยอดกะ, ประวัติกะ
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * renderShiftStatusBar, openShiftModal, renderOpenShiftView, confirmOpenShift,
 * openCashMovementModal, confirmCashMovement, openCloseShiftReport, _shiftCloseSummary,
 * updateShiftCloseDiff, cancelCloseShift, confirmCloseShift, renderShiftHistory
 * ============================================================================= */


/* ==========================================
   SHIFT / CASH DRAWER MANAGEMENT (เปิด-ปิดร้าน, เงินทอนเริ่มต้น, เงินเข้า-ออกลิ้นชัก,
   รายงานสรุปยอดปิดร้าน) — previously referenced throughout the Supabase sync layer
   (db.shifts / db.currentShift / shift_id on every bill) but nothing ever created or
   populated them, so every synced bill silently carried shift_id: null. This module is
   the missing implementation, matching the exact field names the sync layer expects:
   shift objects = { id, startTime, endTime, openingCash, cashOnHand, openedBy, movements }.
   ========================================== */
(function(){
  function fmt(v){ return (window.formatMoney ? window.formatMoney(v) : '฿' + (Math.round((v||0)*100)/100).toFixed(2)); }
  function esc2(v){ return window.escapeHTML ? window.escapeHTML(v) : String(v ?? ''); }

  window.renderShiftStatusBar = function(){
    const btn = document.getElementById('shift-status-btn');
    const label = document.getElementById('shift-status-label');
    const icon = document.getElementById('shift-status-icon');
    if (!btn || !label) return;
    if (db.currentShift) {
      label.textContent = 'เปิดร้านอยู่';
      icon.textContent = '🟢';
      btn.classList.remove('bg-amber-50','text-amber-700','border-amber-200');
      btn.classList.add('bg-emerald-50','text-emerald-700','border-emerald-200');
    } else {
      label.textContent = 'ยังไม่เปิดร้าน';
      icon.textContent = '🗄️';
      btn.classList.add('bg-amber-50','text-amber-700','border-amber-200');
      btn.classList.remove('bg-emerald-50','text-emerald-700','border-emerald-200');
    }
  };

  // Everything that moves cash in/out of the physical drawer during a shift: cash sales,
  // cash received against outstanding debt (cash-in-ar), cash refunds (expense-refund), and
  // manual entries logged via openCashMovementModal — bounded to the shift's open time window.
  function computeShiftSummary(shift){
    const start = shift.startTime;
    const end = shift.endTime || Date.now();
    const bills = (db.bills || []).filter(b => b.time >= start && b.time <= end);
    const cashSales = bills.filter(b => b.method === 'CASH' && !b.isRefunded).reduce((s,b)=>s+ (+b.total||0), 0);
    const transferSales = bills.filter(b => b.method === 'TRANSFER' && !b.isRefunded).reduce((s,b)=>s+ (+b.total||0), 0);
    const creditSales = bills.filter(b => b.method === 'CREDIT' && !b.isRefunded).reduce((s,b)=>s+ (+b.total||0), 0);

    const ledger = (db.cashLedger || []).filter(x => x.time >= start && x.time <= end);
    const cashInAR = ledger.filter(x=>x.type==='cash-in-ar').reduce((s,x)=>s+(+x.income||0),0);
    const refunds = ledger.filter(x=>x.type==='expense-refund').reduce((s,x)=>s+(+x.expense||0),0);
    const manualIn = (shift.movements||[]).filter(m=>m.type==='IN').reduce((s,m)=>s+(+m.amount||0),0);
    const manualOut = (shift.movements||[]).filter(m=>m.type==='OUT').reduce((s,m)=>s+(+m.amount||0),0);

    const expectedCash = roundAmt((+shift.openingCash||0) + cashSales + cashInAR + manualIn - refunds - manualOut);
    return { cashSales, transferSales, creditSales, cashInAR, refunds, manualIn, manualOut, expectedCash };
  }

  window.openShiftModal = function(){
    window.renderShiftHistory();
    const closedEl = document.getElementById('shift-view-closed');
    const openEl = document.getElementById('shift-view-open');
    const closingEl = document.getElementById('shift-view-closing');
    closingEl.classList.add('hidden');
    if (db.currentShift) {
      closedEl.classList.add('hidden'); openEl.classList.remove('hidden');
      window.renderOpenShiftView();
    } else {
      openEl.classList.add('hidden'); closedEl.classList.remove('hidden');
      document.getElementById('shift-open-cash-input').value = '';
    }
    const m = document.getElementById('modal-shift');
    m.classList.remove('hidden'); m.classList.add('flex');
  };

  window.renderOpenShiftView = function(){
    const s = db.currentShift;
    if (!s) return;
    document.getElementById('shift-open-time').textContent = new Date(s.startTime).toLocaleString('th-TH');
    document.getElementById('shift-open-cash-display').textContent = fmt(s.openingCash);
    document.getElementById('shift-opened-by').textContent = s.openedBy || '-';
    const sum = computeShiftSummary(s);
    document.getElementById('shift-expected-cash').textContent = fmt(sum.expectedCash);

    const list = document.getElementById('shift-movements-list');
    const movs = (s.movements || []).slice().reverse();
    list.innerHTML = movs.length ? movs.map(m => `
      <div class="flex justify-between bg-slate-50 border rounded-lg p-2">
        <span>${m.type==='IN' ? '➕' : '➖'} ${esc2(m.note||(m.type==='IN'?'เงินเข้า':'เงินออก'))} <span class="text-slate-400">${new Date(m.time).toLocaleTimeString('th-TH')}</span></span>
        <b class="${m.type==='IN'?'text-emerald-600':'text-rose-600'}">${m.type==='IN'?'+':'-'}${fmt(m.amount)}</b>
      </div>`).join('') : `<p class="text-center text-slate-400 font-bold py-3">ยังไม่มีรายการ</p>`;
  };

  window.confirmOpenShift = function(){
    const val = parseFloat(document.getElementById('shift-open-cash-input').value);
    if (isNaN(val) || val < 0) return window.showAlert?.('ข้อมูลไม่ถูกต้อง', 'กรุณากรอกจำนวนเงินทอนเริ่มต้นให้ถูกต้อง', true);
    const shift = {
      id: 'SHIFT-' + Date.now(),
      startTime: Date.now(),
      endTime: null,
      openingCash: roundAmt(val),
      cashOnHand: null,
      openedBy: db.activeUser?.name || '-',
      openedById: db.activeUser?.id || null,
      movements: []
    };
    db.shifts = db.shifts || [];
    db.shifts.push(shift);
    db.currentShift = shift;
    window.persist?.();
    window.renderShiftStatusBar();
    window.renderOpenShiftView();
    document.getElementById('shift-view-closed').classList.add('hidden');
    document.getElementById('shift-view-open').classList.remove('hidden');
    window.showToast?.(`เปิดร้านแล้ว — เงินทอนเริ่มต้น ${fmt(shift.openingCash)}`);
  };

  window.openCashMovementModal = function(type){
    document.getElementById('cash-movement-type').value = type;
    document.getElementById('cash-movement-title').textContent = type === 'IN' ? '➕ บันทึกเงินเข้าลิ้นชัก' : '➖ บันทึกเงินออกลิ้นชัก';
    document.getElementById('cash-movement-amount').value = '';
    document.getElementById('cash-movement-note').value = '';
    const m = document.getElementById('modal-cash-movement');
    m.classList.remove('hidden'); m.classList.add('flex');
  };

  window.confirmCashMovement = function(){
    if (!db.currentShift) return;
    const type = document.getElementById('cash-movement-type').value;
    const amount = parseFloat(document.getElementById('cash-movement-amount').value);
    const note = document.getElementById('cash-movement-note').value.trim();
    if (isNaN(amount) || amount <= 0) return window.showAlert?.('ข้อมูลไม่ถูกต้อง', 'กรุณากรอกจำนวนเงินให้ถูกต้อง', true);
    db.currentShift.movements = db.currentShift.movements || [];
    db.currentShift.movements.push({ id: 'MV-' + Date.now(), type, amount: roundAmt(amount), note, time: Date.now() });
    window.persist?.();
    window.closeModal('modal-cash-movement');
    window.renderOpenShiftView();
    window.showToast?.('บันทึกรายการเรียบร้อย');
  };

  window.openCloseShiftReport = function(){
    const s = db.currentShift;
    if (!s) return;
    const sum = computeShiftSummary(s);
    window._shiftCloseSummary = sum;
    document.getElementById('shift-close-summary').innerHTML = `
      <div class="flex justify-between"><span>เงินทอนเริ่มต้น</span><b>${fmt(s.openingCash)}</b></div>
      <div class="flex justify-between"><span>ยอดขายเงินสด</span><b class="text-emerald-600">+${fmt(sum.cashSales)}</b></div>
      <div class="flex justify-between"><span>รับชำระหนี้เป็นเงินสด</span><b class="text-emerald-600">+${fmt(sum.cashInAR)}</b></div>
      <div class="flex justify-between"><span>เงินเข้าเพิ่มเติม (บันทึกมือ)</span><b class="text-emerald-600">+${fmt(sum.manualIn)}</b></div>
      <div class="flex justify-between"><span>คืนเงินสดลูกค้า</span><b class="text-rose-600">-${fmt(sum.refunds)}</b></div>
      <div class="flex justify-between"><span>เงินออก (บันทึกมือ)</span><b class="text-rose-600">-${fmt(sum.manualOut)}</b></div>
      <div class="flex justify-between border-t pt-1.5 mt-1"><span class="font-bold">คาดว่ามีเงินสดในลิ้นชัก</span><b class="text-indigo-700">${fmt(sum.expectedCash)}</b></div>
      <div class="flex justify-between text-slate-400"><span>ยอดขายโอน/พร้อมเพย์ (อ้างอิง)</span><b>${fmt(sum.transferSales)}</b></div>
      <div class="flex justify-between text-slate-400"><span>ยอดขายเงินเชื่อ (อ้างอิง)</span><b>${fmt(sum.creditSales)}</b></div>
    `;
    document.getElementById('shift-actual-cash-input').value = '';
    document.getElementById('shift-close-diff').textContent = '';
    document.getElementById('shift-diff-note').value = '';
    document.getElementById('shift-diff-note-wrap').classList.add('hidden');
    document.getElementById('shift-view-open').classList.add('hidden');
    document.getElementById('shift-view-closing').classList.remove('hidden');
  };

  window.updateShiftCloseDiff = function(){
    const actual = parseFloat(document.getElementById('shift-actual-cash-input').value);
    const diffEl = document.getElementById('shift-close-diff');
    const noteWrap = document.getElementById('shift-diff-note-wrap');
    if (isNaN(actual) || !window._shiftCloseSummary) { diffEl.textContent = ''; noteWrap.classList.add('hidden'); return; }
    const diff = roundAmt(actual - window._shiftCloseSummary.expectedCash);
    if (diff === 0) { diffEl.innerHTML = `<span class="text-emerald-600">✅ ยอดตรงกันพอดี</span>`; noteWrap.classList.add('hidden'); }
    else {
      diffEl.innerHTML = diff > 0
        ? `<span class="text-indigo-600">เงินเกิน ${fmt(diff)}</span>`
        : `<span class="text-rose-600">เงินขาด ${fmt(Math.abs(diff))}</span>`;
      // เพิ่มขึ้นมา: บังคับให้บันทึกสาเหตุทุกครั้งที่ยอดไม่ตรง เก็บไว้เช็คย้อนหลังได้ว่าพลาดจากอะไร
      noteWrap.classList.remove('hidden');
    }
  };

  window.cancelCloseShift = function(){
    document.getElementById('shift-view-closing').classList.add('hidden');
    document.getElementById('shift-view-open').classList.remove('hidden');
  };

  window.confirmCloseShift = function(){
    const s = db.currentShift;
    if (!s) return;
    const actual = parseFloat(document.getElementById('shift-actual-cash-input').value);
    if (isNaN(actual) || actual < 0) return window.showAlert?.('ข้อมูลไม่ถูกต้อง', 'กรุณากรอกยอดเงินสดที่นับได้จริง', true);
    const sum = window._shiftCloseSummary || computeShiftSummary(s);
    const diff = roundAmt(actual - sum.expectedCash);
    const diffNote = document.getElementById('shift-diff-note').value.trim();
    // เพิ่มขึ้นมา: ถ้ายอดไม่ตรงต้องกรอกสาเหตุก่อนปิดร้านได้ กันลืมบันทึกแล้วหาสาเหตุย้อนหลังไม่ได้
    if (diff !== 0 && !diffNote) return window.showAlert?.('กรุณาระบุสาเหตุ', 'ยอดเงินไม่ตรง กรุณาบันทึกสาเหตุที่คาดว่าเกิดขึ้นก่อนปิดร้าน เพื่อเก็บไว้ตรวจสอบภายหลัง', true);

    s.endTime = Date.now();
    s.cashOnHand = roundAmt(actual);
    s.closedBy = db.activeUser?.name || '-';
    s.summary = sum;
    s.diff = diff;
    s.diffNote = diff !== 0 ? diffNote : '';

    db.currentShift = null;
    window.persist?.();
    window.renderShiftStatusBar();
    window.closeModal('modal-shift');
    window.showToast?.(`ปิดร้านเรียบร้อย — นำเงินออก ${fmt(actual)} จากลิ้นชัก`);
  };

  window.renderShiftHistory = function(){
    const el = document.getElementById('shift-history-list');
    if (!el) return;
    const past = (db.shifts || []).filter(s => s.endTime).slice().reverse().slice(0, 20);
    el.innerHTML = past.length ? past.map(s => `
      <div class="bg-slate-50 border rounded-lg p-2">
        <div class="flex justify-between font-bold text-slate-700">
          <span>${new Date(s.startTime).toLocaleDateString('th-TH')} ${new Date(s.startTime).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})}–${new Date(s.endTime).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})}</span>
          <span class="${s.diff===0?'text-emerald-600':(s.diff>0?'text-indigo-600':'text-rose-600')}">${s.diff===0?'ตรง':(s.diff>0?'เกิน '+fmt(Math.abs(s.diff)):'ขาด '+fmt(Math.abs(s.diff)))}</span>
        </div>
        <div class="text-[10px] text-slate-400 mt-0.5">เปิด ${fmt(s.openingCash)} • ปิดนับได้ ${fmt(s.cashOnHand)} • โดย ${esc2(s.openedBy)}</div>
        ${s.diffNote ? `<div class="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1">📝 ${esc2(s.diffNote)}</div>` : ''}
      </div>`).join('') : `<p class="text-center text-slate-400 font-bold py-3">ยังไม่มีประวัติกะที่ปิดแล้ว</p>`;
  };

  document.addEventListener('DOMContentLoaded', () => { db.shifts = db.shifts || []; window.renderShiftStatusBar(); });
})();
