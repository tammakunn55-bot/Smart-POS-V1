/* =============================================================================
 * js/settings/category-supplier-managers.js
 * หน้าจัดการหมวดหมู่และซัพพลายเออร์ (เพิ่ม/แก้/ลบ)
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * openCategoryModal, renderCategoryParentOptions, renderCategoryManagerList, editCategory,
 * saveCategory, deleteCategory, saveSupplier, deleteSupplier
 * ============================================================================= */

// ==========================================
// CATEGORY, USER & SUPPLIER MANAGERS
// ==========================================
window.openCategoryModal = function() {
  window.renderCategoryManagerList();
  window.renderCategoryParentOptions();
  document.getElementById('edit-cat-id').value = '';
  document.getElementById('modal-category').classList.remove('hidden');
  document.getElementById('modal-category').classList.add('flex');
};

// มาตรฐานทั่วไปสำหรับหมวดหมู่สินค้าคือโครงสร้างต้นไม้แบบ parent/child ชั้นเดียวหรือหลายชั้น
// (เช่น "เครื่องมือช่าง" > "สว่าน" > "สว่านไร้สาย") — ที่นี่รองรับหมวดหมู่ย่อยด้วยฟิลด์
// parentId บนตัวหมวดหมู่เอง ส่วนสินค้าหนึ่งชิ้นผูกกับ "หมวดหมู่" ได้หลายรายการพร้อมกัน
// (ผ่าน p.cat ที่เป็น array อยู่แล้ว — ตรงกับตาราง product_categories แบบ many-to-many
// ที่ระบบซิงก์ไป Supabase คาดหวังไว้ตั้งแต่แรก) จึงค้นหาสินค้าเจอได้จากหลายเส้นทาง
// โดยไม่ต้องเลือกว่าสินค้าจะ "อยู่หมวดไหนหมวดเดียว" อีกต่อไป
window.renderCategoryParentOptions = function(excludeId) {
  const sel = document.getElementById('cat-parent-input');
  const topLevel = db.categories.filter(c => !c.parentId && c.id !== excludeId);
  sel.innerHTML = `<option value="">— หมวดหมู่หลัก (ไม่มีแม่) —</option>` +
    topLevel.map(c => `<option value="${c.id}">${escapeHTML(c.icon || '📁')} ${escapeHTML(c.name)}</option>`).join('');
};

window.renderCategoryManagerList = function() {
  const container = document.getElementById('cat-manager-list');
  const topLevel = db.categories.filter(c => !c.parentId);
  const childrenOf = pid => db.categories.filter(c => c.parentId === pid);
  const rowHtml = (c, indent) => `
          <div class="bg-slate-50 p-2.5 rounded-xl border flex justify-between items-center" style="margin-left:${indent * 16}px">
            <div class="flex items-center gap-2 min-w-0">
              ${indent ? '<span class="text-slate-300">↳</span>' : ''}
              <span class="text-base">${escapeHTML(c.icon || '📁')}</span>
              <b class="truncate">${escapeHTML(c.name)}</b>
            </div>
            <div class="flex-shrink-0 flex gap-2">
              <button onclick="window.editCategory('${c.id}')" class="text-indigo-600 font-bold hover:underline">แก้ไข</button>
              <button onclick="window.deleteCategory('${c.id}')" class="text-rose-500 font-bold hover:underline">ลบ</button>
            </div>
          </div>`;
  let html = '';
  topLevel.forEach(c => {
    html += rowHtml(c, 0);
    childrenOf(c.id).forEach(child => { html += rowHtml(child, 1); });
  });
  container.innerHTML = html || `<p class="text-center text-slate-400 font-bold py-3">ยังไม่มีหมวดหมู่</p>`;
};

window.editCategory = function(id) {
  const c = db.categories.find(x => x.id === id);
  if (!c) return;
  document.getElementById('edit-cat-id').value = c.id;
  document.getElementById('cat-name-input').value = c.name;
  document.getElementById('cat-icon-input').value = c.icon || '';
  document.getElementById('cat-color-input').value = c.color || '#6366f1';
  window.renderCategoryParentOptions(c.id); // exclude self from the parent list — a category can't be its own parent
  document.getElementById('cat-parent-input').value = c.parentId || '';
};

