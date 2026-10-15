# ขั้นตอนติดตั้งจริง (GitHub Pages + Supabase)

## A. Supabase (ทำกับโปรเจกต์ทดสอบก่อน)
1. สร้างโปรเจกต์ใหม่ ตั้งค่า: **Enable Data API = เปิด**, **Automatically expose new tables = ปิด**, **Enable automatic RLS = เปิด**
2. SQL Editor รันตามลำดับ (แต่ละไฟล์รันซ้ำได้):
   1. `supabase/schema.sql`
   2. `supabase/DB-PATCH-00-grants.sql`
   3. `supabase/DB-PATCH-01-close-shift.sql`
   4. `supabase/DB-PATCH-02-equal-permissions.sql`
3. ตรวจผล (ต้องได้ตามที่เขียน):
   ```sql
   select pos_schema_version();                                   -- 3
   select count(*) from pg_tables where schemaname='public' and not rowsecurity;   -- 0
   select has_table_privilege('anon','public.bills','select');    -- false
   select has_column_privilege('authenticated','public.app_users','pin','select'); -- false
   select proname from pg_proc where proname in ('close_shift','create_sale'); -- 2 แถว
   ```
4. Authentication → Providers → Email: **ปิด "Allow new users to sign up"** หลังสร้างบัญชีเจ้าของแล้ว
5. Deploy Edge Function: `supabase functions deploy pin-login` (ตั้ง `STAFF_EMAIL_DOMAIN` ถ้า Auth ปฏิเสธโดเมนเริ่มต้น)
6. คัดลอก Project URL และ **anon public key** (ห้ามใช้ service_role/secret) ไว้กรอกในแอป

## B. GitHub
1. สร้าง repo (Private ก็ได้ แต่ Pages ฟรีของ repo private ต้องมีแพ็กเกจที่รองรับ)
2. อัปโหลดทุกไฟล์ รวม `.github/workflows/pages.yml` (โฟลเดอร์ขึ้นต้นด้วยจุด อัปโหลดผ่านเว็บอาจไม่เห็น ใช้ git push แทน)
3. Settings → Pages → Source = **GitHub Actions** แล้ว push เข้า `main`
4. เปิด URL ที่ได้ → ใส่ Project URL + anon key → สร้างเจ้าของร้านและ PIN

## C. ทดสอบก่อนใช้งานจริง
เปิดกะ → ขายสด → ขายโอน → ขายเชื่อ → รับชำระหนี้ → คืนสินค้า → ปิดกะ (เทียบเงินจริง)
แล้วปิดเน็ตทำซ้ำ เปิดเน็ตดูว่าคิวซิงค์ส่งครบ ลองล็อกอินพนักงานด้วย PIN ผิด 5 ครั้งต้องถูกพัก
สำรองข้อมูลก่อนเปิดใช้จริงและเป็นประจำ (ส่งออก JSON + `pg_dump`)
