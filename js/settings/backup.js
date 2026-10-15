/* =============================================================================
 * js/settings/backup.js
 * สำรองข้อมูลเป็นไฟล์, กู้คืน, ล้างข้อมูลในเครื่อง
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * exportFullBackup, handleRestoreFile, factoryReset
 * ============================================================================= */


/* ==========================================
   BACKUP / RESTORE / FACTORY RESET
   ทั้งสามฟังก์ชันทำงานกับ localStorage โดยตรงแล้วสั่ง location.reload() ให้แอปโหลดสถานะใหม่
   ตั้งแต่ต้น แทนที่จะพยายามรีเซ็ตตัวแปร/หน้าจอทีละจุดเอง (แอปมีจุดเก็บ state กระจายอยู่หลายที่
   reload สะอาดกว่าและชัวร์กว่าว่าทุกอย่างจะสอดคล้องกันแน่ๆ)
   ========================================== */
(function(){
  const DB_KEY = 'pos_full_db_state';
  const LEGACY_DB_KEY = 'pos_enterprise_state'; // เก็บไว้เผื่อเครื่องเก่ายังไม่ migrate

  // ---------------- สำรองข้อมูล (BACKUP) ----------------
  window.exportFullBackup = function(){
    if (!window.canDo?.('ALL')) return window.showAlert?.('ไม่มีสิทธิ์', 'เฉพาะเจ้าของร้านเท่านั้นที่สำรอง/กู้คืน/ล้างข้อมูลได้', true);
    try {
      const backup = {
        _backupMeta: {
          app: 'smart-pos',
          exportedAt: new Date().toISOString(),
          storeName: db.storeName || ''
        },
        data: db
      };
      const json = JSON.stringify(backup);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);
      const safeName = (db.storeName || 'ร้านค้า').replace(/[\\/:*?"<>|]/g, '');
      a.download = `สำรองข้อมูล-${safeName}-${dateStr}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      window.showToast?.('สำรองข้อมูลเรียบร้อย — เก็บไฟล์นี้ไว้นอกเครื่องด้วยนะครับ');
    } catch (e) {
      console.error('backup failed', e);
      window.showAlert?.('สำรองข้อมูลไม่สำเร็จ', String(e.message || e), true);
    }
  };

  // ---------------- กู้คืนข้อมูล (RESTORE) ----------------
  window.handleRestoreFile = function(event){
    if (!window.canDo?.('ALL')) return window.showAlert?.('ไม่มีสิทธิ์', 'เฉพาะเจ้าของร้านเท่านั้นที่สำรอง/กู้คืน/ล้างข้อมูลได้', true);
    const file = event.target.files?.[0];
    event.target.value = ''; // เคลียร์ input ทันที กันเลือกไฟล์เดิมซ้ำแล้ว onchange ไม่ยิง
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(){
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        return window.showAlert?.('ไฟล์ไม่ถูกต้อง', 'ไฟล์นี้ไม่ใช่ไฟล์ JSON ที่อ่านได้ กรุณาเลือกไฟล์สำรองที่ได้จากปุ่ม "สำรองข้อมูลเป็นไฟล์" เท่านั้น', true);
      }

      // ตรวจแบบหลวมๆ ว่าเป็นไฟล์ backup ของแอปนี้จริง ไม่ใช่ไฟล์ JSON อะไรก็ได้ที่หลุดมาเลือกผิด
      const payload = parsed?.data && parsed?._backupMeta ? parsed.data : parsed;
      const looksValid = payload && typeof payload === 'object' &&
        ('products' in payload) && ('bills' in payload) && ('customers' in payload);
      if (!looksValid) {
        return window.showAlert?.('ไฟล์ไม่ถูกต้อง', 'ไฟล์นี้ไม่ใช่ไฟล์สำรองของระบบ POS นี้ (โครงสร้างข้อมูลไม่ตรง) กรุณาเลือกไฟล์ที่ถูกต้อง', true);
      }

      const meta = parsed?._backupMeta;
      const metaLine = meta ? `\n\nไฟล์นี้สำรองไว้เมื่อ: ${new Date(meta.exportedAt).toLocaleString('th-TH')}\nชื่อร้าน: ${meta.storeName || '-'}` : '\n\n(ไฟล์นี้ไม่มีข้อมูล metadata — อาจเป็นไฟล์เก่ามาก)';
      const sure = confirm(
        `⚠️ ยืนยันการกู้คืนข้อมูล?\n\nข้อมูลปัจจุบันทั้งหมดในเครื่องนี้จะถูกเขียนทับด้วยข้อมูลจากไฟล์นี้ทันที และ` +
        `ย้อนกลับไม่ได้ถ้าไม่มีไฟล์สำรองของข้อมูลปัจจุบันเก็บไว้ต่างหาก${metaLine}\n\nต้องการดำเนินการต่อหรือไม่?`
      );
      if (!sure) return;

      try {
        await window.posStore.replaceAll(payload);   // v11: เขียนลง IndexedDB
        // ตัวนับเลขบิลย้อนกลับไปตามไฟล์สำรอง — ต้องเปลี่ยนรหัสเครื่องด้วย ไม่งั้นเลขบิลจะวนซ้ำกับบิลที่ส่งขึ้นเซิร์ฟเวอร์ไปแล้ว
        try { localStorage.removeItem('pos_device_id'); } catch (e) { /* ignore */ }
        localStorage.removeItem(DB_KEY);
        localStorage.removeItem(LEGACY_DB_KEY); // กันโหลดผิดคีย์เก่าทับของที่เพิ่งกู้คืนมา
        window.showToast?.('กู้คืนข้อมูลสำเร็จ — กำลังโหลดแอปใหม่...');
        setTimeout(() => location.reload(), 800);
      } catch (e) {
        console.error('restore failed', e);
        window.showAlert?.('กู้คืนข้อมูลไม่สำเร็จ', 'พื้นที่จัดเก็บข้อมูลในเครื่องอาจเต็มหรือถูกบล็อก: ' + String(e.message || e), true);
      }
    };
    reader.onerror = () => window.showAlert?.('อ่านไฟล์ไม่สำเร็จ', 'ไม่สามารถอ่านไฟล์ที่เลือกได้ ลองเลือกไฟล์ใหม่อีกครั้ง', true);
    reader.readAsText(file);
  };

  // ---------------- คืนค่าโรงงาน (FACTORY RESET) ----------------
  // ล้างเฉพาะข้อมูลในเครื่องนี้ (localStorage) เท่านั้น — ไม่แตะต้องข้อมูลบน Supabase คลาวด์เลย
  // ต้องยืนยัน 2 ชั้น (confirm + พิมพ์ข้อความยืนยัน) เพราะเป็นการกระทำที่ย้อนกลับไม่ได้และรุนแรงที่สุด
  window.factoryReset = function(){
    if (!window.canDo?.('ALL')) return window.showAlert?.('ไม่มีสิทธิ์', 'เฉพาะเจ้าของร้านเท่านั้นที่สำรอง/กู้คืน/ล้างข้อมูลได้', true);
    const step1 = confirm(
      '☠️ คืนค่าโรงงาน — ล้างข้อมูลทั้งหมดในเครื่องนี้?\n\n' +
      'สินค้า, ลูกค้า, บิล, ผู้ใช้, การตั้งค่า และการเชื่อมต่อฐานข้อมูล Supabase ในเครื่องนี้จะถูกลบถาวร ย้อนกลับไม่ได้ถ้าไม่มีไฟล์สำรอง\n' +
      '(ข้อมูลบน Supabase คลาวด์เองจะไม่ถูกกระทบ ถ้ามีการเชื่อมต่อไว้ — แค่เครื่องนี้จะเลิกต่อกับมันเท่านั้น)\n\n' +
      'แนะนำให้กด "สำรองข้อมูลเป็นไฟล์" ก่อนถ้ายังไม่ได้ทำ ต้องการดำเนินการต่อหรือไม่?'
    );
    if (!step1) return;

    const confirmText = prompt('เพื่อความปลอดภัย กรุณาพิมพ์คำว่า "ล้างข้อมูล" (ไม่มีเว้นวรรค) แล้วกดตกลง เพื่อยืนยันการคืนค่าโรงงาน:');
    if (confirmText !== 'ล้างข้อมูล') {
      if (confirmText !== null) window.showAlert?.('ยกเลิกแล้ว', 'ข้อความยืนยันไม่ตรง จึงไม่ได้ล้างข้อมูลใดๆ', true);
      return;
    }

    try {
      // ลบเฉพาะคีย์ของแอปนี้ ไม่แตะ localStorage ของเว็บไซต์อื่นที่อาจแชร์โดเมนเดียวกัน (ไม่มีในเคสนี้ แต่กันไว้)
      // รวมถึงการตั้งค่าเชื่อมต่อ Supabase ด้วย เพราะถ้าจะส่งต่อเครื่องให้ร้านอื่นแล้วยังต่อฐานข้อมูล
      // เดิมค้างอยู่ ร้านใหม่จะดันไปดึง/ส่งข้อมูลชนกับร้านเก่าทันทีที่เปิดแอป
      [DB_KEY, LEGACY_DB_KEY, 'pos_device_id', 'pos_pin_fails', 'pos_products_grid_cols', 'pos_products_per_page', 'pos_supabase_url', 'pos_supabase_anon_key'].forEach(k => localStorage.removeItem(k));
      window.posStore.clear().catch(() => {}).finally(() => {   // v11: ล้าง IndexedDB ด้วย
        window.showToast?.('ล้างข้อมูลเรียบร้อย — กำลังเริ่มต้นใหม่...');
        setTimeout(() => location.reload(), 600);
      });
    } catch (e) {
      console.error('factory reset failed', e);
      window.showAlert?.('ล้างข้อมูลไม่สำเร็จ', String(e.message || e), true);
    }
  };
})();
