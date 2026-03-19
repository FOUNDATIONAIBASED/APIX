# ApiX Gateway — Enterprise SMS Gateway Platform
## Full System Architecture & Feature Specification

---

## 1. System Overview

**ApiX Gateway** is a self-hosted, enterprise-grade SMS gateway platform that rivals and exceeds Twilio in capability and interface quality. It orchestrates a fleet of Android devices as SMS endpoints, provides a modern real-time web dashboard, exposes a full REST/Webhook API surface, integrates AI inference (Ollama + OpenAI-compatible APIs), and delivers intelligent message routing, load balancing, and forwarding — all within a unified, beautifully designed control plane.

---

## 2. Core Components

### 2.1 ApiX Server (Central Node)
- **Runtime**: Node.js (NestJS) or Go (Fiber) — high-concurrency, low-latency
- **Database**: PostgreSQL (persistent data) + Redis (queues, sessions, pub/sub, caching)
- **Message Broker**: Redis Streams or NATS for real-time event propagation
- **WebSocket Server**: Socket.IO for live Web UI sync
- **REST API**: OpenAPI 3.1 compliant, versioned (`/api/v1/`)
- **Webhook Engine**: Outbound dispatcher with retry logic, signing, and delivery tracking

### 2.2 Android Agent App ("ApiX Agent")
- **Language**: Kotlin (Jetpack Compose UI)
- **Role**: SMS send/receive relay; acts as a virtual modem
- **Communication**: WebSocket connection to ApiX Server (persistent, auto-reconnect)
- **Auto-Discovery**: mDNS/Bonjour broadcast + manual server entry fallback
- **Capabilities**:
  - Send SMS via system SIM(s)
  - Receive SMS and push to server in real time
  - Report SIM card numbers, carrier, signal strength, battery, and send quota
  - Multi-SIM support (dual-SIM devices)
  - Background service with foreground notification
  - Encrypted transport (TLS + HMAC token auth)

### 2.3 Web UI ("ApiX Console")
- **Framework**: React + Vite + TailwindCSS
- **Real-Time**: Socket.IO client — all conversations, device states, queue depths live-sync
- **Sections**: Dashboard, Conversations, Devices, Numbers, API Keys, Webhooks, AI Instances, Forwarding Rules, Statistics, Settings

### 2.4 AI Engine
- **Ollama Integration**: Connect multiple Ollama instances (local or remote)
- **OpenAI-Compatible API**: Works with any OpenAI-API-compatible service (LM Studio, vLLM, Groq, OpenRouter, actual OpenAI)
- **Load Balancer**: Monitors instance availability; queues requests, notifies sender of queue position
- **Trigger System**: Configurable prefix triggers per conversation or globally

---

## 3. Network Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Enterprise Network                    │
│                                                         │
│  ┌──────────────┐     WebSocket/REST     ┌───────────┐  │
│  │  Android     │◄──────────────────────►│           │  │
│  │  Agent #1    │                        │  ApiX     │  │
│  │  (SIM: +1x)  │     mDNS Discovery     │  Server   │  │
│  └──────────────┘◄──────────────────────►│           │  │
│                                          │  :3000    │  │
│  ┌──────────────┐                        │           │  │
│  │  Android     │◄──────────────────────►│  REST API │  │
│  │  Agent #2    │                        │  :4000    │  │
│  │  (SIM: +1y)  │                        │           │  │
│  └──────────────┘                        └─────┬─────┘  │
│                                                │        │
│  ┌──────────────┐                        ┌─────▼─────┐  │
│  │  Ollama      │◄──────────────────────►│ PostgreSQL│  │
│  │  Instance(s) │                        │ + Redis   │  │
│  └──────────────┘                        └───────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Web Browser (ApiX Console)          │   │
│  │              Socket.IO ← Live Sync               │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                            │
                    External Webhooks
                    (Your CRM, App, etc.)
