/* =============================================================================
 * js/inventory/export.js
 * ส่งออกสินค้าเป็น Excel และรูปสินค้าเป็น zip
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * exportProductsToExcel, exportProductImagesZip
 * ============================================================================= */


/* ==========================================
   PRODUCT EXPORT — Excel table with clickable image links (labelled with the product
   name instead of a raw URL) and a ZIP download of the actual image files renamed to
   the product/variant name.
   ========================================== */
(function(){
  function safeFileName(s){
    return String(s || 'สินค้า').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80);
  }

  // ใช้ ExcelJS แทน SheetJS สำหรับตัวนี้โดยเฉพาะ เพราะไลบรารี SheetJS รุ่นฟรีที่โหลดใช้ในแอป
  // (xlsx.full.min.js) ไม่รองรับการฝังรูปภาพจริงลงในไฟล์ .xlsx ได้ (รองรับแค่ข้อความ/สูตร/ลิงก์)
  // — ExcelJS รองรับ addImage() ทำให้เห็นรูปจริงในตารางเพื่อตรวจสอบเบื้องต้นได้ทันทีโดยไม่ต้อง
  // คลิกลิงก์ทีละแถว ส่วนคอลัมน์ "ลิงก์รูปภาพ" ยังคงเป็น hyperlink ที่คลิกได้เหมือนเดิมด้วย
  window.exportProductsToExcel = async function(){
    if (!window.ExcelJS) return window.showAlert?.('ผิดพลาด', 'ไม่พบไลบรารี ExcelJS — ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต', true);

    const rows = [];
    Object.values(db.products || {}).forEach(p => {
      const cats = (p.cat || []).join(', ') || '-';
      const imgUrl = p.imageUrl || '';
      const list = (p.variants || []).length ? p.variants : [{ sizeName: '-', barcode: '', cost: 0, price: 0, stock: 0 }];
      list.forEach(v => {
        rows.push({ name: p.name, sku: p.code || p.id, size: v.sizeName || '-', cat: cats, barcode: v.barcode || '-', cost: +(v.cost || 0), price: +(v.price || 0), stock: +(v.stock || 0), imgUrl });
      });
    });
    if (!rows.length) return window.showAlert?.('ไม่มีข้อมูล', 'ยังไม่มีสินค้าให้ส่งออก', true);

    window.showToast?.('กำลังสร้างไฟล์ Excel พร้อมรูปภาพ...');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('รายการสินค้า');
    ws.columns = [
      { header: 'รูปภาพ', key: 'img', width: 12 },
      { header: 'รหัสสินค้า (SKU)', key: 'sku', width: 16 },
      { header: 'ชื่อสินค้า', key: 'name', width: 28 },
      { header: 'ขนาด/รุ่น', key: 'size', width: 14 },
      { header: 'หมวดหมู่', key: 'cat', width: 18 },
      { header: 'บาร์โค้ด', key: 'barcode', width: 16 },
      { header: 'ราคาทุน', key: 'cost', width: 10 },
      { header: 'ราคาขาย', key: 'price', width: 10 },
      { header: 'คงเหลือ', key: 'stock', width: 10 },
      { header: 'ลิงก์รูปภาพ', key: 'link', width: 26 }
    ];
    ws.getRow(1).font = { bold: true };

    // ใส่แถวข้อมูลทั้งหมดก่อน (เร็ว, ไม่ต้องรอเน็ตเวิร์ก) แล้วค่อยดึงรูปทีหลัง
    const rowMeta = rows.map((r, i) => {
      const rowIdx = i + 2; // แถว 1 คือ header
      const row = ws.addRow({ sku: r.sku, name: r.name, size: r.size, cat: r.cat, barcode: r.barcode, cost: r.cost, price: r.price, stock: r.stock, link: r.imgUrl || '-' });
      row.height = 54; // สูงพอสำหรับ thumbnail
      if (r.imgUrl && r.imgUrl !== '-') {
        row.getCell('link').value = { text: r.name, hyperlink: r.imgUrl };
        row.getCell('link').font = { color: { argb: 'FF2563EB' }, underline: true };
      }
      return { r, rowIdx };
    });

    // BUG FIX / PERF (#7): เดิม fetch รูปทีละแถวแบบ sequential (await ใน for loop) — ถ้าสินค้า
    // หลายร้อย/พันรายการและรูปมาจากโฮสต์ภายนอกจะรวมกันช้ามาก เปลี่ยนเป็นดึงแบบขนานทีละ batch
    // (6 รูปพร้อมกัน) เร็วขึ้นหลายเท่าโดยยังไม่ยิงคำขอพร้อมกันทั้งหมดจนโดน rate-limit ฝั่งโฮสต์รูป
    // แคชรูปที่ดึงมาแล้วไว้ ถ้าสินค้าเดียวกันมีหลายขนาด/สีจะได้ไม่ต้องดึงรูปซ้ำ
    const imageCache = {};
    const uniqueUrls = [...new Set(rowMeta.filter(m => m.r.imgUrl && m.r.imgUrl !== '-').map(m => m.r.imgUrl))];
    const BATCH_SIZE = 6;
    for (let i = 0; i < uniqueUrls.length; i += BATCH_SIZE) {
      const batch = uniqueUrls.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (url) => {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error('fetch failed');
          const blob = await res.blob();
          const buf = await blob.arrayBuffer();
          let ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          if (!['png', 'jpg', 'gif'].includes(ext)) ext = 'png'; // ExcelJS รองรับแค่ 3 แบบนี้
          imageCache[url] = wb.addImage({ buffer: buf, extension: ext });
        } catch (e) {
          console.warn('embed image failed for', url, e); // ข้ามรูปที่ดึงไม่ได้ (เช่นติด CORS) แต่ยังส่งออกแถวข้อมูลต่อ
        }
      }));
    }
    rowMeta.forEach(({ r, rowIdx }) => {
      if (imageCache[r.imgUrl]) {
        ws.addImage(imageCache[r.imgUrl], { tl: { col: 0.1, row: rowIdx - 1 + 0.1 }, ext: { width: 50, height: 50 } });
      }
    });

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `รายการสินค้า-${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    window.showToast?.('ส่งออกไฟล์ Excel พร้อมรูปภาพเรียบร้อย');
  };

  // Downloads every product photo as a ZIP, with each file renamed to the product
  // (and variant, if more than one size/color) name instead of its original filename.
  // Only works for images reachable over HTTP(S) or already embedded as data URLs — a
  // photo that only exists on someone else's device (never uploaded) can't be fetched.
  window.exportProductImagesZip = async function(){
    if (!window.JSZip) return window.showAlert?.('ผิดพลาด', 'ไม่พบไลบรารี JSZip — ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต', true);
    const withPhotos = Object.values(db.products || {}).filter(p => p.imageUrl);
    if (!withPhotos.length) return window.showAlert?.('ไม่มีรูปภาพ', 'ยังไม่มีสินค้าที่แนบรูปภาพไว้ (imageUrl)', true);

    window.showToast?.(`กำลังดาวน์โหลดรูปภาพ ${withPhotos.length} รายการ...`);
    const zip = new JSZip();
    const usedNames = {};
    let okCount = 0, failCount = 0;

    for (const p of withPhotos) {
      try {
        const res = await fetch(p.imageUrl);
        if (!res.ok) throw new Error('fetch failed');
        const blob = await res.blob();
        let ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        if (p.imageUrl.match(/\.(png|jpg|jpeg|webp|gif)(\?|$)/i)) ext = p.imageUrl.match(/\.(png|jpg|jpeg|webp|gif)(\?|$)/i)[1].toLowerCase();
        let base = safeFileName(p.name);
        let fileName = `${base}.${ext}`;
        let n = 2;
        while (usedNames[fileName]) { fileName = `${base}-${n}.${ext}`; n++; }
        usedNames[fileName] = true;
        zip.file(fileName, blob);
        okCount++;
      } catch (e) {
        failCount++;
      }
    }

    if (!okCount) return window.showAlert?.('ดาวน์โหลดไม่สำเร็จ', 'ไม่สามารถดึงรูปภาพได้เลยสักรูป — อาจติด CORS หรือรูปเป็นไฟล์ในเครื่องที่ยังไม่ได้อัปโหลด', true);
    const content = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(content);
    a.download = `รูปสินค้า-${new Date().toISOString().slice(0,10)}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    window.showToast?.(`ดาวน์โหลดสำเร็จ ${okCount} รูป${failCount ? ` (พลาด ${failCount} รูป)` : ''}`);
  };
})();
