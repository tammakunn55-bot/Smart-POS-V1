# โครงสร้างระบบ

```
smart-pos/
├─ public/                      ← สิ่งที่ deploy ขึ้นเว็บ (ไม่มี build step)
│  ├─ index.html                 โครงหน้าจอ (markup) + pos-manifest (ลำดับโหลดสคริปต์)
│  ├─ css/app.css                สไตล์ทั้งหมด
│  ├─ sw.js                      service worker (ใช้ออฟไลน์; อ่านไฟล์ที่ต้องเก็บจาก pos-manifest)
│  └─ js/
│     ├─ boot/                   error-box · store (IndexedDB) · loader (โหลดแอป)
│     ├─ core/                   helpers (ปัดเงิน/UUID/escape) · state (db + ตัวแปรหน้าจอ)
│     ├─ auth/                   session (บันทึก/สิทธิ์/พนักงาน/ล็อกอิน PIN/ล็อกเครื่อง)
│     ├─ sales/                  cart · product-grid · cart-ui · payment · hold-bills · receipt · receivables-returns
│     ├─ inventory/              stock-table · bulk-actions · goods-receipt · product-form · export
│     ├─ shifts/                 เปิด/ปิดกะ
│     ├─ settings/               master-settings · นำเข้า Excel/รูป · หมวดหมู่ · ลูกค้า/ซัพพลายเออร์ · สำรอง · วิซาร์ด · ตรวจสุขภาพ/ความพร้อม
│     ├─ sync/                   client · store-auth · push · pull · queue · staff-auth
│     └─ ui/                     common (modal/alert/toast/กล้องสแกน)
├─ supabase/
│  ├─ schema.sql                 ฐานข้อมูลทั้งหมดในไฟล์เดียว (ติดตั้งใหม่ + รันซ้ำได้)
│  ├─ functions/pin-login/       Edge Function ล็อกอินรายพนักงาน (handler.ts ทดสอบด้วย Node ได้)
│  ├─ config.toml                verify_jwt = false ของ pin-login
│  └─ legacy/                    ประวัติ migration เดิม (ไม่ต้องใช้)
├─ data/import/                  ไฟล์นำเข้าสินค้า (Excel + image_mapping.json) — รูปไม่เก็บใน repo
├─ tests/                        node:test (รันโค้ดจริงใน vm — ไม่ต้องมีเบราว์เซอร์)
├─ tools/                        serve.js · check_syntax.js · check_sql.py · update_headers.py · validate_import.py
└─ docs/                         ARCHITECTURE · CHANGELOG-v12 · GO-LIVE-CHECKLIST · history/
```

## หลักการ 5 ข้อ
1. **ไม่มี build step** — ทุกไฟล์ใน `js/` เป็นสคริปต์แบบคลาสสิกที่ใช้ตัวแปรร่วม (`db`, `cart`, `roundAmt` …) ลำดับโหลดคือลำดับใน `pos-manifest`
   (ไฟล์ที่ใช้ของไฟล์อื่นตอน "โหลด" ต้องอยู่หลังไฟล์นั้น; ส่วนที่เรียกตอน "ใช้งาน" ไม่เกี่ยวกับลำดับ)
2. **ข้อมูลอยู่ที่ `db` ก้อนเดียวในหน่วยความจำ** — แก้แล้วเรียก `persist()` → `posStore` เขียนลง IndexedDB (บิลเขียนเฉพาะที่เปลี่ยน)
3. **ปุ่มใน HTML เรียก `window.ชื่อฟังก์ชัน(...)`** — หัวไฟล์ทุกไฟล์ลิสต์ฟังก์ชันเหล่านี้ให้ (`npm run headers` อัปเดตอัตโนมัติ)
4. **ธุรกรรมที่กระทบสต็อก/เงิน/หนี้ไปทาง RPC เท่านั้น** — เครื่องบันทึกในเครื่องก่อน แล้ว `enqueueSync(...)` → คิว → RPC (ส่งซ้ำได้ปลอดภัย)
5. **สิทธิ์ตัดสินที่เซิร์ฟเวอร์** (RLS + trigger + RPC) — ฝั่งแอปตรวจเพื่อความสะดวกของผู้ใช้เท่านั้น