```

---

## 4. Device Auto-Discovery & Management

### 4.1 Discovery Protocol
1. **Server Side**: Broadcasts mDNS service `_apix._tcp.local` with server IP, port, and instance name
2. **Android Agent**: Listens for mDNS broadcasts; displays discovered servers in app UI
3. **Manual Entry**: User can also enter server IP/hostname manually in the agent app
4. **Server Side Discovery**: Server also scans local subnet for active ApiX Agents announcing themselves via `_apix-agent._tcp.local`
5. **Approval Flow**: New devices appear in Web UI as "Pending" → admin approves or rejects
6. **Auto-Add Mode**: Optional setting to auto-approve devices from trusted subnets

### 4.2 Device Lifecycle
- **Add**: Auto-discovered or manual pairing with token exchange
- **Active**: Heartbeat every 30s; server tracks last-seen, signal, battery, send count
- **Suspended**: Admin can suspend a device (no sends, still receives)
- **Remove**: Manual removal from UI or automatic after configurable offline timeout
- **Re-registration**: Device re-announces after removal; requires re-approval

### 4.3 Device Metadata (per device)
```json
{
  "id": "dev_abc123",
  "name": "Office Android - Desk 4",
  "model": "Samsung Galaxy A54",
  "androidVersion": "14",
  "simSlots": [
    { "slot": 1, "number": "+15551234567", "carrier": "T-Mobile", "signal": -72 },
    { "slot": 2, "number": "+15559876543", "carrier": "AT&T", "signal": -65 }
  ],
  "battery": 84,
  "status": "online",
  "lastSeen": "2026-03-06T14:22:00Z",
  "sentToday": 142,
  "receivedToday": 38
}
```

---

## 5. Number Management & Load Balancing

### 5.1 Available Numbers Pool
- All SIM numbers from all active Android Agents form the **Number Pool**
- Each number has: carrier, daily send limit, cooldown period, last used timestamp, success rate
- API: `GET /api/v1/numbers` returns full pool with availability status

### 5.2 Number Selection Strategies
| Strategy | Behavior |
|----------|----------|
| **Round Robin** | Cycles through all available numbers sequentially |
| **Least Recently Used** | Picks the number that sent least recently |
| **Least Used Today** | Picks number with fewest sends today |
| **Carrier Match** | Prefer same carrier as destination (reduces cost) |
| **Manual** | Caller specifies exact sender number |
| **Sticky** | Same conversation always uses same number |

### 5.3 Anti-Spam Cooldown
- If number X just sent a message, it enters a configurable cooldown (default: 30s)
- Next send automatically picks a different number
- Cooldown bypassed for replies in same conversation thread
- Per-number daily limits enforced; number marked "exhausted" when hit

### 5.4 Fetch Available Numbers (SMS Command)
- User texts `@checknumbers` to the gateway number
- System replies with list of all active send-capable numbers
- User can then use `@forward` command (see Section 9)

---

## 6. REST API

Base URL: `https://your-apix-server/api/v1/`
Authentication: Bearer token (API Key)

### 6.1 Send SMS
```http
POST /messages/send
{
  "to": "+15551234567",
  "body": "Hello from ApiX!",
  "from": "+15559876543",        // optional; auto-selected if omitted
  "strategy": "least_recent",   // optional
  "webhookUrl": "https://...",  // optional per-message webhook
  "tags": ["marketing", "q1"]
}
```

### 6.2 Send Bulk SMS
```http
POST /messages/bulk
{
  "messages": [
    { "to": "+1555...", "body": "Hi {{first_name}}" },
    { "to": "+1556...", "body": "Hi {{first_name}}" }
  ],
  "strategy": "round_robin",           // routing strategy
  "numbers": ["all"] | ["+1555..."],   // "all" or explicit list of sender numbers
  "delay": {
    "mode": "random",                  // random | fixed | ramp | wave
    "minSeconds": 30,
    "maxSeconds": 90
  },
  "limits": {
    "perNumberPerHour": 25,
    "perNumberPerDay": 150
  },
  "scheduledAt": "2026-03-07T09:00:00Z",
  "timezone": "recipient"              // recipient | UTC | America/New_York
}
```

### 6.3 Get Messages
```http
GET /messages?direction=inbound&from=2026-03-01&limit=50&cursor=...
```

### 6.4 Conversations
```http
GET /conversations
GET /conversations/:id/messages
POST /conversations/:id/reply  { "body": "..." }
```

### 6.5 Devices
```http
GET /devices
GET /devices/:id
DELETE /devices/:id
PATCH /devices/:id  { "suspended": true }
```

### 6.6 Numbers
```http
GET /numbers                    // all numbers in pool
GET /numbers/available          // only currently available
GET /numbers/:number/stats
```

---

## 7. Webhook System

### 7.1 Webhook Events
| Event | Trigger |
|-------|---------|
| `message.inbound` | SMS received |
| `message.sent` | SMS sent successfully |
| `message.failed` | SMS send failed |
| `message.delivered` | Delivery receipt received |
| `device.online` | Device connected |
| `device.offline` | Device disconnected |
| `conversation.created` | New conversation thread started |
| `ai.response` | AI replied to a trigger message |
| `forward.sent` | Forwarded message sent |

