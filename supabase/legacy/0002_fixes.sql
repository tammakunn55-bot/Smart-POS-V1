-- ============================================================================
-- 0002_fixes.sql — แพตช์ต่อจาก 0001_base_schema_v3.sql (รันซ้ำได้)
-- แก้: ส่วนลดถูกส่งและตรวจฝั่งเซิร์ฟเวอร์, create_sale/process_return/รับชำระ/ปรับสต็อก/รับของ
-- เป็นแบบ idempotent (ส่งซ้ำไม่ซ้อน), กันคืนเกินจำนวนที่ขาย, ห้ามแก้สต็อก/หนี้ตรงๆ นอก RPC,
-- ปิดสิทธิ์เขียนตรงบนตารางธุรกรรม, ตั้ง search_path ให้ security definer, ต้นทุนถัวเฉลี่ยตอนรับของ
--
-- *** ยังไม่เคยรันกับ Postgres จริง (เขียนจากการอ่านโค้ด) — ทดสอบบนโปรเจกต์ทดสอบก่อนเสมอ ***
-- ============================================================================

-- 0. คอลัมน์/ตารางใหม่ ------------------------------------------------------
-- "seeded" = ค่าตั้งต้นของสต็อก/หนี้ถูกส่งขึ้นเซิร์ฟเวอร์แล้วหรือยัง
-- แถวที่มีอยู่ตอนรัน migration นี้ถือว่า seeded แล้ว (ADD COLUMN default true) แล้วค่อยเปลี่ยน default เป็น false
alter table product_variants add column if not exists stock_seeded boolean not null default true;
alter table product_variants alter column stock_seeded set default false;
alter table customers        add column if not exists debt_seeded  boolean not null default true;
alter table customers        alter column debt_seeded  set default false;
alter table bill_items       add column if not exists returned_qty numeric not null default 0;
alter table inventory_movements add column if not exists op_ref text;
alter table inventory_movements add column if not exists note   text;
alter table cash_ledger      add column if not exists op_ref text;
alter table purchase_orders  add column if not exists client_ref text;
create unique index if not exists idx_inv_move_op_ref    on inventory_movements(op_ref)  where op_ref is not null;
create unique index if not exists idx_cash_ledger_op_ref on cash_ledger(op_ref)          where op_ref is not null;
create unique index if not exists idx_po_client_ref      on purchase_orders(client_ref)  where client_ref is not null;

