# Faerie News API

Node.js 22+ API for the public Faerie House site and its Admin. Run `npm ci`, `npm start`, and `npm test` locally.

Public endpoints: `GET /api/health`, `GET /api/v1/members?year=2026`, `GET /api/v1/events?year=2026`, `GET /api/v1/news`, and `GET /api/v1/popup`.

The homepage popup is configured in `data/popup.json`. Admin can update its visibility, title, introduction, image URL/path, and optional Facebook event link via `PUT /api/v1/admin/popup`. The public API reads the saved config after backend redeployment.
Admin can upload a JPG, PNG, WebP, or supported HEIC popup image (up to 20 MB) via authenticated `POST /api/v1/admin/popup-image` with `{ "mimeType": "image/jpeg", "imageBase64": "..." }`. The backend decodes, resizes, and saves it as a WebP file (up to 3 MB) in `data/popup-images/`. The returned `/api/v1/popup-images/<id>.webp` URL serves from the checkout when available, or reads the newly committed file from GitHub while Render redeploys.

Admin endpoints are limited to the Admin site's origin and require a signed login session: `POST /api/v1/admin/login`, `GET /api/v1/admin/data`, `GET /api/v1/admin/login-logs`, `PUT /api/v1/admin/members`, and `PUT /api/v1/admin/posts`. Password attempts are rate-limited. Successful logins append a timestamp, username, proxy-reported client IP, and inferred OS/browser to `data/admin-login-log.json` in this **private** repository. Only the latest 200 entries are retained. The log is accessible only after Admin login. Render Free's local filesystem is temporary, so the repository is the durable store.

## Render setup

In the Render dashboard, open the **faerienews-backend** web service → **Environment** and add:

| Key | Value |
| --- | --- |
| `ADMIN_USERNAME` | Your chosen Admin username |
| `ADMIN_PASSWORD` | A long, unique Admin password |
| `GITHUB_TOKEN` | Fine-grained token scoped to **only** `Vutheanh11/FaerieHouse-BackEnd` with **Contents: Read and write** |
| `ADMIN_SESSION_SECRET` | A random secret of at least 32 characters; Render Blueprint can generate this, but verify it exists on an already deployed service |

Save with **Save, deploy**. Never add these values to Git, frontend files, or chat. Changing `ADMIN_PASSWORD` or `ADMIN_SESSION_SECRET` requires a new login. The token is used server-side to read/write the private repo and login log; each write triggers a backend redeploy.

The IP is based on the proxy's `X-Forwarded-For` header and can be inaccurate or spoofed in some network setups. The “device” is only an OS/browser guess from User-Agent, not the machine's true name.
