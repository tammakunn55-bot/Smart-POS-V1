-- DB-PATCH-00 — กำหนดสิทธิ์ Data API เอง (ใช้เมื่อปิด "Automatically expose new tables")
-- schema.sql ไม่มีคำสั่ง GRANT เลย ถ้าปิดตัวเลือกนั้นโดยไม่รัน patch นี้ แอปจะขึ้น "permission denied" ทุกตาราง
-- ลำดับรัน: schema.sql → DB-PATCH-00 → DB-PATCH-01 → DB-PATCH-02   (รันซ้ำได้)
-- แถวข้อมูลยังถูกคุมด้วย RLS ที่อยู่ใน schema.sql อีกชั้น

grant usage on schema public to anon, authenticated, service_role;

-- ตาราง: ไม่ให้ anon (ยังไม่ล็อกอิน) แตะอะไรเลย
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- audit_logs เป็นแบบเพิ่มอย่างเดียว (มี trigger กันแก้/ลบอยู่แล้ว) ถอดสิทธิ์ซ้ำอีกชั้น
revoke update, delete on audit_logs from authenticated;
grant all on all tables in schema public to service_role;   -- ใช้โดย Edge Function pin-login

-- ฟังก์ชัน/RPC: ปิดจาก anon และ public เปิดให้เฉพาะผู้ที่ล็อกอิน
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
-- trigger function ไม่ต้องให้เรียกตรงๆ (trigger ทำงานได้เองโดยไม่ต้องมีสิทธิ์ execute)
revoke execute on function guard_balance_columns(), guard_app_users_change(),
  guard_app_users_identity(), guard_bill_user(), audit_logs_immutable() from authenticated;

-- ตารางหรือฟังก์ชันที่จะสร้างเพิ่มในอนาคต ต้องสั่ง grant เองทุกครั้ง (ตั้งใจ)
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke execute on functions from public, anon;
