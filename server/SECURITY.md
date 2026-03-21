# ApiX Server — security notes (operator)

This document summarizes **hardening assumptions** and **residual risks** for recent features. It is not a full penetration test.

## Factory reset + process restart

- **Admin-only** (`requireAdmin`) with exact phrase confirmation in the body.
- After wipe, a **detached helper** may start a new Node process so bare `nohup` installs recover. Set **`FACTORY_RESET_NO_RESTART=true`** when **systemd** or **pm2** already restarts the service to avoid two listeners on the same port.
- Restart uses fixed paths under the server directory (no user-controlled path).

## API test console (`/api-test.html`)

- Same **session cookie** and **API key** rules as the rest of the API (`X-API-Key` / `Authorization`).
- **Do not** paste production API keys on shared or untrusted machines; the page is static HTML (no server-side stripping of secrets from logs).
- Prefer **HTTPS** in production (`USE_SSL`, reverse proxy) so cookies and keys are not sent in clear text.
- Treat this like any authenticated admin tool: **CSRF** risk exists for cookie-based POSTs from a malicious site if the browser sends cookies cross-site; keep `SameSite` cookie settings strict in production where possible.

## Device pairing

- **Pairing tokens** are short-lived and issued only to users with **`devices:manage`** (`GET /api/v1/devices/pair`).
- **LAN WebSocket URLs** in **`GET /api/v1/devices/server-info`** require **`devices:view`** only — they are not secrets, but they expose internal IPs to authenticated operators (expected for setup).
- **`POST /api/v1/devices/verify-token`** is intentionally public for the Android agent; tokens remain unguessable (random 16 bytes hex) and expire.

## Email & IMAP (`/api/v1/mail/*`)

- **Session-only**, plan feature **`imap_mail`**. IMAP passwords are stored **AES-256-GCM** encrypted; set a strong **`IMAP_SECRET_KEY`** in production (or rely on `JWT_SECRET` derivation — less ideal).
- **Local delete** only removes rows in **`received_emails_local`**; it does **not** delete messages on the remote IMAP server.
- **SMS → email** uses the same **SMTP** stack as other mail; users need a **device owner** assignment and **`imap_mail`** on their plan.
- **IMAP polling** runs every minute; each account also respects its **poll interval** throttle.

## Forwarding rules (`/api/v1/forwarding/*`)

- **Session-only** (no API-key shortcut): requires login and plan feature **`forwarding_rules`**. Returns **402** if the plan does not include it (same as other `requireFeature` routes).
- Rules run **after** the global Telegram forward in `telegram.js` (if enabled). Per-user rules use the **Telegram bot token** from Settings; each rule may set its own **chat ID**.
- **SMS forward** sends outbound SMS via the same **inbound device** when possible (`deviceId` passed to the scheduler).
- **Device → account** link: set **`devices.user_id`** (UI: **Devices → Owner** for admins). Inbound traffic is attributed to that user for rule evaluation.

## My data import (`POST /api/v1/backup/my-data-import`)

- **Session-only**. Accepts JSON matching **user export** schema (`version` 2 or 3); **`user.username` must match** the logged-in account.
- **`replace`** deletes the current user’s messages (by device ownership or API key prefix), **user_stats**, **forwarding_rules**, and **api_keys**, then restores from the file. **`merge`** upserts messages/stats/rules without the full wipe.
- **API keys** in export do not include secrets; **`replace`** creates **new placeholder keys** (hashes are random; clients must create new keys in the UI).

## General

- Keep **JWT_SECRET**, **HMAC_SECRET**, and API keys out of git and chat.
- Use **`DEPLOYMENT_MODE=production`** with **`CORS_ORIGINS`** locked to your UI origin(s) when exposed to the internet.
- Enable **`REQUIRE_API_KEY=true`**; pass keys via **`X-API-Key`** or **`Authorization: Bearer`** only (query-string keys are not supported).
