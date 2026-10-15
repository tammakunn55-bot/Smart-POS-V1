/* =============================================================================
 * js/settings/import-excel.js
 * นำเข้าสินค้าจากไฟล์ Excel (จัดกลุ่มตามชื่อ, พรีวิว, คำเตือน, นำเข้าซ้ำ = อัปเดต)
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * handleOpeningStockFile, confirmOpeningStockImport
 * ============================================================================= */

window.handleOpeningStockFile = function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(evt) {
    try {
      const wb = XLSX.read(new Uint8Array(evt.target.result), { type: 'array' });
      const sheetName = wb.SheetNames.includes('รายการสินค้า') ? 'รายการสินค้า' : wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
      const num = v => { const n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
      const txt = v => String(v == null ? '' : v).normalize('NFC').trim();
      const pick = (r, ...keys) => { for (const k of keys) { if (r[k] !== undefined && r[k] !== '') return r[k]; } return ''; };
      const groups = new Map();
      const seenSku = new Set(), seenBar = new Set();
      const warn = { zeroPrice: [], noCost: 0, dupSku: 0, dupBar: 0, noImage: 0 };

      rows.forEach((r, idx) => {
        const name = txt(pick(r, 'ชื่อสินค้า', 'ชื่อ', 'Name'));
        if (!name) return;
        let sku = txt(pick(r, 'SKU', 'รหัสสินค้า', 'รหัส', 'Code')) || ('IMP-' + (idx + 2));
        if (seenSku.has(sku)) { warn.dupSku++; sku = sku + '-DUP' + (idx + 2); }
        seenSku.add(sku);
        let barcode = txt(pick(r, 'บาร์โค้ด', 'Barcode')) || sku;
        if (seenBar.has(barcode)) { warn.dupBar++; barcode = sku; }
        if (seenBar.has(barcode)) barcode = sku + '-' + (idx + 2);
        seenBar.add(barcode);
        const cost = num(pick(r, 'ราคาทุน', 'ทุน', 'Cost'));
        const price = num(pick(r, 'ราคาขาย', 'ราคา', 'Price'));
        const image = txt(pick(r, 'ไฟล์รูปภาพ'));
        if (price <= 0) warn.zeroPrice.push(`${name} (${sku})`);
        if (cost <= 0) warn.noCost++;
        if (!image) warn.noImage++;
        let g = groups.get(name);
        if (!g) {
          g = { name, category: txt(pick(r, 'หมวดหมู่', 'Category')), code: txt(pick(r, 'รหัสสินค้าหลัก')) || sku, variants: [] };
          groups.set(name, g);
        }
        g.variants.push({
          id: 'v_imp_' + sku.replace(/\s+/g, '_'), sku, barcode,
          sizeName: txt(pick(r, 'ขนาด', 'ไซส์', 'Size')) || 'ปกติ',
          cost, price, stock: Math.max(0, num(pick(r, 'ยอดยกมา', 'คงเหลือ', 'Stock')))
        });
      });

      const usedCodes = new Set();
      pendingImportList = Array.from(groups.values()).map(g => {
        let code = g.code, n = 1;
        while (usedCodes.has(code)) code = g.code + '-G' + (++n);
        usedCodes.add(code); g.code = code;
        g.exists = !!Object.values(db.products).find(p => p.code === code);
        return g;
      });
      if (!pendingImportList.length) return window.showAlert?.('ไม่พบข้อมูล', 'ไม่พบแถวสินค้าในไฟล์ (ต้องมีคอลัมน์ "ชื่อสินค้า")', true);

      const nVar = pendingImportList.reduce((a, g) => a + g.variants.length, 0);
      const nExist = pendingImportList.filter(g => g.exists).length;
      document.getElementById('import-preview-box').classList.remove('hidden');
      document.getElementById('import-preview-table').innerHTML = `
              <div class="p-3 text-xs bg-indigo-50 border-b leading-relaxed">
                <b>${pendingImportList.length}</b> สินค้า (<b>${nVar}</b> ขนาด/รายการ) • ใหม่ <b>${pendingImportList.length - nExist}</b> • อัปเดตของเดิม <b>${nExist}</b><br>
                ${warn.zeroPrice.length ? `<span class="text-rose-600 font-bold">⚠️ ราคาขาย 0 บาท ${warn.zeroPrice.length} รายการ</span> • ` : ''}
                ${warn.noCost ? `<span class="text-amber-600 font-bold">ไม่มีราคาทุน ${warn.noCost} รายการ (กำไรจะคำนวณไม่ได้)</span> • ` : ''}
                ${warn.dupSku ? `รหัสซ้ำที่แก้อัตโนมัติ ${warn.dupSku} • ` : ''}${warn.dupBar ? `บาร์โค้ดซ้ำ ${warn.dupBar} • ` : ''}ไม่มีรูป ${warn.noImage}
              </div>
              <table class="w-full text-left text-xs">
                <thead class="bg-slate-100 font-bold"><tr><th class="p-2">ชื่อ</th><th class="p-2">หมวดหมู่</th><th class="p-2">ขนาด</th><th class="p-2">ราคาขาย</th><th class="p-2"></th></tr></thead>
                <tbody class="divide-y">${pendingImportList.slice(0, 150).map(g => {
            const ps = g.variants.map(v => v.price).filter(x => x > 0);
            const lo = ps.length ? Math.min(...ps) : 0, hi = ps.length ? Math.max(...ps) : 0;
            return `<tr><td class="p-2">${escapeHTML(g.name)}</td><td class="p-2">${escapeHTML(g.category || 'อื่นๆ')}</td><td class="p-2">${g.variants.length}</td><td class="p-2">${lo === hi ? formatMoney(lo) : formatMoney(lo) + ' – ' + formatMoney(hi)}</td><td class="p-2 text-[10px] font-bold ${g.exists ? 'text-amber-600' : 'text-emerald-600'}">${g.exists ? 'อัปเดต' : 'ใหม่'}</td></tr>`;
          }).join('')}${pendingImportList.length > 150 ? `<tr><td class="p-2 text-slate-400" colspan="5">… และอีก ${pendingImportList.length - 150} รายการ</td></tr>` : ''}</tbody>
              </table>`;
      if (warn.zeroPrice.length) window.showAlert?.('พบสินค้าราคาขาย 0 บาท', warn.zeroPrice.slice(0, 15).join('\n') + (warn.zeroPrice.length > 15 ? `\n… และอีก ${warn.zeroPrice.length - 15} รายการ` : '') + '\n\nแก้ราคาก่อน/หลังนำเข้าได้ — ระบบจะยังนำเข้ารายการเหล่านี้', true);
    } catch (err) {
      console.error(err);
      window.showAlert?.('อ่านไฟล์ไม่สำเร็จ', err.message || String(err), true);
    }
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
};

window.confirmOpeningStockImport = function() {
  if (!pendingImportList.length) return;
  window.seedYojiCategories();
  db.categories = db.categories || [];
  const catNames = new Set(db.categories.map(c => c.name));
  let added = 0, updated = 0;
  pendingImportList.forEach(g => {
    const cat = (g.category && g.category !== 'ไม่ระบุหมวด') ? g.category : 'อื่นๆ';
    if (!catNames.has(cat)) {   // หมวดจากไฟล์ที่ยังไม่มีในระบบ — สร้างให้ตามชื่อในไฟล์ (เดิมตกไป "อื่นๆ" ถ้าไม่อยู่ในตารางแม็ป)
      db.categories.push({ id: 'cat-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: cat, icon: '📦', color: '#64748b' });
      catNames.add(cat);
    }
    const existing = Object.values(db.products).find(p => p.code === g.code && !p.isDeleted);
    const mk = nv => ({ id: nv.id, sizeName: nv.sizeName, sku: nv.sku, barcode: nv.barcode, cost: nv.cost, price: nv.price, stock: nv.stock, fractions: [] });
    if (existing) {
      existing.name = g.name; existing.cat = [cat];
      existing.variants = existing.variants || [];
      g.variants.forEach(nv => {
        const lv = existing.variants.find(v => (nv.sku && v.sku === nv.sku) || (nv.barcode && v.barcode === nv.barcode));
        if (lv) {   // อัปเดตราคา/ทุนที่มีค่าเท่านั้น และ "ไม่แตะสต็อกเดิม" (นำเข้าซ้ำจะไม่ล้างยอดคงเหลือ)
          if (nv.price > 0) lv.price = nv.price;
          if (nv.cost > 0) lv.cost = nv.cost;
          if (!lv.sku) lv.sku = nv.sku;
        } else existing.variants.push(mk(nv));
      });
      updated++;
    } else {
      const pid = 'imp-' + g.code.replace(/\s+/g, '_');
      db.products[pid] = { id: pid, name: g.name, code: g.code, cat: [cat], image: '📦', imageUrl: null, minStock: 5, variants: g.variants.map(mk) };
      added++;
    }
  });
  window.persist?.();
  window.renderCategoryManagerList?.();
  window.renderCategoryParentOptions?.();
  window.renderStockTable?.();
  window.renderSaleHome?.();
  window.populatePOPickers?.();
  window.showToast?.(`นำเข้าสินค้าใหม่ ${added} • อัปเดต ${updated} รายการเรียบร้อย — ถัดไปให้นำเข้ารูปภาพ แล้วกดซิงค์`);
  window.syncProductsToSupabase?.(true);
  pendingImportList = [];
  document.getElementById('import-preview-box').classList.add('hidden');
};
