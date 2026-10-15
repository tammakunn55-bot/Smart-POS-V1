-- POS Local Server + PostgreSQL blueprint v2.0.0
-- Single shop. Role-based API permissions; PIN login; append-only audit log.
-- PostgreSQL 14+. Run as a database administrator on a NEW database after review.
-- This file is a schema foundation, NOT yet a production-certified deployment.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  shop_name text NOT NULL,
  phone text,
  tax_id text,
  address text,
  receipt_footer text,
  currency_code char(3) NOT NULL DEFAULT 'THB',
  timezone text NOT NULL DEFAULT 'Asia/Bangkok',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  pin_hash text NOT NULL,
  role text NOT NULL DEFAULT 'cashier' CHECK (role IN ('owner','manager','cashier','inventory','accountant')),
  is_active boolean NOT NULL DEFAULT true,
  failed_pin_attempts integer NOT NULL DEFAULT 0 CHECK (failed_pin_attempts >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  token_hash text NOT NULL UNIQUE,
  device_id text,
  device_label text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  actor_username text,
  device_id text,
  request_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  outcome text NOT NULL CHECK (outcome IN ('success','failure','denied')),
  summary text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_logs_time_idx ON audit_logs(occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  parent_id uuid REFERENCES categories(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  tax_id text,
  address text,
  note text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suppliers_name_idx ON suppliers(name);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  category_id uuid REFERENCES categories(id),
  supplier_id uuid REFERENCES suppliers(id),
  image_url text,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_name_idx ON products USING gin (to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category_id);

CREATE TABLE IF NOT EXISTS product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  variant_sku text NOT NULL DEFAULT '',
  variant_name text NOT NULL DEFAULT '',
  barcode text UNIQUE,
  unit_name text NOT NULL DEFAULT 'ชิ้น',
  cost_price numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  sale_price numeric(14,2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  low_stock_threshold numeric(14,3) NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id, variant_name)
);
CREATE INDEX IF NOT EXISTS product_variants_product_idx ON product_variants(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_variant_sku_uq ON product_variants (lower(trim(variant_sku)));
CREATE INDEX IF NOT EXISTS product_variants_product_variant_name_idx ON product_variants (product_id, variant_name);

CREATE TABLE IF NOT EXISTS product_sell_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  unit_name text NOT NULL CHECK (length(trim(unit_name)) BETWEEN 1 AND 40),
  barcode text UNIQUE,
  conversion_factor numeric(14,3) NOT NULL CHECK (conversion_factor > 1),
  sale_price numeric(14,2) NOT NULL CHECK (sale_price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(variant_id, unit_name)
);
CREATE INDEX IF NOT EXISTS product_sell_units_variant_idx ON product_sell_units(variant_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS product_sell_units_barcode_idx ON product_sell_units(barcode) WHERE is_active;

CREATE TABLE IF NOT EXISTS inventory_balances (
  variant_id uuid PRIMARY KEY REFERENCES product_variants(id),
  quantity numeric(14,3) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  movement_type text NOT NULL CHECK (movement_type IN
    ('opening','purchase_receipt','sale','sale_return','purchase_return','adjustment','void_reversal')),
  quantity_delta numeric(14,3) NOT NULL CHECK (quantity_delta <> 0),
  unit_cost numeric(14,2),
  reference_type text,
  reference_id uuid,
  reason text,
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text UNIQUE
);
CREATE INDEX IF NOT EXISTS inventory_movements_variant_time_idx ON inventory_movements(variant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS inventory_movements_ref_idx ON inventory_movements(reference_type, reference_id);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code text UNIQUE,
  name text NOT NULL,
  phone text,
  tax_id text,
  address text,
  credit_limit numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  note text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_name_idx ON customers(name);
CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers(phone);

CREATE TABLE IF NOT EXISTS bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided','partially_returned','returned')),
  customer_id uuid REFERENCES customers(id),
  seller_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  subtotal numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  paid_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  due_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (due_amount >= 0),
  note text,
  operation_id text NOT NULL UNIQUE,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  void_reason text,
  CHECK (paid_amount + due_amount = total_amount)
);
CREATE INDEX IF NOT EXISTS bills_created_idx ON bills(created_at DESC);
CREATE INDEX IF NOT EXISTS bills_customer_idx ON bills(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bills_seller_idx ON bills(seller_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bill_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  sku_snapshot text NOT NULL,
  product_name_snapshot text NOT NULL,
  variant_name_snapshot text NOT NULL DEFAULT '',
  unit_name_snapshot text NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  unit_cost_snapshot numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost_snapshot >= 0),
  discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  line_total numeric(14,2) NOT NULL CHECK (line_total >= 0),
  sold_unit_id uuid REFERENCES product_sell_units(id) ON DELETE SET NULL,
  unit_conversion_factor numeric(14,3) NOT NULL DEFAULT 1 CHECK (unit_conversion_factor > 0),
  base_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (base_quantity >= 0)
);
CREATE INDEX IF NOT EXISTS bill_items_bill_idx ON bill_items(bill_id);
CREATE INDEX IF NOT EXISTS bill_items_variant_idx ON bill_items(variant_id);

CREATE TABLE IF NOT EXISTS bill_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES bills(id),
  method text NOT NULL CHECK (method IN ('cash','transfer','credit','other')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reference_no text,
  received_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  operation_id text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS bill_payments_bill_idx ON bill_payments(bill_id);

CREATE TABLE IF NOT EXISTS customer_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  entry_type text NOT NULL CHECK (entry_type IN ('credit_sale','payment','debit_adjustment','credit_adjustment','sale_void','return')),
  debit_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
  credit_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  bill_id uuid REFERENCES bills(id),
  customer_payment_id uuid,
  note text,
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  operation_id text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (debit_amount > 0 AND credit_amount > 0))
);
CREATE INDEX IF NOT EXISTS customer_ledger_customer_time_idx ON customer_ledger(customer_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS customer_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('cash','transfer','other')),
  reference_no text,
  note text,
  received_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  operation_id text NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_payments_customer_time_idx ON customer_payments(customer_id, received_at DESC);

ALTER TABLE customer_ledger
  DROP CONSTRAINT IF EXISTS customer_ledger_customer_payment_fk;
ALTER TABLE customer_ledger
  ADD CONSTRAINT customer_ledger_customer_payment_fk
  FOREIGN KEY (customer_payment_id) REFERENCES customer_payments(id);

CREATE TABLE IF NOT EXISTS sales_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_no text NOT NULL UNIQUE,
  bill_id uuid NOT NULL REFERENCES bills(id),
  reason text NOT NULL,
  refund_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
  operation_id text NOT NULL UNIQUE,
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sales_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES sales_returns(id),
  bill_item_id uuid NOT NULL REFERENCES bill_items(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  refund_amount numeric(14,2) NOT NULL CHECK (refund_amount >= 0)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no text NOT NULL UNIQUE,
  supplier_id uuid REFERENCES suppliers(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_received','received','cancelled')),
  note text,
  operation_id text NOT NULL UNIQUE,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  quantity_ordered numeric(14,3) NOT NULL CHECK (quantity_ordered > 0),
  unit_cost numeric(14,2) NOT NULL CHECK (unit_cost >= 0)
);
CREATE TABLE IF NOT EXISTS purchase_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no text NOT NULL UNIQUE,
  purchase_order_id uuid REFERENCES purchase_orders(id),
  supplier_id uuid REFERENCES suppliers(id),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
  operation_id text NOT NULL UNIQUE,
  received_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_receipt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES purchase_receipts(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  quantity_received numeric(14,3) NOT NULL CHECK (quantity_received > 0),
  unit_cost numeric(14,2) NOT NULL CHECK (unit_cost >= 0)
);

CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_no text NOT NULL UNIQUE,
  opened_by uuid NOT NULL REFERENCES app_users(id),
  closed_by uuid REFERENCES app_users(id),
  opening_cash numeric(14,2) NOT NULL CHECK (opening_cash >= 0),
  expected_cash numeric(14,2) NOT NULL DEFAULT 0,
  counted_cash numeric(14,2),
  cash_difference numeric(14,2),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  note text
);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_idx ON shifts ((status)) WHERE status = 'open';
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS open_operation_id text UNIQUE;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS close_operation_id text UNIQUE;

CREATE TABLE IF NOT EXISTS cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES shifts(id),
  movement_type text NOT NULL CHECK (movement_type IN ('cash_in','cash_out','sale_cash','customer_payment_cash','refund_cash','opening_float','closing_adjustment')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reference_type text,
  reference_id uuid,
  note text,
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  operation_id text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','synced','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);
CREATE INDEX IF NOT EXISTS sync_outbox_pending_idx ON sync_outbox(status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  destination text PRIMARY KEY,
  last_success_at timestamptz,
  last_event_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sync_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  destination text NOT NULL,
  event_id uuid,
  error_message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE TABLE IF NOT EXISTS backup_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_type text NOT NULL CHECK (backup_type IN ('manual','scheduled','before_restore')),
  storage_location text NOT NULL,
  checksum_sha256 text,
  status text NOT NULL CHECK (status IN ('started','completed','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  note text
);

-- Utility function: write audit events. The application server should call this for every mutation,
-- including failed/denied attempts. Do not place PINs, session tokens, or secrets in JSON arguments.
CREATE OR REPLACE FUNCTION pos_write_audit(
  p_actor_user_id uuid,
  p_actor_username text,
  p_device_id text,
  p_request_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_outcome text,
  p_summary text,
  p_before jsonb DEFAULT NULL,
  p_after jsonb DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO audit_logs(actor_user_id, actor_username, device_id, request_id, action,
    entity_type, entity_id, outcome, summary, before_data, after_data, metadata)
  VALUES (p_actor_user_id, p_actor_username, p_device_id, p_request_id, p_action,
    p_entity_type, p_entity_id, p_outcome, p_summary, p_before, p_after,
    COALESCE(p_metadata, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Idempotent stock movement helper. The caller must wrap related business records in the same transaction.
CREATE OR REPLACE FUNCTION pos_apply_stock_movement(
  p_variant_id uuid,
  p_quantity_delta numeric,
  p_movement_type text,
  p_reference_type text,
  p_reference_id uuid,
  p_reason text,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_unit_cost numeric DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_qty numeric(14,3);
BEGIN
  IF p_quantity_delta = 0 THEN RAISE EXCEPTION 'quantity_delta cannot be zero'; END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'idempotency key required';
  END IF;

  PERFORM 1 FROM product_variants WHERE id = p_variant_id AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'variant not found or inactive'; END IF;

  INSERT INTO inventory_balances(variant_id, quantity)
  VALUES (p_variant_id, 0) ON CONFLICT (variant_id) DO NOTHING;

  PERFORM 1 FROM inventory_balances WHERE variant_id = p_variant_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM inventory_movements WHERE idempotency_key = p_idempotency_key) THEN
    SELECT quantity INTO v_qty FROM inventory_balances WHERE variant_id = p_variant_id;
    RETURN v_qty;
  END IF;

  SELECT quantity + p_quantity_delta INTO v_qty
  FROM inventory_balances WHERE variant_id = p_variant_id;
  IF v_qty < 0 THEN RAISE EXCEPTION 'insufficient stock'; END IF;

  INSERT INTO inventory_movements(variant_id, movement_type, quantity_delta, unit_cost,
    reference_type, reference_id, reason, actor_user_id, idempotency_key)
  VALUES (p_variant_id, p_movement_type, p_quantity_delta, p_unit_cost,
    p_reference_type, p_reference_id, p_reason, p_actor_user_id, p_idempotency_key);

  UPDATE inventory_balances SET quantity = v_qty, updated_at = now()
  WHERE variant_id = p_variant_id;
  RETURN v_qty;
END;
$$;

-- Customer payment: debt payment is a receipt, not a new sale.
CREATE OR REPLACE FUNCTION pos_receive_customer_payment(
  p_customer_id uuid,
  p_amount numeric,
  p_method text,
  p_operation_id text,
  p_actor_user_id uuid,
  p_reference_no text DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_payment_id uuid;
BEGIN
  IF p_amount <= 0 THEN RAISE EXCEPTION 'payment amount must be positive'; END IF;
  IF p_method NOT IN ('cash','transfer','other') THEN RAISE EXCEPTION 'invalid payment method'; END IF;
  IF p_operation_id IS NULL OR length(trim(p_operation_id)) = 0 THEN RAISE EXCEPTION 'operation id required'; END IF;

  SELECT id INTO v_payment_id FROM customer_payments WHERE operation_id = p_operation_id;
  IF v_payment_id IS NOT NULL THEN RETURN v_payment_id; END IF;

  PERFORM 1 FROM customers WHERE id = p_customer_id AND is_active = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer not found or inactive'; END IF;

  INSERT INTO customer_payments(customer_id, amount, method, reference_no, note, received_by, operation_id)
  VALUES (p_customer_id, p_amount, p_method, p_reference_no, p_note, p_actor_user_id, p_operation_id)
  RETURNING id INTO v_payment_id;

  INSERT INTO customer_ledger(customer_id, entry_type, debit_amount, credit_amount,
    customer_payment_id, note, actor_user_id, operation_id)
  VALUES (p_customer_id, 'payment', 0, p_amount, v_payment_id, p_note, p_actor_user_id,
    'customer-payment:' || p_operation_id);

  INSERT INTO sync_outbox(event_type, entity_type, entity_id, payload)
  VALUES ('customer_payment.received', 'customer_payment', v_payment_id::text,
    jsonb_build_object('payment_id', v_payment_id, 'customer_id', p_customer_id,
      'amount', p_amount, 'method', p_method, 'received_at', now()));

  RETURN v_payment_id;
END;
$$;

-- Explicitly prevent UPDATE/DELETE of audit history through ordinary SQL roles.
CREATE OR REPLACE FUNCTION pos_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;
DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_update_delete
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION pos_reject_audit_mutation();

INSERT INTO schema_migrations(version, description)
VALUES ('2.0.0', 'Single-shop local POS schema foundation: PIN users, audit, inventory, sales, debt, purchasing, shifts, sync')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- SECURITY DEPLOYMENT NOTES:
-- 1. Do not expose PostgreSQL directly to the internet or the browser.
-- 2. The Local Server owns login/session issuance, verifies PIN hashes with a vetted password-hashing library,
--    stores only token hashes, rate-limits login, and injects authenticated actor IDs into SQL calls.
-- 3. Use a dedicated least-privilege DB role for the Local Server. Revoke public execution/table access as part
--    of deployment-specific grants. Do not grant browser clients direct database access.
-- 4. Every write endpoint must use a DB transaction, require an idempotency key, and write audit + sync_outbox.
-- 5. This file deliberately does not implement every business RPC (sale/return/shift/purchase/restore) yet.
