/* =============================================================================
 * js/sales/cart.js
 * ตะกร้าสินค้า: เพิ่มสินค้า, ส่วนลดบิล
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * addUnifiedToCart, cart, _flyNameToCart
 * ============================================================================= */

// ==========================================
// CART & BILL DISCOUNTS
// ==========================================
window.addUnifiedToCart = function(productId, variantId, fractionId, evt) {
  const p = db.products[productId];
  if (!p) return;
  const v = p.variants.find(x => x.id === variantId);
  if (!v) return;

  let name = `${p.name} (${v.sizeName})`;
  let price = roundAmt(v.price);
  let multiplier = 1;

  if (fractionId) {
    const f = v.fractions.find(x => x.id === fractionId);
    if (f) {
      name = `${p.name} (${v.sizeName} - ${f.fractionName})`;
      price = roundAmt(f.fractionPrice);
      multiplier = roundStock(f.fractionMultiplier);
    }
  }

  const cartKey = `${productId}_${variantId}_${fractionId || 'main'}`;
  const existing = cart.find(x => x.cartKey === cartKey);

  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ cartKey, id: productId, variantId, fractionId, name, price, qty: 1, multiplier });
  }

  window.cart = cart;
  window.updateCartUI();
  window.showToast("เพิ่มลงตะกร้าเรียบร้อย");
  if (evt) window._flyNameToCart?.(evt, p.name);
};

// ชื่อสินค้าที่กดหยิบ "วิ่ง" ไปที่ไอคอนตะกร้าที่หัวจอ — ฟีดแบ็กภาพให้รู้ทันทีว่าหยิบสำเร็จ
// และหยิบอะไรไป โดยไม่ต้องเหลือบมองข้อความ toast. ล้มเหลวแบบเงียบๆ ถ้าหา element ที่
// เกี่ยวข้องไม่เจอ (ไม่ควรทำให้การหยิบสินค้าเข้าตะกร้าจริงพังเพราะเรื่องเอฟเฟกต์)
window._flyNameToCart = function(evt, name) {
  try {
    const srcEl = evt.currentTarget || evt.target;
    const cartBtn = document.getElementById('header-cart-btn');
    if (!srcEl || !cartBtn) return;
    const srcRect = srcEl.getBoundingClientRect();
    const dstRect = cartBtn.getBoundingClientRect();
    const chip = document.createElement('div');
    chip.textContent = '🛒 ' + name;
    chip.className = 'fly-to-cart-chip';
    chip.style.left = (srcRect.left + srcRect.width / 2) + 'px';
    chip.style.top = (srcRect.top + srcRect.height / 2) + 'px';
    document.body.appendChild(chip);
    requestAnimationFrame(() => {
      chip.style.left = (dstRect.left + dstRect.width / 2) + 'px';
      chip.style.top = (dstRect.top + dstRect.height / 2) + 'px';
      chip.style.transform = 'translate(-50%,-50%) scale(.25)';
      chip.style.opacity = '0';
    });
    setTimeout(() => chip.remove(), 550);
    cartBtn.classList.add('cart-bump');
    setTimeout(() => cartBtn.classList.remove('cart-bump'), 280);
  } catch (e) { /* purely cosmetic — never block the actual add-to-cart */ }
};
