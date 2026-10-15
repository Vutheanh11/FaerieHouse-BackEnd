-- Apply on the existing Neon database before enabling two-factor authentication.
-- The TOTP seed is encrypted in the backend using ADMIN_SESSION_SECRET.
ALTER TABLE faerie_admin_users ADD COLUMN IF NOT EXISTS mfa_secret text;
