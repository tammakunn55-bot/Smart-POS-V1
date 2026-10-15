/* =============================================================================
 * js/inventory/bulk-actions.js
 * เลือกหลายรายการ: ย้ายหมวด, ตั้งสต็อกขั้นต่ำ, ปรับจำนวนสต็อก, รวมสินค้าเป็นกลุ่ม + ข้อเสนอแนะการจัดกลุ่ม
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * toggleProductSelection, toggleSelectAllStock, clearStockSelection, updateBulkToolbar,
 * openBulkCategoryModal, confirmBulkCategory, openBulkMinStockModal, confirmBulkMinStock,
 * openBulkStockModal, confirmBulkStock, mergeProductsIntoGroup, openMergeGroupModal,
 * confirmMergeGroup, suggestProductGroups, applyGroupSuggestion
 * ============================================================================= */

// ==========================================
// BULK SELECTION & ACTIONS (stock table)
// ==========================================
let selectedProductIds = new Set();

window.toggleProductSelection = function(pid, checked) {
  if (checked) selectedProductIds.add(pid); else selectedProductIds.delete(pid);
  // A product can span multiple rows (one per variant) — keep every checkbox for the
  // same product in sync with a single click.
  document.querySelectorAll(`.stock-row-checkbox[data-pid="${pid}"]`).forEach(cb => cb.checked = checked);
  window.updateBulkToolbar();
};

window.toggleSelectAllStock = function(checked) {
  const seen = new Set();
  document.querySelectorAll('.stock-row-checkbox').forEach(cb => {
    cb.checked = checked;
    const pid = cb.dataset.pid;
    if (!seen.has(pid)) { seen.add(pid); if (checked) selectedProductIds.add(pid); else selectedProductIds.delete(pid); }
  });
  window.updateBulkToolbar();
};

window.clearStockSelection = function() {
  selectedProductIds.clear();
  document.querySelectorAll('.stock-row-checkbox, #stock-select-all').forEach(cb => cb.checked = false);
  window.updateBulkToolbar();
};

window.updateBulkToolbar = function() {
  const bar = document.getElementById('stock-bulk-toolbar');
  if (!bar) return;
  const count = selectedProductIds.size;
  bar.classList.toggle('hidden', count === 0);
  const countEl = document.getElementById('stock-bulk-count');
  if (countEl) countEl.textContent = count;
};

window.openBulkCategoryModal = function() {
  if (!selectedProductIds.size) return;
  document.getElementById('bulk-cat-count').textContent = selectedProductIds.size;
  const topLevel = (db.categories || []).filter(c => !c.parentId);
  const childrenOf = pid => (db.categories || []).filter(c => c.parentId === pid);
  const rowHtml = (c, indent) => `
          <label class="flex items-center gap-2 py-1.5 text-xs font-bold text-slate-600 cursor-pointer" style="padding-left:${indent * 14}px">
            <input type="checkbox" value="${escapeHTML(c.name)}" class="bulk-cat-check w-4 h-4 rounded accent-indigo-600">
            ${indent ? '↳ ' : ''}${escapeHTML(c.icon || '📁')} ${escapeHTML(c.name)}
          </label>`;
  let html = '';
  topLevel.forEach(c => { html += rowHtml(c, 0); childrenOf(c.id).forEach(ch => html += rowHtml(ch, 1)); });
  document.getElementById('bulk-cat-checks').innerHTML = html || `<p class="text-slate-400 text-[11px] py-2">ยังไม่มีหมวดหมู่</p>`;
  document.getElementById('modal-bulk-category').classList.remove('hidden');
  document.getElementById('modal-bulk-category').classList.add('flex');
};

