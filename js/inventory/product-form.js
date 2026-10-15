/* =============================================================================
 * js/inventory/product-form.js
 * ฟอร์มเพิ่ม/แก้สินค้า: รูป, สแกนบาร์โค้ด, หลายขนาด, หน่วยแบ่งขาย
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * togglePmCategoryDropdown, renderPmCategoryDropdown, togglePmCategory,
 * updatePmCategorySummary, handleProductPhotoSelect, updateProductEmojiPreview,
 * addProductVariantRow, renderProductVariantList, updatePMVariantField, removePMVariant,
 * splitPMVariantOut, openAddFractionModal, confirmAddFraction, removePMFraction,
 * openProductModal, _pmDuplicateImageUrl, openDuplicateProductPicker,
 * closeDuplicateProductPicker, filterDuplicateProductPicker, applyProductDuplicate,
 * saveProduct, deleteProduct, confirmReceivePO, renderPurchaseHistory, markAPPaid
 * ============================================================================= */

// ส่วนนี้เป็น IIFE แยกของตัวเอง (เดิมอยู่ใน IIFE เดียวกับ auth/session.js) จึงประกาศตัวช่วยที่ใช้ซ้ำไว้ตรงนี้
(function(){
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const sb=()=>window.getSupabase?.()||null;
const ok=p=>window.canDo(p)||(window.showAlert?.('ไม่มีสิทธิ์','บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',true),false);
const persist=()=>window.persist();
const ensure=()=>window.ensure();

// ==========================================
// PRODUCT FORM — modernized: photo capture, barcode scan-to-field, multiple sizes/variants
// per product added in one form, and split-sale ("แบ่งขาย") units manageable per variant.
// BUG FIX: the old single-variant form always saved `variants:[{...one row...}]` — editing an
// existing product that had more than one size (e.g. pulled in from Supabase) silently
// DISCARDED every size but the first the moment it was saved. Now every existing variant loads
// into the editable list and is preserved.
// ==========================================
let pmVariants = [];
let pmSelectedCats = []; // multi-category selection state for the product being edited

// สินค้าหนึ่งชิ้นเลือกได้หลายหมวดหมู่พร้อมกัน (ติ๊กได้หลายอัน) แทนแบบเดิมที่บังคับเลือกได้
// หมวดเดียว — ให้ผลลัพธ์ตรงกับตาราง product_categories (many-to-many) ที่ฝั่ง sync ไป
// Supabase คาดหวังไว้อยู่แล้ว ทำให้ค้นหา/กรองสินค้าจากหลายหมวดได้ง่ายขึ้นโดยไม่ต้อง
// สร้างสินค้าซ้ำหลายรายการสำหรับของชิ้นเดียวที่เข้าได้กับหลายหมวด
window.togglePmCategoryDropdown = function() {
  const box = document.getElementById('pm-category-dropdown');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) {
    setTimeout(() => document.addEventListener('click', function closeOnce(e) {
      if (!box.contains(e.target) && e.target.id !== 'pm-category-btn' && !document.getElementById('pm-category-btn').contains(e.target)) {
        box.classList.add('hidden');
        document.removeEventListener('click', closeOnce);
      }
    }), 0);
  }
};

window.renderPmCategoryDropdown = function() {
  const box = document.getElementById('pm-category-dropdown');
  const topLevel = (db.categories || []).filter(c => !c.parentId);
  const childrenOf = pid => (db.categories || []).filter(c => c.parentId === pid);
  const rowHtml = (c, indent) => `
    <label class="flex items-center gap-2 py-1.5 text-xs font-bold text-slate-600 cursor-pointer" style="padding-left:${indent * 14}px">
      <input type="checkbox" value="${esc(c.name)}" ${pmSelectedCats.includes(c.name) ? 'checked' : ''} onchange="window.togglePmCategory('${esc(c.name)}', this.checked)" class="w-4 h-4 rounded accent-emerald-600">
      ${indent ? '↳ ' : ''}${esc(c.icon || '📁')} ${esc(c.name)}
    </label>`;
  let html = '';
  topLevel.forEach(c => { html += rowHtml(c, 0); childrenOf(c.id).forEach(ch => html += rowHtml(ch, 1)); });
  box.innerHTML = html || `<p class="text-slate-400 text-[11px] py-2">ยังไม่มีหมวดหมู่ — เพิ่มได้ที่ปุ่ม 📁 จัดการหมวดหมู่</p>`;
  window.updatePmCategorySummary();
};

window.togglePmCategory = function(name, checked) {
  if (checked && !pmSelectedCats.includes(name)) pmSelectedCats.push(name);
  if (!checked) pmSelectedCats = pmSelectedCats.filter(n => n !== name);
  window.updatePmCategorySummary();
};

window.updatePmCategorySummary = function() {
  const el = document.getElementById('pm-category-summary');
  el.textContent = pmSelectedCats.length ? pmSelectedCats.join(', ') : 'เลือกหมวดหมู่';
};
let pmPhotoDataUrl = null;
let pmPhotoChanged = false;

window.handleProductPhotoSelect = function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(evt) {
    const img = new Image();
    img.onload = function() {
      const maxDim = 800;
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale); height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      pmPhotoDataUrl = canvas.toDataURL('image/jpeg', 0.75);
      pmPhotoChanged = true;
      document.getElementById('pm-photo-preview').src = pmPhotoDataUrl;
      document.getElementById('pm-photo-preview').classList.remove('hidden');
      document.getElementById('pm-photo-placeholder').classList.add('hidden');
      document.getElementById('pm-image').value = ''; // photo takes priority over emoji
    };
    img.src = evt.target.result;
  };
  reader.readAsDataURL(file);
};

