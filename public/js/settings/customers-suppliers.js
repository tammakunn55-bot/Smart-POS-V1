/* =============================================================================
 * js/settings/customers-suppliers.js
 * รายการซัพพลายเออร์/ลูกค้าในหน้าตั้งค่า (เพิ่ม/แก้/ลบลูกค้า)
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * renderSettingsSuppliers, renderSettingsCustomers, saveCustomer, deleteCustomer
 * ============================================================================= */

window.renderSettingsSuppliers = function() {
  document.getElementById('settings-suppliers-list').innerHTML = Object.values(db.suppliers).map(s => {
    const owed = (db.cashLedger || [])
      .filter(x => x.type === 'ACCOUNTS_PAYABLE' && x.supplierId === s.id && x.status === 'OPEN')
      .reduce((sum, x) => sum + (+x.amount || 0), 0);
    return `
          <div class="bg-slate-50 p-2.5 rounded-xl border flex justify-between items-center">
            <div>
              <b>${escapeHTML(s.name)}</b> <span class="text-slate-400">(เครดิต ${s.terms} วัน)</span>
              <span class="block text-[10px] ${owed > 0 ? 'text-rose-500 font-bold' : 'text-slate-400'}">เจ้าหนี้คงค้าง ${formatMoney(owed)}</span>
            </div>
            <button onclick="window.deleteSupplier('${s.id}')" class="text-rose-500 font-bold hover:underline">ลบ</button>
          </div>`;
  }).join('') || `<p class="text-center text-slate-400 font-bold py-3 text-xs">ยังไม่มีซัพพลายเออร์</p>`;
};

window.renderSettingsCustomers = function() {
  document.getElementById('settings-customers-list').innerHTML = Object.values(db.customers).map(c => `
          <div class="bg-slate-50 p-2.5 rounded-xl border flex justify-between items-center">
            <div><b>${escapeHTML(c.name)}</b> <span class="text-slate-400">📞 ${escapeHTML(c.phone)}</span>
              <span class="block text-[10px] text-slate-400">หนี้คงค้าง ${formatMoney(c.debt || 0)} / วงเงิน ${formatMoney(c.creditLimit ?? 50000)}</span>
            </div>
            <button onclick="window.deleteCustomer('${c.id}')" class="text-rose-500 font-bold hover:underline">ลบ</button>
          </div>
        `).join('');
};

window.saveCustomer = function() {
  const name = document.getElementById('customer-name-input').value.trim();
  const phone = document.getElementById('customer-phone-input').value.trim();
  const creditLimit = parseFloat(document.getElementById('customer-credit-limit-input').value) || 50000;
  if (!name) return window.showAlert("ข้อมูลไม่ครบ", "กรุณากรอกชื่อลูกค้า", true);

  const id = 'CUST-' + Date.now().toString(36).toUpperCase();
  db.customers[id] = { id, name, phone, debt: 0, creditLimit };
  document.getElementById('customer-name-input').value = '';
  document.getElementById('customer-phone-input').value = '';
  document.getElementById('customer-credit-limit-input').value = '';
  window.persist?.();
  window.renderSettingsCustomers();
  window.showToast("บันทึกลูกค้าสำเร็จ");
};

window.deleteCustomer = function(id) {
  if (db.customers[id]?.debt > 0) {
    return window.showAlert("ไม่สามารถลบได้", "ลูกค้ารายนี้ยังมียอดหนี้ค้างชำระอยู่", true);
  }
  delete db.customers[id];
  window.persist?.();
  window.renderSettingsCustomers();
  window.showToast("ลบลูกค้าสำเร็จ");
};
