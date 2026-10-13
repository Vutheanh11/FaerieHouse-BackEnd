# Faerie House Backend

Node.js 22+ API for Faerie House. Run `npm ci`, `npm start`, and `npm test` locally.

The production data store is Neon PostgreSQL (`DATABASE_URL`). It stores members, posts, popup settings, login logs, and uploaded member/popup images. Admin changes are visible through the API immediately; they no longer require a GitHub commit or Render redeploy. Existing member photos were imported into `faerie_images` as WebP files. The fixed 2026 event timeline remains in `src/data.mjs`; it is not edited by Admin.

Public endpoints: `GET /api/health`, `GET /api/v1/members?year=2026`, `GET /api/v1/events?year=2026`, `GET /api/v1/news`, `GET /api/v1/popup`, and `GET /api/v1/member-images/<id>.webp`. Admin endpoints require a signed 12-hour login session. The Admin site can upload new member/popup photos; the backend resizes them to WebP before storing them in PostgreSQL.

Admin accounts are stored in `faerie_admin_users` with salted scrypt password hashes. A `super` admin can edit members, publish/delete database News posts, edit popup settings, view login logs, and create `editor` accounts. An `editor` can only publish new News posts and edit/upload the event popup. These permissions are enforced by the API, not just the Admin UI. Admins can change their own password; this invalidates their earlier sessions. The older Render environment account remains available as a temporary `super` fallback and can be removed after the database account is verified. Fixed 2026 event stories in `src/data.mjs` are not database News posts and cannot be deleted through Admin.

## Production configuration

In Render **faerienews-backend → Environment**, upload a secret file named `.env.local` containing `DATABASE_URL=<Neon pooled PostgreSQL URI>`. The Blueprint's start command reads `/etc/secrets/.env.local` at runtime. Keep this file and `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_SESSION_SECRET` secret; never commit them. Alternatively, set `DATABASE_URL` directly as a Render environment variable. When `DATABASE_URL` is present, the API uses PostgreSQL exclusively for mutable data. Without it, the previous GitHub JSON storage remains available as a temporary fallback; `GITHUB_TOKEN` is required only for that fallback and older popup image URLs.

The base schema is in `sql/001_initial.sql`; apply `sql/002_admin_users.sql` to an existing database before deploying this version. Create the initial `super` account separately with a salted hash, never a plaintext password in Git. `scripts/migrate-to-neon.mjs` copies the existing JSON and member/popup images into an **empty** database; it aborts if any database rows already exist. Do not run it again after Admin has made changes. `.env.local` is ignored by Git and must never be uploaded. `GET /api/health` reports `storage: "postgres"` once the live service is connected.

The frontend currently references the same API URL, so no frontend configuration change is needed. Existing JSON files remain in Git as a historical backup; they are not updated after switching to PostgreSQL. The old login log remains in Git history, which matters because this repository is public. Remove/rewrite that history only as a separate, deliberately reviewed security operation.

The IP in login logs is based on the proxy's `X-Forwarded-For` header and may not be reliable. Device text is inferred from the User-Agent; it is not a hardware identity.
