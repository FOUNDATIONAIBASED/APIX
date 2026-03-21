# Dashboard UI shell (`ui_shell_config`)

Optional JSON stored in **Settings** as `ui_shell_config` (via `PUT /api/v1/settings` as admin, or SQLite `settings` table).

## Shape

```json
{
  "logout_redirect": "/login",
  "post_login_redirect": "/",
  "buttons": {
    "logout": "Sign out",
    "sign_out": "Sign out"
  }
}
```

- **`logout_redirect`**: Path only, must start with `/` (not `//`). Used after **Sign out** in the web console.
- **`post_login_redirect`**: Reserved for future use (login flow still honors `?redirect=` first).
- **`buttons`**: Keys must match `^[a-z0-9_]+$`. Currently the dashboard applies **`logout`** / **`sign_out`** to the top bar **Sign out** button (`#logoutBtn`).

## Example (curl, session cookie)

```bash
curl -sS -X PUT "http://127.0.0.1:3000/api/v1/settings" \
  -H "Content-Type: application/json" \
  -H "Cookie: apix_session=YOUR_SESSION" \
  -H "X-CSRF-Token: YOUR_CSRF" \
  -d '{"ui_shell_config":{"logout_redirect":"/login","buttons":{"logout":"End session"}}}'
```

## CSRF

Cookie sessions require `X-CSRF-Token` (or JSON `_csrf`) matching `apix_csrf`. The console sets this from `GET /api/auth/me` (`csrf_token` in JSON + cookie).
