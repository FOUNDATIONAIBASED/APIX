# Installing Apix CLI (Android)

## “There was a problem parsing the package” (Android 4.x)

**Apix CLI requires Android 5.0 (API 21) or newer.** The app uses libraries and APIs that do not run on Android 4.4 and older, so the system may refuse to install the APK with a parse / package error.

- Use a device (or emulator) running **Lollipop 5.0+**, **or**
- Ensure the APK matches your device **CPU ABI** (e.g. do not sideload an x86-only build on an ARM phone).

## First-time connection

1. Open **Apix CLI** — you start on **network scan** (mDNS), not the QR camera.
2. Use **Enter Server Manually** for IP/hostname and port; optional **pairing token** from the gateway.
3. Or tap **Scan QR Code** if you prefer pairing from the console.
4. The app calls **`POST /api/v1/devices/announce`** so your phone appears under **Security Center → Client discovery hints** on the server (same LAN).

## Debug log in the UI

Enable **Settings → Debug log in UI**, then open **Log → Debug** to see WebSocket connect/register lines (troubleshooting only).
