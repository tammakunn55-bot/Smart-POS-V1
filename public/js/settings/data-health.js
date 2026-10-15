/* =============================================================================
 * js/settings/data-health.js
 * ตรวจสุขภาพข้อมูล (รูปเสีย, สต็อกติดลบ, บาร์โค้ดซ้ำ ฯลฯ) และล้างรูปที่ไม่ใช้
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * clearBrokenImageLinks, _orphanImages, renderOrphanImagesCard, deleteOrphanImage,
 * deleteAllOrphanImages, runDataHealthCheck
 * ============================================================================= */


/* ==========================================
   DATA HEALTH CHECK (ตรวจสุขภาพข้อมูล) — สแกนหาความผิดปกติทั้งในเครื่องและบน Supabase
   Storage แล้วรายงานให้ดู ไม่แก้อะไรให้อัตโนมัติ (ป้องกันลบ/แก้ข้อมูลผิดโดยไม่ตั้งใจ)
   ========================================== */
(function(){
  function esc3(v){ return window.escapeHTML ? window.escapeHTML(v) : String(v ?? ''); }

  function issueCard(level, title, count, detail, fixAction){
    const style = level === 'error'
      ? 'bg-rose-50 border-rose-200 text-rose-700'
      : level === 'warn'
        ? 'bg-amber-50 border-amber-200 text-amber-700'
        : 'bg-slate-50 border-slate-200 text-slate-600';
    const icon = level === 'error' ? '🔴' : level === 'warn' ? '🟡' : 'ℹ️';
    return `<div class="border rounded-xl p-3 text-xs ${style}">
      <div class="flex justify-between items-center font-bold gap-2">
        <span>${icon} ${esc3(title)}</span>
        <span class="flex items-center gap-1.5 flex-none">
          <span>${count} รายการ</span>
          ${fixAction ? `<button onclick="${fixAction}" class="bg-white border rounded-lg px-2 py-1 text-[10px] font-bold hover:bg-slate-100 btn-touch">🧹 ล้างลิงก์ที่เสีย</button>` : ''}
        </span>
      </div>
      <div class="text-[10px] mt-1 opacity-80 leading-relaxed line-clamp-3">${esc3(detail)}</div>
    </div>`;
  }

  // ล้างเฉพาะ "ลิงก์รูปที่เสีย" ทิ้ง (imageUrl) ของสินค้าที่ระบุ — ไม่แตะข้อมูลอื่นของสินค้าเลย ตัว
  // สินค้ายังอยู่ครบทุกอย่าง (ชื่อ ราคา สต็อก) แค่กลับไปโชว์ไอคอนแทนรูปที่เสีย อัปโหลดรูปใหม่ทีหลังได้
  // ปกติ ใช้ร่วมกันได้ทั้ง 2 กรณีที่ตรวจพบ: blob: URL ที่ตายแน่นอนหลัง reload, และรูปที่ยืนยันแล้วว่า
  // ไม่มีอยู่จริงบน Supabase Storage อีกต่อไป (ถูกลบไปหรือ path ผิด)
  window.clearBrokenImageLinks = function(ids){
    if (!confirm(`ล้างลิงก์รูปที่เสียออกจากสินค้า ${ids.length} รายการ?\n\nสินค้ายังอยู่ครบเหมือนเดิมทุกอย่าง แค่เอารูปที่เสียออก จะกลับไปโชว์ไอคอนสินค้าเฉยๆ แทน — อัปโหลดรูปใหม่ทีหลังได้ตามปกติ`)) return;
    let cleared = 0;
    ids.forEach(id => { const p = db.products[id]; if (p) { p.imageUrl = null; cleared++; } });
    window.persist?.();
    window.syncProductsToSupabase?.(true);
    window.showToast?.(`ล้างลิงก์รูปที่เสียแล้ว ${cleared} รายการ`);
    window.runDataHealthCheck(); // รันเช็คใหม่ให้เห็นผลทันทีว่ารายการนี้หายไปแล้ว
  };

  // เพิ่มขึ้นมา: การ์ดพิเศษสำหรับ "รูปกำพร้าบน Supabase Storage" ที่มีปุ่มลบให้กดตรงนี้ได้เลย
  // แทนที่จะแค่รายงานชื่อไฟล์ไว้เฉยๆ แล้วให้ไปลบเองที่ Supabase Dashboard — เก็บรายชื่อไฟล์ไว้ใน
  // window._orphanImages เพื่อให้ deleteOrphanImage อ้างอิงด้วย index (ไม่ใช้ชื่อไฟล์ตรงๆ ใน
  // onclick กันปัญหาอักขระพิเศษในชื่อไฟล์ทำให้ HTML/JS พัง)
  function orphanImageCard(title, files){
    window._orphanImages = files.slice();
    if (!files.length) return `<div class="bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl p-3 text-center text-[11px] font-bold" id="orphan-images-card">✅ ลบรูปกำพร้าหมดแล้ว</div>`;
    const rows = files.map((name, idx) => `
      <div class="flex items-center justify-between gap-2 bg-white border rounded-lg px-2 py-1.5">
        <span class="text-[10px] text-slate-600 break-all flex-1">${esc3(name)}</span>
        <button onclick="window.deleteOrphanImage(${idx})" class="text-rose-500 text-[10px] font-bold px-2 py-1 hover:bg-rose-50 rounded btn-touch flex-none">🗑️ ลบ</button>
      </div>`).join('');
    return `<div class="border rounded-xl p-3 text-xs bg-slate-50 border-slate-200 text-slate-600" id="orphan-images-card">
      <div class="flex justify-between items-center font-bold mb-2 gap-2">
        <span>ℹ️ ${esc3(title)}</span>
        <button onclick="window.deleteAllOrphanImages()" class="text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1 text-[10px] font-bold hover:bg-rose-100 btn-touch flex-none whitespace-nowrap">🗑️ ลบทั้งหมด (${files.length})</button>
      </div>
      <div class="space-y-1 max-h-48 overflow-y-auto">${rows}</div>
    </div>`;
  }

  window.renderOrphanImagesCard = function(){
    const card = document.getElementById('orphan-images-card');
    if (!card) return;
    card.outerHTML = orphanImageCard('รูปภาพบน Supabase Storage ที่ไม่มีสินค้าตัวไหนอ้างอิงแล้ว (ลบได้เพื่อประหยัดพื้นที่)', window._orphanImages || []);
  };

  window.deleteOrphanImage = async function(idx){
    const name = (window._orphanImages || [])[idx];
    if (!name) return;
    if (!confirm(`ลบไฟล์รูป "${name}" ออกจาก Supabase Storage ถาวร?\n\nการลบนี้ย้อนกลับไม่ได้`)) return;
    const client = window.getSupabaseClient?.();
    if (!client) return window.showAlert?.('ยังไม่ได้เชื่อมต่อ', 'ต้องเชื่อมต่อ Supabase ก่อนถึงจะลบรูปได้', true);
    try {
      const { error } = await client.storage.from('product-images').remove([name]);
      if (error) throw error;
      window._orphanImages = (window._orphanImages || []).filter(f => f !== name);
      window.renderOrphanImagesCard();
      window.showToast?.(`ลบไฟล์ "${name}" เรียบร้อย`);
    } catch (e) {
      console.error('delete orphan image failed', e);
      window.showAlert?.('ลบไม่สำเร็จ', String(e.message || e), true);
    }
  };

  window.deleteAllOrphanImages = async function(){
    const files = (window._orphanImages || []).slice();
    if (!files.length) return;
    if (!confirm(`ลบไฟล์รูปกำพร้าทั้งหมด ${files.length} ไฟล์ออกจาก Supabase Storage ถาวร?\n\nการลบนี้ย้อนกลับไม่ได้`)) return;
    const client = window.getSupabaseClient?.();
    if (!client) return window.showAlert?.('ยังไม่ได้เชื่อมต่อ', 'ต้องเชื่อมต่อ Supabase ก่อนถึงจะลบรูปได้', true);

    // BUG FIX: เดิมส่งไฟล์ทั้งหมดไปลบใน .remove() ครั้งเดียว — ถ้ามีเป็นพันไฟล์ (เจอจริงในร้านที่มี
    // สินค้าเยอะ เช่น 2087 ไฟล์) เสี่ยง request timeout หรือพังกลางทางโดยไม่รู้เลยว่าลบไปแล้วกี่ไฟล์
    // และไม่มีทางลองใหม่เฉพาะไฟล์ที่ค้างได้ — แก้เป็นแบ่งลบทีละชุด (100 ไฟล์/ครั้ง) พร้อมโชว์ความ
    // คืบหน้าบนปุ่มเอง ถ้าชุดไหนพลาดจะเก็บเฉพาะไฟล์ที่ยังไม่สำเร็จไว้ใน window._orphanImages ทำให้
    // กดปุ่ม "ลบทั้งหมด" ซ้ำ = ลองใหม่เฉพาะไฟล์ที่ค้างเท่านั้น ไม่ต้องเริ่มใหม่ทั้งชุด
    const CHUNK = 100;
    const failed = [];
    let doneCount = 0;
    const btn = document.querySelector('#orphan-images-card button[onclick="window.deleteAllOrphanImages()"]');
    for (let i = 0; i < files.length; i += CHUNK) {
      const chunk = files.slice(i, i + CHUNK);
      try {
        const { error } = await client.storage.from('product-images').remove(chunk);
        if (error) throw error;
        doneCount += chunk.length;
      } catch (e) {
        console.warn('orphan image chunk delete failed', e);
        failed.push(...chunk);
      }
      if (btn) btn.textContent = `🔄 กำลังลบ... ${doneCount + failed.length}/${files.length}`;
    }

    window._orphanImages = failed;
    window.renderOrphanImagesCard();
    if (failed.length) {
      window.showAlert?.('ลบไม่สำเร็จบางส่วน', `ลบสำเร็จ ${doneCount}/${files.length} ไฟล์ — เหลือ ${failed.length} ไฟล์ที่ลบไม่สำเร็จ (ยังอยู่ในรายการด้านล่าง กด "ลบทั้งหมด" อีกครั้งเพื่อลองใหม่เฉพาะไฟล์ที่เหลือได้)`, true);
    } else {
      window.showToast?.(`ลบรูปกำพร้าทั้งหมด ${files.length} ไฟล์เรียบร้อย`);
    }
  };

  window.runDataHealthCheck = async function(){
    const el = document.getElementById('health-check-results');
    if (!el) return;
    el.innerHTML = `<p class="text-center text-slate-400 font-bold py-4">🔄 กำลังตรวจสอบ...</p>`;

    const issues = [];
    const products = Object.values(db.products || {});

    // 1) ลิงก์รูปเสีย — เศษจากบัค URL.createObjectURL เก่า (ดู bulk image import) ที่ใช้ไม่ได้
    //    อีกต่อไปหลัง reload หน้าเว็บ ถ้ายังมีอยู่แปลว่าเป็นข้อมูลเก่าก่อนแก้บัคนี้
    const brokenImg = products.filter(p => p.imageUrl && p.imageUrl.startsWith('blob:'));
    if (brokenImg.length) issues.push({
      level: 'error', title: 'ลิงก์รูปภาพเสีย (blob: URL ที่ใช้ไม่ได้แล้ว)', count: brokenImg.length,
      detail: brokenImg.map(p => p.name).join(', '),
      fixAction: `window.clearBrokenImageLinks(${JSON.stringify(brokenImg.map(p => p.id))})`
    });

    // 2) สต็อกติดลบ — ปกติไม่ควรเกิดถ้าทุกจุดหักสต็อกถูกต้อง แปลว่ามีจุดหักซ้ำ/ข้ามการเช็คที่ไหนสักแห่ง
    const negStock = [];
    products.forEach(p => (p.variants || []).forEach(v => { if ((+v.stock || 0) < 0) negStock.push(`${p.name} (${v.sizeName || '-'}): ${v.stock}`); }));
    if (negStock.length) issues.push({ level: 'error', title: 'สต็อกติดลบ', count: negStock.length, detail: negStock.join(', ') });

    // 3) บาร์โค้ดซ้ำกันระหว่างสินค้าคนละตัว — สแกนบาร์โค้ดตอนขายจะสุ่มหยิบตัวใดตัวหนึ่งผิดได้
    const barcodeMap = {};
    products.forEach(p => (p.variants || []).forEach(v => { if (v.barcode) (barcodeMap[v.barcode] ||= []).push(p.name); }));
    const dupBarcodes = Object.entries(barcodeMap).filter(([, names]) => new Set(names).size > 1);
    if (dupBarcodes.length) issues.push({ level: 'warn', title: 'บาร์โค้ดซ้ำกันระหว่างสินค้าคนละตัว', count: dupBarcodes.length, detail: dupBarcodes.map(([bc, names]) => `${bc}: ${names.join(' / ')}`).join(' | ') });

    // 4) สินค้าที่ไม่มีตัวเลือก/ไซซ์เลย — ขายหน้าร้านไม่ได้เพราะไม่มี variant ให้กดเลือก
    const noVariant = products.filter(p => !(p.variants || []).length);
    if (noVariant.length) issues.push({ level: 'warn', title: 'สินค้าที่ไม่มีตัวเลือก/ไซซ์เลย (ขายไม่ได้)', count: noVariant.length, detail: noVariant.map(p => p.name).join(', ') });

    // 5) บิลที่มียอดเงินแต่ไม่มีรายการสินค้า — ร่องรอยข้อมูลเพี้ยน/เขียนไม่สมบูรณ์ตอน sync หรือ persist ล้มเหลว
    const emptyBills = (db.bills || []).filter(b => (!b.items || !b.items.length) && (+b.total || 0) > 0);
    if (emptyBills.length) issues.push({ level: 'error', title: 'บิลที่มียอดเงินแต่ไม่มีรายการสินค้า', count: emptyBills.length, detail: emptyBills.map(b => b.id).join(', ') });

    // 6) บิลอ้างอิงลูกค้าที่ไม่มีอยู่ในระบบแล้ว (เช่น ลบลูกค้าทิ้งหลังเคยขายเชื่อไปแล้ว)
    const customerIds = new Set(Object.keys(db.customers || {}));
    const orphanCustomerRefs = (db.bills || []).filter(b => b.customerId && b.customerId !== 'GENERAL' && !customerIds.has(b.customerId));
    if (orphanCustomerRefs.length) issues.push({ level: 'warn', title: 'บิลอ้างอิงลูกค้าที่ไม่มีในระบบแล้ว', count: orphanCustomerRefs.length, detail: orphanCustomerRefs.slice(0, 20).map(b => b.id).join(', ') });

    // 7) รูปภาพบน Supabase Storage เทียบกับสินค้าที่ใช้งานจริง (ต้องเชื่อมต่อ Supabase ไว้ก่อน)
    const client = window.getSupabaseClient?.();
    if (client) {
      try {
        // BUG FIX: .list() คืนมาสูงสุดตาม limit ต่อครั้งเท่านั้น (limit:1000 เดิม) — ร้านที่มีรูป
        // สินค้าเกิน 1000 ไฟล์จะเห็นแค่หน้าแรก ทำให้ไฟล์จริงที่มีอยู่แต่อยู่นอกหน้าแรกถูกเข้าใจผิด
        // ว่า "ไม่มีอยู่จริง" ไปหมด (นี่คือสาเหตุจริงที่ตัวเลขออกมาสูงผิดปกติ เช่น 1000+ รายการ ทั้งที่
        // รูปยังอยู่ครบ) แก้โดยวนดึงทีละหน้าจนกว่าจะได้หน้าที่สั้นกว่า limit (แปลว่าหมดแล้วจริงๆ)
        const PAGE = 1000;
        let files = [], offset = 0, guard = 0;
        while (guard++ < 50) {
          const { data: page, error: pageErr } = await client.storage.from('product-images').list('', { limit: PAGE, offset });
          if (pageErr) throw pageErr;
          files = files.concat(page || []);
          if (!page || page.length < PAGE) break;
          offset += PAGE;
        }
        {
          const realFiles = files.filter(f => f.id); // list() คืนโฟลเดอร์มาด้วยถ้ามี ต้องกรองเอาเฉพาะไฟล์จริง
          const usedUrls = new Set(products.map(p => p.imageUrl).filter(Boolean));
          const orphanFiles = realFiles.filter(f => {
            const { data } = client.storage.from('product-images').getPublicUrl(f.name);
            return !usedUrls.has(data.publicUrl);
          });
          if (orphanFiles.length) issues.push({
            level: 'info',
            type: 'orphan-images',
            title: 'รูปภาพบน Supabase Storage ที่ไม่มีสินค้าตัวไหนอ้างอิงแล้ว (ลบได้เพื่อประหยัดพื้นที่)',
            count: orphanFiles.length,
            files: orphanFiles.map(f => f.name)
          });

          const fileNames = new Set(realFiles.map(f => f.name));
          const missingCloudImg = products.filter(p => p.imageUrl && p.imageUrl.includes('/product-images/') && !fileNames.has(decodeURIComponent(p.imageUrl.split('/').pop())));
          if (missingCloudImg.length) issues.push({
            level: 'error',
            title: 'สินค้าลิงก์ไปยังรูปที่ไม่มีอยู่จริงบน Storage แล้ว (ถูกลบไปหรือ path ผิด)',
            count: missingCloudImg.length,
            detail: missingCloudImg.map(p => p.name).join(', '),
            fixAction: `window.clearBrokenImageLinks(${JSON.stringify(missingCloudImg.map(p => p.id))})`
          });
        }
      } catch (e) {
        console.warn('storage health check failed', e);
        issues.push({ level: 'info', title: 'ตรวจสอบรูปภาพบน Supabase Storage ไม่สำเร็จ (เช็คการเชื่อมต่อเน็ต/สิทธิ์เข้าถึง bucket)', count: 1, detail: String(e.message || e) });
      }
    }

    el.innerHTML = issues.length
      ? issues.map(i => i.type === 'orphan-images' ? orphanImageCard(i.title, i.files) : issueCard(i.level, i.title, i.count, i.detail, i.fixAction)).join('')
      : `<div class="bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl p-4 text-center text-xs font-bold">✅ ไม่พบความผิดปกติ ข้อมูลดูปกติดี</div>`;
  };
})();
