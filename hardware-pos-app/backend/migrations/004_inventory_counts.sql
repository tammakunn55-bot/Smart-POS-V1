-- v1.6.0: cycle stock counts and approved reconciliation.
-- Apply as a schema owner after backing up the database.
BEGIN;
CREATE TABLE IF NOT EXISTS inventory_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_no text NOT NULL UNIQUE,
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  location text,
  reason text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','cancelled')),
  created_by uuid NOT NULL REFERENCES app_users(id),
  decided_by uuid REFERENCES app_users(id),
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  snapshot_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  decided_at timestamptz,
  CHECK ((status IN ('draft','submitted') AND decided_by IS NULL AND decided_at IS NULL) OR (status IN ('approved','rejected','cancelled') AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS inventory_count_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id uuid NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  snapshot_quantity numeric(14,3) NOT NULL CHECK (snapshot_quantity >= 0),
  counted_quantity numeric(14,3) CHECK (counted_quantity >= 0),
  counted_by uuid REFERENCES app_users(id),
  counted_at timestamptz,
  UNIQUE(count_id,variant_id),
  CHECK (counted_quantity IS NULL OR (counted_by IS NOT NULL AND counted_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS inventory_counts_status_time_idx ON inventory_counts(status,created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_count_items_count_idx ON inventory_count_items(count_id);
INSERT INTO schema_migrations(version,description) VALUES('004','Inventory count sessions and approved reconciliation') ON CONFLICT(version) DO NOTHING;
COMMIT;
