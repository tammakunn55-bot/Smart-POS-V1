/* =============================================================================
 * js/sales/product-grid.js
 * หน้าขาย: การ์ดสินค้า, เลือกขนาด/หน่วยแบ่งขาย, แถบหมวดหมู่, ค้นหา, แบ่งหน้า
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * renderProductCard, openVariantPicker, openVirtualGroupPicker, vpNav, renderVariantPicker,
 * openFractionPicker, changeProductsPerPage, changeProductGridCols, renderCategoryBar,
 * scrollCategoryBar, syncCategoryBarOffset, renderProductGridResults, renderProductGridPage,
 * gotoProductPage, selectCategory, exitCategory, onSearchInput
 * ============================================================================= */

// ==========================================
// PRODUCT SELECTION (Category browse / Search)
// Previously window.selectCategory / exitCategory / onSearchInput were referenced
// by the UI but never defined anywhere, so every category and search click on the
// sale page silently did nothing. Implemented below.
// ==========================================
// Group image helper — shared by the main card and the variant-picker modal so both show
// the same "product photo" (a multi-size/multi-color item still only has one master photo).
function productImgHtml(p, sizeClass, emojiClass) {
  const photoUrl = p.imageUrl || (p.image && /^(https?:|blob:|data:)/.test(p.image) ? p.image : '');
  const emojiCls = emojiClass || 'text-4xl text-center mb-1.5';
  return photoUrl
    ? `<img src="${photoUrl}" loading="lazy" decoding="async" class="${sizeClass} mx-auto object-cover rounded-2xl mb-1.5 border-2 border-slate-100 bg-slate-50" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'${emojiCls}',textContent:'📦'}))">`
    : `<div class="${emojiCls}">${(p.image && p.image.length <= 4) ? p.image : '📦'}</div>`;
}

// UX: a product with only ONE size/color still shows and sells directly from its card
// (tap → add to cart), with remaining stock quantity shown right on the button instead of
// just a price. A product with MULTIPLE sizes/colors ("กลุ่มสินค้า") shows once as a single
// group card with its main photo — tapping it opens a picker listing every size/color as
// its own selectable line (see openVariantPicker), instead of cramming every size's chip
// onto the browse-grid card. Split-sale ("แบ่งขาย") items keep the ✂️ shortcut wherever
// their variant is shown, on the grid card or inside the picker. The photo itself always
// comes from the PRODUCT record (p.imageUrl), so a group with several sizes/colors that
// all share one photo — or a product with variants that never got individual photos —
// naturally shows the same picture everywhere it appears without any extra setup.
window.renderProductCard = function(p) {
  const isGroup = (p.variants || []).length > 1;
  // ภาพใหญ่เต็มความกว้างการ์ด (แทนกล่องเล็ก 80x80 เดิม) ให้ดูเหมือนการ์ดสินค้าในแอปช้อปปิ้งทั่วไป
  const imgHtml = productImgHtml(p, 'w-full aspect-square');

  if (!isGroup) {
    const v = p.variants?.[0];
    const out = !v || (+v.stock || 0) <= 0;
    const hasFractions = (v?.fractions || []).length > 0;
    const qtyLabel = out ? 'หมด' : `คงเหลือ ${roundStock(v.stock)} ชิ้น`;
    return `
            <div class="bg-white rounded-2xl border shadow-sm p-2.5 flex flex-col">
              <div class="relative mb-1.5">
                ${imgHtml}
                ${hasFractions ? `<button onclick="window.openFractionPicker('${p.id}','${v.id}',event)" title="เลือกแบ่งขาย" class="absolute bottom-1 right-1 w-7 h-7 rounded-full bg-white/95 shadow border border-amber-200 text-amber-600 flex items-center justify-center text-[13px] btn-touch">✂️</button>` : ''}
              </div>
              <div class="font-bold text-[11px] text-center mb-1 text-slate-800 line-clamp-2">${escapeHTML(p.name)}</div>
              <button ${out ? 'disabled' : ''} onclick="window.addUnifiedToCart('${p.id}','${v?.id}',null,event)" class="${out ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-indigo-50 hover:bg-indigo-100 text-indigo-700'} rounded-lg py-1.5 px-2 text-[10px] font-bold flex flex-col items-center btn-touch w-full justify-center">
                <span>฿${v ? roundAmt(v.price).toFixed(2) : '-'}</span>
                <span class="text-[9px] ${out ? '' : 'text-indigo-400'}">${qtyLabel}</span>
              </button>
            </div>`;
  }

  // Group card: one photo/name, badge shows how many sizes/colors, tap opens the picker.
  // p.__virtual = จัดกลุ่มแค่ตอนแสดงผล (สินค้ายังแยกเรคคอร์ดกันจริงในฐานข้อมูล — ดู
  // clusterForDisplay) ต้องเปิด picker คนละฟังก์ชันกับกลุ่มที่รวมจริงแล้ว เพราะ p.id ของการ์ด
  // เสมือนนี้ไม่มีอยู่จริงใน db.products
  const openPicker = p.__virtual
    ? `window.openVirtualGroupPicker(${JSON.stringify(p._memberIds)})`
    : `window.openVariantPicker('${p.id}')`;
  const totalStock = p.variants.reduce((s, v) => s + (+v.stock || 0), 0);
  return `
          <div class="bg-white rounded-2xl border shadow-sm p-2.5 flex flex-col cursor-pointer btn-touch" onclick="${openPicker}">
            <div class="relative mb-1.5">
              ${imgHtml}
              <span class="absolute top-1 right-1 bg-indigo-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded-full shadow">${p.variants.length} แบบ</span>
              ${p.__virtual ? `<span class="absolute top-1 left-1 bg-white/95 text-slate-500 text-[8px] font-bold px-1.5 py-0.5 rounded-full shadow border" title="ยังไม่ได้รวมกลุ่มจริงในระบบ — จัดกลุ่มให้ดูตอนนี้เฉยๆ">🔎 คล้ายกัน</span>` : ''}
            </div>
            <div class="font-bold text-[11px] text-center mb-1 text-slate-800 line-clamp-2">${escapeHTML(p.name)}</div>
            <div class="text-[9px] text-center ${totalStock > 0 ? 'text-emerald-600' : 'text-slate-400'} font-bold mb-1.5">${totalStock > 0 ? `รวมคงเหลือ ${roundStock(totalStock)} ชิ้น` : 'หมดทุกแบบ'}</div>
            <button onclick="event.stopPropagation();${openPicker}" class="w-full bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg py-1.5 text-[10px] font-bold btn-touch">📏 เลือกขนาด/สี</button>
          </div>`;
};

