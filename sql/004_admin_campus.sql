-- Apply after 003_admin_mfa.sql to enable campus-scoped admin accounts.
ALTER TABLE faerie_admin_users ADD COLUMN IF NOT EXISTS campus text;

ALTER TABLE faerie_admin_users DROP CONSTRAINT IF EXISTS faerie_admin_users_role_check;
ALTER TABLE faerie_admin_users
  ADD CONSTRAINT faerie_admin_users_role_check CHECK (role IN ('super', 'editor', 'campus_admin'));

ALTER TABLE faerie_admin_users DROP CONSTRAINT IF EXISTS faerie_admin_users_campus_check;
ALTER TABLE faerie_admin_users
  ADD CONSTRAINT faerie_admin_users_campus_check
  CHECK (
    (role = 'campus_admin' AND campus IS NOT NULL AND campus = 'quy-nhon')
    OR (role IN ('super', 'editor') AND campus IS NULL)
  );
