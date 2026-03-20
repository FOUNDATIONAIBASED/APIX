# ApiX Gateway — Enterprise SMS/MMS Gateway Platform

A self-hosted, enterprise-grade SMS/MMS gateway that orchestrates a fleet of Android devices as messaging endpoints. Features a modern real-time web dashboard, full REST/Webhook API, AI inference integration (Ollama + OpenAI-compatible), intelligent message routing, load balancing, and campaign management — all within a unified control plane.

> **Your infrastructure, your rules.**

[![ApiX Server — version from package.json](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FFOUNDATIONAIBASED%2FAPIX%2Fmain%2Fserver%2Fpackage.json&query=%24.version&label=ApiX%20Server&logo=node.js&logoColor=white&color=3b82f6)](https://github.com/FOUNDATIONAIBASED/APIX/blob/main/server/package.json)

**Version source of truth:** [`server/package.json`](./server/package.json) (`version` field). The web console shows a **WordPress-style** status pill in the top bar: **green** when you match the newest GitHub release, **red** when a newer tag exists (including **pre-releases** like `v0.0.1-rc1`), and **cyan** when your local version is **ahead** of GitHub (fork / unpublished). Set `GITHUB_RELEASES_STABLE_ONLY=true` in `server/.env` to ignore pre-releases when picking “latest”.

---

## Table of Contents

- [System Overview](#system-overview)
- [Android Client — ApiX Agent](#android-client--apix-agent)
  - [Compatibility](#compatibility)
  - [Features](#features)
  - [Setup & Installation](#setup--installation)
  - [Server Auto-Discovery](#server-auto-discovery)
  - [Reboot Persistence](#reboot-persistence)
  - [SMS & MMS Support](#sms--mms-support)
  - [UI Overview](#ui-overview)
  - [Permissions](#permissions)
  - [Building from Source](#building-from-source)
- [Server Setup](#server-setup)
- [Node.js server handbook (this repo)](#nodejs-server-handbook-this-repo)
- [Email & multi-SMTP (transactional)](#email--multi-smtp-transactional)
- [Web Console](#web-console)
- [REST API Quick Reference](#rest-api-quick-reference)
- [CI/CD & GitHub Actions](#cicd--github-actions)
- [Architecture](#architecture)

---

## System Overview

ApiX Gateway consists of four core components:

| Component | Role |
|-----------|------|
| **ApiX Server** | Central backend — REST API, WebSocket, message routing, queue management |
| **ApiX Agent** | Android client app — relays SMS/MMS through device SIM(s), reports device telemetry |
| **ApiX Console** | React web dashboard — real-time conversations, device management, campaigns, analytics |
| **AI Engine** | Ollama / OpenAI-compatible inference — auto-reply, intent classification, sentiment analysis |

```
┌──────────────────────────────────────────────────────────────┐
│                      Your Network                            │
│                                                              │
│  ┌────────────────┐   WebSocket/TLS    ┌─────────────────┐   │
│  │  Android Agent  │◄─────────────────►│                 │   │
│  │  (KitKat 4.4+)  │                   │  ApiX Server    │   │
│  │  SIM: +1xxx     │   mDNS Discovery  │  :3000 / :4000  │   │
│  └────────────────┘◄─────────────────►│                 │   │
│                                        │  ┌─ REST API     │   │
│  ┌────────────────┐                    │  ├─ WebSocket    │   │
│  │  Android Agent  │◄─────────────────►│  └─ Webhooks    │   │
│  │  (Android 15)   │                   │                 │   │
│  │  SIM: +1yyy     │                   └────────┬────────┘   │
│  └────────────────┘                             │            │
│                                           ┌─────▼──────┐     │
│  ┌───────────────────────────────┐        │ PostgreSQL │     │
│  │  Web Browser (ApiX Console)   │        │ + Redis    │     │
│  │  Socket.IO ← Live Sync       │        └────────────┘     │
│  └───────────────────────────────┘                           │
└──────────────────────────────────────────────────────────────┘
```

> **This repository’s server** is implemented in **Node.js 18+** with **SQLite** (`better-sqlite3`) and serves the dashboard from `server/public/`. The diagram above is a logical overview; your deployment may use Docker-style services or a single `node src/index.js` process — see [Node.js server handbook (this repo)](#nodejs-server-handbook-this-repo).

---

## Android Client — ApiX Agent

### Compatibility

| Android Version | API Level | Supported | Notes |
|-----------------|-----------|-----------|-------|
| **4.4 KitKat** | 19 | Yes | Full SMS + MMS sending. Uses legacy XML-based UI (AppCompat). |
| **5.0–5.1 Lollipop** | 21–22 | Yes | Full SMS + MMS. Material Design v1 UI. |
| **6.0 Marshmallow** | 23 | Yes | Runtime permissions added — agent handles gracefully. |
| **7.0–7.1 Nougat** | 24–25 | Yes | Multi-window support. |
| **8.0–8.1 Oreo** | 26–27 | Yes | Background execution limits handled via foreground service. |
| **9 Pie** | 28 | Yes | |
| **10–11** | 29–30 | Yes | Scoped storage handled. |
| **12–12L** | 31–32 | Yes | Exact alarm permissions handled. |
| **13** | 33 | Yes | Notification runtime permission handled. |
| **14** | 34 | Yes | |
| **15** | 35–36 | Yes | Latest. Full Material You / Dynamic Color support. |

**Minimum SDK**: 19 (Android 4.4 KitKat)
**Target SDK**: 36 (Android 15)

The app uses **AppCompat** and **Material Components** to deliver a consistent, polished UI across all versions. On Android 12+ devices with Material You, the agent automatically adopts the system dynamic color palette.

### Features

- **SMS sending and receiving** — relay messages through the device's SIM card(s)
- **MMS sending and receiving** — full MMS support including on KitKat (API 19–20) where the system MMS APIs are available natively
- **Multi-SIM support** — dual-SIM devices report both slots; route through either
- **Server auto-discovery** — mDNS/NSD scan finds ApiX Server instances on the local network automatically
- **Manual server entry** — fallback to enter server IP/hostname and port manually
- **Reboot persistence** — optional toggle: when enabled, the agent service auto-starts on device boot and reconnects to the server without user intervention
- **Persistent foreground service** — keeps the agent alive in the background with a non-dismissible notification showing connection status
- **Real-time telemetry** — reports SIM numbers, carrier, signal strength, battery level, and send quotas to the server
- **Encrypted transport** — TLS 1.3 with rotating HMAC token authentication
- **Automatic reconnection** — WebSocket connection to the server auto-reconnects with exponential backoff on network loss
- **Live send/receive log** — scrollable log of all SMS/MMS activity on the device

### Setup & Installation

#### From APK

1. Download the latest `apix-agent.apk` from the Releases page.
2. On the Android device, enable **Install from unknown sources** (Settings > Security on KitKat; Settings > Apps > Special access on newer versions).
3. Open the APK and install.
4. Launch **ApiX Agent**.
5. Grant requested permissions (SMS, Phone, Contacts, Notifications — see [Permissions](#permissions)).
6. The agent will automatically scan for ApiX Server instances on the local network.

#### From Play Store (if published)

Search for **ApiX Agent** and install directly.

### Server Auto-Discovery

The agent uses Android's **Network Service Discovery (NSD)** framework to find ApiX Server instances broadcasting on the local network.

**How it works:**

1. The ApiX Server broadcasts an mDNS service of type `_apix._tcp.local` containing its IP address, port, and instance name.
2. When the agent app launches (or when the user taps **Scan for Servers**), it initiates an NSD discovery session listening for `_apix._tcp.local` services.
3. Discovered servers appear in a list showing:
   - Server instance name (e.g., "Office ApiX", "Home Gateway")
   - IP address and port
   - Latency (ping time)
4. Tap a server to connect. On first connection, the server marks the device as **Pending** — an admin must approve it from the ApiX Console.
5. Once approved, subsequent connections are automatic.

**Fallback — Manual Entry:**

If auto-discovery fails (e.g., across subnets without mDNS relay), tap **Enter Server Manually** and provide:
- Server hostname or IP address
- Port number (default: 3000)
- Pairing token (displayed in ApiX Console under Devices > Add Device)

**Server-side discovery:**

The server also actively scans for agents announcing themselves via `_apix-agent._tcp.local`. This bidirectional discovery ensures devices and servers find each other even when one side starts before the other.

### Reboot Persistence

The agent includes a **Boot Receiver** (`RECEIVE_BOOT_COMPLETED`) that re-launches the foreground service after the device restarts.

**This feature is controlled by a toggle in the agent's Settings screen:**

| Setting | Behavior |
|---------|----------|
| **Start on Boot: ON** | After a reboot, the agent automatically starts its foreground service, reconnects to the last-known server, and resumes relaying SMS/MMS. No user interaction required. |
| **Start on Boot: OFF** | After a reboot, the agent does nothing until the user manually opens the app. |

**Implementation details:**

- On **KitKat–Nougat (API 19–25)**: Uses `RECEIVE_BOOT_COMPLETED` broadcast receiver. The foreground service starts immediately on boot.
- On **Oreo+ (API 26+)**: Uses `RECEIVE_BOOT_COMPLETED` + `startForegroundService()` to comply with background execution limits. A persistent notification is displayed within 5 seconds of service start.
- On **Android 13+ (API 33+)**: The notification runtime permission (`POST_NOTIFICATIONS`) must be granted before the first boot-start. The agent prompts for this during initial setup.
- On **Android 12+ (API 31+)**: Exact alarm permission (`SCHEDULE_EXACT_ALARM`) is requested for heartbeat scheduling if needed.

**The boot receiver respects the toggle state.** If the user has disabled "Start on Boot" in the agent UI, the receiver exits immediately without starting any service. The preference is stored in `SharedPreferences` and persists across app updates.

### SMS & MMS Support

#### SMS

Standard SMS sending and receiving is supported across all versions (API 19+). The agent uses `SmsManager` to dispatch outbound messages and a `BroadcastReceiver` on `SMS_RECEIVED` to capture inbound messages and push them to the server in real time.

- Messages exceeding 160 characters are automatically split into multipart SMS.
- Delivery reports are tracked and forwarded to the server.

#### MMS (KitKat and above)

MMS support is available starting from **Android 4.4 KitKat**, which was the first version where Android provided a public system-level MMS API.

| Version | MMS Approach |
|---------|-------------|
| **KitKat (API 19)** | Uses the system `Telephony` content provider and `SendBroadcastReceiver` for MMS dispatch. KitKat introduced the ability for non-default SMS apps to hand off MMS to the default messaging app, or to act as the default SMS app itself for full MMS control. |
| **Lollipop+ (API 21+)** | Uses `SmsManager.sendMultimediaMessage()` and `downloadMultimediaMessage()` — the standard public MMS API introduced in Lollipop. |

**MMS capabilities:**

- Send images, audio, video, vCards, and other media as MMS
- Receive MMS and forward media attachments to the server (base64-encoded or uploaded to server storage)
- Group MMS support (send to multiple recipients in a single MMS)
- MMS subject line support
- Automatic fallback: if MMS fails, the server is notified and can retry through a different device

**On KitKat specifically:**

KitKat was the version that first allowed third-party apps to be set as the **default SMS/MMS application**, which granted full MMS sending capability. The ApiX Agent can request to be set as the default SMS app on KitKat devices to gain MMS access. A prompt guides the user through this during setup if MMS relay is desired. On Lollipop and above, the dedicated `SmsManager` MMS API removes this requirement.

### UI Overview

The agent app uses **Material Components for Android** (AppCompat on KitKat/Lollipop) with a clean, card-based layout designed for quick status visibility and minimal interaction.

#### Screens

**1. Discover / Connect**
- Animated radar-style scan animation while searching for servers
- List of discovered servers with instance name, IP, port, and ping latency
- "Enter Server Manually" button at the bottom
- Connection progress indicator with status text

**2. Home / Dashboard**
- Connection status indicator — large colored dot (green = connected, amber = reconnecting, red = disconnected) with server name
- SIM card info cards — one card per SIM slot showing: phone number, carrier name, signal strength bar, and slot number
- Today's stats — message send count, receive count, and failure count in large readable typography
- Battery level indicator with estimated remaining time
- Quick-action buttons: Pause Relay, View Log, Settings

**3. Message Log**
- Chronological, scrollable list of all SMS/MMS sent and received through this device
- Each entry shows: direction arrow (in/out), phone number, message preview, timestamp, and delivery status icon
- Pull-to-refresh to resync with server
- Filter tabs: All, Sent, Received, Failed
- MMS entries show a media thumbnail

**4. Settings**
- **Server Connection**: Current server info, Disconnect / Switch Server button
- **Start on Boot**: Toggle — "Automatically start ApiX Agent when the device restarts"
- **Foreground Notification**: Notification content customization
- **Default SMS App** (KitKat): Prompt to set agent as default SMS app for MMS support
- **Theme**: Light / Dark / Follow System (Android 10+)
- **Advanced**: WebSocket ping interval, heartbeat frequency, TLS certificate pinning, log verbosity

**Design principles:**
- Large touch targets and readable fonts — the app is often run on secondary/older devices
- Dark theme support across all versions (AppCompat DayNight)
- Dynamic Color / Material You on Android 12+ (automatic palette from wallpaper)
- Minimal battery impact — the UI is lightweight; the foreground service is optimized for low wake-lock usage
- Accessible: TalkBack support, sufficient contrast ratios, content descriptions on all interactive elements

### Permissions

| Permission | Required | Purpose |
|------------|----------|---------|
| `SEND_SMS` | Yes | Send SMS messages through device SIM |
| `RECEIVE_SMS` | Yes | Capture incoming SMS for relay to server |
| `READ_SMS` | Yes | Access SMS history for conversation context |
| `SEND_MMS` / `WRITE_APN_SETTINGS` | KitKat | MMS sending on API 19 (as default SMS app) |
| `READ_PHONE_STATE` | Yes | Detect SIM info, carrier, signal strength, multi-SIM state |
| `READ_PHONE_NUMBERS` | API 26+ | Read SIM phone numbers on Oreo+ |
| `RECEIVE_BOOT_COMPLETED` | Yes | Start service on device reboot (when enabled) |
| `FOREGROUND_SERVICE` | API 28+ | Run persistent background relay service |
| `FOREGROUND_SERVICE_SPECIAL_USE` | API 34+ | Foreground service type declaration |
| `POST_NOTIFICATIONS` | API 33+ | Show foreground service notification on Android 13+ |
| `INTERNET` | Yes | WebSocket/TLS connection to ApiX Server |
| `ACCESS_NETWORK_STATE` | Yes | Detect network availability for reconnection logic |
| `ACCESS_WIFI_STATE` | Yes | mDNS/NSD server discovery on local network |
| `CHANGE_WIFI_MULTICAST_STATE` | Yes | Enable mDNS multicast reception for auto-discovery |
| `WAKE_LOCK` | Yes | Keep service alive during message relay |
| `SCHEDULE_EXACT_ALARM` | API 31+ | Precise heartbeat scheduling |

On **Android 6.0+**, dangerous permissions (SMS, Phone) are requested at runtime with clear rationale dialogs explaining why each permission is needed.

### Building from Source

#### Prerequisites

- **Android Studio** Ladybug (2024.2+) or newer
- **JDK 11** or higher
- **Gradle 8.x** (bundled with the project wrapper)

#### Steps

```bash
# Clone the repository
git clone https://github.com/your-org/apix-gateway.git
cd apix-gateway/client

# Build debug APK
./gradlew assembleDebug

# The APK is at:
# app/build/outputs/apk/debug/app-debug.apk

# Build release APK (requires signing config)
./gradlew assembleRelease

# Install directly to connected device
./gradlew installDebug
```

#### GitHub Actions (releases)

See [CI/CD & GitHub Actions](#cicd--github-actions) in this README for current JDK/SDK versions.

#### Project Structure

```
client/
├── app/
│   ├── src/main/
│   │   ├── java/com/example/apixclient/
│   │   │   ├── ApiXApplication.kt            # Application class
│   │   │   ├── ui/
│   │   │   │   ├── discover/                  # Server discovery screen
│   │   │   │   ├── home/                      # Dashboard screen
│   │   │   │   ├── log/                       # Message log screen
│   │   │   │   └── settings/                  # Settings screen
│   │   │   ├── service/
│   │   │   │   ├── AgentForegroundService.kt  # Persistent foreground service
│   │   │   │   ├── SmsRelayService.kt         # SMS send/receive handling
│   │   │   │   ├── MmsRelayService.kt         # MMS send/receive handling
│   │   │   │   └── BootReceiver.kt            # BOOT_COMPLETED receiver
│   │   │   ├── network/
│   │   │   │   ├── WebSocketClient.kt         # Server WebSocket connection
│   │   │   │   ├── ServerDiscovery.kt         # mDNS/NSD auto-discovery
│   │   │   │   └── ApiXAuth.kt               # HMAC token authentication
│   │   │   └── model/
│   │   │       ├── DeviceInfo.kt              # SIM, battery, signal data
│   │   │       └── Message.kt                 # SMS/MMS message model
│   │   ├── res/
│   │   │   ├── layout/                        # XML layouts (AppCompat)
│   │   │   ├── values/                        # Themes, colors, strings
│   │   │   └── xml/                           # Backup rules, network config
│   │   └── AndroidManifest.xml
│   └── build.gradle.kts                       # App-level build config
├── build.gradle.kts                           # Project-level build config
├── settings.gradle.kts
├── gradle/
│   └── libs.versions.toml                     # Version catalog
└── gradlew / gradlew.bat                      # Gradle wrapper
```

#### Key Dependencies

| Library | Purpose |
|---------|---------|
| `androidx.appcompat` | Backward-compatible UI (KitKat+) |
| `com.google.android.material` | Material Design components |
| `androidx.core-ktx` | Kotlin extensions for Android APIs |
| OkHttp | WebSocket client for server communication |
| Moshi / Gson | JSON serialization for message payloads |

---

## Server Setup

### Docker Compose (Recommended)

```yaml
services:
  apix-server:     # Main API + WebSocket server
  apix-worker:     # Background job processor (bulk sends, webhooks)
  apix-ui:         # React frontend (served via Nginx)
  postgres:        # Persistent storage
  redis:           # Cache, queues, pub/sub
```

```bash
docker compose up -d
```

The server broadcasts `_apix._tcp.local` on the local network. Android agents will discover it automatically.

### Access Modes: HTTP, IP, and Domain Binding

ApiX supports three access patterns:

| Mode | Use case | Configuration |
|------|----------|---------------|
| **HTTP + IP** | LAN, lab, no domain (e.g. `http://192.168.50.19:3000`) | Default. Use `http://` (not `https://`). Leave `USE_SSL` unset or `false`. |
| **HTTP + hostname** | Same network, hostname resolution (e.g. `http://apix.local:3000`) | Same as above. mDNS or local hosts file for name resolution. |
| **HTTPS + domain** | Production with public domain (e.g. `https://gateway.example.com`) | Put Nginx/Caddy in front for SSL termination. Set `USE_SSL=true` and `TRUSTED_PROXIES=1` (or higher). |

**Important:** If you see `SSL_ERROR_RX_RECORD_TOO_LONG`, you are using `https://` while the server serves HTTP. Use `http://` until you have configured a reverse proxy with TLS.

### Deployment mode, CORS, and API keys

| Setting | Homelab (default) | Production |
|--------|-------------------|------------|
| `DEPLOYMENT_MODE` | `homelab` | `production` |
| Browser CORS | Permissive (any origin) | Only origins listed in `CORS_ORIGINS` (comma-separated) |
| API key in URL | `?api_key=` allowed | **Blocked** — use `X-API-Key` or `Authorization: Bearer` |
| Session cookie `Secure` | Set when the request is HTTPS or `USE_SSL=true` | Same (always use HTTPS in production) |

After the first-time setup wizard, `deployment_mode` is stored in the database and can be changed under **Settings** (`deployment_mode`). **Factory reset** wipes all data, users, devices, settings, SMTP send counters, and local backup files under `data/`, then exits; the server **starts a replacement Node process** after a short delay (so bare `nohup` installs are not left permanently down). If you use **systemd** or **pm2** with automatic restart, set **`FACTORY_RESET_NO_RESTART=true`** in `.env` to avoid two instances.

### Email & multi-SMTP (transactional)

Password resets, invitations, and other transactional mail go through a **multi-SMTP** layer in the Node server (`server/src/email/`).

| Topic | Details |
|--------|---------|
| **Profiles** | Stored in SQLite (`settings.smtp_profiles_json`). Default **25** profiles, **max 100** — override with `SMTP_MAX_PROFILES` in `server/.env`. |
| **Legacy `.env`** | If **no** DB profiles are configured, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, etc. are used. If **any** DB profile exists, `.env` SMTP is **ignored** for sending. |
| **Quotas** | Per profile: `hourly`, `daily`, `weekly`, `monthly` limits. Use **`0`** for unlimited on that window. Counts use **UTC** calendar buckets. |
| **Routing** | `fallback` (priority order, skip exhausted / retry on error), `round_robin`, `least_used` (fewest sends in current UTC hour). |
| **Admin alerts** | When usage crosses `limit_warn_threshold_pct` (default 80%) or a window is full, admins get an email (deduped per profile per UTC day). Recipients: `smtp_admin_notify_emails` plus users with role **admin** and an **email** on file. |
| **UI** | **Settings → Email / SMTP** (admin): JSON editor, routing, threshold, **Refresh usage**, **Test SMTP**. |
| **API** | Session cookie, **admin only**: `GET/PUT /api/auth/email-smtp/config`, `GET /api/auth/email-smtp/usage`, `POST /api/auth/email-smtp/test`. See **`/docs`** (`server/public/docs.html`). |
| **Status** | `GET /api/v1/status` includes `smtp_configured`, `smtp_profile_count`, `smtp_routing_mode`, and a redacted primary host/from/user preview. |

**Security note:** SMTP passwords in DB settings are stored in **plain text** (like other server-stored secrets). Restrict filesystem/backup access to the SQLite database.

### Manual Server Configuration

If running outside Docker or on a different subnet:

1. Start the ApiX Server and note its IP and port.
2. Open the web UI at `http://IP:port` (e.g. `http://192.168.50.19:3000`) — **do not use https://** unless behind an HTTPS proxy.
3. In the ApiX Console (web UI), go to **Settings > Network** and verify mDNS broadcasting is enabled.
4. On the Android agent, if auto-discovery doesn't find the server, use **Enter Server Manually** and provide the IP/port.

### Node.js server handbook (this repo)

Use this when you run the gateway from the `server/` folder (not a separate Docker stack).

#### Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Node.js** | **≥ 18** (see `server/package.json` → `engines`) |
| **npm** | Comes with Node |
| **Build tools** | `better-sqlite3` needs a C++ toolchain on some platforms (`build-essential` on Debian/Ubuntu, Xcode CLT on macOS) |

#### First run (development / homelab)

```bash
cd server
npm install
cp .env.example .env
# Edit .env: set JWT_SECRET, HMAC_SECRET (e.g. openssl rand -hex 32)
node src/index.js
# or: npm run dev   (watch mode)
```

Open **`http://<server-ip>:3000`** (default `PORT=3000`). On a fresh database you’ll get the **setup wizard** to create the first admin user. After that, sign in from the browser; the UI stores a session cookie (`apix_session`).

#### What lives where

```
server/
├── src/index.js          # HTTP server, mounts routes & static files
├── src/routes/           # REST handlers (auth, messages, devices, …)
├── src/email/            # Multi-SMTP config, routing, limits, transport
├── public/               # Dashboard SPA (index.html) + /docs (docs.html)
├── data/                 # SQLite DB path (default ./data/apix.db from .env)
└── .env                  # Secrets & tuning (copy from .env.example)
```

#### Two ways to authenticate

| Method | When to use | How |
|--------|-------------|-----|
| **Browser session** | Using the web UI; admin-only routes (e.g. multi-SMTP) | Log in via UI or `POST /api/auth/login` → cookie `apix_session` (also returns `token` in JSON for APIs that accept it) |
| **API key** | Scripts, mobile apps, integrations | Header `X-API-Key: apix_…` or `Authorization: Bearer apix_…` |

In **`DEPLOYMENT_MODE=production`**, putting the API key in the query string (`?api_key=`) is **disabled** — use headers only. See [Deployment mode, CORS, and API keys](#deployment-mode-cors-and-api-keys).

#### Health check

```bash
curl -s http://127.0.0.1:3000/api/v1/status | jq .
```

Useful fields: general uptime, `smtp_configured`, `smtp_profile_count`, `smtp_routing_mode`, and redacted SMTP preview when configured.

#### Multi-SMTP: save config with `curl` (admin session)

After logging in, reuse the session cookie for admin API calls.

```bash
BASE=http://127.0.0.1:3000
# 1) Log in (captures Set-Cookie)
curl -s -c cookies.txt -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}'

# 2) PUT full config (admin only)
curl -s -b cookies.txt -X PUT "$BASE/api/auth/email-smtp/config" \
  -H "Content-Type: application/json" \
  -d '{
    "routing_mode": "fallback",
    "limit_warn_threshold_pct": 80,
    "admin_notify_emails": "ops@example.com",
    "profiles": [
      {
        "id": "primary",
        "enabled": true,
        "name": "SendGrid lane",
        "host": "smtp.sendgrid.net",
        "port": 587,
        "secure": false,
        "user": "apikey",
        "pass": "SG.xxx",
        "from": "alerts@example.com",
        "from_name": "ApiX Gateway",
        "reply_to": "support@example.com",
        "pool": false,
        "tls_reject_unauthorized": true,
        "priority": 10,
        "limits": { "hourly": 100, "daily": 2000, "weekly": 0, "monthly": 0 }
      },
      {
        "id": "backup",
        "enabled": true,
        "name": "Gmail relay",
        "host": "smtp.gmail.com",
        "port": 587,
        "secure": false,
        "user": "you@gmail.com",
        "pass": "app-password",
        "from": "you@gmail.com",
        "priority": 20,
        "limits": { "hourly": 0, "daily": 0, "weekly": 0, "monthly": 0 }
      }
    ]
  }'

# 3) Verify transport
curl -s -b cookies.txt -X POST "$BASE/api/auth/email-smtp/test" \
  -H "Content-Type: application/json" \
  -d '{}'

# 4) Optional: test only one profile
curl -s -b cookies.txt -X POST "$BASE/api/auth/email-smtp/test" \
  -H "Content-Type: application/json" \
  -d '{"profile_id":"primary"}'
```

**Routing modes:** `fallback` (ordered by `priority`, skip exhausted quotas / errors), `round_robin`, `least_used` (fewest sends in the current UTC hour). **Limits:** `0` = unlimited for that window. Buckets are **UTC**.

**Important:** If **any** profile is stored in the database, legacy **`SMTP_*` entries in `.env` are ignored** for sending. Remove DB profiles (or clear `smtp_profiles_json` via UI) to fall back to `.env` SMTP.

#### Troubleshooting (server)

| Symptom | What to check |
|---------|----------------|
| `SSL_ERROR_RX_RECORD_TOO_LONG` in browser | You opened `https://` but the app serves **HTTP**. Use `http://` or terminate TLS in Nginx/Caddy and set `USE_SSL=true`. |
| CORS errors after moving to production | Set `DEPLOYMENT_MODE=production` and `CORS_ORIGINS` to your exact site origins (comma-separated). |
| `401` on `?api_key=` in production | Expected — use `X-API-Key` or `Authorization: Bearer`. |
| Email not sending | `GET /api/auth/email-smtp/usage` (admin); run **Test SMTP** in Settings; confirm `host`/`user`/`pass` and provider rate limits. |
| “No SMTP” but `.env` has values | DB profiles may override — check Settings → Email / SMTP or `GET /api/auth/email-smtp/config` → `using_env_fallback`. |

#### Safe in-place updates (Git + backup + auto-revert)

Use this when the server was installed from a **Git clone** (e.g. [FOUNDATIONAIBASED/APIX](https://github.com/FOUNDATIONAIBASED/APIX)):

1. **Menu:** `cd server && ./apix.sh` → option **`10) Safe update`** (type `UPDATE` to confirm).
2. **Script:** `bash server/scripts/apix-update.sh` (same steps; supports env vars `APIX_GIT_BRANCH`, `APIX_SKIP_SERVICE_STOP`, etc.).

**What it does:** stops the process (systemd `apix-gateway` if present, else `.apix.pid` / port), archives `data/` into `server/.apix-backups/updates/<timestamp>/`, runs `git pull --ff-only`, `npm install`, and `node --check src/index.js`. On any failure it **restores the previous Git commit and data directory** and writes **`update-error.log`** plus **`update.log`** in that session folder. Old sessions are pruned (default: keep **15**).

**Android APKs:** after sign-in, **Settings → Android clients (GitHub)** loads the latest release assets from the API (`GET /api/v1/admin/github-releases`). Set `GITHUB_REPO` in `server/.env` if your fork differs (default `FOUNDATIONAIBASED/APIX`).

**Uninstall:** `./apix.sh` option **9** can optionally remove **`server/.apix-backups/`** and **`server/logs/`** in addition to `node_modules`.

**Full interactive API reference:** open **`/docs`** on your server (file: `server/public/docs.html`).

---

## Web Console

This repository ships a **single-page management UI** under `server/public/` (dashboard, settings, devices, etc.). A separate **React + Vite** console is also described in the architecture doc; use whichever matches your deployment.

#### Documentation in the UI

- In the **left sidebar**, use **API Docs** — opens **`/docs`** in a new tab (`docs.html`). That page is the **detailed REST reference** with copy-paste `curl` examples, authentication notes, multi-SMTP admin APIs, Twilio-compat, and more.
- Bookmark **`http://your-host:3000/docs`** for operators who don’t use the main dashboard.
- **Top bar — version status** (after sign-in): compares **`server/package.json`** to the newest GitHub release using **semver** (pre-releases such as **`v0.0.1-rc1`** count when they sort higher). **Green** = up to date, **red** = update available, **amber** = check failed, **cyan** = local version ahead of GitHub. **Settings → Software version** shows the same detail.

#### Sidebar tour (bundled UI)

| Area | What you use it for |
|------|---------------------|
| **Dashboard** | Fleet overview, throughput, quick health |
| **Conversations** | Threaded SMS view, live updates |
| **Devices** | Approve / suspend Android agents, connection state |
| **Numbers** | Number pool, routing context for sends |
| **Campaigns** | Bulk sends, delays, strategies |
| **Live Feed / Drip** | Operational views for traffic and sequences |
| **Settings** | Network (mDNS), **deployment mode**, **Email / Multi-SMTP** (admin), security-related options |
| **API Docs** | Full server API documentation (this complements the README) |

The bundled **web UI** also includes features such as:

- **API Keys & Webhooks** — scoped keys, outbound webhooks, delivery logs  
- **AI / LLM** — when enabled, Ollama/OpenAI-style endpoints for auto-reply  
- **Statistics / analytics** — usage breakdowns and exports (where implemented in your build)

---

## REST API Quick Reference

**Base URL (typical homelab):** `http://your-server-ip:3000/api/v1/`  
**HTTPS production:** `https://your-domain/api/v1/` (reverse proxy + `USE_SSL=true` on the app)

**Auth:** `X-API-Key: apix_…` or `Authorization: Bearer apix_…` (avoid `?api_key=` in production).

**Example — send one SMS:**

```bash
curl -s -X POST "http://127.0.0.1:3000/api/v1/messages/send" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{"to":"+15551234567","body":"Hello from ApiX"}'
```

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/messages/send` | Send a single SMS/MMS |
| `POST` | `/messages/bulk` | Send bulk SMS with routing strategies |
| `GET` | `/messages` | List messages (filterable) |
| `GET` | `/conversations` | List conversations |
| `GET` | `/conversations/:id/messages` | Get conversation messages |
| `POST` | `/conversations/:id/reply` | Reply in a conversation |
| `GET` | `/devices` | List all connected devices |
| `PATCH` | `/devices/:id` | Suspend/unsuspend a device |
| `GET` | `/numbers` | List all numbers in pool |
| `GET` | `/numbers/available` | List currently available numbers |
| `POST` | `/campaigns` | Create a campaign |
| `POST` | `/campaigns/:id/launch` | Launch a campaign |
| `POST` | `/otp/send` | Send OTP code |
| `POST` | `/otp/verify` | Verify OTP code |

Full API documentation is available at `https://your-server/docs` (static API reference: `server/public/docs.html`). OpenAPI may be offered separately depending on deployment.

---

## CI/CD & GitHub Actions

Workflow: [`.github/workflows/android-build.yml`](.github/workflows/android-build.yml).

| Job | Output |
|-----|--------|
| **`build-client`** | ApiX Agent APK from `client/` — JDK **17**, Gradle wrapper |
| **`build-qksms`** | ApiX QKSMS fork from `test/qksms/` — JDK **17**, Android SDK **API 33** / build-tools **33.0.2**, Gradle **7.6.x** (wrapper), `:presentation:assembleNoAnalyticsDebug` |

- **Releases:** Pushing a tag `v*` builds both jobs and attaches APKs to a GitHub Release.
- **Manual runs:** `workflow_dispatch` builds artifacts without requiring a tag.
- **QKSMS signing:** Debug builds use the default debug keystore on the runner. Release signing in CI only applies when a `test/qksms/keystore` file is present and env vars are set (see `test/qksms/presentation/build.gradle` when `CI=true`).

---

## Architecture

For the complete system architecture, feature specification, database schemas, webhook events, AI engine configuration, campaign management details, and security model, see:

[**ApiX_Gateway_Architecture.md**](./ApiX_Gateway_Architecture.md)

---

## License

Private / Proprietary. All rights reserved.
