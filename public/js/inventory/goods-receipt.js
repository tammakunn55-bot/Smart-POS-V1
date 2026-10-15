/* =============================================================================
 * js/inventory/goods-receipt.js
 * รับสินค้าเข้าคลัง (ใบรับของ, รูปใบส่งของ, เจ้าหนี้)
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * onPOProductChange, filterPOProductPicker, selectPOProduct, renderPOCartList,
 * updatePOItemField, updatePOGrandTotal, clearPOList, handleDeliveryNoteSelect,
 * renderDeliveryNotePreview, removeDeliveryNote, clearDeliveryNote, addItemToPOList,
 * populatePOPickers, renderPOPicker, confirmReceivePO
 * ============================================================================= */

// ==========================================
// GOODS RECEIPT & MASTER SETTINGS
// ==========================================
// BUG FIX / UX: this used to be a plain <select> listing every product as a flat
// alphabetical dropdown — fine for a handful of items, unusable once the catalog grows,
// since finding one SKU meant scrolling through the entire list. Replaced with a
// type-to-search picker (matches name / SKU / barcode) that shows the product photo and
// current stock right in the results, so the right item can be found in a couple of
// keystrokes even without knowing exactly which category it's filed under.
window.onPOProductChange = function() {
  const pid = document.getElementById('po-product-picker-value').value;
  const p = db.products[pid];
  if (p && p.variants[0]) {
    document.getElementById('po-item-cost').value = p.variants[0].cost;
    document.getElementById('po-item-qty').value = 1;
  }
};

window.filterPOProductPicker = function() {
  const qEl = document.getElementById('po-product-search');
  const resultsEl = document.getElementById('po-product-picker-results');
  const q = (qEl.value || '').trim().toLowerCase();
  const all = Object.values(db.products || {});
  let matches = q
    ? all.filter(p => p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q) || (p.variants || []).some(v => (v.barcode || '').toLowerCase().includes(q)))
    : all;
  // Relevance: exact/starts-with name matches surface above mid-string matches.
  if (q) {
    matches.sort((a, b) => {
      const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
      const score = s => s.startsWith(q) ? 0 : 1;
      return score(an) - score(bn) || naturalCompare(a.name, b.name);
    });
  }
  matches = matches.slice(0, 40);

  resultsEl.innerHTML = matches.length ? matches.map(p => {
    const v = p.variants?.[0];
    const img = p.imageUrl
      ? `<img src="${escapeHTML(p.imageUrl)}" class="w-9 h-9 object-cover rounded-lg border flex-shrink-0">`
      : `<span class="w-9 h-9 flex items-center justify-center text-xl flex-shrink-0">${escapeHTML(p.image || '📦')}</span>`;
    const stockLabel = v ? `${v.stock <= 0 ? '<span class="text-rose-500">หมด</span>' : `คงเหลือ ${v.stock}`}` : '';
    return `
            <button type="button" onclick="window.selectPOProduct('${p.id}')" class="w-full flex items-center gap-2 p-2 hover:bg-indigo-50 text-left border-b last:border-0 btn-touch">
              ${img}
              <div class="flex-1 min-w-0">
                <div class="font-bold text-xs text-slate-800 truncate">${escapeHTML(p.name)} ${v ? `<span class="text-slate-400 font-normal">(${escapeHTML(v.sizeName)})</span>` : ''}</div>
                <div class="text-[10px] text-slate-400">SKU: ${escapeHTML(p.code || '-')} • ${stockLabel}</div>
              </div>
            </button>`;
  }).join('') : `<div class="p-4 text-center text-slate-400 text-xs font-bold">ไม่พบสินค้าที่ค้นหา</div>`;
  resultsEl.classList.remove('hidden');
};

window.selectPOProduct = function(pid) {
  const p = db.products[pid];
  if (!p) return;
  document.getElementById('po-product-picker-value').value = pid;
  document.getElementById('po-product-search').value = p.name + (p.variants?.[0] ? ` (${p.variants[0].sizeName})` : '');
  document.getElementById('po-product-picker-results').classList.add('hidden');
  window.onPOProductChange();
};

document.addEventListener('click', (e) => {
  const input = document.getElementById('po-product-search');
  const results = document.getElementById('po-product-picker-results');
  if (input && results && !input.contains(e.target) && !results.contains(e.target)) {
    results.classList.add('hidden');
  }
});