// Typing an emoji cancels any selected photo, so it's always clear which one will be used.
window.updateProductEmojiPreview = function() {
  if (document.getElementById('pm-image').value.trim()) {
    pmPhotoDataUrl = null; pmPhotoChanged = true;
    document.getElementById('pm-photo-preview').classList.add('hidden');
    document.getElementById('pm-photo-placeholder').classList.remove('hidden');
  }
};

window.addProductVariantRow = function() {
  const name = document.getElementById('pmv-name').value.trim();
  const barcode = document.getElementById('pmv-barcode').value.trim();
  const cost = parseFloat(document.getElementById('pmv-cost').value) || 0;
  const price = parseFloat(document.getElementById('pmv-price').value) || 0;
  const stock = parseFloat(document.getElementById('pmv-stock').value) || 0;
  if (!name || price <= 0) return window.showAlert?.('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อขนาด/รุ่น และราคาขายให้ถูกต้อง', true);

  pmVariants.push({ id: 'v-' + Date.now() + Math.random().toString(36).slice(2, 5), sizeName: name, barcode, cost, price, stock, minStock: 5, fractions: [] });
  ['pmv-name', 'pmv-barcode', 'pmv-cost', 'pmv-price', 'pmv-stock'].forEach(id => document.getElementById(id).value = '');
  window.renderProductVariantList();
};

window.renderProductVariantList = function() {
  const container = document.getElementById('pm-variant-list');
  container.innerHTML = pmVariants.length ? pmVariants.map((v, idx) => `
    <div class="bg-slate-50 p-2.5 rounded-xl border text-xs">
      <div class="flex items-center gap-2">
        <div class="flex-1 min-w-0">
          <b class="text-slate-800 block truncate">${escapeHTML(v.sizeName)}</b>
          <span class="text-[10px] text-slate-400">${v.barcode ? 'บาร์โค้ด ' + escapeHTML(v.barcode) : 'ไม่มีบาร์โค้ด'}</span>
        </div>
        ${pmVariants.length > 1 ? `<button onclick="window.splitPMVariantOut(${idx})" title="แยกออกเป็นสินค้าใหม่" class="flex-shrink-0 w-6 h-6 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-600 flex items-center justify-center btn-touch">↗️</button>` : ''}
        <button onclick="window.removePMVariant(${idx})" class="text-rose-500 font-bold hover:bg-rose-50 rounded-lg w-6 h-6 flex items-center justify-center btn-touch">✕</button>
      </div>
      <div class="flex items-center gap-1.5 mt-1.5">
        <span class="text-slate-400 text-[10px]">ทุน</span>
        <input type="number" step="0.01" value="${v.cost}" oninput="window.updatePMVariantField(${idx},'cost',this.value)" class="w-16 border rounded-lg text-center py-1 outline-none">
        <span class="text-slate-400 text-[10px]">ขาย</span>
        <input type="number" step="0.01" value="${v.price}" oninput="window.updatePMVariantField(${idx},'price',this.value)" class="w-16 border rounded-lg text-center py-1 font-bold outline-none">
        <span class="text-slate-400 text-[10px]">สต็อก</span>
        <input type="number" step="0.01" value="${v.stock}" oninput="window.updatePMVariantField(${idx},'stock',this.value)" class="w-16 border rounded-lg text-center py-1 outline-none">
        <button onclick="window.openAddFractionModal(${idx})" title="ตั้งสินค้าแบ่งขาย" class="ml-auto flex-shrink-0 flex items-center gap-1 px-2 h-7 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 text-[10px] font-bold btn-touch whitespace-nowrap">✂️ ตั้งแบ่งขาย</button>
      </div>
      ${(v.fractions || []).length ? `<div class="flex flex-wrap gap-1 mt-1.5">${v.fractions.map((f, fi) => `
        <span class="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-700 rounded-full px-2 py-0.5 text-[10px] font-bold">
          ✂️ ${escapeHTML(f.fractionName)} ฿${f.fractionPrice}
          <button onclick="window.removePMFraction(${idx},${fi})" class="text-amber-400 hover:text-rose-500">✕</button>
        </span>`).join('')}</div>` : ''}
    </div>
  `).join('') : `<p class="text-center text-slate-400 font-bold py-4 text-xs">ยังไม่มีขนาด/รุ่น — เพิ่มอย่างน้อย 1 รายการด้านบน</p>`;
};