## เส้นทางข้อมูลหลัก
```
ขาย:   ปุ่มชำระ → payment.js processPaymentRequest → ตัดสต็อก/สร้างบิลใน db → persist() → enqueueSync({type:'sale'})
       → queue.js flushSyncQueue → RPC create_sale (ตรวจส่วนลด/วงเงิน/สต็อก ที่เซิร์ฟเวอร์) → ตั้งธง bill._syncedViaRPC
คืน:   receivables-returns.js executeReturn → enqueueSync({type:'return'}) → RPC process_return (หักสัดส่วนส่วนลด, กันคืนเกิน)
สินค้า: ผู้จัดการแก้ → push.js syncProductsToSupabase (upsert แคตตาล็อก, ไม่ส่งสต็อก/หนี้) ; สต็อกเปลี่ยนผ่าน adjust_stock/receive_goods
ดึง:   pull.js loadDatabaseState (ผู้จัดการ) — รวมข้อมูลจากเซิร์ฟเวอร์ ปรับสต็อก/หนี้ให้ตรง (เมื่อไม่มีคิวค้าง)
ล็อกอิน: session.js (PIN ในเครื่อง) → staff-auth.js → Edge Function pin-login → session ของพนักงานคนนั้น (ถ้าเปิดโหมดรายพนักงาน)
```

## เพิ่ม/แก้ฟีเจอร์ — สูตรสั้น
- **เพิ่มปุ่ม/หน้าจอ:** เพิ่ม markup ใน `index.html` + ฟังก์ชัน `window.xxx = ...` ในไฟล์โมดูลที่ตรงหมวด → `npm run headers`
- **เพิ่มไฟล์ JS:** สร้างใน `public/js/<หมวด>/ชื่อ.js` → เติมชื่อใน `pos-manifest` (ตำแหน่งที่ถูกต้อง) → `npm run check` จะเตือนถ้าลืม
- **เพิ่มคลาส CSS:** ไม่มี Tailwind compiler — เขียนคลาสเองใน `css/app.css` (ส่วนที่ 1 = ยูทิลิตี้)
- **แก้ฐานข้อมูล:** แก้ `supabase/schema.sql` (ตาราง→หัวข้อ 2, สิทธิ์→หัวข้อ 5, RPC→หัวข้อ 7) → `python3 tools/check_sql.py` → รันบนโปรเจกต์ทดสอบ
  (ถ้ามีร้านจริงใช้อยู่แล้ว ให้เขียนไฟล์ migration แยกสำหรับการเปลี่ยนแปลงนั้น แทนการรัน schema.sql ทับ)
- **ออกเวอร์ชันใหม่:** เพิ่มเลข `version` ใน `pos-manifest` (บังคับโหลดไฟล์ใหม่ + service worker เปลี่ยนแคช)
- **ทดสอบ:** `npm test` (ไม่ต้องมีเบราว์เซอร์) · `npm run dev` เปิด http://localhost:8080 ลองบนเบราว์เซอร์จริง

## ข้อควรระวังเวลาแก้โค้ด
- `auth/session.js` และ `inventory/product-form.js` แต่ละไฟล์ห่อด้วย IIFE ของตัวเอง (ตัวช่วยเล็กๆ `esc/sb/ok` อยู่ในไฟล์) — ฟังก์ชันที่ต้องให้ไฟล์อื่นเรียกต้องผูกกับ `window.`
- ห้ามเขียน `stock_quantity` / `debt` ตรงๆ ลงเซิร์ฟเวอร์ (trigger จะปฏิเสธ) — ใช้ `enqueueSync` ชนิด `adjust`/`payment`/ฯลฯ
- เลขบิล/ใบรับของ/ใบลดหนี้ ต้องมีรหัสเครื่อง (`getRunningDocNumber(..., true)`) — กันซ้ำข้ามเครื่อง