window.renderPOCartList = function() {
  const container = document.getElementById('po-cart-list');
  // Editable worksheet: qty/cost are live inputs, not static text — adjusting either
  // recalculates that row's total and the grand total in place (window.updatePOItemField)
  // without re-rendering the whole list, so the input being typed into never loses focus.
  container.innerHTML = poTempItems.length ? poTempItems.map((item, idx) => `
          <div class="flex items-center gap-2 bg-slate-50 p-2.5 rounded-xl border text-xs">
            <div class="flex-1 min-w-0">
              <b class="text-slate-800 block truncate">${escapeHTML(item.productName)}</b>
              <div class="flex items-center gap-1.5 mt-1">
                <input type="number" min="0" step="any" value="${item.qty}" oninput="window.updatePOItemField(${idx},'qty',this.value)" class="w-16 border rounded-lg text-center py-1 font-bold outline-none focus:ring-2 focus:ring-indigo-500">
                <span class="text-slate-400">ชิ้น ×</span>
                <input type="number" min="0" step="any" value="${item.cost}" oninput="window.updatePOItemField(${idx},'cost',this.value)" class="w-20 border rounded-lg text-center py-1 font-bold outline-none focus:ring-2 focus:ring-indigo-500">
                <span class="text-slate-400">บาท</span>
              </div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <b id="po-item-total-${idx}" class="text-indigo-600">฿${roundAmt(item.total).toFixed(2)}</b>
              <button onclick="poTempItems.splice(${idx},1); window.renderPOCartList();" title="ลบรายการนี้" class="text-rose-500 font-bold hover:bg-rose-50 rounded-lg w-6 h-6 flex items-center justify-center btn-touch">✕</button>
            </div>
          </div>
        `).join('') : `<p class="text-center text-slate-400 font-bold py-6 text-xs">ยังไม่มีรายการ — ค้นหาสินค้าด้านบนเพื่อเพิ่ม</p>`;
  window.updatePOGrandTotal();
};

window.updatePOItemField = function(idx, field, value) {
  const item = poTempItems[idx];
  if (!item) return;
  item[field] = Math.max(0, parseFloat(value) || 0);
  item.total = roundAmt(item.qty * item.cost);
  const totalEl = document.getElementById(`po-item-total-${idx}`);
  if (totalEl) totalEl.innerText = `฿${item.total.toFixed(2)}`;
  window.updatePOGrandTotal();
};

window.updatePOGrandTotal = function() {
  const grandTotal = poTempItems.reduce((a, x) => roundAmt(a + x.total), 0);
  document.getElementById('po-grand-total').innerText = formatMoney(grandTotal);
};

window.clearPOList = function() {
  if (poTempItems.length && !confirm('ล้างรายการที่เพิ่มไว้ทั้งหมด?')) return;
  poTempItems.length = 0;
  window.renderPOCartList();
};

// ---- Delivery note attachments (ใบส่งของ) — kept as accounting evidence ----
// Supports multiple files per receipt (a delivery note is often more than one page/photo)
// and both images (compressed client-side) and PDFs (kept as-is, shown with a document
// icon since a thumbnail can't be rendered without an extra PDF-rendering library).
let poDeliveryNoteFiles = []; // [{ dataUrl, mime, name }]

window.handleDeliveryNoteSelect = function(e) {
  const files = Array.from(e.target.files || []);
  files.forEach(file => {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = function(evt) {
      if (isPdf) {
        poDeliveryNoteFiles.push({ dataUrl: evt.target.result, mime: 'application/pdf', name: file.name });
        window.renderDeliveryNotePreview();
        return;
      }
      const img = new Image();
      img.onload = function() {
        // Downscale/compress client-side — a phone camera photo can be several MB, which
        // would be slow to upload and wasteful to keep as an offline localStorage fallback.
        const maxDim = 1280;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        poDeliveryNoteFiles.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.72), mime: 'image/jpeg', name: file.name });
        window.renderDeliveryNotePreview();
      };
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  });
  e.target.value = ''; // allow re-selecting the same file again if removed and re-added
};

