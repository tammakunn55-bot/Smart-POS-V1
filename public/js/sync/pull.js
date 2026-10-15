/* =============================================================================
 * js/sync/pull.js
 * ดึงข้อมูลจากเซิร์ฟเวอร์ลงเครื่อง (สินค้า/ลูกค้า/บิล/สต็อก/หนี้) — เฉพาะผู้จัดการขึ้นไป
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * SQL_SCHEMA_VERSION, showView, renderSaleHome, loadDatabaseState, db, confirmPullFromCloud,
 * getSupabase
 * ============================================================================= */


/* Compatibility Bridge: แปลงข้อมูลจาก/ไปยัง schema ของ Supabase */
(function(){
  window.SQL_SCHEMA_VERSION='Smart_POS_Pro_Enterprise_Full_Database_Schema';

  // Compatibility fallbacks for missing functions in the original page.
  window.showView = window.showView || function(viewId){
    document.querySelectorAll('.view-content').forEach(function(v){ v.classList.add('hidden'); });
    const view=document.getElementById('view-'+viewId);
    if(view) view.classList.remove('hidden');
    document.querySelectorAll('.nav-btn-el').forEach(function(btn){
      const active=btn.dataset.view===viewId;
      btn.classList.toggle('opacity-100',active);
      btn.classList.toggle('opacity-40',!active);
    });
    if(viewId==='stock') window.renderStockTable?.();
    if(viewId==='history') window.renderSalesAR?.();
    if(viewId==='po-receive') {
      window.renderPOPicker?.();
      window.populatePOPickers?.();
      window.renderPurchaseHistory?.();
    }
  };

  // UX: added a fixed "ทั้งหมด" tile ahead of the category buttons so staff can browse or
  // search the whole catalog in one tap without first having to guess which category an item
  // was filed under — this is what actually makes "find it fast" possible when unsure.
  // UX rework: category "cards" replaced by a sticky, always-reachable category bar (see
  // window.renderCategoryBar in the main script) — this now just kicks off that bar plus the
  // default "all products" grid, and keeps the bar's sticky offset in sync with the header.
  window.renderSaleHome = window.renderSaleHome || function(){
    if(!window.db) return;
    window.renderCategoryBar?.();
    window.syncCategoryBarOffset?.();
    window.selectCategory?.(null);
  };

  function sb(){ return window.getSupabase ? window.getSupabase() : null; }
  async function q(table, fn){
    const c=sb(); if(!c) return null;
    const r=fn(c.from(table)); if(r && typeof r.then==='function'){ const {data,error}=await r; if(error) throw error; return data; }
    return r;
  }
  // BUG FIX: this used to run automatically on every page load (50ms after DOMContentLoaded)
  // and would silently wipe out db.products with whatever Supabase returned — including an
  // EMPTY catalog if this was the first-ever connection before anything had been pushed up yet.
  // It also re-keyed every product/customer using Supabase's own row UUID instead of the
  // original local id, which is what the cart, receipts, and bill history all still referred
  // to — breaking those references on the very next reload. Pulling from the cloud is now an
  // explicit action (Settings > ฐานข้อมูล Supabase > "ดึงข้อมูลจากคลาวด์"), and the merge below
  // matches existing local products/customers by SKU/phone so their local id — and any
  // in-progress local edits to stock — are preserved rather than overwritten.
  window.loadDatabaseState=async function(silent){
    if (window.isPerEmployeeAuth?.() && !window.serverIsManager?.()) return window.showAlert?.('เฉพาะผู้จัดการ','การดึงข้อมูลจากคลาวด์ทำได้เฉพาะผู้จัดการ/เจ้าของ (แคชเชียร์ไม่มีสิทธิ์อ่านต้นทุน/สต็อกทั้งหมด)',true);
    const c=sb(); if(!c) return false;
    // Run each table fetch independently (allSettled, not all) so a problem with one table
    // — e.g. a bad embedded-relationship query — doesn't block every other table from loading,
    // and so the failure message can name exactly which table/column broke instead of a
    // generic "pull failed" with no way to diagnose it.
    const queries={
      categories:q('categories',x=>x.select('*').order('display_order')),
      products:q('products',x=>x.select('*').eq('is_active',true).order('name')),
      product_categories:q('product_categories',x=>x.select('*')),
      product_variants:q('product_variants',x=>x.select('*').eq('is_active',true)),
      product_fractions:q('product_fractions',x=>x.select('*')),
      customers:q('customers',x=>x.select('*').eq('is_active',true).order('name')),
      bills:q('bills',x=>x.select('*, bill_items(*)').order('created_at',{ascending:false}).limit(1000))
    };
    const keys=Object.keys(queries);
    const settled=await Promise.allSettled(Object.values(queries));
    const results={}, failures=[];
    keys.forEach((k,i)=>{
      if(settled[i].status==='fulfilled'){ results[k]=settled[i].value; }
      else { results[k]=[]; failures.push(`${k}: ${settled[i].reason?.message||settled[i].reason}`); }
    });
    if(keys.every((k,i)=>settled[i].status==='rejected')){
      // Every single table failed — almost certainly not signed in, or URL/key wrong, rather
      // than a per-table schema issue. Report that plainly instead of dumping 7 identical errors.
      console.error('loadDatabaseState: all queries failed', failures);
      window.showAlert?.('ดึงข้อมูลไม่สำเร็จ','เชื่อมต่อฐานข้อมูลไม่ได้ทั้งหมด — ตรวจสอบว่าได้ "เข้าสู่ระบบร้านค้า" แล้วหรือยัง (ต้องล็อกอินก่อนจึงจะอ่าน/เขียนข้อมูลได้) และ Project URL/anon key ถูกต้อง',true);
      return false;
    }
    try{
      const {categories:cats,products:prods,product_categories:links,product_variants:vars,product_fractions:fracs,customers:custs,bills}=results;
      window.db=window.db||{};
      // (v10) ส่งคิวที่ค้างให้เสร็จก่อน — ถ้ายังมีรายการค้าง จะไม่เอาสต็อก/ยอดหนี้จากเซิร์ฟเวอร์มาทับ (เพราะยังไม่รวมรายการเหล่านั้น)
      await window.flushSyncQueue?.(true);
      const _hasPending=(db.syncQueue||[]).length>0;

      // Categories — add any remote category not already present locally by name; never
      // touch/remove existing local categories.
      db.categories=db.categories||[];
      let newCats=0;
      (cats||[]).forEach(x=>{
        if(!db.categories.some(lc=>lc.name===x.name)){
          db.categories.push({id:'cat-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name:x.name,icon:x.icon||'📁',color:x.color||'#4f46e5'});
          newCats++;
        }
      });

      const catById=Object.fromEntries((cats||[]).map(x=>[x.id,x.name]));
      const catsByProduct={}; (links||[]).forEach(l=>(catsByProduct[l.product_id]=catsByProduct[l.product_id]||[]).push(catById[l.category_id]||l.category_id));

      // product_fractions are keyed by variant_id in this schema (not product_id), and
      // quantity_ratio means "how many fraction units make up 1 whole stock unit" — the
      // INVERSE of the local fractionMultiplier field ("how much of 1 stock unit does 1
      // fraction unit use"), so it's converted back on the way in (1 / quantity_ratio).
      const fracsByVariant={}; (fracs||[]).forEach(f=>(fracsByVariant[f.variant_id]=fracsByVariant[f.variant_id]||[]).push(f));

      // product_variants columns here are variant_name / price / cost_price — direct values,
      // no override-with-parent-fallback (this schema's `products` table has no price/cost
      // columns of its own at all, unlike the previous schema this app used to target).
      const rawVarsByProduct={}; (vars||[]).forEach(v=>(rawVarsByProduct[v.product_id]=rawVarsByProduct[v.product_id]||[]).push(v));

      // Products — match an existing local product by SKU (the one field that's stable across
      // both the local record and its Supabase row) so its ORIGINAL local id, and therefore its
      // current local stock/price (which may have moved since the last push), is preserved.
      // Only products genuinely new to this device (no local SKU match) get created, using the
      // Supabase row id as their new local id.
      db.products=db.products||{};
      const localIdBySku={};
      Object.values(db.products).forEach(p=>{ if(p.code) localIdBySku[p.code]=p.id; });

      let addedProd=0, matchedProd=0, addedVar=0, stockUpd=0, debtUpd=0;
      (prods||[]).forEach(p=>{
        const sku=p.sku||'';
        const existingId=sku?localIdBySku[sku]:null;
        if(existingId && db.products[existingId]){
          const existing=db.products[existingId];
          existing.name=p.name;
          existing.cat=catsByProduct[p.id]||existing.cat;
          existing.image=p.image_url||existing.image;
          if(p.min_stock_alert!=null)existing.minStock=+p.min_stock_alert;
          matchedProd++;
          if(!_hasPending){   // ให้สต็อกตรงกับเซิร์ฟเวอร์ + เพิ่มตัวเลือก (variant) ที่เครื่องอื่นเพิ่มไว้
            existing.variants=existing.variants||[];
            (rawVarsByProduct[p.id]||[]).forEach(rv=>{
              const lv=existing.variants.find(x=>toUUID(x.id)===rv.id);
              if(!lv){
                existing.variants.push({id:rv.id,sizeName:rv.variant_name||'ปกติ',barcode:rv.barcode||'',sku:rv.sku||'',cost:+(rv.cost_price||0),price:+(rv.price||0),stock:+(rv.stock_quantity||0),_seeded:!!rv.stock_seeded,fractions:[]});
                addedVar++;
              }else if(rv.stock_seeded){
                lv.stock=+(rv.stock_quantity||0); lv._seeded=true; stockUpd++;
              }
            });
          }
        }else if(!existingId){
          const remoteVariants=(rawVarsByProduct[p.id]||[]).map(v=>({
            id:v.id,sizeName:v.variant_name||'ปกติ',barcode:v.barcode||'',sku:v.sku||'',_seeded:!!v.stock_seeded,
            cost:+(v.cost_price||0),price:+(v.price||0),stock:+(v.stock_quantity||0),
            fractions:(fracsByVariant[v.id]||[]).map(f=>({
              id:f.id,fractionName:f.fraction_name,
              fractionMultiplier:f.quantity_ratio>0?roundStock(1/f.quantity_ratio):1,
              fractionPrice:+(f.price||0),barcode:f.barcode||''
            }))
          }));
          db.products[p.id]={
            id:p.id,name:p.name,code:sku,cat:catsByProduct[p.id]||[],image:p.image_url||'📦',
            minStock:+(p.min_stock_alert||0),
            variants:remoteVariants.length?remoteVariants:[{id:null,sizeName:'ปกติ',barcode:'',cost:0,price:0,stock:0,fractions:[]}]
          };
          addedProd++;
        }
      });

      // Customers — match by phone (or name if no phone on either side). This schema has no
      // debt/accounts-receivable column, so a pulled-in new customer starts at debt:0 — an
      // existing local record's tracked debt is never touched (there's nothing server-side to
      // reconcile it against anyway).
      db.customers=db.customers||{};
      const localIdByPhone={}, localIdByName={};
      Object.values(db.customers).forEach(cu=>{ if(cu.phone)localIdByPhone[cu.phone]=cu.id; localIdByName[cu.name]=cu.id; });
      let addedCust=0;
      (custs||[]).forEach(cu=>{
        const existingId=(cu.phone&&localIdByPhone[cu.phone])||localIdByName[cu.name];
        if(!existingId){
          db.customers[cu.id]={id:cu.id,name:cu.name,phone:cu.phone||'',address:cu.address||'',debt:+(cu.debt||0),_debtSeeded:!!cu.debt_seeded,creditLimit:+(cu.credit_limit||0)};
          addedCust++;
        }else if(!_hasPending && cu.debt_seeded && db.customers[existingId]){
          db.customers[existingId].debt=roundAmt(+(cu.debt||0)); db.customers[existingId]._debtSeeded=true; debtUpd++;   // ยอดหนี้ตามเซิร์ฟเวอร์
        }
      });

      // Bills — additive only. Never overwrite or remove a local bill; only pull in remote
      // bills this device doesn't have yet (e.g. rung up on a different terminal), matched by
      // bill_number which is exactly the local bill's id.
      db.bills=db.bills||[];
      const _localCidByUuid={}; Object.values(db.customers||{}).forEach(cu=>{_localCidByUuid[toUUID(cu.id)]=cu.id;});
      const localBillIds=new Set(db.bills.map(b=>b.id));
      let addedBills=0;
      (bills||[]).forEach(b=>{
        if(!localBillIds.has(b.bill_number)){
          db.bills.push({
            id:b.bill_number,time:new Date(b.created_at).getTime(),total:+b.total,subtotal:+(b.subtotal||b.total),discount:+(b.discount_amount||0),
            _syncedViaRPC:true,_serverBillId:b.id,
            method:(b.payment_method||'CASH').toUpperCase(),customerId:(b.customer_id&&(_localCidByUuid[b.customer_id]||b.customer_id))||'GENERAL',
            isRefunded:b.status==='CANCELLED',
            items:(b.bill_items||[]).map(bi=>({id:bi.product_id,variantId:bi.variant_id,fractionId:bi.fraction_id,name:bi.item_name,price:+bi.unit_price,qty:+bi.quantity,returnedQty:+(bi.returned_qty||0)}))
          });
          addedBills++;
        }
      });

      persist();
      window.renderSaleHome?.(); window.renderStockTable?.(); window.renderSalesAR?.();
      window.populateCustomerSelect?.(); window.populatePOPickers?.();
      const summary=`หมวดหมู่ใหม่ ${newCats} • สินค้าใหม่ ${addedProd} (จับคู่ของเดิม ${matchedProd}) • ลูกค้าใหม่ ${addedCust} • บิลที่ดึงเพิ่ม ${addedBills} • ปรับสต็อก ${stockUpd} • ปรับยอดหนี้ ${debtUpd}${_hasPending?' (ข้ามการปรับสต็อก/หนี้ เพราะยังมีรายการค้างส่ง)':''}`;
      if(failures.length){
        console.warn('loadDatabaseState: partial failure on', failures);
        window.showAlert?.('ดึงข้อมูลสำเร็จบางส่วน',`${summary}\n\n⚠️ ตารางต่อไปนี้ดึงไม่สำเร็จ: ${failures.join(' | ')}`,true);
      } else if(!silent){
        window.showAlert?.('ดึงข้อมูลจากคลาวด์สำเร็จ',summary,false);
      }
      return true;
    }catch(e){ console.error('loadDatabaseState',e); window.showAlert?.('ดึงข้อมูลไม่สำเร็จ','เกิดข้อผิดพลาดระหว่างประมวลผลข้อมูลที่ดึงมา: '+(e.message||e),true); return false; }
  };

  // Explicit, confirmed pull — replaces the old silent auto-pull on every page load.
  window.confirmPullFromCloud=function(){
    if(!confirm('ดึงข้อมูลล่าสุดจากฐานข้อมูลคลาวด์มาเพิ่มในเครื่องนี้?\n\n(เพิ่มรายการที่ยังไม่มีในเครื่องนี้ และปรับจำนวนสต็อก/ยอดหนี้ให้ตรงกับเซิร์ฟเวอร์ เมื่อไม่มีรายการค้างส่ง)'))return;
    window.loadDatabaseState(false);
  };

  // NOTE: previously this read from different localStorage keys ('pos_sb_url'/'pos_sb_key')
  // than the Settings UI actually saves to ('pos_supabase_url'/'pos_supabase_anon_key' via
  // window.getSupabaseClient), so this bridge's client was always null and every RPC call
  // below silently no-op'd. Reuse the real client so the RPC path actually connects.
  window.getSupabase = window.getSupabaseClient;

  // NOTE: this used to also carry window.calculateCartViaDBServer / window.processDatabaseCheckout
  // — a second, disconnected "database-authoritative checkout" path from an earlier iteration
  // of this app. It was never wired to any button (window.processPaymentRequest + the
  // window.syncBillToSupabaseRPC → create_sale RPC pairing is the real, active checkout path),
  // and it called calculate_order_totals / process_checkout_transaction, neither of which exist
  // in this schema (superseded by create_sale, which computes totals server-side from the line
  // items itself). Removed rather than updated, since dead code referencing functions that no
  // longer exist is worse than no code at all.

  // Cloud pull is now explicit only (see window.confirmPullFromCloud, wired to the Settings
  // button) — no longer runs automatically on page load. See the note above loadDatabaseState.
})();
