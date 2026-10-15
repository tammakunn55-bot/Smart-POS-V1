-- ============================================================================
-- Smart POS — YOJIONLINE : schema.sql  (ไฟล์เดียว ติดตั้งใหม่ได้เลย)
--
-- วิธีใช้: Supabase > SQL Editor > วางทั้งไฟล์ > Run     (รันซ้ำได้ ไม่ทำข้อมูลหาย)
-- ตรวจผล: select pos_schema_version();   -- ต้องได้ 3
--
-- สารบัญ
--   1. Extensions
--   2. ตาราง + ดัชนี        (สถานะสุดท้ายรวมทุกคอลัมน์ ไม่มี ALTER ปะติดปะต่อ)
--   3. ฟังก์ชันตรวจสิทธิ์    is_staff / is_manager / is_owner / has_perm
--   4. Trigger ป้องกัน       (สต็อก/หนี้ต้องผ่าน RPC, บิลต้องเป็นของผู้ล็อกอิน, แก้ตัวตนพนักงาน, audit แก้ไม่ได้)
--   5. Row Level Security    (ตารางสิทธิ์อ่าน/เขียนอยู่ที่หัวข้อนี้ — แก้สิทธิ์ที่นี่ที่เดียว)
--   6. View                  (ซ่อนต้นทุนจากแคชเชียร์)
--   7. RPC ธุรกิจ            (ขาย/คืน/รับชำระ/ปรับสต็อก/รับของ/ลบ/ตั้งค่าเจ้าของ/ล้างข้อมูล)
--   8. Storage bucket
--   9. สิทธิ์ execute
--
-- หลักการสำคัญ
--   • สต็อก (product_variants.stock_quantity) และหนี้ลูกค้า (customers.debt) แก้ได้ผ่าน RPC เท่านั้น (trigger บังคับ)
--   • บิล/รายการบิล/ประวัติสต็อก เขียนผ่าน RPC เท่านั้น (ไม่มี policy เขียนตรง)
--   • RPC ทุกตัวส่งซ้ำได้ปลอดภัย (idempotent) — เครื่องที่ออฟไลน์ส่งคิวซ้ำได้โดยไม่ซ้อน
-- ============================================================================


-- ============================================================================
-- 1. EXTENSIONS
-- ============================================================================

create extension if not exists pgcrypto;


-- ============================================================================
-- 2. ตาราง + ดัชนี
-- ลำดับตารางเรียงตาม foreign key (ตารางที่ถูกอ้างอิงมาก่อน)
-- ============================================================================