### 7.2 Webhook Formats
All webhooks support multiple payload formats:

**JSON (default)**
```json
{
  "event": "message.inbound",
  "timestamp": "2026-03-06T14:22:00Z",
  "data": {
    "id": "msg_xyz",
    "from": "+15551234567",
    "to": "+15559876543",
    "body": "Hello!",
    "deviceId": "dev_abc123"
  }
}
```

**Form-encoded** (Twilio-compatible)
```
MessageSid=msg_xyz&From=%2B15551234567&To=%2B15559876543&Body=Hello%21
```

**XML** (legacy enterprise compatibility)
```xml
<Message>
  <Event>message.inbound</Event>
  <From>+15551234567</From>
  <Body>Hello!</Body>
</Message>
```

### 7.3 Webhook Security
- HMAC-SHA256 signature on every request (`X-ApiX-Signature` header)
- Configurable retry policy (exponential backoff, up to 72h)
- Delivery log with status per attempt in Web UI

---

## 8. AI Engine

### 8.1 Instance Management
- Add unlimited Ollama instances (URL + optional auth token)
- Add OpenAI-compatible instances (base URL + API key + model name)
- Health monitoring: latency, availability, tokens/sec
- Load balancer distributes inference requests across healthy instances

### 8.2 Load Balancing
- **Strategy**: Least-connections (pick instance with fewest active requests)
- **Queue**: If all instances busy, message enters queue
- **Queue Notification**: System texts sender: *"You are #3 in queue. Estimated wait: 45s"*
- **Timeout**: Configurable max queue wait; falls back to error message if exceeded

### 8.3 Trigger System
Triggers are prefix patterns that activate AI or forwarding rules.

**Built-in triggers (all customizable):**

| Trigger | Action |
|---------|--------|
| `@ollama <message>` | Send to AI, reply to sender |
| `@ai <message>` | Alias for @ollama |
| `@gpt <message>` | Route specifically to OpenAI-compatible instance |
| `@checknumbers` | Reply with available sender numbers |
| `@forward sender:X receiver:Y <msg>` | Forward message as X to Y |
| `@status` | Reply with system status summary |
| `@help` | Reply with available commands |

### 8.4 Custom Prompts
Each AI trigger has a configurable system prompt:
```json
{
  "trigger": "@ollama",
  "model": "llama3.2",
  "systemPrompt": "You are a helpful SMS assistant. Be concise (under 160 chars when possible). Never include markdown.",
  "maxTokens": 300,
  "temperature": 0.7,
  "replyTo": "sender"       // sender | defined_number | both
}
```

### 8.5 Per-Contact AI Mode
- Enable AI auto-reply for specific contacts or number ranges
- No trigger prefix needed — all inbound from that contact routes to AI
- Useful for: customer support automation, scheduling bots, FAQ bots

---

## 9. SMS Forwarding System

### 9.1 Rule-Based Forwarding
Define forwarding rules in Web UI:
```json
{
  "name": "Support Forward",
  "condition": {
    "bodyContains": "SUPPORT",
    "fromNumber": "+1555*"
  },
  "action": {
    "forwardTo": "+15557778888",
    "useNumber": "auto",
    "prependOriginalSender": true
  }
}
```

### 9.2 Interactive Forwarding via SMS Commands

**Step 1 — Check available numbers:**
```
User → Gateway:  @checknumbers

Gateway → User:  Available numbers:
                 1. +15551112222 (T-Mobile, 42 sent today)
                 2. +15553334444 (AT&T, 18 sent today)
                 3. +15555556666 (Verizon, 0 sent today)
```

**Step 2 — Forward a message:**
```
User → Gateway:  @forward sender:+15555556666 receiver:+15559998888 Hey, meeting at 3pm

Gateway → +15559998888 (via +15555556666):  Hey, meeting at 3pm
Gateway → User:  ✓ Forwarded via +15555556666 to +15559998888
```

### 9.3 Auto-Forward on Trigger Words
Rules can trigger on keywords, regex, or AI classification of message intent.

---

## 10. Web UI — ApiX Console

### 10.1 Dashboard
- Live message throughput graph (sends/receives per minute)
- Device fleet status grid (green/yellow/red per device)
- Number pool heatmap (usage intensity per number)
- AI queue depth and instance health
- Recent activity feed (live, real-time)
- Cost savings estimate vs. Twilio pricing