window.renderDeliveryNotePreview = function() {
  const wrap = document.getElementById('po-delivery-note-preview');
  if (!wrap) return;
  if (!poDeliveryNoteFiles.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  wrap.innerHTML = poDeliveryNoteFiles.map((f, idx) => `
          <div class="relative">
            ${f.mime === 'application/pdf'
        ? `<div class="w-24 h-24 flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-indigo-200 bg-indigo-50 shadow-sm p-1">
                   <span class="text-3xl">📄</span>
                   <span class="text-[9px] font-bold text-indigo-700 text-center line-clamp-2 px-1">${escapeHTML(f.name)}</span>
                 </div>`
        : `<img src="${f.dataUrl}" class="w-24 h-24 object-cover rounded-xl border-2 border-indigo-200 shadow-sm">`
      }
            <button onclick="window.removeDeliveryNote(${idx})" class="absolute -top-2 -right-2 w-6 h-6 bg-rose-500 hover:bg-rose-600 text-white rounded-full text-xs font-bold flex items-center justify-center shadow btn-touch">✕</button>
          </div>
        `).join('');
};

window.removeDeliveryNote = function(idx) {
  poDeliveryNoteFiles.splice(idx, 1);
  window.renderDeliveryNotePreview();
};

window.clearDeliveryNote = function() {
  poDeliveryNoteFiles = [];
  const inputEl = document.getElementById('po-delivery-note-input');
  if (inputEl) inputEl.value = '';
  window.renderDeliveryNotePreview();
};

window.addItemToPOList = function() {
  const pid = document.getElementById('po-product-picker-value').value;
  const qty = parseFloat(document.getElementById('po-item-qty').value) || 0;
  const cost = parseFloat(document.getElementById('po-item-cost').value) || 0;
  if (!pid || qty <= 0) return window.showAlert ? window.showAlert("ข้อมูลไม่ครบ", "กรุณาค้นหาและเลือกสินค้า พร้อมระบุจำนวนให้ถูกต้อง", true) : alert("กรุณาเลือกสินค้าและระบุจำนวนให้ถูกต้อง");

  const p = db.products[pid];
  poTempItems.push({ productId: pid, productName: p.name, qty, cost, total: roundAmt(qty * cost) });
  window.renderPOCartList();

  // Reset the picker so the next item can be searched for immediately.
  document.getElementById('po-product-search').value = '';
  document.getElementById('po-product-picker-value').value = '';
  document.getElementById('po-item-qty').value = '';
  document.getElementById('po-item-cost').value = '';
};

// Populates the supplier dropdown and clears/resets the product search picker so it's
// ready to search fresh (e.g. after the product catalog changes elsewhere).
// BUG FIX: this function was called from three places (showView, saveSupplier,
// saveProduct/deleteProduct) via `window.populatePOPickers?.()` and `window.renderPOPicker?.()`
// but neither was ever actually defined anywhere — the supplier select was silently,
// permanently empty, so a supplier could never be chosen and the whole "receive goods"
// feature was unusable no matter what confirmReceivePO() did.
window.populatePOPickers = function() {
  const supSel = document.getElementById('po-supplier-select');
  if (supSel) {
    const cur = supSel.value;
    // Use the dictionary key (not s.id) as the option value — keeps the AP/PO record's
    // supplierId consistent with how db.suppliers is actually keyed and looked up elsewhere,
    // even for the seed supplier whose internal .id field doesn't match its key.
    supSel.innerHTML = `<option value="">-- เลือกซัพพลายเออร์ --</option>` +
      Object.entries(db.suppliers || {}).map(([key, s]) =>
        `<option value="${key}">${escapeHTML(s.name)} (เครดิต ${s.terms} วัน)</option>`
      ).join('');
    if (cur && db.suppliers[cur]) supSel.value = cur;
  }

  const resultsEl = document.getElementById('po-product-picker-results');
  if (resultsEl) resultsEl.classList.add('hidden');
};
// Alias: showView() calls this name specifically when opening the po-receive view.
window.renderPOPicker = window.populatePOPickers;

window.confirmReceivePO = function() {
  // Superseded by the atomic version in the Enterprise Management Repair Layer
  // (creates the purchase-order record, sets accounts payable, and syncs stock/cost
  // to Supabase). Kept only as a safety no-op in case that layer fails to load.
  return window.showAlert ? window.showAlert("เกิดข้อผิดพลาด", "ไม่สามารถโหลดระบบรับสินค้าได้ กรุณารีเฟรชหน้าเว็บ", true) : alert("กรุณารีเฟรชหน้าเว็บ");
};