window.updatePMVariantField = function(idx, field, value) {
  if (!pmVariants[idx]) return;
  pmVariants[idx][field] = Math.max(0, parseFloat(value) || 0);
};

window.removePMVariant = function(idx) {
  pmVariants.splice(idx, 1);
  window.renderProductVariantList();
};

// "เอาสินค้าออกจากกลุ่ม" — splits one variant out of the product currently being edited into
// its own brand-new standalone product. Only offered when the product is already saved (has
// an id) and has more than one variant, since splitting the only variant or a not-yet-saved
// draft doesn't have anything meaningful to split from.
window.splitPMVariantOut = function(idx) {
  const pid = document.getElementById('product-edit-id').value;
  if (!pid || !db.products[pid]) return window.showAlert?.('บันทึกก่อน', 'กรุณาบันทึกสินค้านี้ก่อน แล้วค่อยแยกขนาดออกเป็นสินค้าใหม่', true);
  if (pmVariants.length <= 1) return;
  const v = pmVariants[idx];
  if (!confirm(`แยก "${v.sizeName}" ออกเป็นสินค้าใหม่แยกต่างหาก?`)) return;

  const parent = db.products[pid];
  const newId = 'p-' + Date.now();
  db.products[newId] = {
    id: newId, name: v.sizeName, code: window.getAutoSku(), cat: [...(parent.cat || [])],
    image: parent.image, imageUrl: parent.imageUrl,
    minStock: v.minStock || 5, variants: [{ ...v }]
  };
  pmVariants.splice(idx, 1);
  parent.variants = pmVariants.map(x => ({ ...x }));
  window.persist?.();
  window.renderProductVariantList();
  window.renderStockTable();
  window.renderSaleHome?.();
  window.showToast?.(`แยก "${v.sizeName}" เป็นสินค้าใหม่แล้ว`);
  window.syncProductsToSupabase?.(true);
};

window.openAddFractionModal = function(variantIdx) {
  document.getElementById('frac-variant-idx').value = variantIdx;
  document.getElementById('frac-name').value = '';
  document.getElementById('frac-ratio').value = '';
  document.getElementById('frac-price').value = '';
  document.getElementById('modal-add-fraction').classList.remove('hidden');
  document.getElementById('modal-add-fraction').classList.add('flex');
};

window.confirmAddFraction = function() {
  const idx = parseInt(document.getElementById('frac-variant-idx').value);
  const name = document.getElementById('frac-name').value.trim();
  const ratio = parseFloat(document.getElementById('frac-ratio').value) || 0;
  const price = parseFloat(document.getElementById('frac-price').value) || 0;
  if (!name || ratio <= 0 || price <= 0) return window.showAlert?.('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อ จำนวนหน่วยย่อยต่อ 1 หน่วยหลัก และราคาให้ถูกต้อง', true);
  if (!pmVariants[idx]) return;

  pmVariants[idx].fractions = pmVariants[idx].fractions || [];
  pmVariants[idx].fractions.push({ id: 'f-' + Date.now(), fractionName: name, fractionMultiplier: roundStock(1 / ratio), fractionPrice: price });
  window.closeModal('modal-add-fraction');
  window.renderProductVariantList();
};

