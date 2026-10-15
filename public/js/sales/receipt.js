/* =============================================================================
 * js/sales/receipt.js
 * แสดง/พิมพ์ใบเสร็จ
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * renderReceipt
 * ============================================================================= */

window.renderReceipt = function(bill) {
  const cName = bill.customerId !== 'GENERAL' && db.customers[bill.customerId] ? db.customers[bill.customerId].name : 'ลูกค้าทั่วไป';
  let itemsHtml = bill.items.map(i => `
          <div class="flex justify-between border-b border-dashed border-slate-200 py-1 text-xs">
            <span class="flex-1">${escapeHTML(i.name)}</span>
            <span class="w-8 text-center">${i.qty}</span>
            <span class="w-16 text-right">${formatMoney(i.qty * i.price)}</span>
          </div>
        `).join('');

  // Return / credit-note history for this bill — shows up right on the receipt itself so
  // there's a clear paper trail of every deduction applied against it, not just the
  // original sale total.
  const returns = (db.returns || []).filter(r => r.billId === bill.id);
  const returnsHtml = returns.length ? `
          <div class="mt-2 pt-2 border-t border-dashed border-rose-200 text-[10px] text-rose-600 space-y-0.5">
            <p class="font-bold">↩️ ประวัติใบลดหนี้ / คืนสินค้า:</p>
            ${returns.map(r => `<p>${escapeHTML(r.id)} — ${new Date(r.time).toLocaleDateString('th-TH')} — ${r.isDebtReduction ? 'หักยอดหนี้' : 'คืนเงินสด'} ${formatMoney(r.amount)}</p>`).join('')}
          </div>` : '';

  const html = `
          <div class="space-y-3 p-4 border rounded-xl bg-white max-w-sm mx-auto text-slate-800">
            <div class="text-center">
              <h2 class="text-base font-bold">${escapeHTML(db.storeName)}</h2>
              <p class="text-[10px] text-slate-500">${escapeHTML(db.storeAddress)}</p>
              <div class="border-b my-2"></div>
            </div>
            <div class="text-[10px] space-y-0.5">
              <p><b>เลขที่บิล:</b> ${escapeHTML(bill.id)}</p>
              <p><b>วันที่เวลา:</b> ${new Date(bill.time).toLocaleString('th-TH')}</p>
              <p><b>ลูกค้า:</b> ${escapeHTML(cName)}</p>
              <p><b>ช่องทางชำระ:</b> ${bill.method}</p>
            </div>
            <div class="font-bold border-b pb-1 mb-1 flex text-[10px]">
              <span class="flex-1">รายการ</span><span class="w-8 text-center">จำนวน</span><span class="w-16 text-right">รวม</span>
            </div>
            ${itemsHtml}
            <div class="mt-3 text-right text-xs border-t pt-2 font-bold text-indigo-600">
              <div class="flex justify-between text-sm"><span>ยอดรวมสุทธิ:</span><span>${formatMoney(bill.total)}</span></div>
            </div>
            ${returnsHtml}
          </div>
        `;
  document.getElementById('print-document-area').innerHTML = html;
  document.getElementById('modal-document-viewer').classList.remove('hidden');
  document.getElementById('modal-document-viewer').classList.add('flex');
};