// "เพิ่มเข้าไป" = เติมหมวดที่ติ๊กเข้าไปเพิ่มจากของเดิม (ไม่ลบหมวดเดิมทิ้ง) เหมาะกับสินค้า
// ที่อยู่ได้หลายหมวดพร้อมกัน — "แทนที่หมวดเดิมทั้งหมด" = ล้างหมวดเดิมแล้วตั้งใหม่ตามที่ติ๊ก
window.confirmBulkCategory = function() {
  const chosen = Array.from(document.querySelectorAll('.bulk-cat-check:checked')).map(el => el.value);
  if (!chosen.length) return window.showAlert?.('ยังไม่ได้เลือก', 'กรุณาติ๊กอย่างน้อย 1 หมวดหมู่', true);
  const mode = document.querySelector('input[name="bulk-cat-mode"]:checked').value;
  selectedProductIds.forEach(pid => {
    const p = db.products[pid];
    if (!p) return;
    if (mode === 'REPLACE') { p.cat = chosen.slice(); }
    else { p.cat = p.cat || []; chosen.forEach(name => { if (!p.cat.includes(name)) p.cat.push(name); }); }
  });
  window.persist?.();
  window.closeModal('modal-bulk-category');
  window.clearStockSelection();
  window.renderStockTable();
  window.renderSaleHome?.();
  window.showToast?.(`แก้ไขหมวดหมู่สำเร็จ`);
  window.syncProductsToSupabase?.(true);
};

window.openBulkMinStockModal = function() {
  if (!selectedProductIds.size) return;
  document.getElementById('bulk-minstock-count').textContent = selectedProductIds.size;
  document.getElementById('bulk-minstock-value').value = '';
  document.getElementById('modal-bulk-minstock').classList.remove('hidden');
  document.getElementById('modal-bulk-minstock').classList.add('flex');
};

window.confirmBulkMinStock = function() {
  const val = parseFloat(document.getElementById('bulk-minstock-value').value);
  if (isNaN(val) || val < 0) return window.showAlert?.('ข้อมูลไม่ถูกต้อง', 'กรุณากรอกจำนวนขั้นต่ำให้ถูกต้อง', true);
  selectedProductIds.forEach(pid => {
    const p = db.products[pid];
    if (!p) return;
    p.minStock = val;
    (p.variants || []).forEach(v => v.minStock = val);
  });
  window.persist?.();
  window.closeModal('modal-bulk-minstock');
  window.clearStockSelection();
  window.renderStockTable();
  window.showToast?.('เปลี่ยนจำนวนขั้นต่ำแจ้งเตือนสำเร็จ');
  window.syncProductsToSupabase?.(true);
};

// ปรับ "จำนวนที่มี" (สต็อกจริง) แบบเลือกได้หลายรายการพร้อมกัน — ใช้ได้เฉพาะสินค้าที่มี
// ขนาด/สีเดียว เพราะสินค้ากลุ่มมีหลาย variant พร้อมกัน ไม่รู้ว่าผู้ใช้ตั้งใจปรับตัวไหน
// (ข้ามให้อัตโนมัติพร้อมแจ้งเตือนจำนวนที่ข้าม แทนที่จะเดาเอาเองแล้วพลาด)
window.openBulkStockModal = function() {
  if (!selectedProductIds.size) return;
  const eligible = Array.from(selectedProductIds).filter(pid => (db.products[pid]?.variants || []).length === 1);
  const skipped = selectedProductIds.size - eligible.length;
  document.getElementById('bulk-stock-count').textContent = eligible.length;
  const note = document.getElementById('bulk-stock-skip-note');
  if (skipped > 0) {
    note.textContent = `⚠️ ข้าม ${skipped} รายการที่เป็นสินค้ากลุ่ม (มีหลายขนาด/สี) — ปรับจำนวนของสินค้ากลุ่มได้ที่หน้าแก้ไขสินค้าแต่ละชิ้นแทน`;
    note.classList.remove('hidden');
  } else note.classList.add('hidden');
  document.getElementById('bulk-stock-value').value = '';
  document.getElementById('modal-bulk-stock').classList.remove('hidden');
  document.getElementById('modal-bulk-stock').classList.add('flex');
};

