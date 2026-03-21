# Android clients

| App | Path | Role |
|-----|------|------|
| ApiX Agent | `client/` | Standalone relay |
| ApiX QKSMS | `test/qksms/` | SMS app + gateway drawer |

## Build (local)

See root `README.md` → CI/CD & GitHub Actions.

## SMS vs voice (QKSMS / gateway)

- **Voice calls** use the carrier circuit; **SMS** goes through the **default SMS app** and your **ApiX relay** to the server.
- If QKSMS is **not** the default SMS app, or the **ApiX gateway** drawer is not connected (**Start relay** + server reachable), you can see **no MO/MT SMS** while **calls still work**.
- **Install signature:** you cannot update the Play Store QKSMS with a sideloaded ApiX build — **uninstall** the store app first, then install the ApiX-signed APK (same package `com.moez.QKSMS`, different signing key).

_Add device-specific pairing notes, QR flow, and test numbers in your private `wiki/` copy._