### 10.2 Conversations View
- All conversations listed (like iMessage/WhatsApp Web)
- Live sync — new messages appear instantly via Socket.IO
- Compose new message directly from UI
- Select sender number manually or use auto-select
- AI badge on messages that were AI-generated
- Message status: sent, delivered, failed
- Search and filter by contact, number, date, tag

### 10.3 Devices View
- Grid of all devices with real-time status
- Click device: full detail panel (SIM info, signal, battery, send history)
- Pending devices notification badge
- Approve/Reject/Suspend/Remove actions

### 10.4 Statistics
- Hourly/daily/weekly/monthly send & receive volumes
- Per-number breakdown
- Per-device breakdown  
- Delivery rate, failure rate
- AI usage stats (requests, tokens, avg latency per instance)
- Forwarding rule trigger counts
- Export to CSV/PDF

### 10.5 API Keys & Webhooks
- Create/revoke API keys with permission scopes
- Configure webhook endpoints with event subscriptions
- Webhook delivery log with retry controls

---

## 11. Campaign Management

Campaigns are the primary mechanism for bulk outbound SMS using **private SIM numbers** — personal numbers on Android devices, not registered business short codes or 10DLC numbers. This distinction drives every design decision in the campaign engine: the goal is natural-looking, human-paced sending that avoids carrier flagging.

---

### 11.1 Campaign Types

| Type | Description |
|------|-------------|
| **One-time Blast** | Single message sent to entire contact list |
| **Drip Sequence** | Series of messages spaced over hours/days |
| **Triggered** | Message fired when contact matches a condition |
| **Survey / Poll** | Multi-step conversation with response tracking |

---

### 11.2 Number Routing — Private Number Modes

Because every sender number is a private personal SIM, campaigns must distribute load across numbers in a way that mimics organic usage patterns.

#### Routing Mode Selection

**Mode 1 — All Available (default)**
Automatically distributes sends evenly across every number in the pool that is currently ready (not in cooldown, not at daily limit, health score ≥ threshold). No manual selection required.

**Mode 2 — Choose Numbers**
Admin manually selects a subset of numbers to use for this campaign. Each candidate number is displayed with:
- Phone number + carrier
- Health score (0–100)
- Sends today / daily limit
- Current status: Ready / Cooldown / Exhausted / Pending
- Last used timestamp

Useful when running parallel campaigns and wanting to partition the number pool, or when certain numbers are reserved for specific audiences.

**Mode 3 — Smart Select**
System auto-selects the optimal subset based on:
- Health score ≥ configured minimum (default: 75)
- Carrier diversity (spread across T-Mobile, AT&T, Verizon, etc.)
- Recency (prefer numbers not used in last N hours)
- Remaining daily capacity

#### Number Selection UI Fields
```
[x] +1 (555) 111-2222   T-Mobile   Score: 97   Sent: 412/500   ● Ready
[x] +1 (555) 333-4444   AT&T       Score: 94   Sent: 208/500   ● Ready
[x] +1 (555) 555-6666   Verizon    Score: 99   Sent: 210/500   ● Ready
[ ] +1 (555) 888-9999   Verizon    Score: 62   Sent:   0/500   ○ Low health
[ ] +1 (555) 123-9876   AT&T       Score: 55   Sent:   0/500   ⏱ Cooldown
```

Quick-select helpers: **Select All**, **Deselect All**, **Only Healthy (≥80)**, **By Carrier**.

---

### 11.3 Rotation Strategy

Once numbers are selected, the rotation strategy controls the order in which they are used:

| Strategy | Behavior |
|----------|----------|
| **Round Robin** | Cycle through selected numbers in sequence |
| **Least Recently Used** | Always pick the number that sent the longest time ago |
| **Least Used Today** | Pick number with lowest send count today |
| **Carrier Diversity** | Alternate across carriers; avoid consecutive sends from same carrier |
| **Weighted by Health** | Higher health score = more sends allocated |
| **Sticky per Contact** | Same number always used for same recipient across all campaigns |

---

### 11.4 Delay & Pacing — Private Number Safety

This is the most critical section for private number campaigns. Sending too fast from a personal SIM will trigger carrier spam detection. All delay settings are per-message, between consecutive sends.

#### Delay Modes

**Random Range (recommended)**
Delay between each send is a uniformly random value between `minSeconds` and `maxSeconds`. This is the most natural-looking pattern and hardest for carriers to fingerprint.

```json
{
  "mode": "random",
  "minSeconds": 30,
  "maxSeconds": 90
}
```