window.confirmBulkStock = function() {
  const val = parseFloat(document.getElementById('bulk-stock-value').value);
  if (isNaN(val)) return window.showAlert?.('ข้อมูลไม่ถูกต้อง', 'กรุณากรอกจำนวน', true);
  const mode = document.querySelector('input[name="bulk-stock-mode"]:checked').value;
  let changed = 0;
  selectedProductIds.forEach(pid => {
    const p = db.products[pid];
    if (!p || (p.variants || []).length !== 1) return;
    const v = p.variants[0];
    v.stock = mode === 'SET' ? Math.max(0, val) : Math.max(0, roundStock((+v.stock || 0) + val));
    changed++;
    window.enqueueSync({ type: 'adjust', payload: { variantId: v.id, value: v.stock, reason: 'ปรับจำนวนหลายรายการ', opRef: 'ADJ-' + Date.now() + '-' + window.getDeviceId() + '-' + changed } }, true);
  });
  window.persist?.();
  window.closeModal('modal-bulk-stock');
  window.clearStockSelection();
  window.renderStockTable();
  window.renderSaleHome?.();
  window.showToast?.(`ปรับจำนวนคงเหลือสำเร็จ ${changed} รายการ`);
  window.syncProductsToSupabase?.(true)?.then?.(() => window.flushSyncQueue?.());
};

// ---- Merge selected products into one grouped product (shared with auto-suggestions) ----
window.mergeProductsIntoGroup = function(ids, groupName) {
  if (ids.length < 2) return false;
  const target = db.products[ids[0]];
  if (!target) return false;
  // BUG FIX: merging used to just `delete db.products[srcId]` locally with no
  // corresponding delete on Supabase — the merged-away product rows (and their
  // product_variants/product_categories junction rows) were left orphaned in the
  // cloud database forever, since upsert() never removes rows that stop appearing
  // locally. Now mirrors the same best-effort cloud delete window.deleteProduct() uses.
  const mergedAwayIds = [];
  ids.slice(1).forEach(srcId => {
    const src = db.products[srcId];
    if (!src) return;
    (src.variants || []).forEach(v => {
      target.variants.push({ ...v, id: 'v-' + Date.now() + Math.random().toString(36).slice(2, 6), sizeName: `${src.name} - ${v.sizeName}` });
    });
    // รวมหมวดหมู่ของทุกสินค้าที่ถูกยุบเข้าด้วยกันด้วย ไม่ใช่แค่ของสินค้าตัวหลัก
    (src.cat || []).forEach(cName => { if (!target.cat) target.cat = []; if (!target.cat.includes(cName)) target.cat.push(cName); });
    mergedAwayIds.push(srcId);
    delete db.products[srcId];
  });
  target.name = groupName;
  window.persist?.();
  (async () => {
    const c = sb();
    if (!c) return;
    for (const id of mergedAwayIds) {
      try { await c.from('products').delete().eq('id', toUUID ? toUUID(id) : id); } catch (e) { console.warn('cleanup delete failed for merged product', id, e); }
    }
  })();
  window.syncProductsToSupabase?.(true);
  return true;
};

window.openMergeGroupModal = function() {
  if (selectedProductIds.size < 2) return window.showAlert?.('เลือกไม่พอ', 'กรุณาเลือกสินค้าอย่างน้อย 2 รายการเพื่อรวมกลุ่ม', true);
  const ids = Array.from(selectedProductIds);
  document.getElementById('merge-group-preview').innerHTML = ids.map(id => {
    const p = db.products[id];
    return p ? `<div class="bg-slate-50 p-2 rounded-lg border">${escapeHTML(p.name)} <span class="text-slate-400">(${p.variants.length} ขนาด)</span></div>` : '';
  }).join('');
  document.getElementById('merge-group-name').value = db.products[ids[0]]?.name || '';
  document.getElementById('modal-merge-group').classList.remove('hidden');
  document.getElementById('modal-merge-group').classList.add('flex');
};