// Carousel-style picker: shows ONE size/color at a time with a big card-sized photo,
// price, and remaining quantity — navigated with the ‹ › arrows fixed to the left/right
// screen edges (vertically centered) instead of scrolling a list. The ✂️ split-sale
// shortcut appears next to "หยิบใส่ตะกร้า" only when the current size/color supports it.
let vpItems = []; // [{ productId, product, variantId, variant }] — uniform whether this is one product's own variants, or members of a display-only cluster (see clusterForDisplay)
let vpIndex = 0;

window.openVariantPicker = function(productId) {
  const p = db.products[productId];
  if (!p || !(p.variants || []).length) return;
  vpItems = p.variants.map(v => ({ productId, product: p, variantId: v.id, variant: v }));
  vpIndex = 0;
  window.renderVariantPicker();
  const m = document.getElementById('modal-variant-picker');
  m.classList.remove('hidden'); m.classList.add('flex');
};

// เหมือน openVariantPicker เป๊ะ แต่แต่ละ "รายการ" มาจากสินค้าคนละตัวกัน — ใช้ตอนกดการ์ดกลุ่ม
// เสมือนที่ clusterForDisplay จัดกลุ่มให้ตอนแสดงผลเท่านั้น (สินค้ายังแยกเรคคอร์ดกันจริงอยู่)
window.openVirtualGroupPicker = function(productIds) {
  vpItems = (productIds || []).map(id => {
    const p = db.products[id];
    const v = p?.variants?.[0];
    return (p && v) ? { productId: id, product: p, variantId: v.id, variant: v } : null;
  }).filter(Boolean);
  if (!vpItems.length) return;
  vpIndex = 0;
  window.renderVariantPicker();
  const m = document.getElementById('modal-variant-picker');
  m.classList.remove('hidden'); m.classList.add('flex');
};

window.vpNav = function(delta) {
  const n = vpItems.length;
  if (!n) return;
  vpIndex = (vpIndex + delta + n) % n;
  window.renderVariantPicker();
};

