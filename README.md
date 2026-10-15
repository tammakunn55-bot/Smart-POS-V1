# Smart POS — YOJIONLINE

โปรแกรมขายหน้าร้าน (POS) ทำงานออฟไลน์บนเบราว์เซอร์ + ซิงค์ขึ้น Supabase (Postgres) — ไม่มี build step
โครงสร้างโดยละเอียดอยู่ที่ [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

```
public/        หน้าเว็บ: index.html (โครงหน้า) · css/ · js/<หมวด>/… (33 โมดูล) · sw.js
supabase/      schema.sql (ฐานข้อมูลไฟล์เดียว) · functions/pin-login · config.toml
data/import/   ไฟล์นำเข้าสินค้า (Excel + image_mapping.json) — รูปสินค้าไม่เก็บใน repo
tests/ tools/ docs/
```

## เริ่มใช้งาน (ครั้งแรก)
1. สร้างโปรเจกต์ Supabase → **SQL Editor** วางไฟล์ `supabase/schema.sql` ทั้งไฟล์แล้ว Run
   (ตรวจ: `select pos_schema_version();` ต้องได้ `3`)
2. เปิดแอป (GitHub Pages หรือ `npm run dev` → http://localhost:8080) → ตั้งค่า > คลาวด์: ใส่ Project URL + anon key → **สมัคร/ล็อกอินด้วยอีเมลเจ้าของในแอป**
   แล้วตั้งชื่อร้าน + PIN เจ้าของร้านตามหน้าจอ (แอปสร้างบัญชีเจ้าของให้เอง — ไม่ต้องไปสร้างใน Supabase Dashboard; ไม่มี PIN เริ่มต้น)
3. เมื่อสร้างเจ้าของเสร็จแล้ว ไปที่ **Authentication → Sign In / Providers** แล้ว **ปิด "Allow new users to sign up"** (ไม่งั้นใครมี anon key ก็สมัครเองได้)
4. ตั้งค่า > นำเข้า: เลือก `data/import/สินค้าพร้อมนำเข้า_YOJIONLINE.xlsx` → ตรวจตัวอย่าง/คำเตือน → ยืนยัน → นำเข้ารูป (zip) → กดซิงค์ 🔄
5. กรอก **ราคาทุน** และ **ยอดยกมา** (ไฟล์ตั้งต้นว่าง/0) → ตั้งค่า > ร้านค้า > กด **✅ ตรวจความพร้อมก่อนใช้งานจริง** แล้วแก้ตามที่แจ้ง
6. เมื่อสต็อกถูกต้องแล้วค่อยเปิด "ป้องกันสต็อกติดลบ"

ขั้นตอนทดสอบก่อนเปิดร้านจริงอยู่ที่ [`docs/GO-LIVE-CHECKLIST.md`](docs/GO-LIVE-CHECKLIST.md)

## ล็อกอินรายพนักงาน (ไม่บังคับ — ปิดอยู่ = ทุกเครื่องใช้สิทธิ์เจ้าของร้านร่วมกัน)
1. Deploy ฟังก์ชัน: `supabase functions deploy pin-login` (`config.toml` ตั้ง `verify_jwt = false` ไว้แล้ว เพราะผู้เรียกยังไม่มี session)
   — อีเมลพนักงานเป็นอีเมลสังเคราะห์ `staff-<id>@staff.pos.invalid` ถ้า Auth ปฏิเสธโดเมนนี้ ให้ตั้ง secret `STAFF_EMAIL_DOMAIN` เป็นโดเมนที่คุณเป็นเจ้าของ
   — Auth ต้องเปิดผู้ให้บริการ Email (ใช้สร้าง magic-link token ผ่าน Admin API ไม่มีการส่งอีเมลจริง)
2. ผู้จัดการ/เจ้าของกด **ซิงค์** (ส่งรายชื่อพนักงาน + hash ของ PIN ขึ้นเซิร์ฟเวอร์) แล้วเปิด ตั้งค่า > ร้านค้า > "ใช้บัญชีรายพนักงานบนเซิร์ฟเวอร์"
3. พนักงานแต่ละคนใส่ PIN ครั้งแรกตอนออนไลน์ → ระบบสร้างบัญชี Auth ให้อัตโนมัติ

กติกา: แคชเชียร์ส่งได้เฉพาะรายการของตัวเอง (บิลค้างคิวของคนอื่นรอเจ้าของรายการ/ผู้จัดการ) · ซิงค์สินค้า/ดึงข้อมูล/ปรับสต็อก/รับของ เป็นงานผู้จัดการขึ้นไป ·
PIN ผิด 5 ครั้งบนเซิร์ฟเวอร์ถูกพัก (ปลดด้วย `select unlock_staff('<id>')`)

## ที่เก็บข้อมูลในเครื่อง
IndexedDB `pos_yojionline` (ข้อมูลหลัก 1 ระเบียน + บิลแยกรายใบ) · เครื่องที่เคยใช้ localStorage จะถูกย้ายให้อัตโนมัติ (เก็บสำเนาไว้ที่คีย์ `legacy_backup`) ·
เปิดแอปสองแท็บ แท็บที่สองจะเป็นอ่านอย่างเดียว

## Deploy บน GitHub
Settings → Pages → Source = **GitHub Actions** แล้ว push ขึ้น `main` (workflow `pages.yml` เผยแพร่โฟลเดอร์ `public/`)
ต้องเป็น HTTPS (กล้องสแกนและ service worker ต้องใช้) — อย่า commit รูปสินค้า (43MB) ใช้ Supabase Storage / Git LFS · อย่า commit `service_role` key

## พัฒนา
| คำสั่ง | ทำอะไร |
|---|---|
| `npm run dev` | เปิดเซิร์ฟเวอร์ทดสอบ http://localhost:8080 |
| `npm run check` | ตรวจโครงสร้างหน้าบ้าน (manifest/syntax) + หัวไฟล์ + `schema.sql` (สถิต) |
| `npm run headers` | อัปเดตรายการ `window.*` ในหัวไฟล์ JS |
| `npm test` | เทสต์ 66 ข้อ (Node ≥ 22.18; รันโค้ดจริงใน vm ไม่ต้องมีเบราว์เซอร์) |
| `python3 tools/validate_import.py <xlsx>` | ตรวจไฟล์นำเข้าสินค้าก่อนอัปโหลด |

> ⚠️ `schema.sql` และ Edge Function **ยังไม่เคยรันบน Supabase จริง** (ตรวจสถิต + ทดสอบ logic ด้วยตัวจำลอง) และยังไม่ได้เปิดแอปในเบราว์เซอร์จริง —
> ทดสอบบนโปรเจกต์ทดสอบและทำตามเช็กลิสต์ก่อนใช้กับร้านจริง