window.confirmMergeGroup = function() {
  const groupName = document.getElementById('merge-group-name').value.trim();
  if (!groupName) return window.showAlert?.('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อกลุ่ม', true);
  const ids = Array.from(selectedProductIds);
  const count = ids.length;
  if (!window.mergeProductsIntoGroup(ids, groupName)) return;
  window.closeModal('modal-merge-group');
  window.clearStockSelection();
  window.renderStockTable();
  window.renderSaleHome?.();
  window.populatePOPickers?.();
  window.showToast?.(`รวม ${count} รายการเป็นกลุ่ม "${groupName}" สำเร็จ`);
};

// ---- Auto-detect likely groups by name (same base name, differing size/color/letter
// suffix) — always shown for review; nothing is merged automatically. ----
// ปรับเพิ่มรอบนี้ (เพื่อให้ "จับกลุ่มได้จริง" ตามที่แจ้งว่ายังจับไม่ค่อยเจอ):
//  - เดิมต้องมีช่องว่างคั่นก่อนตัวอักษรไซส์เท่านั้น ("เสื้อยืด XL" เจอ แต่ "เสื้อยืดXL" ไม่เจอ)
//    ตอนนี้คั่นด้วยช่องว่าง/ขีด/วงเล็บ/ไม่มีอะไรคั่นเลยก็เจอหมด
//  - เพิ่มการตัดวงเล็บท้ายชื่อทั้งก้อนออก เช่น "เสื้อยืด (สีแดง)" -> "เสื้อยืด"
//  - เพิ่ม fallback แบบ "คำนำหน้าเหมือนกันยาวพอสมควร" (longest common prefix) สำหรับชื่อที่
//    ไม่ตรง pattern สี/ไซส์/หน่วยเป๊ะเลย แต่ขึ้นต้นเหมือนกันมากจนน่าจะเป็นสินค้าเดียวกัน — วิธีนี้
//    มั่นใจน้อยกว่า จึงติดป้ายเตือนให้ตรวจสอบก่อนกดรวมเป็นพิเศษ (ระบบไม่รวมให้อัตโนมัติอยู่แล้ว)
function getProductBaseName(name) {
  let base = (name || '').trim();
  const colors = ['สีแดง', 'สีน้ำเงิน', 'สีเขียว', 'สีเหลือง', 'สีดำ', 'สีขาว', 'สีส้ม', 'สีชมพู', 'สีม่วง', 'สีเทา', 'สีน้ำตาล', 'สีทอง', 'สีเงิน', 'สีฟ้า', 'สีครีม'];
  const thaiSizes = ['เล็กพิเศษ', 'ใหญ่พิเศษ', 'เล็ก', 'กลาง', 'ใหญ่'];
  const unitNumberRe = /[\s\-\/]*\(?\d+(\.\d+)?\s*(\/\s*\d+(\.\d+)?)?\s*(x\s*\d+(\.\d+)?)?\s*(นิ้ว|หุน|มม\.?|ซม\.?|มล\.?|ลิตร|กก\.?|kg|g|mm|cm|ml|l)\)?\s*$/i;
  // [\s\-\/,]* แทน \s+ เดิม: คั่นด้วยช่องว่าง/ขีด/สแลช/จุลภาค หรือ "ไม่คั่นเลย" ก็จับได้
  const letterSizeRe = /[\s\-\/,]*\(?(XXXL|XXL|XL|L|M|S|XS)\)?\s*$/i;
  const trailingParenRe = /\s*\([^()]{1,20}\)\s*$/; // วงเล็บท้ายชื่อ เช่น "(สีแดง)" "(เบอร์ 8)"

  let changed = true, guard = 0;
  while (changed && guard < 6) {
    changed = false; guard++;
    const colorHit = colors.find(c => base.endsWith(c) || base.endsWith(`(${c})`));
    if (colorHit) { base = base.replace(new RegExp(`\\(?${colorHit}\\)?\\s*$`), '').trim(); changed = true; continue; }
    const thaiSizeHit = thaiSizes.find(c => base.endsWith(c) || base.endsWith(`(${c})`));
    if (thaiSizeHit) { base = base.replace(new RegExp(`\\(?${thaiSizeHit}\\)?\\s*$`), '').trim(); changed = true; continue; }
    let stripped = base.replace(unitNumberRe, '').trim();
    if (stripped && stripped !== base) { base = stripped; changed = true; continue; }
    stripped = base.replace(letterSizeRe, '').trim();
    if (stripped && stripped !== base) { base = stripped; changed = true; continue; }
    stripped = base.replace(trailingParenRe, '').trim();
    if (stripped && stripped !== base) { base = stripped; changed = true; continue; }
  }
  return base;
}