window.removePMFraction = function(variantIdx, fracIdx) {
  pmVariants[variantIdx]?.fractions?.splice(fracIdx, 1);
  window.renderProductVariantList();
};

window.openProductModal = function(id) {
  if (id && !ok('PRODUCT_EDIT')) return;
  if (!id && !ok('PRODUCT_CREATE')) return;

  const p = id ? db.products[id] : null;
  pmSelectedCats = (p?.cat || []).slice();
  window.renderPmCategoryDropdown();
  const set = (k, v) => document.getElementById(k).value = v ?? '';
  set('product-edit-id', id || '');
  set('pm-name', p?.name);
  set('pm-sku', p?.code);

  pmPhotoDataUrl = null; pmPhotoChanged = false; window._pmDuplicateImageUrl = null;
  if (p?.imageUrl) {
    document.getElementById('pm-photo-preview').src = p.imageUrl;
    document.getElementById('pm-photo-preview').classList.remove('hidden');
    document.getElementById('pm-photo-placeholder').classList.add('hidden');
    set('pm-image', '');
  } else {
    document.getElementById('pm-photo-preview').classList.add('hidden');
    document.getElementById('pm-photo-placeholder').classList.remove('hidden');
    set('pm-image', p?.image || '');
  }

  // Load EVERY existing variant (not just the first) so editing a multi-size product doesn't
  // silently drop the rest of its sizes.
  pmVariants = p ? p.variants.map(v => ({ ...v, fractions: (v.fractions || []).map(f => ({ ...f })) })) : [];
  window.renderProductVariantList();
  ['pmv-name', 'pmv-barcode', 'pmv-cost', 'pmv-price', 'pmv-stock'].forEach(fid => document.getElementById(fid).value = '');

  document.getElementById('product-modal-title').textContent = p ? '✏️ แก้ไขสินค้า' : '➕ เพิ่มสินค้า';
  // Only useful when adding a brand-new product — editing is already about one specific item.
  const dupWrap = document.getElementById('pm-duplicate-wrap');
  if (dupWrap) dupWrap.classList.toggle('hidden', !!p);
  window.closeDuplicateProductPicker?.();

  const m = document.getElementById('modal-product-manager');
  m.classList.remove('hidden'); m.classList.add('flex');
};

// ---- "คัดลอกจากสินค้าเดิม" — fast-start a new product from an existing one's category,
// photo, and sizes, instead of typing everything from scratch. Stock resets to 0 (a clone
// is a distinct new catalog entry, not the same physical stock) and barcodes are cleared
// (barcodes must stay unique per item); everything else carries over for quick editing. ----
window.openDuplicateProductPicker = function() {
  document.getElementById('pm-duplicate-wrap').querySelector('button').classList.add('hidden');
  const search = document.getElementById('pm-duplicate-search');
  search.classList.remove('hidden');
  search.value = '';
  search.focus();
  window.filterDuplicateProductPicker();
};

window.closeDuplicateProductPicker = function() {
  const btn = document.getElementById('pm-duplicate-wrap')?.querySelector('button');
  if (btn) btn.classList.remove('hidden');
  document.getElementById('pm-duplicate-search')?.classList.add('hidden');
  document.getElementById('pm-duplicate-results')?.classList.add('hidden');
};

window.filterDuplicateProductPicker = function() {
  const q = (document.getElementById('pm-duplicate-search').value || '').trim().toLowerCase();
  const resultsEl = document.getElementById('pm-duplicate-results');
  const all = Object.values(db.products || {});
  let matches = q
    ? all.filter(p => p.name.toLowerCase().includes(q) || (p.code || '').toLowerCase().includes(q))
    : all;
  matches = matches.slice(0, 40);

  resultsEl.innerHTML = matches.length ? matches.map(p => {
    const img = p.imageUrl
      ? `<img src="${escapeHTML(p.imageUrl)}" class="w-9 h-9 object-cover rounded-lg border flex-shrink-0">`
      : `<span class="w-9 h-9 flex items-center justify-center text-xl flex-shrink-0">${escapeHTML(p.image || '📦')}</span>`;
    return `
      <button type="button" onclick="window.applyProductDuplicate('${p.id}')" class="w-full flex items-center gap-2 p-2 hover:bg-indigo-50 text-left border-b last:border-0 btn-touch">
        ${img}
        <div class="flex-1 min-w-0">
          <div class="font-bold text-xs text-slate-800 truncate">${escapeHTML(p.name)}</div>
          <div class="text-[10px] text-slate-400">SKU: ${escapeHTML(p.code || '-')} • ${p.variants.length} ขนาด</div>
        </div>
      </button>`;
  }).join('') : `<div class="p-4 text-center text-slate-400 text-xs font-bold">ไม่พบสินค้าที่ค้นหา</div>`;
  resultsEl.classList.remove('hidden');
};

