-- Apply once to an empty Neon PostgreSQL database before setting DATABASE_URL on Render.
CREATE TABLE IF NOT EXISTS faerie_documents (
  kind text PRIMARY KEY CHECK (kind IN ('members', 'posts', 'popup', 'logs')),
  data jsonb NOT NULL,
  revision char(40) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS faerie_images (
  filename text PRIMARY KEY CHECK (filename ~ '^[a-f0-9-]{36}\.webp$'),
  kind text NOT NULL CHECK (kind IN ('member', 'popup')),
  mime_type text NOT NULL DEFAULT 'image/webp',
  body bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
