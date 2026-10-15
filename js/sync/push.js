/* =============================================================================
 * js/sync/push.js
 * ส่งข้อมูลหลักขึ้นเซิร์ฟเวอร์ (สินค้า/ลูกค้า/ซัพพลายเออร์/พนักงาน/กะ) + ปุ่ม "ซิงค์ตอนนี้"
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * _syncProductsImpl, _lastSyncError, syncProductsToSupabase, syncTransactionsToSupabase,
 * forceSyncNow, adoptServerUserId, reconcileOwnerId
 * ============================================================================= */

window._syncProductsImpl = async function(isQuiet = false) {
  const client = window.getSupabaseClient();
  if (!client) return false;
    if (!window.serverIsManager()) return true;   // แคตตาล็อก/ลูกค้า/พนักงาน: ผู้จัดการขึ้นไปเท่านั้นที่ซิงค์ขึ้นได้ (RLS บังคับอยู่แล้ว)

  try {
    // 1. Categories
    const categoryRows = (db.categories || []).map((c, idx) => ({
      id: toUUID(c.id),
      name: c.name,
      icon: c.icon || '📁',
      color: c.color || '#4F46E5',
      display_order: idx + 1
    }));
    if (categoryRows.length > 0) {
      const { error: catErr } = await client.from('categories').upsert(categoryRows, { onConflict: 'id' });
      if (catErr) throw catErr;
    }

    // 2. Products — schema note: price/cost/stock no longer live on `products` at all
    // (moved entirely onto product_variants below). `products` only holds catalog-level
    // fields shared across every size/variant of the item.
    const productsList = Object.values(db.products || {});
    // ตาราง products ฝั่ง Supabase มี "sku unique" กันไว้ — ถ้าสินค้าในเครื่องนี้ดันมีรหัส
    // ซ้ำกันอยู่ (เช่น นำเข้าไฟล์เก่าตั้งแต่ก่อนมีการกันซ้ำตอนนำเข้า) การ upsert ทั้งก้อนจะโดน
    // ปฏิเสธทั้งหมดด้วย error 23505 ทันทีที่เจอแค่คู่เดียว (all-or-nothing) ทำให้สินค้าทั้งร้าน
    // ไม่ขึ้น Supabase เลยสักตัว จึงต้องเช็คและแก้ไขรหัสซ้ำในเครื่องให้เรียบร้อยก่อน "ทุกครั้ง"
    // ที่จะซิงค์ ไม่ใช่แค่ตอนนำเข้าไฟล์ใหม่เท่านั้น — แก้ตรงนี้แล้ว persist กลับลง db.products
    // ด้วยเลย เพื่อให้ทั้งเครื่องนี้และ Supabase เห็นรหัสเดียวกันตรงกันเสมอ
    const seenSku = new Map();
    const renamedSkus = [];
    productsList.forEach(p => {
      let sku = String(p.code || p.id).trim();
      if (seenSku.has(sku)) {
        const n = seenSku.get(sku) + 1;
        seenSku.set(sku, n);
        const newSku = sku + '-DUP' + n;
        renamedSkus.push(`${p.name}: ${sku} → ${newSku}`);
        p.code = newSku;
        if (p.variants && p.variants[0]) p.variants[0].barcode = newSku;
      } else {
        seenSku.set(sku, 1);
      }
    });
    if (renamedSkus.length > 0) {
      window.persist?.();
      console.warn('syncProductsToSupabase: renamed duplicate SKUs before sync', renamedSkus);
    }
    const productRows = productsList.map(p => ({
      id: toUUID(p.id),
      sku: p.code || p.id,
      name: p.name,
      image_url: p.imageUrl || null,
      min_stock_alert: roundStock((p.variants && p.variants[0] && p.variants[0].minStock) || 5),
      is_active: !p.isDeleted
    }));
    if (productRows.length > 0) {
      const { error: prodErr } = await client.from('products').upsert(productRows, { onConflict: 'id' });
      if (prodErr) throw prodErr;
    }

    // 3. Product Categories Junction
    const nameToId = {};
    (db.categories || []).forEach(c => { nameToId[c.name] = c.id; });
    const linkRows = [];
    productsList.forEach(p => {
      (p.cat || []).forEach(cName => {
        if (nameToId[cName]) {
          linkRows.push({
            product_id: toUUID(p.id),
            category_id: toUUID(nameToId[cName])
          });
        }
      });
    });
    if (linkRows.length > 0) {
      const { error: linkErr } = await client.from('product_categories').upsert(linkRows, { onConflict: 'product_id,category_id' });
      if (linkErr) throw linkErr;
    }

    // 4. Product Variants — price/cost_price are direct columns here (no more
    // override-with-fallback-to-parent semantics from the old schema).
    const variantRows = [];
    const _vSeen = new Set();   // sku ของ variant ต้องไม่ซ้ำ (unique index) — ซ้ำให้เป็น null แทนที่จะทำให้ซิงค์ทั้งชุดล้ม
    const _vsku = (v) => { const k = v.sku ? String(v.sku).trim() : ''; if (!k || _vSeen.has(k)) return null; _vSeen.add(k); return k; };
    productsList.forEach(p => {
      (p.variants || []).forEach(v => {
        variantRows.push({
          id: toUUID(v.id),
          product_id: toUUID(p.id),
          variant_name: v.sizeName || 'ปกติ',
          barcode: v.barcode || null,
          sku: _vsku(v),
          price: roundAmt(v.price),
          cost_price: roundAmt(v.cost),
          // (v10) ไม่ส่ง stock_quantity ในการ upsert อีกแล้ว — เดิมเครื่องไหนซิงค์ทีหลังจะเขียนทับสต็อกของเครื่องอื่น
          // สต็อกเปลี่ยนผ่าน RPC เท่านั้น (create_sale / process_return / receive_goods / adjust_stock / seed)
          is_active: !p.isDeleted
        });
      });
    });
    if (variantRows.length > 0) {
      const { error: varErr } = await client.from('product_variants').upsert(variantRows, { onConflict: 'id' });
      if (varErr) throw varErr;
      await window._seedStock(client, productsList);   // ส่งสต็อกตั้งต้นครั้งเดียวต่อสินค้า (ไม่ทับค่าที่เซิร์ฟเวอร์รู้อยู่แล้ว)
    }

    // 5. Product Fractions — keyed off variant_id (not product_id), and the ratio column
    // is named quantity_ratio: "how many fraction units make up 1 whole stock unit" — e.g.
    // a fraction sold by the metre out of a 100m roll has quantity_ratio = 100, matching
    // this schema's create_sale RPC which divides quantity sold by this ratio to find how
    // much to deduct from stock_quantity. This is the INVERSE of the old schema's
    // fractionMultiplier (which was "how much of 1 stock unit does 1 fraction unit use"),
    // so it's converted here rather than passed through directly.
    const fractionRows = [];
    productsList.forEach(p => {
      (p.variants || []).forEach(v => {
        (v.fractions || []).forEach(f => {
          const ratio = f.fractionMultiplier > 0 ? roundStock(1 / f.fractionMultiplier) : 1;
          fractionRows.push({
            id: toUUID(f.id),
            variant_id: toUUID(v.id),
            fraction_name: f.fractionName,
            quantity_ratio: ratio,
            price: roundAmt(f.fractionPrice),
            barcode: f.barcode || null
          });
        });
      });
    });
    if (fractionRows.length > 0) {
      const { error: fracErr } = await client.from('product_fractions').upsert(fractionRows, { onConflict: 'id' });
      if (fracErr) throw fracErr;
    }

    // 6. Customers — ไม่ส่ง debt ใน upsert นี้ (trigger guard_balance_columns ห้ามแก้ยอดหนี้ตรงๆ)
    // ยอดหนี้ตั้งต้นส่งครั้งเดียวผ่าน seed_customer_debt (ผู้จัดการเท่านั้น) หลังจากนั้นเปลี่ยนผ่าน RPC
    // (create_sale / process_return / receive_customer_payment) เท่านั้น
    const customerRows = Object.values(db.customers || {}).map(c => ({
      id: toUUID(c.id),
      name: c.name,
      phone: c.phone || null,
      address: c.address || '',
      credit_limit: roundAmt(c.creditLimit ?? 0)   // ไม่ระบุ = ไม่มีวงเงิน (ปลอดภัยไว้ก่อน — ให้ผู้จัดการตั้งวงเงินเอง) ตรงกับค่าเริ่มต้นของ schema
    }));
    if (customerRows.length > 0) {
      const { error: custErr } = await client.from('customers').upsert(customerRows, { onConflict: 'id' });
      if (custErr) throw custErr;
      await window._seedDebts(client, Object.values(db.customers || {}));   // ยอดหนี้ตั้งต้นครั้งเดียว — หลังจากนั้นเปลี่ยนผ่าน RPC เท่านั้น
    }

    // 7. Suppliers
    const supplierRows = Object.entries(db.suppliers || {}).map(([key, s]) => ({
      id: toUUID(key),
      name: s.name,
      phone: s.phone || null,
      address: s.address || ''
    }));
    if (supplierRows.length > 0) {
      const { error: supErr } = await client.from('suppliers').upsert(supplierRows, { onConflict: 'id' });
      if (supErr) throw supErr;
    }

    // 8. app_users — auth_user_id ไม่ส่งจากแอป (เจ้าของตั้งผ่าน bootstrap_first_owner, พนักงานผ่าน Edge Function
    // pin-login) ที่ส่งในคอลัมน์ `pin` คือ hash เท่านั้น (pbkdf2$...) ไม่ใช่ PIN ดิบ
    // และ client อ่านคอลัมน์ pin กลับจากเซิร์ฟเวอร์ไม่ได้ (ถูก revoke ใน schema.sql ข้อ 9)
    await window.reconcileOwnerId(client);   // ให้ id ของเจ้าของในเครื่องตรงกับแถวบนเซิร์ฟเวอร์ก่อน (กันสร้างเจ้าของซ้ำ → ชนดัชนี one_owner)
    const userRows = (db.users || [])
      .filter(u => u.pinHash)
      .map(u => ({
        id: toUUID(u.id),
        name: u.name,
        pin: u.pinHash,
        role: u.role || 'CASHIER',
        permissions: u.permissions || []
        // ไม่ส่ง is_active: แถวใหม่ได้ค่าเริ่มต้น true ส่วนแถวเดิมคงสถานะบนเซิร์ฟเวอร์ไว้
        // (เดิมส่ง true ทุกครั้ง → เครื่องที่ข้อมูลเก่าปลุกพนักงานที่ถูกปิดบัญชีกลับมาได้)
      }));
    if (userRows.length > 0) {
      const { error: userErr } = await client.from('app_users').upsert(userRows, { onConflict: 'id' });
      if (userErr) throw userErr;
    }

    if (renamedSkus.length > 0 && !isQuiet) {
      window.showAlert?.('แก้รหัสสินค้าซ้ำอัตโนมัติก่อนซิงค์',
        `พบและแก้รหัส/บาร์โค้ดที่ซ้ำกัน ${renamedSkus.length} รายการก่อนส่งขึ้น Supabase (เติม "-DUP" ต่อท้าย) เพื่อไม่ให้ทั้งชุดซิงค์ไม่ผ่าน แนะนำให้ไปตรวจแก้รหัสที่ถูกต้องในเมนูสินค้าอีกครั้ง:\n\n` + renamedSkus.slice(0, 10).join('\n') + (renamedSkus.length > 10 ? `\n...และอีก ${renamedSkus.length - 10} รายการ` : ''),
        false);
    }
    return true;
  } catch (err) {
    console.error("Products SQL sync error:", err);
    window._lastSyncError = err;
    if (!isQuiet) window.showAlert("ข้อผิดพลาดในการซิงค์สินค้า", window.describeError(err), true);
    return false;
  }
};

