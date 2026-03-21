# n8n + ApiX webhooks

Use this pattern to trigger n8n workflows when ApiX emits webhook events (inbound SMS, delivery status, etc.).

## Prerequisites

1. ApiX **Webhooks** configured in the dashboard (URL signing / secret as you prefer).
2. n8n instance reachable from your ApiX server (self-hosted or n8n cloud).
3. Plan feature **Webhooks** enabled for the account that owns the webhook definition.

## 1. Create a workflow in n8n

1. Add a **Webhook** node (HTTP method `POST`, path e.g. `apix-inbound`).
2. Set **Authentication** if you expose n8n on the public internet (recommended).
3. Activate the workflow and copy the **Production Webhook URL** (e.g. `https://n8n.example.com/webhook/apix-inbound`).

## 2. Register the URL in ApiX

1. Open **Webhooks** in the ApiX console.
2. Create a webhook pointing to the n8n production URL.
3. Choose payload format (**JSON** / Twilio-compatible / n8n-friendly) to match how you want to parse items in n8n.
4. Subscribe to events you need (e.g. `message.inbound`, `message.delivered`).

## 3. Minimal n8n follow-up nodes

| Node | Purpose |
|------|---------|
| Webhook | Entry — receives ApiX POST |
| Set | Map `body.from`, `body.body`, etc. to named fields |
| IF / Switch | Filter by keyword or sender |
| HTTP Request | Forward to CRM, Slack, or Telegram |
| Respond to Webhook | Optional 200 response if ApiX waits for sync callbacks |

## 4. Verify signatures (recommended)

If ApiX signs payloads with an HMAC secret:

1. Store the same secret in n8n **Credentials** or env.
2. Add a **Function** or **Crypto** step to validate `X-ApiX-Signature` (see your ApiX webhook settings for the exact header and algorithm).

## 5. Example JSON shape (generic)

Your exact fields depend on the webhook format selected in ApiX. Typical inbound fields include:

- `from` / `to` — E.164 numbers  
- `body` — message text  
- `type` — `sms` or `mms`  
- `device_id` — sending device  

Inspect one delivery in n8n’s **Executions** view, then pin that structure in a **Set** node.

## Troubleshooting

| Issue | Check |
|-------|--------|
| 404 from n8n | Workflow must be **Active**; URL must be the **Production** URL |
| ApiX retries | Ensure your workflow responds with **2xx** within the timeout ApiX uses |
| Empty body | Content-Type `application/json`; verify ApiX event subscriptions |

## Related

- ApiX REST API: `GET /api/v1/status`, webhook routes under `/api/v1/webhooks` (see in-app **API** / docs).
- For **outbound** SMS from n8n, call ApiX `POST /api/v1/messages` with an API key that has send permission.
