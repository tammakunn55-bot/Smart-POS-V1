/* =============================================================================
 * js/settings/image-import.js
 * นำเข้ารูปสินค้าทีละหลายรูป (ไฟล์รูป + image_mapping.json) แล้วอัปโหลดขึ้น Storage
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * openBulkImageModal, startBulkImageImport
 * ============================================================================= */

// ==========================================
// BULK IMAGE IMPORT WITH JSON MAPPING IMPLEMENTATION
// ==========================================
window.openBulkImageModal = function() {
  document.getElementById('modal-bulk-image').classList.remove('hidden');
  document.getElementById('modal-bulk-image').classList.add('flex');
};

window.startBulkImageImport = async function() {
  const jsonInput = document.getElementById('bulk-json-input');
  const filesInput = document.getElementById('bulk-image-files-input');
  const btn = document.getElementById('btn-start-bulk-image');
  const progressWrap = document.getElementById('bulk-image-progress-wrap');
  const progressBar = document.getElementById('bulk-image-progress-bar');
  const progressText = document.getElementById('bulk-image-progress-text');

  if (!jsonInput.files[0]) return window.showAlert("ข้อมูลไม่ครบ", "กรุณาเลือกไฟล์ image mapping.json", true);
  if (!filesInput.files.length) return window.showAlert("ข้อมูลไม่ครบ", "กรุณาเลือกไฟล์รูปภาพสินค้าอย่างน้อย 1 ไฟล์", true);

  let mappingData = {};
  try {
    const jsonText = await jsonInput.files[0].text();
    mappingData = JSON.parse(jsonText);
  } catch (err) {
    return window.showAlert("ไฟล์ JSON ไม่ถูกต้อง", "ไม่สามารถอ่านโครงสร้างไฟล์ JSON ได้", true);
  }

  const imageFilesMap = {};
  Array.from(filesInput.files).forEach(f => {
    imageFilesMap[f.name] = f;
  });

  const entries = Object.entries(mappingData);
  if (entries.length === 0) return window.showAlert("ไม่มีข้อมูล", "ไฟล์ JSON ไม่มีรายการจับคู่รูปภาพ", true);

  btn.disabled = true;
  btn.innerText = "กำลังประมวลผล...";
  progressWrap.classList.remove('hidden');

  let successCount = 0;
  let processedCount = 0;
  const client = window.getSupabaseClient();

  for (const [productName, fileName] of entries) {
    processedCount++;
    const pct = Math.round((processedCount / entries.length) * 100);
    progressBar.style.width = `${pct}%`;
    progressText.innerText = `${processedCount} / ${entries.length} - กำลังประมวลผล: ${productName}`;

    const file = imageFilesMap[fileName];
    if (!file) continue;

    // Find product by name
    const _nm = (t) => String(t || '').normalize('NFC').trim();
  const p = Object.values(db.products).find(x => _nm(x.name) === _nm(productName));
    if (!p) continue;

    // Upload to Supabase storage if client exists
    let publicUrl = '';
    if (client) {
      try {
        const path = `product-${p.id}-${Date.now()}.${file.name.split('.').pop()}`;
        const { error: upErr } = await client.storage.from('product-images').upload(path, file, { upsert: true });
        if (!upErr) {
          const { data } = client.storage.from('product-images').getPublicUrl(path);
          publicUrl = data.publicUrl;
        }
      } catch (e) {}
    }

    if (publicUrl) {
      p.imageUrl = publicUrl;
    } else {
      // BUG FIX: เดิม fallback เป็น URL.createObjectURL(file) ซึ่งเป็น blob: URL ที่ใช้ได้
      // แค่ในแท็บ/เซสชันปัจจุบันเท่านั้น — พอ persist() ลง localStorage แล้วรีเฟรชหน้าเว็บ
      // URL นี้จะใช้ไม่ได้ทันที รูปหายทุกครั้ง (ไม่สอดคล้องกับจุดถ่ายรูปสินค้าทีละชิ้นที่ใช้
      // base64 data URL เป็น fallback แทน ซึ่งอยู่ข้ามการรีเฟรชได้ปกติ) เปลี่ยนมาใช้
      // FileReader.readAsDataURL() แบบเดียวกันให้สอดคล้องกัน รูปจะไม่หายหลัง reload อีกต่อไป
      p.imageUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
    }
    successCount++;
  }

  btn.disabled = false;
  btn.innerText = "🚀 เริ่มจับคู่และนำเข้ารูปภาพ";
  window.persist?.();
  window.closeModal('modal-bulk-image');
  window.renderStockTable();
  window.renderSaleHome?.();
  window.showAlert("นำเข้ารูปภาพเรียบร้อย", `จับคู่และอัปโหลดรูปภาพสำเร็จ ${successCount} รายการ จากทั้งหมด ${entries.length} รายการ`, false);
};
