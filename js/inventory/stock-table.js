/* =============================================================================
 * js/inventory/stock-table.js
 * ตารางสต็อกสินค้า: ค้นหา, กรอง, เรียง
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * resetStockFilters, setStockSort, renderStockTable
 * ============================================================================= */

// ==========================================
// COMPREHENSIVE PRODUCT TABLE RENDER
// ==========================================
window.resetStockFilters = function() {
  document.getElementById('stock-search-input').value = '';
  document.getElementById('stock-category-filter').value = 'ALL';
  document.getElementById('stock-status-filter').value = 'ALL';
  stockSortBy = 'name';
  stockSortDir = 'asc';
  window.renderStockTable();
};

// Toggles sort direction when clicking the same column again, matching the familiar
// spreadsheet convention (click once = ascending, click again = descending).
window.setStockSort = function(field) {
  if (stockSortBy === field) {
    stockSortDir = stockSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    stockSortBy = field;
    stockSortDir = 'asc';
  }
  window.renderStockTable();
};

window.renderStockTable = function() {
  // Clear any selection on every re-render (search/filter/sort change the row set, so a
  // stale selection referencing rows no longer shown would be confusing) — also hides
  // the bulk toolbar until the user checks something again.
  selectedProductIds.clear();
  window.updateBulkToolbar();

  const search = document.getElementById('stock-search-input').value.toLowerCase();
  const catFilter = document.getElementById('stock-category-filter').value;
  const statusFilter = document.getElementById('stock-status-filter').value;
  const tbody = document.getElementById('stock-table-body');

  const catSel = document.getElementById('stock-category-filter');
  if (catSel.options.length <= 1) {
    catSel.innerHTML = `<option value="ALL">📁 หมวดหมู่ทั้งหมด</option>` +
      db.categories.map(c => `<option value="${escapeHTML(c.name)}">${escapeHTML(c.name)}</option>`).join('');
  }

  // Reflect the active sort column/direction on the column headers.
  document.querySelectorAll('[id^="sort-arrow-"]').forEach(el => el.innerHTML = '');
  const activeArrow = document.getElementById('sort-arrow-' + stockSortBy);
  if (activeArrow) activeArrow.innerHTML = stockSortDir === 'asc' ? '▲' : '▼';

  let flt = [];
  Object.values(db.products).forEach(p => {
    (p.variants || []).forEach((v) => {
      const isMatchSearch = p.name.toLowerCase().includes(search) ||
                           (p.code || '').toLowerCase().includes(search) ||
                           (v.barcode || '').toLowerCase().includes(search);
      const isMatchCat = catFilter === 'ALL' || (p.cat && p.cat.includes(catFilter));
      const stock = roundStock(v.stock);
      const isOut = stock <= 0;
      const isBelowMin = !isOut && stock <= roundStock(v.minStock || 10);
      let isMatchStatus = true;
      if (statusFilter === 'LOW') isMatchStatus = isBelowMin;
      else if (statusFilter === 'OUT') isMatchStatus = isOut;
      else if (statusFilter === 'NORMAL') isMatchStatus = !isOut && !isBelowMin;

      if (isMatchSearch && isMatchCat && isMatchStatus) {
        flt.push({ p, v, isBelowMin, isOut });
      }
    });
  });

  document.getElementById('stock-total-count').innerText = flt.length;
  const totalStockValue = flt.reduce((s, item) => s + ((+item.v.cost || 0) * (+item.v.stock || 0)), 0);
  document.getElementById('stock-total-value').innerText = '฿' + roundAmt(totalStockValue).toLocaleString('th-TH');

  // Sorting — every data column is sortable, toggling asc/desc on repeated clicks.
  const dir = stockSortDir === 'desc' ? -1 : 1;
  const sorters = {
    name: (a, b) => naturalCompare(a.p.name, b.p.name) * dir,
    code: (a, b) => naturalCompare(a.p.code || '', b.p.code || '') * dir,
    barcode: (a, b) => naturalCompare(a.v.barcode || '', b.v.barcode || '') * dir,
    cost: (a, b) => ((a.v.cost || 0) - (b.v.cost || 0)) * dir,
    price: (a, b) => ((a.v.price || 0) - (b.v.price || 0)) * dir,
    stock: (a, b) => ((a.v.stock || 0) - (b.v.stock || 0)) * dir,
    margin: (a, b) => (((a.v.price || 0) - (a.v.cost || 0)) - ((b.v.price || 0) - (b.v.cost || 0))) * dir,
    stockvalue: (a, b) => (((a.v.cost || 0) * (a.v.stock || 0)) - ((b.v.cost || 0) * (b.v.stock || 0))) * dir,
    cat: (a, b) => (((a.p.cat && a.p.cat[0]) || '').localeCompare(((b.p.cat && b.p.cat[0]) || ''), 'th')) * dir
  };
  if (sorters[stockSortBy]) flt.sort(sorters[stockSortBy]);

  if (flt.length === 0) {
    tbody.innerHTML = `<tr><td colspan="14" class="p-8 text-center text-slate-400 font-bold">ไม่พบรายการสินค้าที่ตรงเงื่อนไข</td></tr>`;
    return;
  }

  tbody.innerHTML = flt.map((item, idx) => {
    const p = item.p, v = item.v, isBelowMin = item.isBelowMin, isOut = item.isOut;
    const fractionsHtml = (v.fractions || []).map(f => `
            <span class="inline-block bg-slate-100 border rounded px-1.5 py-0.5 mr-1 mb-1 text-[10px] font-bold text-slate-600">
              ${escapeHTML(f.fractionName)} (x${f.fractionMultiplier}) = ฿${f.fractionPrice}
            </span>
          `).join('');

    const imgThumb = p.imageUrl
      ? `<img src="${escapeHTML(p.imageUrl)}" class="w-8 h-8 object-cover rounded-lg border mx-auto">`
      : `<span class="text-2xl">${escapeHTML(p.image || '📦')}</span>`;

    const stockBadge = isOut
      ? `<span class="text-rose-600 bg-rose-50">${v.stock} ชิ้น<span class="block text-[8px]">❌ หมดสต็อก</span></span>`
      : isBelowMin
        ? `<span class="text-amber-600 bg-amber-50">${v.stock} ชิ้น<span class="block text-[8px]">⚠️ ต่ำกว่าเกณฑ์</span></span>`
        : `<span class="text-emerald-600">${v.stock} ชิ้น</span>`;

    // Group badge — a product with more than one variant is effectively a "group" (see
    // the merge/split tools); this makes that visible at a glance in the table too.
    const groupBadge = (p.variants || []).length > 1
      ? `<span class="block text-[9px] text-indigo-500 font-bold mt-0.5">🔗 กลุ่ม ${p.variants.length} ขนาด</span>` : '';

    // เพิ่มขึ้นมา: ตารางเดิมไม่มีคอลัมน์กำไร/มูลค่าสต็อกเลย ทำให้ต้องเปิดดูทีละตัวเอง
    const cost = +v.cost || 0, price = +v.price || 0, stockQty = +v.stock || 0;
    const profit = roundAmt(price - cost);
    const marginPct = cost > 0 ? Math.round((profit / cost) * 100) : (price > 0 ? 100 : 0);
    const stockValue = roundAmt(cost * stockQty);
    const minStock = roundStock(v.minStock || 10);

    return `
            <tr class="hover:bg-indigo-50/40 border-b even:bg-slate-50/60 transition-colors">
              <td class="p-3 text-center"><input type="checkbox" class="stock-row-checkbox w-4 h-4 rounded accent-indigo-600" data-pid="${p.id}" ${selectedProductIds.has(p.id) ? 'checked' : ''} onchange="window.toggleProductSelection('${p.id}', this.checked)"></td>
              <td class="p-3 text-center font-bold text-slate-400">${idx + 1}</td>
              <td class="p-3 text-center">${imgThumb}</td>
              <td class="p-3 whitespace-nowrap">
                <span class="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-full px-2 py-0.5">
                  ${escapeHTML((p.cat && p.cat[0]) || 'งานทั่วไป')}
                </span>
              </td>
              <td class="p-3 font-bold text-slate-800 text-xs max-w-[220px] break-words">${escapeHTML(p.name)} <span class="text-slate-400 text-[10px]">(${escapeHTML(v.sizeName)})</span>${groupBadge}</td>
              <td class="p-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">${escapeHTML(p.code || p.id)}</td>
              <td class="p-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">${escapeHTML(v.barcode || '-')}</td>
              <td class="p-3 text-right tabular-nums whitespace-nowrap">฿${v.cost || 0}</td>
              <td class="p-3 text-right tabular-nums font-bold text-indigo-600 whitespace-nowrap">฿${v.price || 0}</td>
              <td class="p-3 text-right tabular-nums whitespace-nowrap"><span class="${profit >= 0 ? 'text-emerald-600' : 'text-rose-600'} font-bold">฿${profit}</span><span class="block text-[9px] text-slate-400">${marginPct}%</span></td>
              <td class="p-3 text-center font-black text-xs rounded-lg whitespace-nowrap">${stockBadge}</td>
              <td class="p-3 text-center text-[11px] text-slate-500 whitespace-nowrap">${minStock}</td>
              <td class="p-3 text-right tabular-nums text-[11px] text-slate-600 whitespace-nowrap">฿${stockValue.toLocaleString('th-TH')}</td>
              <td class="p-3 max-w-[200px]">${fractionsHtml || '<span class="text-slate-300">-</span>'}</td>
              <td class="p-3 text-center whitespace-nowrap">
                <button onclick="window.openProductModal('${p.id}')" class="text-indigo-600 font-bold mr-2 hover:underline btn-touch">แก้ไข</button>
                <button onclick="window.deleteProduct('${p.id}')" class="text-rose-500 font-bold hover:underline btn-touch">ลบ</button>
              </td>
            </tr>
          `;
  }).join('');
};