// Fallback แบบ "คำนำหน้าเหมือนกัน" สำหรับชื่อที่ไม่ตรง pattern สี/ไซส์ที่รู้จักเลย —
// ต้องยาวอย่างน้อย 4 ตัวอักษร และอย่างน้อย 60% ของชื่อที่สั้นกว่า ถึงจะถือว่าน่าจะเป็นกลุ่มเดียวกัน
function longestCommonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i).trim();
}

// สองวิธีตรวจจับกลุ่มสินค้า:
//  1) ชื่อคล้ายกันแต่ท้ายชื่อมีขนาด/สี/หน่วยต่างกัน (getProductBaseName ตัดท้ายออก)
//  2) รูปภาพเดียวกันเป๊ะ (imageUrl ตรงกัน) — เผื่อกรณีชื่อไม่คล้ายกันเลยแต่ใช้รูปสินค้า
//     ใบเดียวกันเพราะเป็นของชิ้นเดียวกันจริงๆ (เช่นตั้งชื่อรุ่นไว้คนละแบบ)
// ถ้ากลุ่มไหนตรวจพบจากทั้งสองวิธีด้วยชุดสินค้าเดียวกันพอดี จะรวมเป็นการ์ดเดียว ไม่ขึ้นซ้ำ
window.suggestProductGroups = function() {
  const candidates = Object.values(db.products).filter(p => (p.variants || []).length <= 1);

  // วิธีที่ 1: ชื่อคล้ายกัน
  const byName = {};
  candidates.forEach(p => {
    const base = getProductBaseName(p.name);
    if (base.length > 1) (byName[base] = byName[base] || []).push(p);
  });
  const nameSuggestions = Object.entries(byName)
    .filter(([, items]) => items.length > 1)
    .map(([base, items]) => ({ label: base, reason: 'ชื่อคล้ายกัน', items }));

  // วิธีที่ 2: รูปภาพเดียวกัน (เฉพาะรูปจริง ไม่ใช่ emoji ว่างๆ ที่จะชนกันมั่ว)
  const byImage = {};
  candidates.forEach(p => {
    const url = p.imageUrl;
    if (url && /^(https?:|data:)/.test(url)) (byImage[url] = byImage[url] || []).push(p);
  });
  const imageSuggestions = Object.values(byImage)
    .filter(items => items.length > 1)
    .map(items => ({ label: getProductBaseName(items[0].name) || items[0].name, reason: 'รูปภาพเดียวกัน', items }));

  // รวมสองชุดแรก: ถ้าชุดสินค้า (id) เหมือนกันเป๊ะทั้งสองวิธี ให้โชว์ใบเดียวแต่บอกเหตุผลทั้งคู่
  const merged = [];
  const keyOf = items => items.map(p => p.id).sort().join(',');
  [...nameSuggestions, ...imageSuggestions].forEach(sug => {
    const key = keyOf(sug.items);
    const existing = merged.find(m => keyOf(m.items) === key);
    if (existing) { if (!existing.reason.includes(sug.reason)) existing.reason += ' + ' + sug.reason; }
    else merged.push({ ...sug });
  });

  // วิธีที่ 3 (fallback, มั่นใจน้อยกว่า): ชื่อที่ไม่ตรง pattern สี/ไซส์ที่รู้จักเลย แต่ขึ้นต้น
  // เหมือนกันยาวมากจนน่าจะเป็นสินค้าเดียวกัน — รันเฉพาะกับสินค้าที่ยังไม่ถูกจับกลุ่มได้จาก
  // 2 วิธีแรก เพื่อไม่ขึ้นซ้ำ และต้องคำนำหน้าเหมือนกัน ≥60% ของชื่อที่สั้นกว่า (อย่างน้อย 4 ตัวอักษร)
  // ถึงจะเสนอ ป้ายกำกับ "ตรวจสอบก่อนรวม" ให้เห็นชัดว่าความมั่นใจต่ำกว่าสองวิธีแรก
  const alreadyGrouped = new Set(merged.flatMap(m => m.items.map(p => p.id)));
  const remaining = candidates.filter(p => !alreadyGrouped.has(p.id));
  const fuzzyGroups = [];
  const usedInFuzzy = new Set();
  for (let i = 0; i < remaining.length; i++) {
    if (usedInFuzzy.has(remaining[i].id)) continue;
    const cluster = [remaining[i]];
    for (let j = i + 1; j < remaining.length; j++) {
      if (usedInFuzzy.has(remaining[j].id)) continue;
      const prefix = longestCommonPrefix(remaining[i].name, remaining[j].name);
      const shorterLen = Math.min(remaining[i].name.length, remaining[j].name.length);
      if (prefix.length >= 4 && prefix.length >= shorterLen * 0.6) cluster.push(remaining[j]);
    }
    if (cluster.length > 1) {
      cluster.forEach(p => usedInFuzzy.add(p.id));
      const label = cluster.reduce((a, b) => longestCommonPrefix(a, b.name), cluster[0].name);
      fuzzyGroups.push({ label: label || cluster[0].name, reason: 'ชื่อคล้ายกันบางส่วน — ตรวจสอบก่อนรวม', items: cluster, lowConfidence: true });
    }
  }
  merged.push(...fuzzyGroups);

  const el = document.getElementById('group-suggestions-list');
  el.innerHTML = merged.length ? merged.map(({ label, reason, items, lowConfidence }) => `
          <div class="bg-slate-50 p-3 rounded-xl border text-xs ${lowConfidence ? 'border-amber-300' : ''}">
            <div class="flex justify-between items-center mb-1.5 gap-2">
              <div class="min-w-0">
                <b class="text-slate-800">${escapeHTML(label)} <span class="text-slate-400 font-normal">(${items.length} รายการ)</span></b>
                <div class="text-[9px] ${lowConfidence ? 'text-amber-600' : 'text-indigo-500'} font-bold">${lowConfidence ? '⚠️' : '🔎'} ${escapeHTML(reason)}</div>
              </div>
              <button onclick='window.applyGroupSuggestion(${JSON.stringify(items.map(p => p.id))}, ${JSON.stringify(label)})' class="flex-shrink-0 text-[10px] bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-2.5 py-1.5 rounded-lg btn-touch">✅ รวมกลุ่มนี้</button>
            </div>
            <div class="flex flex-wrap gap-1">${items.map(p => `<span class="bg-white border rounded-full px-2 py-0.5 text-[10px]">${escapeHTML(p.name)}</span>`).join('')}</div>
          </div>
        `).join('') : `<p class="text-center text-slate-400 font-bold py-6 text-xs">ไม่พบสินค้าที่ชื่อหรือรูปคล้ายกันพอจะจับกลุ่มได้ในตอนนี้</p>`;

  document.getElementById('modal-group-suggestions').classList.remove('hidden');
  document.getElementById('modal-group-suggestions').classList.add('flex');
};

window.applyGroupSuggestion = function(ids, base) {
  if (!confirm(`รวม ${ids.length} รายการเป็นกลุ่ม "${base}"?`)) return;
  if (!window.mergeProductsIntoGroup(ids, base)) return;
  window.renderStockTable();
  window.renderSaleHome?.();
  window.showToast?.(`รวมกลุ่ม "${base}" สำเร็จ`);
  window.suggestProductGroups(); // refresh the list — this group is now merged and gone
};