window.renderVariantPicker = function() {
  const item = vpItems[vpIndex];
  if (!item) return;
  const p = item.product, v = item.variant;
  const out = (+v.stock || 0) <= 0;
  const hasFractions = (v.fractions || []).length > 0;

  document.getElementById('vp-title').textContent = `📏 ${p.name}`;
  document.getElementById('vp-image-wrap').innerHTML = productImgHtml(p, 'w-full h-full', 'text-8xl flex items-center justify-center w-full h-full');
  document.getElementById('vp-variant-name').textContent = v.sizeName;
  document.getElementById('vp-variant-stock').innerHTML = out
    ? `<span class="text-rose-500">หมด</span>`
    : `<span class="text-emerald-600">คงเหลือ ${roundStock(v.stock)} ชิ้น</span>`;
  document.getElementById('vp-variant-price').textContent = `฿${roundAmt(v.price).toFixed(2)}`;

  document.getElementById('vp-dots').innerHTML = vpItems.map((_, i) =>
    `<span class="w-2 h-2 rounded-full ${i === vpIndex ? 'bg-indigo-600' : 'bg-slate-200'}"></span>`
  ).join('');

  document.getElementById('vp-actions').innerHTML = `
          <button ${out ? 'disabled' : ''} onclick="window.addUnifiedToCart('${p.id}','${v.id}',null,event)" class="${out ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 text-white'} flex-1 rounded-xl py-3 text-sm font-bold btn-touch">🛒 หยิบใส่ตะกร้า</button>
          ${hasFractions ? `<button onclick="window.openFractionPicker('${p.id}','${v.id}',event)" title="เลือกแบ่งขาย" class="flex-shrink-0 w-12 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-600 flex items-center justify-center text-lg btn-touch">✂️</button>` : ''}
        `;
};

// Small popover for picking a "แบ่งขาย" (split/fraction) unit, opened from the ✂️ button
// instead of permanently listing every fraction option inline on the card.
window.openFractionPicker = function(productId, variantId, evt) {
  evt.stopPropagation();
  document.querySelectorAll('.fraction-popover').forEach(el => el.remove());
  const p = db.products[productId];
  const v = p?.variants?.find(x => x.id === variantId);
  if (!v || !(v.fractions || []).length) return;

  const anchor = evt.currentTarget.parentElement;
  anchor.style.position = anchor.style.position || 'relative';
  const pop = document.createElement('div');
  pop.className = 'fraction-popover cart-item-pop absolute z-50 right-0 top-full mt-1 bg-white border rounded-xl shadow-2xl p-1.5 min-w-[160px]';
  pop.innerHTML = `<div class="text-[9px] font-bold text-slate-400 px-2 pb-1">✂️ เลือกแบ่งขาย</div>` + (v.fractions || []).map(f => `
          <button onclick="window.addUnifiedToCart('${productId}','${variantId}','${f.id}',event); this.closest('.fraction-popover').remove();" class="w-full text-left px-2 py-1.5 hover:bg-amber-50 rounded-lg text-[10px] font-bold text-amber-700 flex justify-between gap-2 btn-touch">
            <span>${escapeHTML(f.fractionName)}</span><span class="flex-shrink-0">฿${roundAmt(f.fractionPrice).toFixed(2)}</span>
          </button>`).join('');
  anchor.appendChild(pop);

  setTimeout(() => document.addEventListener('click', function closeOnce(e) {
    if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', closeOnce); }
  }), 0);
};

// ---- Category bar (sticky, horizontally scrollable) + paginated product grid ----
let productsPerPage = 24;
let productGridPage = 0;

// ต่อหน้า / คอลัมน์ ปรับได้จาก selector บนแถบแบ่งหน้า — ตั้งค่าถูกจดจำไว้ใน localStorage
// เพื่อไม่ต้องตั้งใหม่ทุกครั้งที่เปิดแอป
window.changeProductsPerPage = function(val) {
  productsPerPage = Math.max(1, parseInt(val) || 24);
  productGridPage = 0;
  try { localStorage.setItem('pos_products_per_page', productsPerPage); } catch (e) {}
  window.renderProductGridPage();
};

window.changeProductGridCols = function(val) {
  const cols = Math.max(1, parseInt(val) || 4);
  const grid = document.getElementById('product-grid');
  // BUG FIX: เดิม Math.min(cols, 2) ล็อกจำนวนคอลัมน์พื้นฐาน (มือถือ/จอแคบกว่า md=768px)
  // ไว้ที่ 2 เสมอ ไม่ว่าจะเลือกกี่คอลัมน์ก็ตาม ทำให้บนมือถือ/แท็บเล็ตจอแคบกดเลือก
  // "6 คอลัมน์" แล้วไม่มีอะไรเกิดขึ้นเลย เพราะ class md:grid-cols-6 ยังไม่ทำงานที่ความกว้าง
  // นั้น — ผู้ใช้เลือกเองแล้วต้องเห็นผลทันทีทุกขนาดจอ ไม่ควรมี breakpoint มาทับ
  if (grid) grid.className = `grid gap-3 grid-cols-${cols}`;
  try { localStorage.setItem('pos_products_grid_cols', cols); } catch (e) {}
};

