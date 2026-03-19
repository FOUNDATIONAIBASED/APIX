'use strict';
/**
 * Webhook Dispatcher — Enhanced
 *
 * Features:
 *  - Rule-based filtering (field / operator / value)
 *  - Multiple formats: json (default), twilio, n8n
 *  - HMAC-SHA256 request signing
 *  - Retry queue with exponential back-off (1m → 5m → 30m → 2h → 24h)
 *  - Delivery log persisted to DB
 *  - n8n-compatible payload structure
 */
const axios  = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Webhooks } = require('../db');

const BACKOFF_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 24 * 3600_000];

class WebhookDispatcher {
    constructor() {
        this._retryQueue = [];
        this._retryTimer = null;
    }

    start() {
        this._retryTimer = setInterval(() => this._processRetries(), 30_000);
    }

    stop() {
        if (this._retryTimer) clearInterval(this._retryTimer);
    }

    // ── Dispatch an event to all matching webhooks ──
    async dispatch(event, payload) {
        const hooks = Webhooks.findEnabled(event);
        if (!hooks.length) return;

        const tasks = hooks.map(hook => this._send(hook, event, payload, 1));
        await Promise.allSettled(tasks);
    }

    // ── Internal send with retries ──
    async _send(hook, event, rawPayload, attempt) {
        const body      = this._formatPayload(hook.format || 'json', event, rawPayload);
        const bodyStr   = JSON.stringify(body);
        const headers   = this._buildHeaders(hook, bodyStr);

        const started = Date.now();
        const delivId = uuidv4();

        // Filter by rules
        if (hook.rules && !this._matchesRules(hook.rules, rawPayload)) {
            return;
        }

        try {
            const res = await axios.post(hook.url, body, {
                headers,
                timeout: 15_000,
                validateStatus: null,
            });

            const ok = res.status >= 200 && res.status < 300;
            Webhooks.incStats(hook.id, ok);
            Webhooks.logDelivery({
                id:          delivId,
                webhook_id:  hook.id,
                event,
                payload:     bodyStr,
                status_code: res.status,
                status:      ok ? 'delivered' : 'failed',
                attempts:    attempt,
                duration_ms: Date.now() - started,
                last_error:  ok ? null : `HTTP ${res.status}`,
                delivered_at: ok ? new Date().toISOString() : null,
            });

            if (!ok && attempt <= BACKOFF_DELAYS_MS.length) {
                this._scheduleRetry(hook, event, rawPayload, attempt, delivId);
            }
        } catch (err) {
            Webhooks.incStats(hook.id, false);
            Webhooks.logDelivery({
                id:          delivId,
                webhook_id:  hook.id,
                event,
                payload:     bodyStr,
                status_code: null,
                status:      'failed',
                attempts:    attempt,
                duration_ms: Date.now() - started,
                last_error:  err.message,
                delivered_at: null,
            });

            if (attempt <= BACKOFF_DELAYS_MS.length) {
                this._scheduleRetry(hook, event, rawPayload, attempt, delivId);
            }
        }
    }

    _scheduleRetry(hook, event, payload, attempt, prevId) {
        const delay = BACKOFF_DELAYS_MS[attempt - 1] || BACKOFF_DELAYS_MS.at(-1);
        const fireAt = Date.now() + delay;
        this._retryQueue.push({ hook, event, payload, attempt: attempt + 1, fireAt, prevId });
    }

    async _processRetries() {
        const now = Date.now();
        const due = this._retryQueue.filter(r => r.fireAt <= now);
        this._retryQueue = this._retryQueue.filter(r => r.fireAt > now);
        for (const r of due) {
            await this._send(r.hook, r.event, r.payload, r.attempt);
        }
    }

    // ── Rule matching ──
    _matchesRules(rules, payload) {
        return rules.every(rule => {
            const fieldVal = this._getField(payload, rule.field);
            return this._evalOp(String(fieldVal || ''), rule.operator, rule.value);
        });
    }

    _getField(obj, path) {
        return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
    }

    _evalOp(val, op, ruleVal) {
        switch (op) {
            case 'equals':       return val === ruleVal;
            case 'not_equals':   return val !== ruleVal;
            case 'contains':     return val.toLowerCase().includes(ruleVal.toLowerCase());
            case 'not_contains': return !val.toLowerCase().includes(ruleVal.toLowerCase());
            case 'starts_with':  return val.toLowerCase().startsWith(ruleVal.toLowerCase());
            case 'ends_with':    return val.toLowerCase().endsWith(ruleVal.toLowerCase());
            case 'regex':        try { return new RegExp(ruleVal,'i').test(val); } catch { return false; }
            default:             return true;
        }
    }

    // ── Payload formatting ──
    _formatPayload(format, event, data) {
        switch (format) {
            case 'twilio': return this._twilioFormat(event, data);
            case 'n8n':    return this._n8nFormat(event, data);
            default:       return { event, timestamp: new Date().toISOString(), data };
        }
    }

    _twilioFormat(event, d) {
        // Twilio-compatible field names
        const base = {
            MessageSid:    d.id || '',
            AccountSid:    'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            From:          d.from || d.from_number || '',
            To:            d.to   || d.to_number   || '',
            Body:          d.body || '',
            NumSegments:   d.num_segments || '1',
            NumMedia:      d.media_url ? '1' : '0',
            MessageStatus: d.status || '',
        };
        if (d.media_url) { base.MediaUrl0 = d.media_url; base.MediaContentType0 = 'image/jpeg'; }
        return base;
    }

    _n8nFormat(event, d) {
        // n8n expects a specific structure for webhook trigger nodes
        return {
            headers: { 'x-apix-event': event },
            params:  {},
            query:   {},
            body:    { event, timestamp: new Date().toISOString(), data: d },
        };
    }

    // ── Headers ──
    _buildHeaders(hook, bodyStr) {
        const headers = {
            'Content-Type':   'application/json',
            'User-Agent':     'ApiX-Gateway/2.0',
            'X-ApiX-Event':   'webhook',
            'X-ApiX-Version': '2',
        };
        if (hook.secret) {
            headers['X-ApiX-Signature'] = 'sha256=' + crypto
                .createHmac('sha256', hook.secret)
                .update(bodyStr)
                .digest('hex');
            // Twilio-compatible signature header alias
            headers['X-Twilio-Signature'] = headers['X-ApiX-Signature'];
        }
        return headers;
    }
}

module.exports = new WebhookDispatcher();