window.applyProductDuplicate = function(sourceId) {
  const src = db.products[sourceId];
  if (!src) return;

  document.getElementById('pm-name').value = src.name + ' (สำเนา)';
  document.getElementById('pm-sku').value = ''; // auto-generated fresh on save — SKUs must stay unique
  pmSelectedCats = (src.cat || []).slice();
  window.renderPmCategoryDropdown();

  pmPhotoDataUrl = null; pmPhotoChanged = false; window._pmDuplicateImageUrl = null;
  if (src.imageUrl) {
    document.getElementById('pm-photo-preview').src = src.imageUrl;
    document.getElementById('pm-photo-preview').classList.remove('hidden');
    document.getElementById('pm-photo-placeholder').classList.add('hidden');
    document.getElementById('pm-image').value = '';
    // Carried over by URL reference only (it's already hosted) — saveProduct checks
    // window._pmDuplicateImageUrl before its normal upload logic, so this doesn't get
    // needlessly re-uploaded as a new file.
    window._pmDuplicateImageUrl = src.imageUrl;
  } else {
    document.getElementById('pm-photo-preview').classList.add('hidden');
    document.getElementById('pm-photo-placeholder').classList.remove('hidden');
    document.getElementById('pm-image').value = src.image || '';
  }

  // Clone every size — new ids, barcode cleared (must stay unique), stock reset to 0 (a
  // duplicate is a new catalog entry, not the same physical inventory), price/cost carried over.
  pmVariants = src.variants.map(v => ({
    id: 'v-' + Date.now() + Math.random().toString(36).slice(2, 5),
    sizeName: v.sizeName, barcode: '', cost: v.cost, price: v.price, stock: 0, minStock: v.minStock || 5,
    fractions: (v.fractions || []).map(f => ({ id: 'f-' + Date.now() + Math.random().toString(36).slice(2, 5), fractionName: f.fractionName, fractionMultiplier: f.fractionMultiplier, fractionPrice: f.fractionPrice }))
  }));
  window.renderProductVariantList();

  window.closeDuplicateProductPicker();
  window.showToast?.(`คัดลอกจาก "${src.name}" แล้ว — ตรวจสอบและแก้ไขก่อนบันทึก`);
};

document.addEventListener('click', (e) => {
  const wrap = document.getElementById('pm-duplicate-wrap');
  if (wrap && !wrap.contains(e.target)) window.closeDuplicateProductPicker?.();
});

