-- Apply after 001_initial.sql. Passwords are stored as salted scrypt hashes.
CREATE TABLE IF NOT EXISTS faerie_admin_users (
  username text PRIMARY KEY CHECK (username ~ '^[a-z0-9._-]{1,40}$'),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('super', 'editor')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  session_version integer NOT NULL DEFAULT 1,
  disabled boolean NOT NULL DEFAULT false
);