**Fixed Delay**
Identical delay between every send. Simpler but creates a detectable periodic signature. Only recommended for very low-volume campaigns.

```json
{
  "mode": "fixed",
  "seconds": 60
}
```

**Gradual Ramp**
Starts at `startSeconds` and linearly increases to `endSeconds` over the campaign duration. Mimics a single person who starts quick and slows down.

```json
{
  "mode": "ramp",
  "startSeconds": 15,
  "endSeconds": 120
}
```

**Wave Pattern**
Alternates between burst phases (fast sends) and rest phases (long pauses). Simulates multiple people sending in shifts.

```json
{
  "mode": "wave",
  "burstCount": 10,
  "burstDelaySeconds": 20,
  "restSeconds": 300
}
```

---

### 11.5 Per-Number Rate Limits

Separate from the inter-message delay, each number has hard caps enforced by the campaign engine:

| Limit | Default | Description |
|-------|---------|-------------|
| `perNumberPerHour` | 25 | Max sends from one number in any 60-min window |
| `perNumberPerDay` | 150 | Max sends from one number in a calendar day |
| `interNumberGapSeconds` | 5 | Minimum pause before switching to next number in pool |
| `cooldownAfterSendSeconds` | 30 | Per-number cooldown after each individual send |

When a number hits its hourly cap, the campaign engine automatically rotates to the next available number. When all numbers are at cap, the campaign pauses and resumes when capacity frees up — this is logged and surfaced in the UI.

---

### 11.6 Quiet Hours

Sends are automatically suppressed outside the configured window:

```json
{
  "quietHours": {
    "enabled": true,
    "start": "09:00",
    "end": "20:00",
    "timezone": "recipient",   // auto-detect from area code
    "allowWeekends": true
  }
}
```

When `timezone: "recipient"` is set, the gateway uses the recipient number's area code to estimate their timezone. Messages queued for outside quiet hours are held and dispatched at the start of the next send window.

---

### 11.7 Carrier Safety Score

The campaign builder calculates a real-time **Carrier Safety Score (0–100)** based on the current configuration:

| Factor | Points | Condition |
|--------|--------|-----------|
| Min delay | +10 | minSeconds ≥ 20 |
| Max delay | +15 | maxSeconds ≥ 60 |
| Delay randomness | +10 | range ≥ 30s |
| Number pool size | +10 | ≥ 5 numbers |
| Number pool size | +5 | ≥ 8 numbers |
| Hourly cap | +5 | perHour ≤ 30 |
| Hourly cap | +5 | perHour ≤ 20 |
| Carrier diversity | +10 | ≥ 2 carriers in pool |
| Base score | +30 | Always |

Scores below 60 show a red warning; 60–79 amber; 80+ green. The UI shows exactly which factors are reducing the score and how to fix them.

---

### 11.8 Send Estimation

Before launching, the UI displays estimated delivery timeline:

```
Recipients:        5,000
Active numbers:    9
Avg delay:         60s
Rate per number:   ~60/hr (capped at 25/hr)
Total rate:        225 msgs/hr
Est. total time:   ~22.2 hrs
Est. completion:   Mar 11, 07:14 EST
```

If quiet hours are enabled, the estimate accounts for daily send windows and shows per-day breakdown.

---

### 11.9 Campaign Database Schema

```sql
campaigns (
  id, name, type, status,          -- draft | scheduled | active | paused | completed | failed
  contact_list_id,
  message_body, template_id,
  scheduled_at, timezone,
  created_by, created_at, updated_at
)

campaign_number_routing (
  campaign_id,
  mode,                            -- all | select | smart
  strategy,                        -- round_robin | lru | least_used | carrier | weighted | sticky
  selected_numbers jsonb,          -- null = all available
  min_health_score int
)

campaign_delay_config (
  campaign_id,
  mode,                            -- random | fixed | ramp | wave
  min_seconds, max_seconds,
  per_number_per_hour, per_number_per_day,
  inter_number_gap_seconds,
  quiet_hours_start, quiet_hours_end,
  quiet_hours_timezone,
  allow_weekends bool
)

campaign_sends (
  id, campaign_id, contact_id,
  sender_number, recipient_number,
  message_body,
  status,                          -- queued | sent | delivered | failed | retrying
  scheduled_at, sent_at, delivered_at,
  retry_count, last_error,
  link_clicked bool, click_at
)
```

---

### 11.10 Campaign API Endpoints

