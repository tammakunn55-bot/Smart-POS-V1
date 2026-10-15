-- ============================================================================
-- 0003_staff_auth.sql — รองรับล็อกอินรายพนักงาน (Edge Function `pin-login`)
-- รันต่อจาก 0002 (รันซ้ำได้) — *** ยังไม่เคยรันบน Postgres จริง ทดสอบบนโปรเจกต์ทดสอบก่อน ***
-- แนวคิด: พนักงานแต่ละคนมี auth user ของตัวเอง (สร้างอัตโนมัติโดย Edge Function ตอนล็อกอินด้วย PIN สำเร็จครั้งแรก)
-- ทำให้ RLS / is_manager() / has_perm() ที่เขียนไว้ใน 0001 มีผลจริงรายคน แทนที่จะเป็นบัญชีเจ้าของร้านบัญชีเดียวทั้งเครื่อง
-- ============================================================================

alter table app_users add column if not exists failed_pin_attempts int not null default 0;
alter table app_users add column if not exists locked_until timestamptz;
alter table app_users add column if not exists login_email text;          -- อีเมลสังเคราะห์ของพนักงาน (ไม่มีกล่องจดหมายจริง)
create unique index if not exists idx_app_users_auth_user_uniq on app_users(auth_user_id) where auth_user_id is not null;

-- 1. ห้ามฝั่งผู้ใช้แก้คอลัมน์ที่ผูกตัวตน (กันผู้จัดการเอา auth_user_id ของตัวเองไปใส่แถวพนักงานอื่นเพื่อสวมรอย)
--    service role / SQL Editor (auth.uid() เป็น NULL) แก้ได้ตามปกติ; ผู้จัดการปลดล็อก (failed_pin_attempts/locked_until) ได้
create or replace function guard_app_users_identity() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return new; end if;
  if new.auth_user_id is distinct from old.auth_user_id or new.login_email is distinct from old.login_email then
    raise exception 'แก้ auth_user_id / login_email ไม่ได้ (ระบบจัดการให้เอง)';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_app_users_identity on app_users;
create trigger trg_guard_app_users_identity before update on app_users
  for each row execute function guard_app_users_identity();

-- 2. พนักงานที่ไม่ใช่ผู้จัดการ บันทึกบิลได้เฉพาะในนามตัวเอง (กันปลอม user_id ของคนอื่น)
create or replace function guard_bill_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me uuid;
begin
  if auth.uid() is null or is_manager() then return new; end if;
  select id into v_me from app_users where auth_user_id = auth.uid() and is_active limit 1;
  if new.user_id is distinct from v_me then
    raise exception 'บันทึกบิลแทนผู้อื่นไม่ได้ (บิลต้องเป็นของผู้ที่ล็อกอินอยู่ — ถ้าเป็นบิลค้างคิวของคนอื่น ให้ผู้จัดการ/เจ้าของเป็นผู้ซิงค์)';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_bill_user on bills;
create trigger trg_guard_bill_user before insert on bills
  for each row execute function guard_bill_user();

-- 3. ลูกค้า: พนักงานเพิ่มลูกค้าใหม่ได้ แต่แก้ข้อมูล (เช่นวงเงินเครดิต) ได้เฉพาะผู้จัดการ
do $$ begin
  drop policy if exists "staff_update_customers" on customers;
  drop policy if exists "manager_update_customers" on customers;
  create policy "manager_update_customers" on customers for update using (is_manager()) with check (is_manager());
end $$;

create or replace function pos_schema_version() returns int
language sql stable set search_path = public, pg_temp as $$ select 3 $$;

-- 4. ปลดล็อกพนักงานที่ใส่ PIN ผิดจนถูกพัก (เรียกโดยผู้จัดการ/เจ้าของ)
create or replace function unlock_staff(p_app_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_manager() then raise exception 'เฉพาะผู้จัดการขึ้นไป'; end if;
  update app_users set failed_pin_attempts = 0, locked_until = null where id = p_app_user_id;
end $$;
do $$ begin
  begin
    revoke all on function unlock_staff(uuid) from public, anon;
    grant execute on function unlock_staff(uuid) to authenticated;
  exception when undefined_object then null;
  end;
end $$;