-- ---- แคตตาล็อกสินค้า ---------------------------------------------------------
create table if not exists categories (
  id            uuid primary key,
  name          text not null,
  code          text,
  icon          text default '📁',
  color         text default '#4F46E5',
  display_order integer default 0,
  parent_id     uuid references categories(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_categories_parent on categories(parent_id);

create table if not exists products (
  id               uuid primary key,
  sku              text,
  name             text not null,
  image_url        text,
  group_name       text,
  display_order    integer default 0,
  min_stock_alert  numeric not null default 5,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists idx_products_sku_unique on products(sku) where sku is not null;
create index if not exists idx_products_name   on products using gin (to_tsvector('simple', name));
create index if not exists idx_products_active on products(is_active);
create index if not exists idx_products_group  on products(group_name);

create table if not exists product_categories (
  product_id  uuid not null references products(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  primary key (product_id, category_id)
);
create index if not exists idx_prodcat_category on product_categories(category_id);

-- ตัวเลือกของสินค้า (ขนาด/รุ่น) — สต็อกและราคาอยู่ที่ระดับนี้
create table if not exists product_variants (
  id              uuid primary key,
  product_id      uuid not null references products(id) on delete cascade,
  variant_name    text not null default 'ปกติ',
  barcode         text,
  sku             text,
  image_url       text,
  price           numeric not null default 0 check (price >= 0),
  cost_price      numeric not null default 0 check (cost_price >= 0),
  stock_quantity  numeric not null default 0,            -- แก้ผ่าน RPC เท่านั้น (trigger guard_balance_columns)
  stock_seeded    boolean not null default false,        -- ส่งยอดตั้งต้นจากเครื่องแล้วหรือยัง (ดู seed_variant_stock)
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
create unique index if not exists idx_variants_barcode on product_variants(barcode) where barcode is not null;
create unique index if not exists idx_product_variants_sku on product_variants(sku) where sku is not null;
create index if not exists idx_variants_product on product_variants(product_id);

-- หน่วยแบ่งขาย (เช่น ขายเป็นเมตรจากม้วน): ตัดสต็อก = จำนวน / quantity_ratio
create table if not exists product_fractions (
  id              uuid primary key,
  variant_id      uuid not null references product_variants(id) on delete cascade,
  fraction_name   text not null,
  quantity_ratio  numeric not null check (quantity_ratio > 0),
  price           numeric not null default 0 check (price >= 0),
  barcode         text,
  is_active       boolean not null default true
);
create index if not exists idx_fractions_variant on product_fractions(variant_id);

-- ---- ลูกค้า / ซัพพลายเออร์ / พนักงาน ---------------------------------------------
create table if not exists customers (
  id            uuid primary key,
  name          text not null,
  phone         text,
  address       text default '',
  credit_limit  numeric not null default 0,
  debt          numeric not null default 0,              -- แก้ผ่าน RPC เท่านั้น (trigger guard_balance_columns)
  debt_seeded   boolean not null default false,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists suppliers (
  id          uuid primary key,
  name        text not null,
  phone       text,
  address     text default '',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- พนักงาน: pin เก็บ hash (pbkdf2$รอบ$salt$hash) ไม่เก็บ PIN ดิบ; auth_user_id ผูกกับ Supabase Auth (สร้างโดย Edge Function pin-login)
create table if not exists app_users (
  id                   uuid primary key,
  auth_user_id         uuid references auth.users(id) on delete set null,
  name                 text not null,
  pin                  text not null,
  role                 text not null default 'CASHIER' check (role in ('OWNER','MANAGER','CASHIER')),
  permissions          jsonb not null default '[]'::jsonb,
  is_active            boolean not null default true,
  failed_pin_attempts  int not null default 0,
  locked_until         timestamptz,
  login_email          text,                              -- อีเมลสังเคราะห์ของพนักงาน (ไม่มีกล่องจดหมายจริง)
  created_at           timestamptz not null default now()
);
create unique index if not exists idx_app_users_auth      on app_users(auth_user_id) where auth_user_id is not null;
create unique index if not exists idx_app_users_one_owner on app_users((role = 'OWNER')) where role = 'OWNER';

-- ---- การขาย --------------------------------------------------------------------
create table if not exists shifts (
  id            uuid primary key,
  opened_at     timestamptz not null,
  closed_at     timestamptz,
  opening_cash  numeric not null default 0,
  closing_cash  numeric,
  status        text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  opened_by     uuid references app_users(id),
  closed_by     uuid references app_users(id)
);
create index if not exists idx_shifts_status on shifts(status);

create table if not exists bills (
  id               uuid primary key,
  bill_number      text not null unique,
  customer_id      uuid references customers(id),
  user_id          uuid references app_users(id),
  shift_id         uuid references shifts(id),
  subtotal         numeric not null default 0,            -- ยอดก่อนลด
  discount_amount  numeric not null default 0,
  tax_amount       numeric not null default 0,
  total            numeric not null default 0,
  payment_method   text not null default 'CASH' check (upper(payment_method) in ('CASH','TRANSFER','CREDIT')),
  status           text not null default 'PAID' check (status in ('PAID','CANCELLED')),
  created_at       timestamptz not null default now()
);
create index if not exists idx_bills_shift    on bills(shift_id);
create index if not exists idx_bills_customer on bills(customer_id);
create index if not exists idx_bills_created  on bills(created_at);

create table if not exists bill_items (
  id            uuid primary key,
  bill_id       uuid not null references bills(id) on delete cascade,
  product_id    uuid references products(id),
  variant_id    uuid references product_variants(id),
  fraction_id   uuid references product_fractions(id),
  item_name     text not null,
  quantity      numeric not null check (quantity > 0),
  unit_price    numeric not null,
  line_total    numeric not null,
  returned_qty  numeric not null default 0                -- จำนวนที่คืนไปแล้ว (กันคืนเกินจำนวนที่ขาย)
);
create index if not exists idx_bill_items_bill on bill_items(bill_id);

create table if not exists bill_returns (
  id            uuid primary key default gen_random_uuid(),
  ref           text not null unique,                     -- เลขใบลดหนี้ (กันส่งซ้ำ)
  bill_id       uuid not null references bills(id),
  refund_total  numeric not null default 0,
  method        text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);

-- ---- จัดซื้อ / สต็อก / บัญชี ------------------------------------------------------
create table if not exists purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  po_number     text,
  supplier_id   uuid references suppliers(id),
  status        text not null default 'ORDERED' check (status in ('ORDERED','RECEIVED','CANCELLED')),
  document_ref  text,
  credit_terms  integer default 30,
  client_ref    text,                                     -- รหัสจากเครื่อง (กันรับของซ้ำ)
  ordered_at    timestamptz not null default now(),
  received_at   timestamptz
);
create unique index if not exists idx_po_client_ref on purchase_orders(client_ref) where client_ref is not null;

create table if not exists purchase_order_items (
  id                 uuid primary key default gen_random_uuid(),
  purchase_order_id  uuid not null references purchase_orders(id) on delete cascade,
  product_id         uuid references products(id),
  variant_id         uuid references product_variants(id),
  quantity           numeric not null,
  unit_cost          numeric not null default 0,
  received_quantity  numeric not null default 0
);

create table if not exists inventory_movements (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references product_variants(id),
  change_qty  numeric not null,
  reason      text not null,                              -- SALE / RETURN / PURCHASE_RECEIPT / ADJUSTMENT / OPENING_BALANCE
  ref_type    text,
  ref_id      uuid,
  op_ref      text,                                       -- รหัสการทำรายการ (กันบันทึกซ้ำ)
  note        text,
  created_at  timestamptz not null default now()
);
create unique index if not exists idx_inv_move_op_ref  on inventory_movements(op_ref) where op_ref is not null;
create index        if not exists idx_inv_move_variant on inventory_movements(variant_id);

create table if not exists cash_ledger (
  id           uuid primary key default gen_random_uuid(),
  shift_id     uuid references shifts(id),
  type         text not null,                             -- cash-in-ar (รับชำระหนี้) / expense-refund (คืนเงิน) ...
  income       numeric not null default 0,
  expense      numeric not null default 0,
  description  text,
  ref_id       text,
  op_ref       text,
  created_at   timestamptz not null default now()
);
create unique index if not exists idx_cash_ledger_op_ref on cash_ledger(op_ref) where op_ref is not null;
create index        if not exists idx_cash_ledger_shift  on cash_ledger(shift_id);

create table if not exists accounts_payable (
  id                 uuid primary key,
  supplier_id        uuid references suppliers(id),
  purchase_order_id  uuid references purchase_orders(id) on delete set null,
  doc_ref            text,
  amount             numeric not null default 0 check (amount >= 0),
  credit_terms       integer default 30,
  status             text not null default 'OPEN' check (status in ('OPEN','PAID')),
  created_at         timestamptz not null default now(),
  paid_at            timestamptz
);
create index if not exists idx_ap_supplier on accounts_payable(supplier_id);
create index if not exists idx_ap_status   on accounts_payable(status);

-- ประวัติการใช้งาน: เพิ่มได้อย่างเดียว (trigger ห้ามแก้/ลบ)
create table if not exists audit_logs (
  id                 uuid primary key,
  occurred_at        timestamptz not null default now(),
  actor_app_user_id  uuid,
  actor_name         text,
  actor_role         text,
  action             text not null,
  entity             text,
  entity_id          text,
  detail             text,
  meta               jsonb,
  device_id          text,
  received_at        timestamptz not null default now(),
  received_by        uuid default auth.uid()
);
create index if not exists idx_audit_occurred on audit_logs(occurred_at desc);
create index if not exists idx_audit_actor    on audit_logs(actor_name, occurred_at desc);
create index if not exists idx_audit_action   on audit_logs(action, occurred_at desc);
create index if not exists idx_audit_entity   on audit_logs(entity, entity_id);


-- ============================================================================
-- 3. ฟังก์ชันตรวจสิทธิ์
-- ใช้ใน RLS และ RPC — ดูจาก app_users ของ session ปัจจุบัน (auth.uid())
-- ============================================================================


create or replace function is_staff() returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select exists (select 1 from app_users where auth_user_id = auth.uid() and is_active);
$$;

create or replace function is_manager() returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select exists (select 1 from app_users where auth_user_id = auth.uid() and is_active and role in ('OWNER','MANAGER'));
$$;

create or replace function is_owner() returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select exists (select 1 from app_users where auth_user_id = auth.uid() and is_active and role = 'OWNER');
$$;

create or replace function has_perm(p_perm text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select exists (
    select 1 from app_users
    where auth_user_id = auth.uid() and is_active
      and (role in ('OWNER','MANAGER') or coalesce(permissions, '[]'::jsonb) @> to_jsonb(p_perm))
  );
$$;


create or replace function pos_schema_version() returns int
language sql stable set search_path = public, pg_temp as $$ select 3 $$;


-- ============================================================================
-- 4. TRIGGER ป้องกัน
-- ============================================================================

create or replace function guard_balance_columns() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or coalesce(current_setting('app.balance_write', true), '') = 'on' then
    return new;
  end if;
  if tg_table_name = 'product_variants' then
    if tg_op = 'INSERT' then
      if coalesce(new.stock_quantity, 0) <> 0 then
        raise exception 'ห้ามตั้งสต็อกตรงๆ — ใช้ seed_variant_stock / adjust_stock / รับสินค้า / ขาย เท่านั้น';
      end if;
    elsif new.stock_quantity is distinct from old.stock_quantity then
      raise exception 'ห้ามแก้ stock_quantity ตรงๆ — ใช้ adjust_stock / รับสินค้า / ขาย / คืนสินค้า เท่านั้น';
    end if;
  elsif tg_table_name = 'customers' then
    if tg_op = 'INSERT' then
      if coalesce(new.debt, 0) <> 0 then
        raise exception 'ห้ามตั้งยอดหนี้ตรงๆ — ใช้ seed_customer_debt / receive_customer_payment / ขายเชื่อ เท่านั้น';
      end if;
    elsif new.debt is distinct from old.debt then
      raise exception 'ห้ามแก้ยอดหนี้ตรงๆ — ใช้ receive_customer_payment / ขายเชื่อ / คืนสินค้า เท่านั้น';
    end if;
  end if;
  return new;
end $$;

create or replace function guard_app_users_change() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or is_owner() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.role = 'OWNER' and not exists (select 1 from app_users where role = 'OWNER') then return new; end if;
    if new.role <> 'CASHIER' then raise exception 'เฉพาะเจ้าของร้านเท่านั้นที่เพิ่มบัญชีผู้จัดการ/เจ้าของได้'; end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.role <> 'CASHIER' or new.role <> 'CASHIER' then raise exception 'เฉพาะเจ้าของร้านเท่านั้นที่แก้ไขบัญชีผู้จัดการ/เจ้าของ หรือเปลี่ยนตำแหน่งได้'; end if;
    return new;
  else
    if old.role <> 'CASHIER' then raise exception 'เฉพาะเจ้าของร้านเท่านั้นที่ลบบัญชีผู้จัดการ/เจ้าของได้'; end if;
    return old;
  end if;
end;
$$;

create or replace function guard_app_users_identity() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return new; end if;
  if new.auth_user_id is distinct from old.auth_user_id or new.login_email is distinct from old.login_email then
    raise exception 'แก้ auth_user_id / login_email ไม่ได้ (ระบบจัดการให้เอง)';
  end if;
  return new;
end $$;

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

create or replace function audit_logs_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'audit_logs เป็นประวัติแบบเพิ่มได้อย่างเดียว ห้ามแก้ไข/ลบ';
end;
$$;


drop trigger if exists trg_guard_variant_stock      on product_variants;
drop trigger if exists trg_guard_customer_debt      on customers;
drop trigger if exists trg_guard_app_users          on app_users;
drop trigger if exists trg_guard_app_users_identity on app_users;
drop trigger if exists trg_guard_bill_user          on bills;
drop trigger if exists trg_audit_logs_no_update     on audit_logs;
drop trigger if exists trg_audit_logs_no_truncate   on audit_logs;

create trigger trg_guard_variant_stock      before insert or update on product_variants for each row execute function guard_balance_columns();
create trigger trg_guard_customer_debt      before insert or update on customers        for each row execute function guard_balance_columns();
create trigger trg_guard_app_users          before insert or update or delete on app_users for each row execute function guard_app_users_change();
create trigger trg_guard_app_users_identity before update on app_users                  for each row execute function guard_app_users_identity();
create trigger trg_guard_bill_user          before insert on bills                      for each row execute function guard_bill_user();
create trigger trg_audit_logs_no_update     before update or delete on audit_logs       for each row       execute function audit_logs_immutable();
create trigger trg_audit_logs_no_truncate   before truncate         on audit_logs       for each statement execute function audit_logs_immutable();


-- ============================================================================
-- 5. ROW LEVEL SECURITY — ตารางสิทธิ์
-- อ่าน  : พนักงานที่ใช้งานอยู่ (is_staff) อ่านได้ทุกตาราง ยกเว้น product_variants (ต้นทุน) = ผู้จัดการ, audit_logs = ผู้จัดการ
-- เขียน : ดูตารางด้านล่าง     (RPC แบบ security definer ข้าม RLS เอง จึงเขียนตารางธุรกรรมได้โดยไม่ต้องมี policy เขียนตรง)
-- 
--  ตาราง                                        เพิ่ม        แก้          ลบ
--  categories products product_categories
--  product_variants product_fractions            ผู้จัดการ    ผู้จัดการ    ผู้จัดการ
--  purchase_orders(+items) cash_ledger
--  accounts_payable                              ผู้จัดการ    ผู้จัดการ    ผู้จัดการ
--  customers                                     พนักงาน      ผู้จัดการ    ผู้จัดการ
--  suppliers                                     ผู้จัดการ    ผู้จัดการ    ผู้จัดการ
--  shifts                                        พนักงาน      พนักงาน      ผู้จัดการ
--  app_users                                     ผู้จัดการ*   ผู้จัดการ*   ผู้จัดการ*     (* trigger จำกัดให้ผู้จัดการจัดการได้เฉพาะแคชเชียร์)
--  bills bill_items inventory_movements
--  bill_returns                                  RPC เท่านั้น RPC เท่านั้น RPC เท่านั้น
--  audit_logs                                    ผู้จัดการ    ห้าม         ห้าม
-- ============================================================================


alter table categories           enable row level security;
alter table products             enable row level security;
alter table product_categories   enable row level security;
alter table product_variants     enable row level security;
alter table product_fractions    enable row level security;
alter table customers            enable row level security;
alter table suppliers            enable row level security;
alter table app_users            enable row level security;
alter table shifts               enable row level security;
alter table bills                enable row level security;
alter table bill_items           enable row level security;
alter table bill_returns         enable row level security;
alter table purchase_orders      enable row level security;
alter table purchase_order_items enable row level security;
alter table inventory_movements  enable row level security;
alter table cash_ledger          enable row level security;
alter table accounts_payable     enable row level security;
alter table audit_logs           enable row level security;

-- เคลียร์ policy เดิมของตารางเหล่านี้ทั้งหมด แล้วสร้างตามตารางด้านบน (รันซ้ำได้ ไม่เหลือ policy เก่าตกค้าง)
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
            where schemaname = 'public'
              and tablename in ('categories','products','product_categories','product_variants','product_fractions',
                                'customers','suppliers','app_users','shifts','bills','bill_items','bill_returns',
                                'purchase_orders','purchase_order_items','inventory_movements','cash_ledger',
                                'accounts_payable','audit_logs')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- อ่าน: พนักงานอ่านได้ทุกตาราง (ยกเว้น 3 ตารางด้านล่างที่เป็นของผู้จัดการ)
do $$
declare t text;
begin
  foreach t in array array['categories','products','product_categories','product_fractions','customers','suppliers',
                           'shifts','bills','bill_items','bill_returns','purchase_orders','purchase_order_items',
                           'inventory_movements','cash_ledger','accounts_payable']
  loop
    execute format('create policy "staff_select_%1$s" on %1$s for select using (is_staff())', t);
  end loop;
end $$;
create policy "manager_select_product_variants" on product_variants for select using (is_manager());   -- มีต้นทุน: แคชเชียร์อ่านผ่าน view
create policy "manager_select_audit_logs"       on audit_logs       for select using (is_manager());
create policy "self_select_app_users"           on app_users        for select using (auth_user_id = auth.uid() or is_manager());

-- เขียน: ผู้จัดการ (เพิ่ม/แก้/ลบ)
do $$
declare t text;
begin
  foreach t in array array['categories','products','product_categories','product_variants','product_fractions',
                           'suppliers','purchase_orders','purchase_order_items','cash_ledger','accounts_payable','app_users']
  loop
    execute format('create policy "manager_insert_%1$s" on %1$s for insert with check (is_manager())', t);
    execute format('create policy "manager_delete_%1$s" on %1$s for delete using (is_manager())', t);
    if t <> 'product_categories' then   -- ตารางผูกหมวดไม่มีคอลัมน์ให้แก้ (เพิ่ม/ลบอย่างเดียว)
      execute format('create policy "manager_update_%1$s" on %1$s for update using (is_manager()) with check (is_manager())', t);
    end if;
  end loop;
end $$;

-- ลูกค้า: พนักงานเพิ่มลูกค้าใหม่ได้ แต่แก้ข้อมูล (เช่นวงเงินเครดิต) ได้เฉพาะผู้จัดการ
create policy "staff_insert_customers"   on customers for insert with check (is_staff());
create policy "manager_update_customers" on customers for update using (is_manager()) with check (is_manager());
create policy "manager_delete_customers" on customers for delete using (is_manager());

-- กะ: พนักงานเปิด/ปิดกะได้
create policy "staff_insert_shifts"   on shifts for insert with check (is_staff());
create policy "staff_update_shifts"   on shifts for update using (is_staff()) with check (is_staff());
create policy "manager_delete_shifts" on shifts for delete using (is_manager());

-- ประวัติการใช้งาน: เพิ่มโดยผู้จัดการเท่านั้น (RPC บันทึกให้เองฝั่งเซิร์ฟเวอร์) แก้/ลบไม่ได้
create policy "manager_insert_audit_logs" on audit_logs for insert with check (is_manager());


-- ============================================================================
-- 6. VIEW
-- แคชเชียร์อ่านสินค้า/สต็อกผ่าน view นี้ (ต้นทุนถูกซ่อน) — ผู้จัดการขึ้นไปเห็นต้นทุน
-- ============================================================================


create or replace view product_variants_view as
select id, product_id, variant_name, barcode, sku, image_url, price,
       case when is_manager() then cost_price else null end as cost_price,
       stock_quantity, is_active, created_at
from product_variants;


-- ============================================================================
-- 7. RPC ธุรกิจ
-- ทุกตัว: security definer + search_path ตายตัว + ตรวจสิทธิ์ภายใน
-- ============================================================================

-- 7.1 ตั้งเจ้าของร้านคนแรก
create or replace function bootstrap_first_owner(p_name text, p_pin text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'ต้องเข้าสู่ระบบก่อนตั้งค่าเจ้าของร้าน'; end if;
  if coalesce(btrim(p_name), '') = '' or length(p_name) > 100 then raise exception 'ชื่อเจ้าของร้านไม่ถูกต้อง'; end if;
  if p_pin !~ '^[0-9a-f]{64}$' and p_pin !~ '^pbkdf2\$[0-9]+\$[0-9a-f]+\$[0-9a-f]{64}$' then
    raise exception 'รูปแบบ PIN hash ไม่ถูกต้อง (ห้ามส่ง PIN ดิบ)';
  end if;
  perform pg_advisory_xact_lock(hashtext('bootstrap_first_owner'));
  if exists (select 1 from app_users where role = 'OWNER') then raise exception 'มี OWNER อยู่แล้ว'; end if;
  insert into app_users (id, auth_user_id, name, pin, role, permissions, is_active)
  values (gen_random_uuid(), auth.uid(), btrim(p_name), p_pin, 'OWNER', '["ALL"]'::jsonb, true)
  returning id into new_id;
  return new_id;
end $$;

-- 7.2 ขาย (สร้างบิล + ตัดสต็อก + เพิ่มหนี้ ใน transaction เดียว, ส่งซ้ำด้วยเลขบิลเดิมได้)
create or replace function create_sale(
  p_bill_number text, p_customer_id uuid, p_user_id uuid, p_shift_id uuid,
  p_discount_amount numeric, p_tax_amount numeric, p_payment_method text, p_items jsonb,
  p_allow_negative boolean default false, p_tax_mode text default 'NONE',
  p_expected_total numeric default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing bills%rowtype;  v_bill_id uuid := gen_random_uuid();
  v_subtotal numeric := 0;   v_discount numeric := coalesce(p_discount_amount, 0);
  v_tax numeric := coalesce(p_tax_amount, 0);  v_total numeric;
  v_method text := upper(coalesce(nullif(p_payment_method, ''), 'CASH'));
  v_item jsonb; v_qty numeric; v_price numeric;
  v_variant product_variants%rowtype; v_fraction product_fractions%rowtype;
  v_deduct numeric; v_server_price numeric;
  v_customer customers%rowtype; v_cust_id uuid := p_customer_id;
  v_user_id uuid := p_user_id; v_shift_id uuid := p_shift_id; v_me app_users%rowtype;
begin
  if not is_staff() then raise exception 'ไม่มีสิทธิ์บันทึกการขาย'; end if;
  perform set_config('app.balance_write', 'on', true);
  if coalesce(btrim(p_bill_number), '') = '' then raise exception 'ต้องระบุเลขที่บิล'; end if;

  select * into v_existing from bills where bill_number = p_bill_number;
  if found then
    return jsonb_build_object('bill_id', v_existing.id, 'total', v_existing.total, 'duplicate', true);
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'บิลต้องมีรายการสินค้าอย่างน้อย 1 รายการ';
  end if;
  if v_method not in ('CASH','TRANSFER','CREDIT') then raise exception 'วิธีชำระเงินไม่ถูกต้อง: %', v_method; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::numeric;  v_price := (v_item->>'unit_price')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'จำนวนของ "%" ต้องมากกว่า 0', v_item->>'item_name'; end if;
    if v_price is null or v_price < 0 then raise exception 'ราคาของ "%" ไม่ถูกต้อง', v_item->>'item_name'; end if;
    v_subtotal := v_subtotal + v_qty * v_price;
  end loop;
  v_subtotal := round(v_subtotal, 2);
  if v_discount < 0 or v_discount > v_subtotal then
    raise exception 'ส่วนลด % ไม่ถูกต้อง (ยอดรวมก่อนลด %)', v_discount, v_subtotal;
  end if;
  v_total := round(v_subtotal - v_discount
             + case when upper(coalesce(p_tax_mode, 'NONE')) = 'EXCLUDED' then v_tax else 0 end, 2);

  -- ตัวอ้างอิงที่อาจยังไม่ถูก sync: ไม่ให้บิลล้มเพราะ FK (ลูกค้าเชื่อต้องมีจริงเท่านั้น)
  if v_user_id  is not null and not exists (select 1 from app_users where id = v_user_id)  then v_user_id := null; end if;
  if v_shift_id is not null and not exists (select 1 from shifts    where id = v_shift_id) then v_shift_id := null; end if;
  select * into v_me from app_users where auth_user_id = auth.uid() and is_active limit 1;

  if v_method = 'CREDIT' then
    if v_cust_id is null then raise exception 'ขายเชื่อต้องระบุลูกค้า'; end if;
    select * into v_customer from customers where id = v_cust_id for update;
    if not found then raise exception 'ไม่พบลูกค้าบนเซิร์ฟเวอร์ (ยังไม่ได้ซิงค์ลูกค้า)'; end if;
    if (v_customer.debt + v_total) > v_customer.credit_limit then
      raise exception 'ยอดหนี้รวมจะเกินวงเงินเครดิต (วงเงิน % หนี้เดิม % ยอดนี้ %)',
        v_customer.credit_limit, v_customer.debt, v_total;
    end if;
    update customers set debt = debt + v_total where id = v_cust_id;
  elsif v_cust_id is not null and not exists (select 1 from customers where id = v_cust_id) then
    v_cust_id := null;
  end if;

  -- ล็อก variant ทั้งหมดของบิลเรียงตาม id ก่อน (ป้องกัน deadlock เวลาขายพร้อมกันหลายเครื่อง)
  perform 1 from product_variants
   where id in (select nullif(x->>'variant_id', '')::uuid from jsonb_array_elements(p_items) x
                 where nullif(x->>'variant_id', '') is not null)
   order by id for update;

  insert into bills (id, bill_number, customer_id, user_id, shift_id, subtotal, discount_amount, tax_amount,
                     total, payment_method, status)
  values (v_bill_id, p_bill_number, v_cust_id, v_user_id, v_shift_id, v_subtotal, v_discount, v_tax,
          v_total, v_method, 'PAID');

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::numeric;  v_price := (v_item->>'unit_price')::numeric;
    insert into bill_items (id, bill_id, product_id, variant_id, fraction_id, item_name, quantity, unit_price, line_total)
    values (gen_random_uuid(), v_bill_id, nullif(v_item->>'product_id', '')::uuid,
            nullif(v_item->>'variant_id', '')::uuid, nullif(v_item->>'fraction_id', '')::uuid,
            coalesce(v_item->>'item_name', '(ไม่ระบุชื่อ)'), v_qty, v_price, v_qty * v_price);

    if nullif(v_item->>'variant_id', '') is not null then
      select * into v_variant from product_variants where id = (v_item->>'variant_id')::uuid;
      if not found then
        raise exception 'ไม่พบสินค้า "%" บนเซิร์ฟเวอร์ (ยังไม่ซิงค์สินค้า หรือถูกลบแล้ว)', v_item->>'item_name';
      end if;
      v_server_price := v_variant.price;
      if nullif(v_item->>'fraction_id', '') is not null then
        select * into v_fraction from product_fractions
         where id = (v_item->>'fraction_id')::uuid and variant_id = v_variant.id;
        if not found then raise exception 'ไม่พบหน่วยแบ่งขายของ "%"', v_item->>'item_name'; end if;
        v_deduct := v_qty / v_fraction.quantity_ratio;
        v_server_price := v_fraction.price;
      else
        v_deduct := v_qty;
      end if;

      if abs(v_price - v_server_price) > 0.005 then   -- ไม่บล็อกการขาย แต่บันทึกร่องรอยไว้ตรวจสอบ
        insert into audit_logs (id, actor_app_user_id, actor_name, actor_role, action, entity, entity_id, detail, device_id)
        values (gen_random_uuid(), v_me.id, v_me.name, v_me.role, 'PRICE_MISMATCH', 'bill', v_bill_id::text,
                format('บิล %s สินค้า %s ขายที่ %s แต่ราคาในระบบ %s', p_bill_number, v_item->>'item_name', v_price, v_server_price),
                'server');
      end if;
      if not p_allow_negative and v_variant.stock_quantity - v_deduct < 0 then
        raise exception 'สินค้า "%" คงเหลือไม่พอ (คงเหลือ % ต้องการ %)',
          v_item->>'item_name', v_variant.stock_quantity, v_deduct;
      end if;
      update product_variants set stock_quantity = stock_quantity - v_deduct where id = v_variant.id;
      insert into inventory_movements (variant_id, change_qty, reason, ref_type, ref_id)
      values (v_variant.id, -v_deduct, 'SALE', 'bill', v_bill_id);
    end if;
  end loop;

  if p_expected_total is not null and abs(p_expected_total - v_total) > 0.05 then
    insert into audit_logs (id, actor_app_user_id, actor_name, actor_role, action, entity, entity_id, detail, device_id)
    values (gen_random_uuid(), v_me.id, v_me.name, v_me.role, 'TOTAL_MISMATCH', 'bill', v_bill_id::text,
            format('บิล %s ยอดจากเครื่อง %s แต่เซิร์ฟเวอร์คำนวณ %s', p_bill_number, p_expected_total, v_total), 'server');
  end if;
  return jsonb_build_object('bill_id', v_bill_id, 'total', v_total, 'duplicate', false);
end $$;

-- 7.3 คืนสินค้า (หักสัดส่วนส่วนลด, กันคืนเกิน, ส่งซ้ำด้วย p_return_ref ได้)
create or replace function process_return(
  p_bill_id uuid, p_items jsonb, p_full_return boolean default false,
  p_return_ref text default null, p_shift_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bill bills%rowtype; v_prev bill_returns%rowtype; v_item jsonb; v_bi bill_items%rowtype;
  v_qty numeric; v_variant product_variants%rowtype; v_fraction product_fractions%rowtype;
  v_restock numeric; v_gross numeric := 0; v_factor numeric; v_refund numeric;
  v_all_returned boolean; v_ref text; v_shift uuid := p_shift_id; v_n int := 0;
begin
  if not is_staff() then raise exception 'ไม่มีสิทธิ์บันทึกการคืนสินค้า'; end if;
  perform set_config('app.balance_write', 'on', true);
  if p_return_ref is not null then
    select * into v_prev from bill_returns where ref = p_return_ref;
    if found then return jsonb_build_object('refund_total', v_prev.refund_total, 'duplicate', true); end if;
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ไม่มีรายการคืน';
  end if;

  select * into v_bill from bills where id = p_bill_id for update;
  if not found then raise exception 'ไม่พบบิล id=%', p_bill_id; end if;
  if v_bill.status = 'CANCELLED' then raise exception 'บิล % ถูกคืนครบ/ยกเลิกแล้ว', v_bill.bill_number; end if;
  v_factor := case when v_bill.subtotal > 0
                   then (v_bill.subtotal - v_bill.discount_amount) / v_bill.subtotal else 1 end;
  v_ref := coalesce(p_return_ref, gen_random_uuid()::text);
  if v_shift is not null and not exists (select 1 from shifts where id = v_shift) then v_shift := null; end if;
  if v_shift is null then v_shift := v_bill.shift_id; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'จำนวนคืนต้องมากกว่า 0'; end if;
    select * into v_bi from bill_items
     where bill_id = p_bill_id
       and variant_id  is not distinct from nullif(v_item->>'variant_id', '')::uuid
       and fraction_id is not distinct from nullif(v_item->>'fraction_id', '')::uuid
       and (quantity - returned_qty) >= v_qty
     order by (quantity - returned_qty) desc limit 1 for update;
    if not found then raise exception 'จำนวนที่คืนเกินจำนวนที่ขายไป หรือไม่พบรายการนี้ในบิล'; end if;

    update bill_items set returned_qty = returned_qty + v_qty where id = v_bi.id;
    v_gross := v_gross + v_qty * v_bi.unit_price;

    if v_bi.variant_id is not null then
      select * into v_variant from product_variants where id = v_bi.variant_id for update;
      if found then
        if v_bi.fraction_id is not null then
          select * into v_fraction from product_fractions where id = v_bi.fraction_id;
          v_restock := v_qty / coalesce(v_fraction.quantity_ratio, 1);
        else
          v_restock := v_qty;
        end if;
        update product_variants set stock_quantity = stock_quantity + v_restock where id = v_variant.id;
        v_n := v_n + 1;
        insert into inventory_movements (variant_id, change_qty, reason, ref_type, ref_id, op_ref)
        values (v_variant.id, v_restock, 'RETURN', 'bill', p_bill_id, v_ref || '#' || v_n);
      end if;
    end if;
  end loop;

  v_refund := round(v_gross * v_factor, 2);
  select not exists (select 1 from bill_items where bill_id = p_bill_id and quantity - returned_qty > 0.00005)
    into v_all_returned;
  if v_all_returned then update bills set status = 'CANCELLED' where id = p_bill_id; end if;

  if upper(v_bill.payment_method) = 'CREDIT' and v_bill.customer_id is not null then
    update customers set debt = greatest(0, debt - v_refund) where id = v_bill.customer_id;
  else
    insert into cash_ledger (shift_id, type, income, expense, description, ref_id, op_ref)
    values (v_shift, 'expense-refund', 0, v_refund, 'คืนสินค้าบิล ' || v_bill.bill_number, p_bill_id::text, v_ref);
  end if;
  insert into bill_returns (ref, bill_id, refund_total, method) values (v_ref, p_bill_id, v_refund, v_bill.payment_method);
  return jsonb_build_object('refund_total', v_refund, 'bill_cancelled', v_all_returned, 'duplicate', false);
end $$;

-- 7.4 รับชำระหนี้ลูกค้า
create or replace function receive_customer_payment(
  p_customer_id uuid, p_amount numeric, p_shift_id uuid, p_op_ref text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_customer customers%rowtype; v_applied numeric; v_prev cash_ledger%rowtype; v_shift uuid := p_shift_id;
begin
  if not is_staff() then raise exception 'ไม่มีสิทธิ์บันทึกการรับชำระหนี้'; end if;
  perform set_config('app.balance_write', 'on', true);
  if coalesce(p_amount, 0) <= 0 then raise exception 'จำนวนเงินที่รับชำระต้องมากกว่า 0'; end if;
  if p_op_ref is not null then
    select * into v_prev from cash_ledger where op_ref = p_op_ref;
    if found then return jsonb_build_object('applied', v_prev.income, 'duplicate', true); end if;
  end if;
  select * into v_customer from customers where id = p_customer_id for update;
  if not found then raise exception 'ไม่พบลูกค้า id=%', p_customer_id; end if;
  v_applied := least(p_amount, v_customer.debt);
  if v_applied <= 0 then
    return jsonb_build_object('applied', 0, 'remaining_debt', v_customer.debt, 'duplicate', false);
  end if;
  if v_shift is not null and not exists (select 1 from shifts where id = v_shift) then v_shift := null; end if;
  update customers set debt = debt - v_applied where id = p_customer_id;
  insert into cash_ledger (shift_id, type, income, expense, description, ref_id, op_ref)
  values (v_shift, 'cash-in-ar', v_applied, 0, 'รับชำระหนี้จาก ' || v_customer.name, p_customer_id::text, p_op_ref);
  return jsonb_build_object('applied', v_applied, 'remaining_debt', v_customer.debt - v_applied, 'duplicate', false);
end $$;

-- 7.5 ปรับสต็อกด้วยมือ (ผู้จัดการขึ้นไป)
create or replace function adjust_stock(
  p_variant_id uuid, p_mode text, p_value numeric, p_reason text default null, p_op_ref text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_variant product_variants%rowtype; v_new numeric; v_change numeric;
begin
  if not is_manager() then raise exception 'เฉพาะผู้จัดการขึ้นไปเท่านั้นที่ปรับจำนวนสต็อกด้วยมือได้'; end if;
  perform set_config('app.balance_write', 'on', true);
  if p_mode not in ('SET', 'DELTA') then raise exception 'p_mode ต้องเป็น SET หรือ DELTA'; end if;
  if p_op_ref is not null and exists (select 1 from inventory_movements where op_ref = p_op_ref) then
    return jsonb_build_object('duplicate', true);
  end if;
  select * into v_variant from product_variants where id = p_variant_id for update;
  if not found then raise exception 'ไม่พบสินค้า variant id=%', p_variant_id; end if;
  v_new := case when p_mode = 'SET' then greatest(0, p_value)
                else greatest(0, v_variant.stock_quantity + p_value) end;
  v_change := v_new - v_variant.stock_quantity;
  update product_variants set stock_quantity = v_new, stock_seeded = true where id = p_variant_id;
  if v_change <> 0 then
    insert into inventory_movements (variant_id, change_qty, reason, ref_type, ref_id, op_ref, note)
    values (p_variant_id, v_change, 'ADJUSTMENT', 'manual', null, p_op_ref, p_reason);
  end if;
  return jsonb_build_object('variant_id', p_variant_id, 'new_stock', v_new, 'change', v_change, 'duplicate', false);
end $$;

-- 7.6 ส่งค่าตั้งต้นของสต็อก/หนี้จากเครื่องแรก (ครั้งเดียวต่อรายการ ไม่ทับค่าที่เซิร์ฟเวอร์รู้แล้ว)
create or replace function seed_variant_stock(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item jsonb; v_v product_variants%rowtype; v_applied int := 0; v_qty numeric;
begin
  if not is_manager() then raise exception 'เฉพาะผู้จัดการขึ้นไป'; end if;
  perform set_config('app.balance_write', 'on', true);
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into v_v from product_variants where id = (v_item->>'variant_id')::uuid for update;
    if found and not v_v.stock_seeded then
      v_qty := greatest(0, coalesce((v_item->>'stock')::numeric, 0));
      update product_variants set stock_quantity = v_qty, stock_seeded = true where id = v_v.id;
      if v_qty <> 0 then
        insert into inventory_movements (variant_id, change_qty, reason, ref_type, note)
        values (v_v.id, v_qty, 'OPENING_BALANCE', 'seed', 'ยอดยกมาจากเครื่องแรกที่ซิงค์');
      end if;
      v_applied := v_applied + 1;
    end if;
  end loop;
  return jsonb_build_object('applied', v_applied);
end $$;

create or replace function seed_customer_debt(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item jsonb; v_c customers%rowtype; v_applied int := 0;
begin
  if not is_staff() then raise exception 'ไม่มีสิทธิ์'; end if;
  perform set_config('app.balance_write', 'on', true);
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into v_c from customers where id = (v_item->>'customer_id')::uuid for update;
    if found and not v_c.debt_seeded then
      update customers set debt = greatest(0, coalesce((v_item->>'debt')::numeric, 0)), debt_seeded = true
       where id = v_c.id;
      v_applied := v_applied + 1;
    end if;
  end loop;
  return jsonb_build_object('applied', v_applied);
end $$;

-- 7.7 รับสินค้าเข้า (ต้นทุนถัวเฉลี่ยถ่วงน้ำหนัก)
create or replace function receive_goods(
  p_client_ref text, p_supplier_id uuid, p_doc_ref text, p_terms integer, p_received_at timestamptz, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_po purchase_orders%rowtype; v_item jsonb; v_variant product_variants%rowtype;
  v_qty numeric; v_cost numeric; v_new_cost numeric; v_sup uuid := p_supplier_id; v_po_id uuid;
begin
  if not is_manager() then raise exception 'ต้องเป็นผู้จัดการขึ้นไปจึงจะรับสินค้าเข้าคลังได้'; end if;
  perform set_config('app.balance_write', 'on', true);
  if coalesce(btrim(p_client_ref), '') = '' then raise exception 'ต้องระบุ client_ref'; end if;
  select * into v_po from purchase_orders where client_ref = p_client_ref;
  if found then return jsonb_build_object('po_id', v_po.id, 'duplicate', true); end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'ไม่มีรายการรับสินค้า';
  end if;
  if v_sup is not null and not exists (select 1 from suppliers where id = v_sup) then v_sup := null; end if;

  insert into purchase_orders (po_number, supplier_id, status, document_ref, credit_terms, ordered_at, received_at, client_ref)
  values (p_doc_ref, v_sup, 'RECEIVED', p_doc_ref, coalesce(p_terms, 30), coalesce(p_received_at, now()), now(), p_client_ref)
  returning id into v_po_id;

  perform 1 from product_variants
   where id in (select nullif(x->>'variant_id', '')::uuid from jsonb_array_elements(p_items) x
                 where nullif(x->>'variant_id', '') is not null)
   order by id for update;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::numeric;  v_cost := coalesce((v_item->>'unit_cost')::numeric, 0);
    if v_qty is null or v_qty <= 0 then raise exception 'จำนวนรับต้องมากกว่า 0'; end if;
    insert into purchase_order_items (purchase_order_id, product_id, variant_id, quantity, unit_cost, received_quantity)
    values (v_po_id, nullif(v_item->>'product_id', '')::uuid, nullif(v_item->>'variant_id', '')::uuid,
            v_qty, v_cost, v_qty);

    if nullif(v_item->>'variant_id', '') is not null then
      select * into v_variant from product_variants where id = (v_item->>'variant_id')::uuid;
      if not found then raise exception 'ไม่พบสินค้า variant id=%', v_item->>'variant_id'; end if;
      v_new_cost := v_variant.cost_price;
      if v_cost > 0 then
        if v_variant.stock_quantity > 0 then
          v_new_cost := round((v_variant.stock_quantity * v_variant.cost_price + v_qty * v_cost)
                              / (v_variant.stock_quantity + v_qty), 2);
        else
          v_new_cost := v_cost;       -- สต็อกเดิมเป็น 0/ติดลบ: ใช้ต้นทุนล่าสุดตรงๆ
        end if;
      end if;
      update product_variants
         set stock_quantity = stock_quantity + v_qty, cost_price = v_new_cost, stock_seeded = true
       where id = v_variant.id;
      insert into inventory_movements (variant_id, change_qty, reason, ref_type, ref_id)
      values (v_variant.id, v_qty, 'PURCHASE_RECEIPT', 'purchase_order', v_po_id);
    end if;
  end loop;
  return jsonb_build_object('po_id', v_po_id, 'duplicate', false);
end $$;

create or replace function receive_purchase_order(p_purchase_order_id uuid, p_items jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item jsonb; v_poi purchase_order_items%rowtype; v_new_recv numeric;
        v_variant product_variants%rowtype; v_recv numeric; v_new_cost numeric;
begin
  if not is_manager() then raise exception 'ต้องเป็นผู้จัดการขึ้นไปจึงจะรับสินค้าเข้าคลังได้'; end if;
  perform set_config('app.balance_write', 'on', true);
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_recv := (v_item->>'received_quantity')::numeric;
    if v_recv is null or v_recv <= 0 then raise exception 'จำนวนรับต้องมากกว่า 0'; end if;
    select * into v_poi from purchase_order_items
     where id = (v_item->>'purchase_order_item_id')::uuid and purchase_order_id = p_purchase_order_id for update;
    if not found then
      raise exception 'ไม่พบรายการสั่งซื้อ id=% ในใบสั่งซื้อนี้', v_item->>'purchase_order_item_id';
    end if;
    v_new_recv := v_poi.received_quantity + v_recv;
    if v_new_recv > v_poi.quantity then
      raise exception 'รับสินค้าเกินจำนวนที่สั่ง (สั่ง % รับรวม %)', v_poi.quantity, v_new_recv;
    end if;
    update purchase_order_items set received_quantity = v_new_recv where id = v_poi.id;
    if v_poi.variant_id is not null then
      select * into v_variant from product_variants where id = v_poi.variant_id for update;
      v_new_cost := v_variant.cost_price;
      if coalesce(v_poi.unit_cost, 0) > 0 then
        v_new_cost := case when v_variant.stock_quantity > 0
          then round((v_variant.stock_quantity * v_variant.cost_price + v_recv * v_poi.unit_cost)
                     / (v_variant.stock_quantity + v_recv), 2)
          else v_poi.unit_cost end;
      end if;
      update product_variants
         set stock_quantity = stock_quantity + v_recv, cost_price = v_new_cost, stock_seeded = true
       where id = v_poi.variant_id;
      insert into inventory_movements (variant_id, change_qty, reason, ref_type, ref_id)
      values (v_poi.variant_id, v_recv, 'PURCHASE_RECEIPT', 'purchase_order', p_purchase_order_id);
    end if;
  end loop;
  update purchase_orders set status = 'RECEIVED', received_at = now()
   where id = p_purchase_order_id
     and not exists (select 1 from purchase_order_items
                      where purchase_order_id = p_purchase_order_id and received_quantity < quantity);
end $$;

-- 7.8 ลบ/เก็บเข้าประวัติ (มีประวัติผูกอยู่ = archive ไม่ลบจริง)
create or replace function delete_entity(p_kind text, p_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_mode      text := 'deleted';
  v_has_hist  boolean;
  v_row       record;
  v_me        app_users%rowtype;
  v_tag       text := '#arch-' || left(p_id::text, 8);
begin
  if not is_staff() then
    raise exception 'ต้องเข้าสู่ระบบเป็นพนักงานก่อน';
  end if;
  select * into v_me from app_users where auth_user_id = auth.uid() and is_active limit 1;
  if v_me.id is null then
    raise exception 'ไม่พบบัญชีพนักงานที่ใช้งานอยู่ — กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่';
  end if;

  if p_kind in ('product','variant','fraction','category') then
    if not has_perm('products.delete') then raise exception 'ไม่มีสิทธิ์ลบสินค้า/หมวดหมู่ (products.delete)'; end if;
  elsif p_kind = 'customer' then
    if not has_perm('customers.delete') then raise exception 'ไม่มีสิทธิ์ลบลูกค้า (customers.delete)'; end if;
  elsif p_kind in ('supplier','purchase_order') then
    if not has_perm('suppliers.manage') then raise exception 'ไม่มีสิทธิ์จัดการซัพพลายเออร์/ใบสั่งซื้อ (suppliers.manage)'; end if;
  elsif p_kind = 'employee' then
    if not has_perm('employees.manage') then raise exception 'ไม่มีสิทธิ์จัดการพนักงาน (employees.manage)'; end if;
  else
    raise exception 'ไม่รู้จักชนิดข้อมูลที่จะลบ: %', p_kind;
  end if;

  if p_kind = 'product' then
    if not exists (select 1 from products where id = p_id) then return jsonb_build_object('mode','missing','kind',p_kind); end if;
    v_has_hist :=
         exists (select 1 from bill_items where product_id = p_id)
      or exists (select 1 from purchase_order_items where product_id = p_id)
      or exists (select 1 from inventory_movements m join product_variants v on v.id = m.variant_id where v.product_id = p_id);
    if v_has_hist then
      update products set is_active = false,
             sku = case when sku is null then null when sku like '%#arch-%' then sku else sku || v_tag end
       where id = p_id;
      update product_variants set is_active = false, barcode = null,
             sku = case when sku is null then null when sku like '%#arch-%' then sku else sku || '#arch-' || left(id::text, 8) end
       where product_id = p_id;
      update product_fractions set is_active = false where variant_id in (select id from product_variants where product_id = p_id);
      v_mode := 'archived';
    else
      delete from products where id = p_id;
    end if;

  elsif p_kind = 'variant' then
    if not exists (select 1 from product_variants where id = p_id) then return jsonb_build_object('mode','missing','kind',p_kind); end if;
    v_has_hist :=
         exists (select 1 from bill_items where variant_id = p_id)
      or exists (select 1 from purchase_order_items where variant_id = p_id)
      or exists (select 1 from inventory_movements where variant_id = p_id);
    if v_has_hist then
      update product_variants set is_active = false, barcode = null,
             sku = case when sku is null then null when sku like '%#arch-%' then sku else sku || v_tag end
       where id = p_id;
      update product_fractions set is_active = false where variant_id = p_id;
      v_mode := 'archived';
    else
      delete from product_variants where id = p_id;
    end if;

  elsif p_kind = 'fraction' then
    if not exists (select 1 from product_fractions where id = p_id) then return jsonb_build_object('mode','missing','kind',p_kind); end if;
    if exists (select 1 from bill_items where fraction_id = p_id) then
      update product_fractions set is_active = false where id = p_id;
      v_mode := 'archived';
    else
      delete from product_fractions where id = p_id;
    end if;

  elsif p_kind = 'category' then
    if not exists (select 1 from categories where id = p_id) then return jsonb_build_object('mode','missing','kind',p_kind); end if;
    delete from categories where id = p_id;

  elsif p_kind = 'customer' then
    select * into v_row from customers where id = p_id;
    if not found then return jsonb_build_object('mode','missing','kind',p_kind); end if;
    if coalesce(v_row.debt, 0) > 0 then raise exception 'ลูกค้า "%" ยังมีหนี้ค้าง % บาท — ต้องรับชำระให้หมดก่อนถึงจะลบได้', v_row.name, v_row.debt; end if;
    if exists (select 1 from bills where customer_id = p_id) then
      update customers set is_active = false where id = p_id; v_mode := 'archived';
    else
      delete from customers where id = p_id;
    end if;

  elsif p_kind = 'supplier' then
    if not exists (select 1 from suppliers where id = p_id) then return jsonb_build_object('mode','missing','kind',p_kind); end if;
    if exists (select 1 from purchase_orders where supplier_id = p_id) or exists (select 1 from accounts_payable where supplier_id = p_id) then
      update suppliers set is_active = false where id = p_id; v_mode := 'archived';
    else
      delete from suppliers where id = p_id;
    end if;

  elsif p_kind = 'purchase_order' then
    select * into v_row from purchase_orders where id = p_id;
    if not found then return jsonb_build_object('mode','missing','kind',p_kind); end if;
    if v_row.status = 'RECEIVED' or exists (select 1 from purchase_order_items where purchase_order_id = p_id and coalesce(received_quantity, 0) > 0) then
      raise exception 'ใบสั่งซื้อ % รับสินค้าเข้าคลังแล้ว ลบไม่ได้ (มีประวัติสต็อกผูกอยู่)', v_row.po_number;
    end if;
    delete from purchase_orders where id = p_id;

  elsif p_kind = 'employee' then
    select * into v_row from app_users where id = p_id;
    if not found then return jsonb_build_object('mode','missing','kind',p_kind); end if;
    if v_row.role = 'OWNER' then raise exception 'ลบเจ้าของร้านไม่ได้'; end if;
    if v_row.id = v_me.id then raise exception 'ลบบัญชีของตัวเองไม่ได้'; end if;
    if v_me.role <> 'OWNER' and v_row.role <> 'CASHIER' then raise exception 'ผู้จัดการลบได้เฉพาะบัญชีแคชเชียร์'; end if;
    if exists (select 1 from bills where user_id = p_id) or exists (select 1 from shifts where opened_by = p_id or closed_by = p_id) then
      update app_users set is_active = false where id = p_id; v_mode := 'archived';
    else
      delete from app_users where id = p_id;
    end if;
  end if;

  insert into audit_logs (id, actor_app_user_id, actor_name, actor_role, action, entity, entity_id, detail, meta, device_id)
  values (gen_random_uuid(), v_me.id, v_me.name, v_me.role, 'SERVER_DELETE', p_kind, p_id::text,
          coalesce(p_note, '') || ' → ' || case v_mode when 'archived' then 'เก็บเข้าประวัติ' else 'ลบถาวร' end,
          jsonb_build_object('mode', v_mode), 'server');

  return jsonb_build_object('mode', v_mode, 'kind', p_kind);
end;
$$;

-- 7.9 ปลดล็อกพนักงานที่ใส่ PIN ผิดจนถูกพัก
create or replace function unlock_staff(p_app_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_manager() then raise exception 'เฉพาะผู้จัดการขึ้นไป'; end if;
  update app_users set failed_pin_attempts = 0, locked_until = null where id = p_app_user_id;
end $$;

-- 7.10 ล้างข้อมูลบนคลาวด์ (เจ้าของเท่านั้น)
create or replace function factory_reset_cloud_data()
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me app_users%rowtype;
begin
  if not is_owner() then
    raise exception 'เฉพาะเจ้าของร้าน (OWNER) เท่านั้นที่ล้างข้อมูลทั้งหมดบนคลาวด์ได้';
  end if;
  select * into v_me from app_users where auth_user_id = auth.uid() limit 1;

  truncate table
    bill_items, bills,
    purchase_order_items, purchase_orders,
    accounts_payable, cash_ledger, inventory_movements,
    product_fractions, product_variants, product_categories, products,
    categories, customers, suppliers, shifts
    cascade;

  delete from app_users where auth_user_id is distinct from auth.uid();

  insert into audit_logs (id, actor_app_user_id, actor_name, actor_role, action, entity, entity_id, detail, meta, device_id)
  values (gen_random_uuid(), v_me.id, v_me.name, v_me.role, 'SERVER_RESET', 'system', null,
          'ล้างข้อมูลทั้งหมดบนคลาวด์ (คงไว้เฉพาะบัญชีเจ้าของร้านและประวัติการใช้งาน)', null, 'server');
end;
$$;

-- ============================================================================
-- 8. STORAGE BUCKET
-- ============================================================================


insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true)
on conflict (id) do update set public = excluded.public;
insert into storage.buckets (id, name, public) values ('delivery-notes', 'delivery-notes', false)
on conflict (id) do nothing;

drop policy if exists "public_read_product_images"  on storage.objects;
drop policy if exists "staff_write_product_images"   on storage.objects;
drop policy if exists "staff_update_product_images"  on storage.objects;
drop policy if exists "staff_delete_product_images"  on storage.objects;
drop policy if exists "staff_read_delivery_notes"    on storage.objects;
drop policy if exists "staff_write_delivery_notes"   on storage.objects;
drop policy if exists "staff_delete_delivery_notes"  on storage.objects;

create policy "public_read_product_images" on storage.objects for select using (bucket_id = 'product-images');
create policy "staff_write_product_images" on storage.objects for insert with check (bucket_id = 'product-images' and is_staff());
create policy "staff_update_product_images" on storage.objects for update using (bucket_id = 'product-images' and is_staff());
create policy "staff_delete_product_images" on storage.objects for delete using (bucket_id = 'product-images' and is_staff());
create policy "staff_read_delivery_notes"  on storage.objects for select using (bucket_id = 'delivery-notes' and is_staff());
create policy "staff_write_delivery_notes" on storage.objects for insert with check (bucket_id = 'delivery-notes' and is_staff());
create policy "staff_delete_delivery_notes" on storage.objects for delete using (bucket_id = 'delivery-notes' and is_staff());


-- ============================================================================
-- 9. สิทธิ์ EXECUTE
-- ปิดไม่ให้ anon เรียก RPC (ทุกตัวตรวจสิทธิ์ภายในอยู่แล้ว นี่เป็นด่านที่สอง); ผู้ใช้ที่ล็อกอินแล้ว (authenticated) เรียกได้
-- ============================================================================


do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('create_sale','process_return','receive_customer_payment','adjust_stock','bootstrap_first_owner',
                               'receive_purchase_order','receive_goods','seed_variant_stock','seed_customer_debt',
                               'delete_entity','unlock_staff','factory_reset_cloud_data','is_staff','is_manager','is_owner','has_perm')
  loop
    begin
      execute format('revoke all on function %s from public, anon', r.sig);
      execute format('grant execute on function %s to authenticated', r.sig);
    exception when undefined_object then null;   -- ไม่ใช่ Supabase (ไม่มี role anon/authenticated)
    end;
  end loop;
  begin
    grant select on product_variants_view to authenticated;
  exception when undefined_object then null;
  end;
end $$;
