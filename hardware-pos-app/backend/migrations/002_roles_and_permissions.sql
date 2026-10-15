-- v1.4.0: role-based access control. Review and back up before applying.
BEGIN;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'cashier';
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('owner','manager','cashier','inventory','accountant'));
-- Preserve the ability to administer an existing installation: promote the oldest active account.
WITH first_user AS (SELECT id FROM app_users WHERE is_active=true ORDER BY created_at,id LIMIT 1)
UPDATE app_users SET role='owner' WHERE id IN (SELECT id FROM first_user) AND NOT EXISTS (SELECT 1 FROM app_users WHERE role='owner' AND is_active=true);
INSERT INTO schema_migrations(version,description) VALUES('002','Role-based access control and user administration') ON CONFLICT(version) DO NOTHING;
COMMIT;