window.saveProduct = async function() {
  const id = document.getElementById('product-edit-id').value;
  if (id && !ok('PRODUCT_EDIT')) return;
  if (!id && !ok('PRODUCT_CREATE')) return;

  const name = document.getElementById('pm-name').value.trim();
  if (!name) return window.showAlert?.('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อสินค้า', true);
  if (!pmVariants.length) return window.showAlert?.('ข้อมูลไม่ครบ', 'กรุณาเพิ่มขนาด/รุ่นอย่างน้อย 1 รายการ', true);

  let sku = document.getElementById('pm-sku').value.trim();
  if (!sku) sku = window.getAutoSku(); // fast entry: don't block on a SKU nobody typed in

  const p = id ? db.products[id] : null;
  const pid = id || ('p-' + Date.now());

  let imageUrl = p?.imageUrl || null;
  let imageEmoji = document.getElementById('pm-image').value.trim() || (imageUrl ? '' : '📦');

  if (window._pmDuplicateImageUrl) {
    // Carried over from "คัดลอกจากสินค้าเดิม" — already a hosted URL, nothing to (re-)upload.
    imageUrl = window._pmDuplicateImageUrl;
    imageEmoji = '';
    window._pmDuplicateImageUrl = null;
  } else if (pmPhotoChanged) {
    if (pmPhotoDataUrl) {
      // Try to upload the compressed photo to Supabase Storage so it's usable across devices;
      // fall back to keeping the compressed data URL locally if offline or upload fails.
      try {
        const c = sb();
        if (c) {
          const blob = await (await fetch(pmPhotoDataUrl)).blob();
          const path = `${pid}_${Date.now()}.jpg`;
          const { error: upErr } = await c.storage.from('product-images').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
          if (!upErr) { const { data } = c.storage.from('product-images').getPublicUrl(path); imageUrl = data.publicUrl; }
          else { imageUrl = pmPhotoDataUrl; }
        } else {
          imageUrl = pmPhotoDataUrl;
        }
      } catch (e) { imageUrl = pmPhotoDataUrl; console.warn('product photo upload failed, kept locally', e); }
      imageEmoji = '';
    } else {
      imageUrl = null; // user cleared the photo in favor of an emoji
    }
  }

  const _oldProd = db.products[pid];
  db.products[pid] = {
    id: pid, name, code: sku, cat: pmSelectedCats.slice(),
    image: imageEmoji, imageUrl,
    minStock: pmVariants[0]?.minStock || 5,
    variants: pmVariants.map(v => ({ ...v }))
  };

  window.persist?.();
  window.closeModal('modal-product-manager');
  window.renderStockTable();
  window.renderSaleHome?.();
  window.populatePOPickers?.();
  window.showToast?.(id ? 'บันทึกการแก้ไขสินค้าสำเร็จ' : `เพิ่มสินค้าสำเร็จ (SKU: ${sku})`);

  // Best-effort background push — reuses the same product/variant/fraction mapping as the
  // periodic full sync, so there's no separate, possibly-drifting mapping logic to maintain here.
  if (_oldProd) {   // จำนวนที่แก้ในหน้าสินค้า → ส่งเป็นรายการปรับสต็อก (เซิร์ฟเวอร์ไม่รับการเขียนสต็อกตรงๆ แล้ว)
    pmVariants.forEach(nv => {
      const ov = (_oldProd.variants || []).find(x => x.id === nv.id);
      if (ov && roundStock(+ov.stock || 0) !== roundStock(+nv.stock || 0)) {
        window.enqueueSync({ type: 'adjust', payload: { variantId: nv.id, value: roundStock(+nv.stock || 0), reason: 'แก้ไขจำนวนในหน้าสินค้า', opRef: 'ADJ-' + Date.now() + '-' + window.getDeviceId() + '-' + nv.id } }, true);
      }
    });
  }
  window.syncProductsToSupabase?.(true)?.then?.(() => window.flushSyncQueue?.());
};

window.deleteProduct = async id => {
  if (!ok('PRODUCT_DELETE') || !confirm('ยืนยันการลบสินค้านี้?')) return;
  window.enqueueSync({ type: 'delete', payload: { kind: 'product', id, note: db.products[id]?.name || '' } });   // เดิมส่ง id ในเครื่องตรงๆ (ไม่ใช่ UUID) จึงไม่เคยลบสำเร็จ
  delete db.products[id];
  window.persist?.();
  window.renderStockTable();
  window.renderSaleHome?.();
  window.populatePOPickers?.();
};

// NOTE: the action-column patch that used to live here (bolting a "แก้ไข/ลบ" cell onto each
// row by matching Object.values(db.products)[rowIndex]) has been removed — it silently
// targeted the wrong product for any item with more than one variant, or whenever a filter,
// sort, or search reduced/reordered the rows (which is most of the time). The action buttons
// are now built directly into each row in window.renderStockTable() using the row's actual
// product id, so they can never point at the wrong product.