window.saveCategory = function() {
  const editId = document.getElementById('edit-cat-id').value;
  const name = document.getElementById('cat-name-input').value.trim();
  const icon = document.getElementById('cat-icon-input').value.trim() || '📁';
  const color = document.getElementById('cat-color-input').value;
  const parentId = document.getElementById('cat-parent-input').value || null;
  if (!name) return window.showAlert("ข้อมูลไม่ครบ", "กรุณากรอกชื่อหมวดหมู่", true);
  if (parentId === editId) return window.showAlert("ผิดพลาด", "หมวดหมู่ไม่สามารถเป็นแม่ของตัวเองได้", true);

  if (editId) {
    const c = db.categories.find(x => x.id === editId);
    if (c) { c.name = name; c.icon = icon; c.color = color; c.parentId = parentId; }
  } else {
    db.categories.push({ id: 'cat-' + Date.now(), name, icon, color, parentId });
  }
  document.getElementById('edit-cat-id').value = '';
  document.getElementById('cat-name-input').value = '';
  document.getElementById('cat-icon-input').value = '';
  window.persist?.();
  window.renderCategoryManagerList();
  window.renderCategoryParentOptions();
  window.renderSaleHome?.();
  window.showToast("บันทึกหมวดหมู่สำเร็จ");
};

window.deleteCategory = function(id) {
  const cat = db.categories.find(c => c.id === id);
  if (!cat) return;
  // ก่อนลบ: ปลดหมวดหมู่ย่อยของหมวดนี้ให้กลายเป็นหมวดหมู่หลักแทน (ไม่ลบตาม เพื่อไม่ให้
  // ข้อมูลหายเป็นลูกโซ่โดยไม่ตั้งใจ) และเอาชื่อหมวดหมู่นี้ออกจากทุกสินค้าที่เคยผูกไว้
  // ไม่งั้นสินค้าจะยังมีชื่อหมวดหมู่ที่ไม่มีอยู่จริงค้างอยู่ใน p.cat
  db.categories.forEach(c => { if (c.parentId === id) c.parentId = null; });
  Object.values(db.products || {}).forEach(p => {
    if (p.cat && p.cat.includes(cat.name)) p.cat = p.cat.filter(n => n !== cat.name);
  });
  db.categories = db.categories.filter(c => c.id !== id);
  window.persist?.();
  window.renderCategoryManagerList();
  window.renderCategoryParentOptions?.();
  window.renderStockTable?.();
  window.renderSaleHome?.();
  window.showToast("ลบหมวดหมู่สำเร็จ");
};

// Employee management now lives inline in the Settings > USERS tab (see switchSettingsTab)
// instead of a separate floating modal, matching the other management panels.
// NOTE: window.renderUserManagerList / window.saveUser / window.deleteUser are defined
// later in the "Enterprise Management Repair Layer" script (with role support and
// hashed PINs via window.hashPin) — that is the active implementation actually used
// by the Settings > USERS tab.

window.saveSupplier = function() {
  const name = document.getElementById('supplier-name-input').value.trim();
  const terms = parseInt(document.getElementById('supplier-terms-input').value) || 30;
  if (!name) return window.showAlert("ข้อมูลไม่ครบ", "กรุณากรอกชื่อซัพพลายเออร์", true);

  const id = 'SUP-' + Date.now().toString(36).toUpperCase();
  db.suppliers[id] = { id, name, terms };
  document.getElementById('supplier-name-input').value = '';
  window.persist?.();
  window.renderSettingsSuppliers?.();
  window.populatePOPickers?.();
  window.showToast("บันทึกซัพพลายเออร์สำเร็จ");
};

window.deleteSupplier = function(id) {
  delete db.suppliers[id];
  window.persist?.();
  window.renderSettingsSuppliers?.();
  window.populatePOPickers?.();
  window.showToast("ลบซัพพลายเออร์สำเร็จ");
};