create table if not exists bill_returns (
  id           uuid primary key default gen_random_uuid(),
  ref          text not null unique,               -- เลขใบลดหนี้ (กันส่งซ้ำ)
  bill_id      uuid not null references bills(id),
  refund_total numeric not null default 0,
  method       text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
alter table bill_returns enable row level security;
drop policy if exists "staff_select_bill_returns" on bill_returns;
create policy "staff_select_bill_returns" on bill_returns for select using (is_staff());

create or replace function pos_schema_version() returns int
language sql stable set search_path = public, pg_temp as $$ select 2 $$;

-- 1. กัน "แก้สต็อก/หนี้ตรงๆ" — ต้องผ่าน RPC เท่านั้น (RPC ตั้ง app.balance_write = on) ----------
-- auth.uid() เป็น NULL (SQL Editor / service role) ผ่านได้เสมอ
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
drop trigger if exists trg_guard_variant_stock on product_variants;
create trigger trg_guard_variant_stock before insert or update on product_variants
  for each row execute function guard_balance_columns();
drop trigger if exists trg_guard_customer_debt on customers;
create trigger trg_guard_customer_debt before insert or update on customers
  for each row execute function guard_balance_columns();

-- 2. จำกัดสิทธิ์เขียนตรงบนตาราง (ธุรกรรมเขียนผ่าน RPC เท่านั้น) ---------------------------------
do $$
declare t text;
begin
  -- บิล/รายการบิล/ประวัติสต็อก: อ่านได้ แต่ห้ามเขียนตรง (RPC แบบ security definer ข้าม RLS อยู่แล้ว)
  foreach t in array array['bills','bill_items','inventory_movements'] loop
    execute format('drop policy if exists "staff_insert_%1$s" on %1$s;', t);
    execute format('drop policy if exists "staff_update_%1$s" on %1$s;', t);
    execute format('drop policy if exists "manager_delete_%1$s" on %1$s;', t);
  end loop;
  -- ข้อมูลหลัก/บัญชี: เขียนได้เฉพาะ manager ขึ้นไป
  foreach t in array array['categories','products','product_categories','product_variants','product_fractions',
                           'purchase_orders','purchase_order_items','cash_ledger','accounts_payable'] loop
    execute format('drop policy if exists "staff_insert_%1$s" on %1$s;', t);
    execute format('drop policy if exists "staff_update_%1$s" on %1$s;', t);
    execute format('drop policy if exists "manager_insert_%1$s" on %1$s;', t);
    execute format('drop policy if exists "manager_update_%1$s" on %1$s;', t);
    execute format('create policy "manager_insert_%1$s" on %1$s for insert with check (is_manager());', t);
    execute format('create policy "manager_update_%1$s" on %1$s for update using (is_manager()) with check (is_manager());', t);
  end loop;
end $$;

-- 3. constraint (NOT VALID = ไม่ตรวจข้อมูลเก่า แต่บังคับกับข้อมูลใหม่) ------------------------
do $$ begin
  alter table bills add constraint bills_payment_method_chk
    check (upper(payment_method) in ('CASH','TRANSFER','CREDIT')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table bill_items add constraint bill_items_qty_pos_chk check (quantity > 0) not valid;
exception when duplicate_object then null; end $$;

-- 4. RPC -----------------------------------------------------------------------------------
-- ลบฟังก์ชันเวอร์ชันเก่าทุก signature ก่อน (ชื่อเดียวกันแต่พารามิเตอร์ต่างกันจะไม่ชนกัน)
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('create_sale','process_return','receive_customer_payment','adjust_stock',
                               'bootstrap_first_owner','receive_purchase_order','receive_goods',
                               'seed_variant_stock','seed_customer_debt')
  loop
    execute format('drop function if exists %s cascade;', r.sig);
  end loop;
end $$;

-- 4.1 bootstrap_first_owner — ตรวจรูปแบบ hash + กันแข่งกันสร้าง OWNER
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

-- 4.2 create_sale — idempotent ตามเลขบิล; ตรวจส่วนลด/จำนวน/วงเงิน/สต็อก; ล็อกแถวเรียงตาม id (กัน deadlock)
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

-- 4.3 process_return — ใช้ราคาจากบิลจริง (ไม่เชื่อราคาจากเครื่อง), หักสัดส่วนส่วนลด, กันคืนเกิน, idempotent
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

-- 4.4 receive_customer_payment — idempotent ด้วย p_op_ref
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

-- 4.5 adjust_stock — manager ขึ้นไป, idempotent ด้วย p_op_ref, เก็บเหตุผล
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

-- 4.6 seed_* — ส่งค่าตั้งต้น (ครั้งเดียว) ของสต็อก/หนี้ที่เซิร์ฟเวอร์ยังไม่เคยรู้ ไม่ทับค่าที่ seeded แล้ว
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

-- 4.7 receive_goods — ใบรับของ + บวกสต็อก + ต้นทุนถัวเฉลี่ย ใน transaction เดียว, idempotent ด้วย p_client_ref
-- p_items: [{product_id, variant_id, quantity, unit_cost}]
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

-- 4.8 receive_purchase_order (ของเดิม) — คงไว้ให้เข้ากันได้: ผ่าน trigger, ตรวจว่ารายการเป็นของ PO นี้จริง, ถัวเฉลี่ยต้นทุน
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

-- 5. search_path ของ security definer ทุกตัวใน public + จำกัดสิทธิ์ execute ---------------------
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef
  loop
    execute format('alter function %s set search_path = public, pg_temp', r.sig);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('create_sale','process_return','receive_customer_payment','adjust_stock',
                               'bootstrap_first_owner','receive_purchase_order','receive_goods',
                               'seed_variant_stock','seed_customer_debt','delete_entity',
                               'factory_reset_cloud_data','is_staff','is_manager','is_owner','has_perm')
  loop
    begin
      execute format('revoke all on function %s from public, anon', r.sig);
      execute format('grant execute on function %s to authenticated', r.sig);
    exception when undefined_object then null;   -- ไม่ใช่ Supabase (ไม่มี role anon/authenticated)
    end;
  end loop;
end $$;