```http
POST   /campaigns                    Create campaign (returns draft)
GET    /campaigns                    List all campaigns (paginated)
GET    /campaigns/:id                Get campaign + config + stats
PATCH  /campaigns/:id                Update draft campaign
POST   /campaigns/:id/launch         Start sending (validates config first)
POST   /campaigns/:id/pause          Pause active campaign
POST   /campaigns/:id/resume         Resume paused campaign
DELETE /campaigns/:id                Delete draft or completed campaign
GET    /campaigns/:id/stats          Delivery stats + per-number breakdown
GET    /campaigns/:id/sends          Paginated send log with status
POST   /campaigns/:id/duplicate      Clone campaign as new draft
```

---

### 11.11 Advanced Campaign Options

| Option | Description |
|--------|-------------|
| **Auto-retry failed sends** | Automatically retry failed sends via a different number; configurable max retries (default: 3) |
| **Link tracking** | Auto-wrap all URLs as `apix.io/l/xxxxx`; track click-through rate per campaign and per number |
| **AI auto-reply** | Route inbound replies to AI engine; configure per-campaign system prompt |
| **Personalization** | Replace `{{first_name}}`, `{{last_name}}`, `{{custom_field}}` from contact record |
| **Sticky number** | Once a number sends to a contact, that number is always used for that contact (all campaigns) |
| **Stop-on-STOP** | Immediately halt all sends to a number and log opt-out on any `STOP` / `UNSUBSCRIBE` reply |
| **Carrier-pause** | Auto-pause campaign if carrier flag rate exceeds configurable threshold (default: 5%) |
| **Webhook on event** | Per-campaign webhook fired on: send, deliver, fail, click, reply, opt-out |

---

## 12. Additional Innovative Features

### 12.1 Smart Scheduling
- Schedule messages or bulk sends for future delivery
- Timezone-aware delivery windows ("only send 9am–8pm recipient local time")
- Drip campaign builder (sequence of messages with delays)

### 12.2 Contact Book
- Store contacts with names, tags, opt-out status
- Import/export CSV
- Automatic opt-out handling (`STOP` keyword → blacklists number)
- GDPR-compliant data retention policies

### 12.3 Templates
- Message templates with variable substitution: `Hello {{name}}, your order {{orderId}} is ready.`
- Template library accessible via API: `POST /messages/send { "templateId": "order_ready", "vars": {...} }`

### 12.4 Two-Factor Auth Gateway
- Built-in OTP generation and SMS delivery
- Endpoint: `POST /otp/send` and `POST /otp/verify`
- Rate limiting and abuse protection built in

### 12.5 Conversation Analytics (AI-Powered)
- Sentiment analysis on inbound messages
- Intent classification
- Auto-tagging of conversations
- Anomaly detection (spike in messages, high failure rate)

### 12.6 Multi-Tenant Support
- Multiple workspaces with isolated number pools and API keys
- Per-workspace rate limits and quotas
- Admin super-panel to manage all tenants

### 12.7 Audit Log
- Full immutable audit trail of all actions (who sent what, from where, when)
- Exportable for compliance

### 12.8 Number Health Scoring
- Automatic scoring of each number: 0-100 based on delivery rate, carrier feedback, age
- Numbers with low scores flagged for review
- Automatic rotation away from degraded numbers

---

## 13. Android Agent App Screens

1. **Discover / Connect**: Scan for ApiX servers on network, show list, tap to pair
2. **Home**: Connection status, SIM info, today's send/receive counts, battery
3. **Log**: Live log of SMS sent and received through this device
4. **Settings**: Server URL override, notification preferences, foreground service toggle

---

## 14. Security Architecture

- All Agent ↔ Server communication: TLS 1.3 + rotating HMAC tokens
- Web UI: JWT auth + optional TOTP 2FA
- API Keys: scoped permissions (read-only, send-only, full-access)
- Webhook payloads: HMAC-SHA256 signed
- Database: field-level encryption for message bodies (optional, configurable)
- Rate limiting on all endpoints (per-key, per-IP)
- Fail2ban integration for brute-force protection

---

## 15. Deployment

### Docker Compose (recommended)
```yaml
services:
  apix-server:    # Main API + WebSocket server
  apix-worker:    # Background job processor (bulk sends, webhooks)
  apix-ui:        # React frontend (served via Nginx)
  postgres:       # Persistent storage
  redis:          # Cache, queues, pub/sub
```

### Kubernetes
- Helm chart provided
- Horizontal autoscaling on apix-server and apix-worker
- Redis Cluster for HA

---

*ApiX Gateway — Beyond Twilio. Your infrastructure, your rules.*
