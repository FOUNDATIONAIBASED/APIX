# ApiX Gateway — Enterprise SMS/MMS Gateway Platform

A self-hosted, enterprise-grade SMS/MMS gateway that orchestrates a fleet of Android devices as messaging endpoints. Features a modern real-time web dashboard, full REST/Webhook API, AI inference integration (Ollama + OpenAI-compatible), intelligent message routing, load balancing, and campaign management — all within a unified control plane.

> **Your infrastructure, your rules.**

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
- [Web Console](#web-console)
- [REST API Quick Reference](#rest-api-quick-reference)
- [Architecture](#architecture)

---

## System Overview

ApiX Gateway consists of four core components:

| Component | Role |
|-----------|------|
| **ApiX Server** | Central Node.js/Go backend — REST API, WebSocket, message routing, queue management |
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

### Manual Server Configuration

If running outside Docker or on a different subnet:

1. Start the ApiX Server and note its IP and port.
2. Open the web UI at `http://IP:port` (e.g. `http://192.168.50.19:3000`) — **do not use https://** unless behind an HTTPS proxy.
3. In the ApiX Console (web UI), go to **Settings > Network** and verify mDNS broadcasting is enabled.
4. On the Android agent, if auto-discovery doesn't find the server, use **Enter Server Manually** and provide the IP/port.

---

## Web Console

The **ApiX Console** is a React + Vite + TailwindCSS web app that provides:

- **Dashboard** — live throughput graphs, device fleet grid, number pool heatmap, AI queue depth
- **Conversations** — iMessage/WhatsApp-style threaded view with live sync
- **Devices** — real-time device grid with approval workflow (Pending > Approved > Active)
- **Numbers** — full number pool with carrier, health score, usage stats
- **Campaigns** — bulk SMS/MMS builder with delay modes, number routing, carrier safety scoring
- **API Keys & Webhooks** — scoped key management, webhook subscriptions, delivery logs
- **AI Instances** — manage Ollama/OpenAI endpoints, load balancing, trigger configuration
- **Statistics** — per-number, per-device, per-campaign breakdowns with CSV/PDF export

---

## REST API Quick Reference

Base URL: `https://your-server/api/v1/`
Auth: `Authorization: Bearer <API_KEY>`

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

Full API documentation is available at `https://your-server/api/docs` (OpenAPI 3.1).

---

## Architecture

For the complete system architecture, feature specification, database schemas, webhook events, AI engine configuration, campaign management details, and security model, see:

[**ApiX_Gateway_Architecture.md**](./ApiX_Gateway_Architecture.md)

---

## License

Private / Proprietary. All rights reserved.
