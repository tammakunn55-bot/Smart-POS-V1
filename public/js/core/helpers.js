/* =============================================================================
 * js/core/helpers.js
 * ฟังก์ชันช่วยทั่วไป: ปัดเศษเงิน/สต็อก, รูปแบบเงิน, แฮช PIN รุ่นเดิม, แปลง id เป็น UUID, escape HTML, เรียงชื่อ
 *
 * ไฟล์นี้เป็นสคริปต์แบบ "คลาสสิก" ที่ใช้ตัวแปรร่วมของทั้งแอป (db, cart, roundAmt ฯลฯ) — ลำดับการโหลดอยู่ใน
 * <script id="pos-manifest"> ของ index.html (ไฟล์ที่ใช้ของไฟล์อื่นต้องอยู่หลังไฟล์นั้น)
 *
 * ฟังก์ชันที่ปุ่ม/ส่วนอื่นเรียกได้ (window.*):
 * formatMoney, hashPin, debouncedRenderStockTable
 * ============================================================================= */


      // ==========================================
      // MASTER APPLICATION LOGIC & STATE
      // ==========================================
      // BUG FIX (money-rounding, application-wide): every monetary calculation in this file
      // (cart subtotal/discount/tax/grand total, change, refunds, reports, cloud sync — 49
      // call sites) already funnels through this one function as its final rounding step, so
      // fixing the rounding math itself closes the whole floating-point-rounding defect class
      // at once, without migrating every stored/calculated value to a different unit (integer
      // cents) — a much larger, riskier change touching the SQL schema and every sync path too.
      // The OLD `Math.round(num*100)/100` has a textbook float-precision bug: the intermediate
      // multiplication can itself already be wrong in binary floating point — e.g. in real
      // JS, `1.005*100 === 100.49999999999999`, not 100.5 — so Math.round then silently rounds
      // the wrong way for specific values (1.005 rounded to 1.00 instead of 1.01). Shifting the
      // decimal point via a string exponent (`+'e2'` / `+'e-2'`) instead routes through JS's own
      // exact decimal-string-to-number parsing rather than a binary multiply, which avoids that
      // intermediate error entirely — this is the standard, well-established fix for this exact
      // class of bug. Verified against known problem values (1.005, 1.015, 1.025, 0.145, etc.)
      // before applying.
      const roundAmt = (num) => {
        const n = parseFloat(num) || 0;
        return Number(Math.round(Number(n + 'e2')) + 'e-2');
      };
      const roundStock = (num) => {
        const n = parseFloat(num) || 0;
        return Number(Math.round(Number(n + 'e4')) + 'e-4');
      };
      const formatMoney = (val) => "฿" + roundAmt(val).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
window.formatMoney = formatMoney;

      // SHA-256 hash for employee PINs — PINs must never be stored or synced as plaintext.
      window.hashPin = async function(pin) {
        const str = String(pin);
        if (crypto?.subtle) {
          try {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
          } catch (e) {
            console.warn('crypto.subtle.digest failed, falling back to non-crypto hash:', e);
          }
        }
        const h1 = fnv1a(str, 0x1000193).toString(16).padStart(8, '0');
        const h2 = fnv1a(str + '\u0005', 0x2000193).toString(16).padStart(8, '0');
        const h3 = fnv1a(str + '\u0006', 0x3000193).toString(16).padStart(8, '0');
        const h4 = fnv1a(str + '\u0007', 0x4000193).toString(16).padStart(8, '0');
        return h1 + h2 + h3 + h4;
      };

      // FNV-1a 32-bit — เร็ว, sync, กระจายบิตดีพอสำหรับปั้น id ให้ดูสุ่ม (ไม่ใช่ crypto hash
      // แท้ๆ แต่พอสำหรับจุดประสงค์นี้เพราะรันกับ 4 seed คนละค่ากัน ไม่ได้พึ่ง seed เดียว)
      function fnv1a(str, seed) {
        let h = seed >>> 0;
        for (let i = 0; i < str.length; i++) {
          h ^= str.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h >>> 0;
      }

      // BUG FIX: เวอร์ชันเดิมปั้น UUID 128 บิตจาก hash 32 บิตตัวเดียวแล้ว XOR กับค่าคงที่ 3 ค่า
      // — เอนโทรปีจริงมีแค่ 32 บิต ไม่ใช่ 128 บิต ทำให้โอกาสสองรหัสในเครื่อง (สินค้า/บิล/ลูกค้า ฯลฯ)
      // แปลงแล้วชนกันเริ่มมีนัยสำคัญตั้งแต่ประมาณ 65,000 รายการ (birthday paradox) และ upsert
      // ฝั่ง Supabase จะ "เขียนทับ" เรคคอร์ดที่ชนกันแบบเงียบๆ โดยไม่มี error ให้เห็นเลย
      // เวอร์ชันนี้รัน FNV-1a 4 รอบด้วย seed และ salt ต่างกันในแต่ละรอบ ให้ได้เอนโทรปีอิสระ
      // ครบทั้ง 128 บิตจริง โดยยังคง sync และ deterministic เหมือนเดิม (string เดิมแปลงแล้วได้
      // uuid เดิมเสมอ ซึ่งจำเป็นสำหรับ upsert ให้ตรงแถวเดิมทุกครั้งที่ sync ซ้ำ) — ไม่ต้องแก้จุดที่
      // เรียกใช้ toUUID() เลยสักจุดเดียว
      function toUUID(str) {
        if (!str) return null;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(str)) return str;
        const h1 = fnv1a(str, 0x811c9dc5).toString(16).padStart(8, '0');
        const h2 = fnv1a(str + '\u0001', 0x9e3779b9).toString(16).padStart(8, '0');
        const h3 = fnv1a(str + '\u0002', 0x85ebca6b).toString(16).padStart(8, '0');
        const h4 = fnv1a(str + '\u0003', 0xc2b2ae35).toString(16).padStart(8, '0');
        const c = h1 + h2 + h3 + h4; // 32 hex chars รวม = 128 บิต เอนโทรปีอิสระจริง
        return `${c.slice(0,8)}-${c.slice(8,12)}-4${c.slice(13,16)}-8${c.slice(17,20)}-${c.slice(20,32)}`;
      }

      // PERF FIX (#8): เดิมพิมพ์ค้นหาในตารางสต็อกทีเดียวก็ re-render ทั้งตารางทันที ถ้าสินค้าเยอะ
      // (หลักพันรายการ) จะกระตุกทุกตัวอักษรที่พิมพ์ — หน่วงไว้ 200ms ให้พิมพ์เสร็จก่อนค่อย render
      window.debouncedRenderStockTable = (function(){
        let t = null;
        return function(){
          clearTimeout(t);
          t = setTimeout(() => window.renderStockTable?.(), 200);
        };
      })();

      function escapeHTML(str) {
        if (!str) return '';
        return str.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
      }

      function naturalCompare(a, b) {
        const chunk = s => (s || '').toString().match(/\d+|\D+/g) || [];
        const ca = chunk(a), cb = chunk(b);
        const len = Math.max(ca.length, cb.length);
        for (let i = 0; i < len; i++) {
          const xa = ca[i] || '', xb = cb[i] || '';
          const na = /^\d+$/.test(xa), nb = /^\d+$/.test(xb);
          if (na && nb) {
            const diff = parseInt(xa, 10) - parseInt(xb, 10);
            if (diff !== 0) return diff;
          } else {
            const diff = xa.localeCompare(xb, 'th');
            if (diff !== 0) return diff;
          }
        }
        return 0;
      }
