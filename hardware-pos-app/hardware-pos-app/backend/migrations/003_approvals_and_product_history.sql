-- v1.5.0: approval workflow for stock adjustments and product price/cost changes.
-- Back up the database and apply as a schema owner before restarting the API.
BEGIN;
CREATE TABLE IF NOT EXISTS approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type text NOT NULL CHECK (request_type IN ('inventory_adjustment','product_price_change','product_cost_change')),
  entity_type text NOT NULL CHECK (entity_type IN ('variant')),
  entity_id uuid NOT NULL REFERENCES product_variants(id),
  payload jsonb NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by uuid NOT NULL REFERENCES app_users(id),
  decided_by uuid REFERENCES app_users(id),
  decision_note text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK ((status='pending' AND decided_by IS NULL AND decided_at IS NULL) OR (status<>'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS approval_requests_status_time_idx ON approval_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS approval_requests_entity_idx ON approval_requests(entity_id, created_at DESC);
INSERT INTO schema_migrations(version,description) VALUES('003','Approval workflow and product history') ON CONFLICT(version) DO NOTHING;
COMMIT;