window.confirmReceivePO=async function(){if(!ok('GOODS_RECEIPT'))return;const supplierId=document.getElementById('po-supplier-select').value;let docRef=document.getElementById('po-doc-ref').value.trim();const terms=parseInt(document.getElementById('po-credit-terms').value)||30;if(!supplierId)return window.showAlert?.('ข้อมูลไม่ครบ','กรุณาเลือกซัพพลายเออร์',true);if(!poTempItems?.length)return window.showAlert?.('ไม่มีรายการ','กรุณาเพิ่มรายการรับสินค้า',true);
  // เลขที่ใบส่งของ is now optional — if the supplier's own delivery-note number wasn't typed
  // in, run our own sequential number automatically rather than blocking the whole receipt.
  if(!docRef){docRef=window.getGoodsReceiptNumber();document.getElementById('po-doc-ref').value=docRef;}
  const receipt={id:'GR-'+Date.now(),supplierId,docRef,terms,status:'RECEIVED',items:poTempItems.map(x=>({...x})),receivedAt:new Date().toISOString()};
  // Delivery-note attachments (multiple images and/or PDFs): upload each to Supabase Storage
  // when online so they survive a browser cache clear (this is accounting evidence, not
  // throwaway UI state); fall back to keeping the local copy on the record itself if offline
  // or if a particular upload fails, so nothing is ever silently lost either way.
  if(typeof poDeliveryNoteFiles!=='undefined'&&poDeliveryNoteFiles.length){
    receipt.deliveryNoteUrls=[];
    const c=sb();
    for(let i=0;i<poDeliveryNoteFiles.length;i++){
      const f=poDeliveryNoteFiles[i];
      const ext=f.mime==='application/pdf'?'pdf':'jpg';
      try{
        if(c){
          const blob=await (await fetch(f.dataUrl)).blob();
          const path=`${Date.now()}_${i}_${(docRef||'note').replace(/[^a-zA-Z0-9ก-๙_-]/g,'_')}.${ext}`;
          const{error:upErr}=await c.storage.from('delivery-notes').upload(path,blob,{contentType:f.mime,upsert:true});
          if(!upErr){const{data}=c.storage.from('delivery-notes').getPublicUrl(path);receipt.deliveryNoteUrls.push(data.publicUrl);}
          else{receipt.deliveryNoteUrls.push(f.dataUrl);console.warn('delivery note upload failed, kept locally',upErr);}
        }else{
          receipt.deliveryNoteUrls.push(f.dataUrl); // offline fallback
        }
      }catch(e){receipt.deliveryNoteUrls.push(f.dataUrl);console.warn('delivery note upload error, kept locally',e);}
    }
  }
  db.purchaseOrders=db.purchaseOrders||[];db.purchaseOrders.push(receipt);for(const x of poTempItems){const p=db.products[x.productId],v=p?.variants?.[0];if(v){{const _os=Math.max(0,+v.stock||0),_q=+x.qty||0,_nc=+x.cost||0;if(_nc>0){v.cost=_os>0?roundAmt((_os*(+v.cost||0)+_q*_nc)/(_os+_q)):_nc;}v.stock=(+v.stock||0)+_q;}}}db.cashLedger=db.cashLedger||[];const apEntry={id:'AP-'+Date.now(),type:'ACCOUNTS_PAYABLE',supplierId,docRef,amount:poTempItems.reduce((a,x)=>a+x.total,0),terms,status:'OPEN',createdAt:receipt.receivedAt};db.cashLedger.push(apEntry);persist();const itemsForSync=receipt.items;poTempItems.length=0;window.renderPOCartList();window.renderStockTable();window.renderPurchaseHistory();window.clearDeliveryNote?.();window.showToast?.('รับสินค้าเข้าคลังและบันทึกเจ้าหนี้สำเร็จ');document.getElementById('po-doc-ref').value='';
  // Best-effort authoritative push to Supabase via the proper purchase_orders →
  // purchase_order_items → receive_purchase_order RPC flow (the schema's real, atomic
  // receiving path — it locks rows, validates received quantity against ordered quantity, and
  // writes an inventory_movements audit entry). Runs in the background so the cashier flow
  // above never blocks on network; local stock/AP are already authoritative either way.
  // NOTE: receive_purchase_order requires the signed-in Supabase session to belong to an
  // OWNER or MANAGER app_user (enforced by is_manager() inside the function itself) — this
  // silently no-ops (logged to console only) if that's not the case, same as every other
  // background sync in this app.
  window.enqueueSync({type:'receive',payload:{receiptId:receipt.id,apId:apEntry.id}});
};