// คืนค่าที่เคยตั้งไว้ตอนโหลดแอป
(function restoreGridPrefs() {
  try {
    const savedPerPage = localStorage.getItem('pos_products_per_page');
    const savedCols = localStorage.getItem('pos_products_grid_cols');
    if (savedPerPage) productsPerPage = parseInt(savedPerPage) || 24;
    document.addEventListener('DOMContentLoaded', () => {
      const sel1 = document.getElementById('product-page-size-select');
      const sel2 = document.getElementById('product-grid-cols-select');
      if (sel1) sel1.value = String(productsPerPage);
      if (sel2) { sel2.value = savedCols || '4'; window.changeProductGridCols(savedCols || '4'); }
    });
  } catch (e) {}
})();
let currentCategoryFilter = null; // null = "ทั้งหมด"
let currentMainCategoryId = null; // which main category's subcategory row is expanded
let _lastProductList = [];
let _lastProductTitle = 'สินค้าทั้งหมด';

window.renderCategoryBar = function() {
  const bar = document.getElementById('category-bar');
  if (!bar) return;
  const cats = Array.isArray(db.categories) ? db.categories : [];
  const topLevel = cats.filter(c => !c.parentId);
  const pill = (label, icon, isActive, onclick, extraCls) => `
          <button onclick="${onclick}" class="flex-shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-bold btn-touch transition-colors ${isActive ? 'bg-indigo-600 text-white shadow-sm' : 'bg-white border text-slate-600 hover:border-indigo-300'} ${extraCls || ''}">
            <span>${icon}</span><span>${label}</span>
          </button>`;
  bar.innerHTML = pill('ทั้งหมด', '🏷️', currentCategoryFilter === null, `window.selectCategory(null)`) +
    topLevel.map(c => pill(escapeHTML(c.name), c.icon || '📦', currentCategoryFilter === c.name || currentMainCategoryId === c.id, `window.selectCategory(${JSON.stringify(c.name)})`)).join('');

  // Subcategory row — only shown while a main category that actually has children is expanded.
  const subWrap = document.getElementById('subcategory-bar-wrap');
  const subBar = document.getElementById('subcategory-bar');
  const children = currentMainCategoryId ? cats.filter(c => c.parentId === currentMainCategoryId) : [];
  if (subWrap && subBar) {
    if (children.length) {
      const mainCat = cats.find(c => c.id === currentMainCategoryId);
      subWrap.classList.remove('hidden');
      subBar.innerHTML =
        pill(`ทั้งหมดใน${escapeHTML(mainCat?.name || '')}`, mainCat?.icon || '🏷️', currentCategoryFilter === mainCat?.name, `window.selectCategory(${JSON.stringify(mainCat?.name)})`, 'bg-indigo-50') +
        children.map(c => pill(escapeHTML(c.name), c.icon || '📦', currentCategoryFilter === c.name, `window.selectCategory(${JSON.stringify(c.name)})`)).join('');
    } else {
      subWrap.classList.add('hidden');
      subBar.innerHTML = '';
    }
  }
};

window.scrollCategoryBar = function(dir) {
  const bar = document.getElementById('category-bar');
  if (bar) bar.scrollBy({ left: dir * 160, behavior: 'smooth' });
};

// Keeps the category bar pinned directly beneath the app header, and the pagination bar
// pinned directly beneath the category bar — both computed from actual rendered heights
// rather than a hardcoded offset that could drift out of sync.
window.syncCategoryBarOffset = function() {
  const header = document.querySelector('header');
  const catWrap = document.getElementById('category-bar-wrap');
  const subWrap = document.getElementById('subcategory-bar-wrap');
  const pageWrap = document.getElementById('product-page-bar-wrap');
  if (header && catWrap) {
    const afterHeader = header.offsetHeight;
    catWrap.style.top = afterHeader + 'px';
    const subVisible = subWrap && !subWrap.classList.contains('hidden');
    const afterCat = afterHeader + catWrap.offsetHeight;
    if (subWrap) subWrap.style.top = afterCat + 'px';
    if (pageWrap) pageWrap.style.top = (afterCat + (subVisible ? subWrap.offsetHeight : 0)) + 'px';
  }
};
window.addEventListener('resize', () => window.syncCategoryBarOffset());

