-- DB-PATCH-01 (ฉบับแก้ไข) — ปิดกะแบบคำนวณเงินคาดการณ์ฝั่งเซิร์ฟเวอร์
-- ใช้กับ supabase/schema.sql ของ repo นี้ (schema version 3) รันซ้ำได้ปลอดภัย (idempotent)
-- แก้จากฉบับเดิม: ไม่ใช้ pos_is_owner()/auth_user_id ใน audit_logs ที่ไม่มีอยู่จริง,
-- ใส่ id ให้ audit_logs, และรวมยอด "ขายเงินสด" จากตาราง bills (create_sale ไม่เขียนลง cash_ledger)

alter table shifts add column if not exists expected_cash  numeric;
alter table shifts add column if not exists cash_variance  numeric;
alter table shifts add column if not exists close_note     text;

create or replace function close_shift(
  p_shift_id    uuid,
  p_actual_cash numeric,
  p_note        text    default null,
  p_manual_in   numeric default 0,    -- เงินเข้าลิ้นชักที่บันทึกมือ (ยังไม่อยู่ในฐานข้อมูล)
  p_manual_out  numeric default 0     -- เงินออกลิ้นชักที่บันทึกมือ
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me        app_users%rowtype;
  v_shift     shifts%rowtype;
  v_cash_sales numeric;
  v_ledger_in  numeric;
  v_ledger_out numeric;
  v_expected   numeric;
  v_variance   numeric;
begin
  if not is_staff() then raise exception 'ไม่มีสิทธิ์ปิดกะ'; end if;
  select * into v_me from app_users where auth_user_id = auth.uid() and is_active;

  if p_actual_cash is null or p_actual_cash < 0 then
    raise exception 'ยอดเงินสดที่นับได้ต้องไม่ติดลบ';
  end if;
  if coalesce(p_manual_in,0) < 0 or coalesce(p_manual_out,0) < 0 then
    raise exception 'ยอดเงินเข้า/ออกมือต้องไม่ติดลบ';
  end if;

  select * into v_shift from shifts where id = p_shift_id for update;
  if not found then raise exception 'ไม่พบกะนี้'; end if;
  if v_shift.status = 'CLOSED' then raise exception 'กะนี้ปิดไปแล้ว'; end if;
  -- แคชเชียร์ปิดได้เฉพาะกะที่ตัวเองเปิด; ผู้จัดการขึ้นไปปิดแทนได้
  if v_shift.opened_by is not null and v_shift.opened_by <> v_me.id and not is_manager() then
    raise exception 'ปิดได้เฉพาะกะที่คุณเปิดเอง (หรือต้องเป็นผู้จัดการ)';
  end if;

  -- ขายเงินสด: นับทุกบิลของกะ รวมที่ถูกยกเลิกภายหลัง เพราะเงินคืนถูกบันทึกเป็น expense-refund ใน ledger แล้ว
  select coalesce(sum(total),0) into v_cash_sales
    from bills where shift_id = p_shift_id and upper(payment_method) = 'CASH';

  select coalesce(sum(income),0), coalesce(sum(expense),0) into v_ledger_in, v_ledger_out
    from cash_ledger where shift_id = p_shift_id
      and type not in ('SHIFT_CASH_IN','SHIFT_CASH_OUT');   -- สองชนิดนี้มาจากพารามิเตอร์ p_manual_in/out กันนับซ้ำ

  v_expected := round(v_shift.opening_cash + v_cash_sales + v_ledger_in - v_ledger_out
                      + coalesce(p_manual_in,0) - coalesce(p_manual_out,0), 2);
  v_variance := round(p_actual_cash - v_expected, 2);

  if v_variance <> 0 and coalesce(btrim(p_note),'') = '' then
    raise exception 'ยอดไม่ตรง (ต่าง %) กรุณาระบุสาเหตุ', v_variance;
  end if;

  update shifts set status = 'CLOSED', closed_at = now(), closed_by = v_me.id,
         closing_cash = round(p_actual_cash,2), expected_cash = v_expected,
         cash_variance = v_variance, close_note = nullif(btrim(coalesce(p_note,'')),'')
   where id = p_shift_id;

  insert into audit_logs (id, actor_app_user_id, actor_name, actor_role, action, entity, entity_id, detail, meta, device_id)
  values (gen_random_uuid(), v_me.id, v_me.name, v_me.role, 'SHIFT_CLOSE', 'shift', p_shift_id::text,
          format('ปิดกะ คาดการณ์ %s นับได้ %s ต่าง %s', v_expected, p_actual_cash, v_variance),
          jsonb_build_object('cash_sales', v_cash_sales, 'ledger_in', v_ledger_in, 'ledger_out', v_ledger_out,
                             'manual_in', coalesce(p_manual_in,0), 'manual_out', coalesce(p_manual_out,0), 'note', p_note),
          'server');

  return jsonb_build_object('expected_cash', v_expected, 'actual_cash', round(p_actual_cash,2),
                            'variance', v_variance, 'cash_sales', v_cash_sales);
end $$;

create or replace function guard_closed_shift() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status = 'CLOSED' and not is_owner() then
    raise exception 'กะที่ปิดแล้วแก้ไขได้เฉพาะเจ้าของร้าน';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_closed_shift on shifts;
create trigger trg_guard_closed_shift before update on shifts
  for each row execute function guard_closed_shift();

revoke all on function close_shift(uuid, numeric, text, numeric, numeric) from public, anon;
grant execute on function close_shift(uuid, numeric, text, numeric, numeric) to authenticated;

-- ตรวจผล:  select close_shift('<shift-uuid>', 1500, 'ทดสอบ', 0, 0);