let _prodSyncPromise = null;   // กันซิงค์สินค้าซ้อนกัน (บันทึกสินค้า + คิวซิงค์ + ปุ่มซิงค์)
window.syncProductsToSupabase = function(isQuiet) {
  if (_prodSyncPromise) return _prodSyncPromise;
  _prodSyncPromise = window._syncProductsImpl(isQuiet).finally(() => { _prodSyncPromise = null; });
  return _prodSyncPromise;
};

window.syncTransactionsToSupabase = async function(isQuiet = false) {
  const client = window.getSupabaseClient();
  if (!client) return false;

  try {
    // 1. Shifts — column names in this schema: opening_cash/closing_cash (not
    // starting_cash/ending_cash), opened_at/closed_at, status 'OPEN'/'CLOSED' (uppercase).
    const shiftRows = (db.shifts || []).map(s => ({
      id: toUUID(s.id),
      opened_at: new Date(s.startTime).toISOString(),
      closed_at: s.endTime ? new Date(s.endTime).toISOString() : null,
      opening_cash: roundAmt(s.openingCash),
      closing_cash: s.cashOnHand ? roundAmt(s.cashOnHand) : null,
      status: s.endTime ? 'CLOSED' : 'OPEN'
    }));
    if (shiftRows.length > 0) {
      const { error: shiftErr } = await client.from('shifts').upsert(shiftRows, { onConflict: 'id' });
      if (shiftErr) throw shiftErr;
    }
    if (!window.serverIsManager()) { window.updateSupabaseBadge?.(true); return true; }   // แคชเชียร์ส่งได้แค่กะ — ที่เหลือเป็นงานผู้จัดการ

    // 2. Bills — (v10) ไม่เขียนบิลตรงเข้าตารางอีกต่อไป: บิลทั้งหมดไปทาง create_sale (คิวซิงค์) เท่านั้น
    //    เพื่อให้เซิร์ฟเวอร์ตรวจสต็อก/วงเงิน/ส่วนลดเสมอ ไม่มี fallback ที่ข้ามกฎได้

    // 3. Cash Ledger — real cash-drawer movements only (AR payments received, cash
    // refunds, and manual cash-in/cash-out recorded during a shift). id is synthesized
    // per source since these were never given a stable id shaped for toUUID() the way
    // bills/products are.
    const cashLedgerRows = [];
    (db.cashLedger || []).forEach(cl => {
      if (!cl._viaRpc && (cl.type === 'cash-in-ar' || cl.type === 'expense-refund')) {   // รายการที่ไปทาง RPC แล้วห้ามส่งซ้ำ
        cashLedgerRows.push({
          id: toUUID(cl.id),
          shift_id: cl.shiftId ? toUUID(cl.shiftId) : null,
          type: cl.type,
          income: roundAmt(cl.income || 0),
          expense: roundAmt(cl.expense || 0),
          description: cl.description || null,
          ref_id: cl.refId || null,
          created_at: new Date(cl.time).toISOString()
        });
      }
      // 'ACCOUNTS_PAYABLE' entries are handled separately below (accounts_payable table) —
      // they represent a balance owed, not a cash-drawer movement, so they don't belong here.
    });
    (db.shifts || []).forEach(s => {
      (s.movements || []).forEach(m => {
        cashLedgerRows.push({
          id: toUUID(m.id),
          shift_id: toUUID(s.id),
          type: m.type === 'IN' ? 'SHIFT_CASH_IN' : 'SHIFT_CASH_OUT',
          income: m.type === 'IN' ? roundAmt(m.amount) : 0,
          expense: m.type === 'OUT' ? roundAmt(m.amount) : 0,
          description: m.note || null,
          ref_id: null,
          created_at: new Date(m.time).toISOString()
        });
      });
    });
    if (cashLedgerRows.length > 0) {
      const { error: cashErr } = await client.from('cash_ledger').upsert(cashLedgerRows, { onConflict: 'id' });
      if (cashErr) throw cashErr;
    }

    // 4. Accounts Payable — outstanding supplier debt from goods receipts
    // (window.confirmReceivePO). purchase_order_id links to the purchase_orders row
    // created by that receipt's own background sync (window.syncGoodsReceiptToSupabase),
    // which stores its server-generated id back onto the AP entry as
    // _serverPurchaseOrderId — already a real Supabase uuid, so it's used as-is rather
    // than passed through toUUID(). Falls back to null if that sync hasn't completed yet
    // (offline, or still in flight) — the next sync pass will fill it in once it has.
    const apRows = (db.cashLedger || [])
      .filter(cl => cl.type === 'ACCOUNTS_PAYABLE')
      .map(ap => ({
        id: toUUID(ap.id),
        supplier_id: ap.supplierId ? toUUID(ap.supplierId) : null,
        purchase_order_id: ap._serverPurchaseOrderId || null,
        doc_ref: ap.docRef || null,
        amount: roundAmt(ap.amount || 0),
        credit_terms: ap.terms || 30,
        status: ap.status || 'OPEN',
        created_at: new Date(ap.createdAt).toISOString(),
        paid_at: ap.paidAt ? new Date(ap.paidAt).toISOString() : null
      }));
    if (apRows.length > 0) {
      const { error: apErr } = await client.from('accounts_payable').upsert(apRows, { onConflict: 'id' });
      if (apErr) throw apErr;
    }

    return true;
  } catch (err) {
    console.error("Transactions SQL sync error:", err);
    window._lastSyncError = err;
    if (!isQuiet) window.showAlert("ข้อผิดพลาดในการซิงค์ธุรกรรม", window.describeError(err), true);
    return false;
  }
};