// Purchase history + accounts-payable panel (§2.3/2.7 of the manual — "รับสินค้าเข้าคลัง...ตั้งยอดเจ้าหนี้การค้าให้อัตโนมัติ")
window.renderPurchaseHistory=function(){
  const listEl=document.getElementById('po-history-list');
  if(listEl){
    const pos=(db.purchaseOrders||[]).slice().reverse();
    listEl.innerHTML=pos.length?pos.map(po=>{
      const supplier=db.suppliers[po.supplierId]?.name||po.supplierId||'-';
      const total=(po.items||[]).reduce((s,x)=>s+(x.total||0),0);
      const dt=new Date(po.receivedAt||po.createdAt).toLocaleString('th-TH');
      const itemsLabel=(po.items||[]).map(x=>`${esc(x.productName)} ×${x.qty}`).join(', ');
      const urls=po.deliveryNoteUrls||(po.deliveryNoteUrl?[po.deliveryNoteUrl]:[]); // deliveryNoteUrl = legacy single-file records from before multi-file support
      const noteThumbs=urls.map(u=>{
        const isPdf=/\.pdf($|\?)/i.test(u)||u.startsWith('data:application/pdf');
        return isPdf
          ?`<div data-url="${esc(u)}" onclick="window.open(this.dataset.url,'_blank','noopener')" class="w-12 h-12 flex items-center justify-center rounded-lg border bg-indigo-50 text-xl flex-shrink-0 cursor-pointer" title="เปิดไฟล์ PDF ใบส่งของ">📄</div>`
          :`<img src="${esc(u)}" data-url="${esc(u)}" onclick="window.open(this.dataset.url,'_blank','noopener')" class="w-12 h-12 object-cover rounded-lg border flex-shrink-0 cursor-pointer" title="ดูรูปใบส่งของ">`;
      }).join('');
      return `<div class="bg-slate-50 p-3 rounded-xl border text-xs flex gap-2">
        ${noteThumbs ? `<div class="flex flex-col gap-1 flex-shrink-0">${noteThumbs}</div>` : ''}
        <div class="flex-1 min-w-0">
          <div class="flex justify-between font-bold text-slate-800"><span>${esc(po.docRef||po.id)}</span><span class="text-indigo-600">${formatMoney(total)}</span></div>
          <div class="text-slate-400 text-[10px] flex justify-between mt-0.5"><span>${esc(supplier)}</span><span>${dt}</span></div>
          <div class="text-[10px] text-slate-500 mt-1">${itemsLabel}</div>
        </div>
      </div>`;
    }).join(''):`<p class="text-center text-slate-400 font-bold py-6">ยังไม่มีประวัติการรับสินค้า</p>`;
  }
  const apEl=document.getElementById('po-ap-list');
  if(apEl){
    const now=Date.now();
    const aps=(db.cashLedger||[]).filter(x=>x.type==='ACCOUNTS_PAYABLE').slice().reverse();
    apEl.innerHTML=aps.length?aps.map(ap=>{
      const supplier=db.suppliers[ap.supplierId]?.name||ap.supplierId||'-';
      const created=new Date(ap.createdAt);
      const due=new Date(created.getTime()+(ap.terms||30)*86400000);
      const daysLeft=Math.ceil((due-now)/86400000);
      const isPaid=ap.status==='PAID';
      const overdue=!isPaid&&daysLeft<0;
      const dueLabel=isPaid?'ชำระแล้ว':overdue?`เกินกำหนด ${Math.abs(daysLeft)} วัน`:`ครบกำหนดใน ${daysLeft} วัน`;
      return `<div class="p-3 rounded-xl border text-xs ${isPaid?'bg-slate-50 border-slate-200':overdue?'bg-rose-50 border-rose-200':'bg-amber-50 border-amber-200'}">
        <div class="flex justify-between font-bold text-slate-800"><span>${esc(supplier)}</span><span>${formatMoney(ap.amount)}</span></div>
        <div class="text-[10px] text-slate-500 flex justify-between mt-0.5">
          <span>${esc(ap.docRef||'')} | ครบกำหนด ${due.toLocaleDateString('th-TH')}</span>
          <span class="font-bold ${isPaid?'text-slate-400':overdue?'text-rose-600':'text-amber-600'}">${dueLabel}</span>
        </div>
        ${isPaid?'':`<button onclick="window.markAPPaid('${ap.id}')" class="mt-2 w-full py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold btn-touch">✅ บันทึกว่าชำระแล้ว</button>`}
      </div>`;
    }).join(''):`<p class="text-center text-slate-400 font-bold py-6">ไม่มีรายการเจ้าหนี้ค้างชำระ</p>`;
  }
};
window.markAPPaid=function(id){if(!ok('ALL')&&!ok('GOODS_RECEIPT'))return;const ap=(db.cashLedger||[]).find(x=>x.id===id);if(!ap)return;ap.status='PAID';ap.paidAt=new Date().toISOString();persist();window.renderPurchaseHistory();window.showToast?.('บันทึกการชำระเงินเรียบร้อย');};

document.addEventListener('DOMContentLoaded',()=>{ensure();window.renderStockTable?.();});
})();
