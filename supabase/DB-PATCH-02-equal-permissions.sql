-- DB-PATCH-02 — ทุกคนที่ล็อกอิน (PIN) ได้สิทธิ์เท่ากัน
-- รันหลัง schema.sql และ DB-PATCH-01 รันซ้ำได้ปลอดภัย
-- is_manager()/has_perm() ถูกใช้ใน RLS และ RPC ทั้งระบบ เปลี่ยนที่นี่ที่เดียวแล้วทุกตารางตามอัตโนมัติ
-- (ผลข้างเคียงตั้งใจ: ทุกบัญชีเห็นต้นทุนสินค้า)

create or replace function is_manager() returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select exists (select 1 from app_users where auth_user_id = auth.uid() and is_active);
$$;

create or replace function has_perm(p_perm text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select exists (select 1 from app_users where auth_user_id = auth.uid() and is_active);
$$;

-- is_owner() ไม่แตะ: ยังใช้กับ factory_reset_cloud_data, การสร้าง/แก้บัญชี OWNER/MANAGER
-- และการแก้กะที่ปิดแล้ว (ถ้าอยากให้ทุกคนทำได้ด้วย แจ้งผมแล้วจะเพิ่ม patch 03)

-- ปิดช่องรั่ว: เมื่อทุกคนเป็น "ผู้จัดการ" นโยบาย self_select_app_users จะให้ทุกคนอ่านแถวของทุกคนได้ รวมถึง hash ของ PIN
-- PIN 4 หลักมีแค่ 10,000 แบบ ใครได้ hash ไปเดาได้ในไม่กี่วินาที แล้วสวมรอยล็อกอินเป็นคนอื่นได้
-- จึงเอาสิทธิ์อ่านคอลัมน์ pin ออกจากผู้ใช้ที่ล็อกอิน (การเขียน/ตั้ง PIN ยังทำได้ตามเดิม; Edge Function ใช้ service_role จึงอ่านได้)
revoke select on app_users from authenticated;
grant select (id, auth_user_id, name, role, permissions, is_active, failed_pin_attempts, locked_until, login_email, created_at)
  on app_users to authenticated;