window.forceSyncNow = async function() {
  const client = window.getSupabaseClient();
  if (!client) {
    window.showAlert("ไม่ได้เชื่อมต่อ Supabase", "กรุณากรอก Project URL และ Key ในศูนย์การตั้งค่าก่อน", true);
    return;
  }

  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.remove('hidden');

  try {
    // BUG FIX: เดิมไม่เช็คค่าที่ return กลับมาเลย ต่อให้ syncProductsToSupabase/
    // syncTransactionsToSupabase ล้มเหลวจริง (เช่นโดน RLS บล็อกเพราะยังไม่ได้ล็อกอิน) ก็ยัง
    // ขึ้นโทสต์ "ซิงค์สำเร็จ" หลอกอยู่ดี ทำให้ไม่มีทางรู้เลยว่าทำไมตารางบน Supabase ว่างเปล่า
    // เรียกซ้ำแบบไม่ quiet (isQuiet=false) เฉพาะตัวที่ล้มเหลว เพื่อให้ error จริงเด้งให้เห็น
    const _ver = await window.checkServerSchema();
    if (_ver !== null && _ver < 2) throw new Error('ฐานข้อมูลบนเซิร์ฟเวอร์ยังเป็นเวอร์ชันเก่า — ต้องรัน supabase/migrations/0002_fixes.sql ก่อน');
    if (window.isPerEmployeeAuth() && !window._serverUser) await window.resolveServerUser();
    window.retryFailedSyncOps();   // กดซิงค์เองถือว่าสั่งลองส่งรายการที่เคยล้มเหลวใหม่
    const res1 = await window.syncProductsToSupabase(true);
    const res2 = await window.syncTransactionsToSupabase(true);
    const qres = await window.flushSyncQueue(true);

    // แสดงสาเหตุจริงในกล่องเดียว (เดิมเรียกซ้ำแล้วโยน error ทั่วๆ ไปทับ ทำให้สาเหตุหาย)
    if (!res1) throw new Error('ซิงค์สินค้า/หมวดหมู่/ลูกค้า/พนักงานไม่สำเร็จ\n\n' + window.describeError(window._lastSyncError));
    if (!res2) throw new Error('ซิงค์บิล/กะ/รายรับ-จ่ายไม่สำเร็จ\n\n' + window.describeError(window._lastSyncError));

    if (qres && qres.failed > 0) {
      window.updateSupabaseBadge(false);
      return window.showAlert('ซิงค์เสร็จ แต่มีรายการที่เซิร์ฟเวอร์ปฏิเสธ', window.describeSyncFailures(), true);
    }
    if (qres && qres.pending > 0) { window.updateSupabaseBadge(false); return window.showAlert('ยังมีรายการรอส่ง', `เหลือ ${qres.pending} รายการ (อาจออฟไลน์) — จะลองส่งใหม่อัตโนมัติ`, true); }
    window.updateSupabaseBadge(true);
    window.showToast("ซิงค์ข้อมูลกับ Supabase SQL สำเร็จแล้ว!");
  } catch (err) {
    console.error("Force sync failed:", err);
    window.updateSupabaseBadge(false);
    window.showAlert("เกิดข้อผิดพลาดในการซิงค์", window.describeError(err), true);
  } finally {
    if (overlay) overlay.classList.add('hidden');
  }
};