// จัดกลุ่มสินค้าที่ "ยังไม่ได้รวมกลุ่มจริงในฐานข้อมูล" ให้แสดงรวมเป็นการ์ดเดียวตอนค้นหา/เลือก
// หมวดหมู่ — แค่ตอนแสดงผลเท่านั้น ไม่แก้ไขข้อมูลจริงเลย (ยังกด "🩺 จับกลุ่มสินค้าอัตโนมัติ" ในหน้า
// ตั้งค่าเพื่อรวมจริงถาวรได้เหมือนเดิม) ใช้ตรรกะตรวจจับชุดเดียวกับเครื่องมือนั้น
// (getProductBaseName) แต่เอาเฉพาะ 2 วิธีที่มั่นใจสูง — ชื่อคล้ายกันตามรูปแบบไซส์/สี/หน่วยที่รู้จัก
// และรูปภาพเดียวกันเป๊ะ — ไม่เอา fallback แบบคำนำหน้าคล้ายกัน (fuzzy) ที่หน้าตั้งค่าติดป้าย
// "ตรวจสอบก่อนรวม" ไว้ เพราะพลาดแล้วกระทบการขายจริงตรงๆ ต่างจากหน้าตั้งค่าที่แค่เป็นคำแนะนำ
function clusterForDisplay(products) {
  const standalone = products.filter(p => (p.variants || []).length === 1);
  const clustered = new Set();
  const virtualGroups = [];

  const byName = {};
  standalone.forEach(p => {
    const base = getProductBaseName(p.name);
    if (base.length > 1) (byName[base] = byName[base] || []).push(p);
  });
  Object.entries(byName).forEach(([base, items]) => {
    if (items.length < 2) return;
    items.forEach(p => clustered.add(p.id));
    virtualGroups.push({ label: base, items });
  });

  const byImage = {};
  standalone.filter(p => !clustered.has(p.id)).forEach(p => {
    const url = p.imageUrl;
    if (url && /^(https?:|data:)/.test(url)) (byImage[url] = byImage[url] || []).push(p);
  });
  Object.values(byImage).forEach(items => {
    if (items.length < 2) return;
    items.forEach(p => clustered.add(p.id));
    virtualGroups.push({ label: getProductBaseName(items[0].name) || items[0].name, items });
  });

  if (!virtualGroups.length) return products; // ทางลัด — ไม่มีอะไรให้จัดกลุ่มเพิ่ม

  const idToVirtualCard = new Map();
  virtualGroups.forEach(g => {
    const card = {
      __virtual: true,
      id: 'vg-' + g.items.map(p => p.id).join('-'),
      name: g.label,
      imageUrl: g.items.find(p => p.imageUrl)?.imageUrl || null,
      image: g.items.find(p => p.image)?.image || null,
      variants: g.items.flatMap(p => p.variants || []),
      _memberIds: g.items.map(p => p.id)
    };
    g.items.forEach(p => idToVirtualCard.set(p.id, card));
  });

  // คงลำดับเดิมของผลลัพธ์ไว้ (สำคัญตอนค้นหา — รายการที่ตรงสุดต้องขึ้นก่อนเหมือนเดิม ไม่ใช่ถูก
  // ดันไปท้ายแถวเพราะถูกจัดกลุ่ม) โดยแทรกการ์ดกลุ่มเสมือน ณ ตำแหน่งของสมาชิกตัวแรกที่เจอ
  const out = [];
  const emitted = new Set();
  products.forEach(p => {
    const vcard = idToVirtualCard.get(p.id);
    if (vcard) {
      if (!emitted.has(vcard.id)) { out.push(vcard); emitted.add(vcard.id); }
      return;
    }
    out.push(p);
  });
  return out;
}

window.renderProductGridResults = function(products, title) {
  _lastProductList = clusterForDisplay(products);
  _lastProductTitle = title;
  productGridPage = 0;
  window.renderProductGridPage();
};

// A product counts as "out of stock" for this filter when every one of its variants is
// at 0 (or less) — a product with at least one variant still available stays visible.
function isProductFullyOutOfStock(p) {
  return (p.variants || []).every(v => (+v.stock || 0) <= 0);
}

