# ApiX Server (Node.js)

Express API, WebSocket agent bridge, **SQLite** persistence (`better-sqlite3`), and the operator UI in **`public/`** (dashboard + **`/docs`**).

[![package.json version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FFOUNDATIONAIBASED%2FAPIX%2Fmain%2Fserver%2Fpackage.json&query=%24.version&label=ApiX%20Server&logo=npm&logoColor=white&color=3b82f6)](./package.json)

**Software version:** the authoritative value is the `"version"` field in **[`package.json`](./package.json)** (same value the web UI and `GET /api/v1/admin/update-check` use). The badge above reflects that file on the **`main`** branch of [FOUNDATIONAIBASED/APIX](https://github.com/FOUNDATIONAIBASED/APIX) when viewed on GitHub; your **local** checkout may differ until you push.

---

## Quick start

```bash
cd server
npm install
cp .env.example .env
# Set at least JWT_SECRET and HMAC_SECRET (e.g. openssl rand -hex 32)
node src/index.js
```

- **UI:** `http://<host>:3000` (default `PORT=3000`)  
- **API docs (HTML):** `http://<host>:3000/docs` → [`public/docs.html`](./public/docs.html)  
- **API test console:** `http://<host>:3000/api-test.html` — preset requests (editable), device + `device_strategy` (`auto` spreads sends across online devices).  
- **Health / status:** `GET /api/v1/status`

**Node:** ≥ 18 (`package.json` → `engines`).

---

## Project layout

| Path | Role |
|------|------|
| `src/index.js` | App entry: middleware, routes, static files |
| `src/routes/` | REST: auth, messages, devices, campaigns, … |
| `src/email/` | Multi-SMTP: `smtpConfig`, `smtpRouter`, limits, transport |
| `src/db.js` | SQLite models and migrations |
| `public/index.html` | Web console (sidebar includes link to `/docs`) |
| `public/api-test.html` | Interactive API tester (session or `X-API-Key`) |
| `public/docs.html` | Full API reference (examples, tables) |
| `data/` | Default DB directory (`DB_PATH` in `.env`) |

---

## Environment

See **[`.env.example`](./.env.example)** for every variable. Highlights:

| Variable | Purpose |
|----------|---------|
| `PORT`, `HOST` | Listen address (default `3000`, `0.0.0.0`) |
| `JWT_SECRET`, `HMAC_SECRET` | Required secrets — change before production |
| `DEPLOYMENT_MODE` | `homelab` vs `production` — CORS + whether `?api_key=` is allowed |
| `CORS_ORIGINS` | Comma-separated allowed Origins when locked down |
| `USE_SSL` | `true` behind HTTPS reverse proxy (cookies / HSTS behavior) |
| `DB_PATH` | SQLite file path |
| `FACTORY_RESET_NO_RESTART` | `true` = do not spawn a replacement process after factory reset (use with **systemd** `Restart=always` / **pm2**) |

**Security overview:** [`SECURITY.md`](./SECURITY.md) (API test page, factory reset, pairing, production tips).
| `SMTP_*` | Legacy single SMTP when **no** DB profiles exist |
| `SMTP_MAX_PROFILES` | Cap for UI/API stored profiles (default **25**, max **100**) |
| `EMAIL_PRESET` | Transactional HTML template: **`dark`** (default) or **`light`** — matches management UI palette |
| `IMAP_SECRET_KEY` | Optional 32+ char secret for encrypting stored IMAP passwords (defaults to deriving from `JWT_SECRET`) |
| `EMAIL_BRAND_COLOR` | Accent color for buttons / logo in templates |

---

## Authentication (two paths)

1. **Browser session** — `POST /api/auth/login` with `username` / `password` → `Set-Cookie: apix_session=…`. Admin-only routes (e.g. **`/api/auth/email-smtp/*`**) require an **admin** user with this cookie (or equivalent session token if your client sends it).
2. **API key** — `X-API-Key` or `Authorization: Bearer` for `/api/v1/*` automation. In **production** mode, query-string `api_key` is rejected.

---

## Multi-SMTP (transactional email)

- **UI:** Settings → **Email / SMTP** (admin): JSON profiles, routing, quotas, test send.  
- **API:** `GET/PUT /api/auth/email-smtp/config`, `GET /api/auth/email-smtp/usage`, `POST /api/auth/email-smtp/test` (session + admin).  
- **Behavior:** If **any** profile is saved in the database, **`.env` `SMTP_*` is not used** for sending. Use **`0`** in `limits` for unlimited in that window (UTC buckets).  
- **Docs:** Root [`README.md`](../README.md) → *Node.js server handbook* and **`/docs`** → *Email / Multi-SMTP*.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | `node src/index.js` |
| `npm run dev` | `node --watch src/index.js` |

---

## Safe updates & backups

- **Interactive:** [`apix.sh`](./apix.sh) → option **10** (backup → `git pull` → `npm install` → verify; **revert** + `update-error.log` on failure).
- **Direct:** [`scripts/apix-update.sh`](./scripts/apix-update.sh) — backups under **`server/.apix-backups/updates/<timestamp>/`**.
- **GitHub APK links in UI:** `GET /api/v1/admin/github-releases` (session cookie); configure **`GITHUB_REPO`** (default `FOUNDATIONAIBASED/APIX`).
- **Version vs GitHub:** `GET /api/v1/admin/update-check` compares **`package.json` `version`** to GitHub releases using **semver** (via `semver`); **pre-releases** like `v0.0.1-rc1` are treated as the latest release unless **`GITHUB_RELEASES_STABLE_ONLY=true`**. The UI shows green/red/cyan in the top bar and under **Settings → Software version** (this bullet does **not** print the number — see the badge at the top of this file and [`package.json`](./package.json)).

## Further reading

- **Operator + architecture overview:** [`../README.md`](../README.md)  
- **Deep spec (if present in repo):** [`../ApiX_Gateway_Architecture.md`](../ApiX_Gateway_Architecture.md)
