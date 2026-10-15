-- Hardware POS v1.2.0 migration. Back up the database before applying.
BEGIN;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS open_operation_id text UNIQUE;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS close_operation_id text UNIQUE;
COMMIT;