window.renderProductGridPage = function() {
  const hideOut = document.getElementById('hide-out-of-stock')?.checked;
  const visibleList = hideOut ? _lastProductList.filter(p => !isProductFullyOutOfStock(p)) : _lastProductList;

  const totalPages = Math.max(1, Math.ceil(visibleList.length / productsPerPage));
  productGridPage = Math.max(0, Math.min(productGridPage, totalPages - 1));
  const pageItems = visibleList.slice(productGridPage * productsPerPage, (productGridPage + 1) * productsPerPage);

  document.getElementById('current-cat-title').textContent = `${_lastProductTitle} (${visibleList.length} รายการ)`;
  document.getElementById('product-page-indicator').textContent = `หน้า ${productGridPage + 1}/${totalPages}`;
  document.getElementById('product-grid').innerHTML = pageItems.length
    ? pageItems.map(window.renderProductCard).join('')
    : `<p class="col-span-full text-center text-slate-400 font-bold py-10">ไม่พบสินค้า</p>`;
  // Re-measure after render: adding the page-size/column selectors can wrap the bar onto
  // a second line on narrow screens, changing its height.
  window.syncCategoryBarOffset?.();
};

window.gotoProductPage = function(delta) {
  const hideOut = document.getElementById('hide-out-of-stock')?.checked;
  const visibleList = hideOut ? _lastProductList.filter(p => !isProductFullyOutOfStock(p)) : _lastProductList;
  const totalPages = Math.max(1, Math.ceil(visibleList.length / productsPerPage));
  productGridPage = Math.max(0, Math.min(totalPages - 1, productGridPage + delta));
  window.renderProductGridPage();
  document.getElementById('product-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.selectCategory = function(catName) {
  currentCategoryFilter = catName;
  const cats = Array.isArray(db.categories) ? db.categories : [];
  const cat = catName === null ? null : cats.find(c => c.name === catName);
  // ตัดสินว่าแถวหมวดหมู่ย่อยควรกางออกให้ "หมวดหมู่หลัก" ไหน: ถ้าเลือกหมวดหมู่หลักเอง
  // ก็กางของตัวเอง, ถ้าเลือกหมวดหมู่ย่อยก็กางของแม่มันไว้ (ให้เห็นว่าอยู่ในกลุ่มไหน)
  currentMainCategoryId = cat ? (cat.parentId || cat.id) : null;
  const s = document.getElementById('search-product');
  if (s) s.value = '';
  window.renderCategoryBar();
  window.syncCategoryBarOffset?.(); // re-measure — bar heights can change per filter

  // เลือกหมวดหมู่หลักที่มีหมวดหมู่ย่อย = รวมสินค้าทุกหมวดหมู่ย่อยในนั้นมาแสดงด้วย
  // ไม่ใช่แค่สินค้าที่ติดป้ายชื่อหมวดหมู่หลักตรงตัวเท่านั้น
  const namesToMatch = cat && !cat.parentId
    ? [cat.name, ...cats.filter(c => c.parentId === cat.id).map(c => c.name)]
    : (catName === null ? null : [catName]);

  const products = namesToMatch === null
    ? Object.values(db.products).sort((a, b) => naturalCompare(a.name, b.name))
    : Object.values(db.products).filter(p => (p.cat || []).some(pc => namesToMatch.includes(pc))).sort((a, b) => naturalCompare(a.name, b.name));
  window.renderProductGridResults(products, catName === null ? '🏷️ สินค้าทั้งหมด' : catName);
};

window.exitCategory = function() {
  const s = document.getElementById('search-product');
  if (s) s.value = '';
  window.selectCategory(currentCategoryFilter);
};

window.onSearchInput = function(e) {
  const q = (e.target.value || '').trim().toLowerCase();
  if (!q) { window.selectCategory(currentCategoryFilter); return; }
  let results = Object.values(db.products).filter(p => {
    if ((p.name || '').toLowerCase().includes(q)) return true;
    if ((p.code || '').toLowerCase().includes(q)) return true;
    return (p.variants || []).some(v => (v.barcode || '').toLowerCase().includes(q));
  });
  // Relevance ordering: exact barcode/SKU hits and name-starts-with matches surface
  // first, so the item being searched for shows up without scanning the whole grid.
  results.sort((a, b) => {
    const score = p => {
      if ((p.variants || []).some(v => (v.barcode || '').toLowerCase() === q)) return 0;
      if ((p.code || '').toLowerCase() === q) return 0;
      if ((p.name || '').toLowerCase().startsWith(q)) return 1;
      return 2;
    };
    return score(a) - score(b) || naturalCompare(a.name, b.name);
  });
  window.renderProductGridResults(results, `🔍 ผลการค้นหา: "${e.target.value}"`);
};