// ---------------------------------------------------------------------------
// ผูก id ของเจ้าของ/พนักงานในเครื่องให้ตรงกับแถว app_users บนเซิร์ฟเวอร์
// ที่มา: bootstrap_first_owner สร้างแถวเจ้าของด้วย id ที่เซิร์ฟเวอร์สุ่มขึ้น แต่เจ้าของในเครื่องใช้ id ของตัวเอง (เช่น owner-local)
// ตอนซิงค์ครั้งแรกแอปจึงพยายามเพิ่ม "เจ้าของคนที่สอง" → ชนดัชนี idx_app_users_one_owner → ซิงค์ทั้งชุดล้ม
// ---------------------------------------------------------------------------
window.adoptServerUserId = function(user, newId) {
  const oldId = user.id;
  if (!newId || oldId === newId) return false;
  user.id = newId;
  (db.bills || []).forEach(b => { if (b.cashierId === oldId) { b.cashierId = newId; window.posStore?.touchBill(b.id); } });
  (db.shifts || []).forEach(s => { if (s.openedById === oldId) s.openedById = newId; if (s.closedById === oldId) s.closedById = newId; });
  if (db.currentShift && db.currentShift.openedById === oldId) db.currentShift.openedById = newId;
  (db.syncQueue || []).forEach(o => { if (o.by === oldId) o.by = newId; });
  if (db.activeUser && db.activeUser.id === oldId) db.activeUser.id = newId;
  window.persist?.();
  return true;
};

window.reconcileOwnerId = async function(client) {
  const owner = (db.users || []).find(u => u.role === 'OWNER');
  if (!owner) return false;
  const { data, error } = await client.from('app_users').select('id').eq('role', 'OWNER').maybeSingle();
  if (error || !data || !data.id) return false;           // อ่านไม่ได้ (ไม่ใช่ผู้จัดการ) หรือเซิร์ฟเวอร์ยังไม่มีเจ้าของ → ข้าม
  if (toUUID(owner.id) === data.id) return false;          // ตรงกันอยู่แล้ว
  return window.adoptServerUserId(owner, data.id);
};
