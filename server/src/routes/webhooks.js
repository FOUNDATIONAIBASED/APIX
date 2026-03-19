'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { Webhooks, getDb } = require('../db');
const { validateRequired, sanitizeString } = require('../security');

const VALID_EVENTS = [
    '*',
    'message.inbound', 'message.outbound', 'message.delivered',
    'message.failed', 'message.status',
    'device.online', 'device.offline', 'device.registered',
    'campaign.started', 'campaign.completed', 'campaign.paused',
    'optout.received',
];
const VALID_FORMATS = ['json', 'twilio', 'n8n'];

// GET /api/v1/webhooks
router.get('/', (req, res) => {
    res.json({ webhooks: Webhooks.findAll() });
});

// GET /api/v1/webhooks/:id
router.get('/:id', (req, res) => {
    const wh = Webhooks.findById(req.params.id);
    if (!wh) return res.status(404).json({ error: 'Webhook not found' });
    // Include recent deliveries
    const deliveries = getDb().prepare(
        'SELECT * FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC LIMIT 20'
    ).all(req.params.id);
    res.json({ ...wh, recent_deliveries: deliveries });
});

// POST /api/v1/webhooks
router.post('/', (req, res) => {
    const err = validateRequired(req.body, ['url']);
    if (err) return res.status(400).json({ error: err });

    const events = Array.isArray(req.body.events) ? req.body.events : ['message.inbound'];
    const invalid = events.filter(e => !VALID_EVENTS.includes(e));
    if (invalid.length) return res.status(400).json({ error: `Invalid events: ${invalid.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}` });

    const format = req.body.format || 'json';
    if (!VALID_FORMATS.includes(format)) return res.status(400).json({ error: `Invalid format. Valid: ${VALID_FORMATS.join(', ')}` });

    const wh = {
        id:      'wh_' + uuidv4().replace(/-/g, '').slice(0, 12),
        name:    sanitizeString(req.body.name, 100) || 'Webhook',
        url:     req.body.url,
        events:  JSON.stringify(events),
        secret:  req.body.secret || null,
        format,
        enabled: req.body.enabled !== false ? 1 : 0,
    };
    Webhooks.insert(wh);
    res.status(201).json({ success: true, webhook: { ...wh, events } });
});

// PUT /api/v1/webhooks/:id
router.put('/:id', (req, res) => {
    const existing = Webhooks.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Webhook not found' });

    const events  = Array.isArray(req.body.events) ? req.body.events : existing.events;
    const updated = {
        name:    sanitizeString(req.body.name, 100) || existing.name,
        url:     req.body.url || existing.url,
        events:  JSON.stringify(events),
        secret:  req.body.secret !== undefined ? req.body.secret : existing.secret,
        format:  VALID_FORMATS.includes(req.body.format) ? req.body.format : existing.format,
        enabled: req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled,
    };
    Webhooks.update(req.params.id, updated);
    res.json({ success: true });
});

// DELETE /api/v1/webhooks/:id
router.delete('/:id', (req, res) => {
    Webhooks.delete(req.params.id);
    res.json({ success: true });
});

// POST /api/v1/webhooks/:id/test  — send a test event
router.post('/:id/test', async (req, res) => {
    const wh = Webhooks.findById(req.params.id);
    if (!wh) return res.status(404).json({ error: 'Webhook not found' });

    const dispatcher = require('../queue/dispatcher');
    const testPayload = {
        id: 'msg_test_' + Date.now(),
        from: '+15550001111', to: '+15550002222',
        body: 'Test message from ApiX Gateway',
        status: 'delivered', direction: 'inbound',
        type: 'sms',
    };
    try {
        await dispatcher._send(wh, 'message.inbound', testPayload, 1);
        res.json({ success: true, message: 'Test event dispatched' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Rules ──────────────────────────────────────────────────────

// POST /api/v1/webhooks/:id/rules
router.post('/:id/rules', (req, res) => {
    const err = validateRequired(req.body, ['field', 'value']);
    if (err) return res.status(400).json({ error: err });

    const rule = {
        id:         'rule_' + uuidv4().replace(/-/g, '').slice(0, 12),
        webhook_id: req.params.id,
        field:      sanitizeString(req.body.field, 100),
        operator:   req.body.operator || 'contains',
        value:      sanitizeString(req.body.value, 500),
    };
    Webhooks.addRule(rule);
    res.status(201).json({ success: true, rule });
});

// DELETE /api/v1/webhooks/:webhookId/rules/:ruleId
router.delete('/:webhookId/rules/:ruleId', (req, res) => {
    Webhooks.deleteRule(req.params.ruleId);
    res.json({ success: true });
});

// GET /api/v1/webhooks/:id/deliveries
router.get('/:id/deliveries', (req, res) => {
    const { limit = 50 } = req.query;
    const deliveries = getDb().prepare(
        'SELECT * FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC LIMIT ?'
    ).all(req.params.id, +limit);
    res.json({ deliveries });
});

// POST /api/v1/webhooks/:id/test  — fire a test event
router.post('/:id/test', async (req, res) => {
    const wh = Webhooks.findById(req.params.id);
    if (!wh) return res.status(404).json({ error: 'Webhook not found' });

    const testPayload = {
        event:    'test',
        message:  'This is a test webhook from ApiX Gateway',
        id:       'msg_test_' + Date.now(),
        from:     req.body.from || '+15005550006',
        to:       req.body.to   || '+15005550001',
        body:     req.body.body || 'Test SMS message content',
        status:   'delivered',
        ts:       new Date().toISOString(),
    };

    try {
        const axios = require('axios');
        const { signPayload } = require('../security');
        const headers = {
            'Content-Type': 'application/json',
            'X-ApiX-Event': 'test',
            'X-ApiX-Webhook-Id': wh.id,
        };
        if (wh.secret) {
            const body = JSON.stringify(testPayload);
            headers['X-ApiX-Signature'] = signPayload(wh.secret, body);
        }
        const start = Date.now();
        const response = await axios.post(wh.url, testPayload, {
            headers,
            timeout: 10_000,
            validateStatus: () => true,
        });
        const duration = Date.now() - start;

        // Log delivery
        const deliveryId = 'wd_' + uuidv4().replace(/-/g,'').slice(0,12);
        getDb().prepare(
            "INSERT INTO webhook_deliveries (id,webhook_id,event,payload,response_code,response_body,duration_ms,success,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))"
        ).run(deliveryId, wh.id, 'test', JSON.stringify(testPayload), response.status, String(response.data||'').slice(0,500), duration, response.status<400?1:0);

        res.json({
            success: response.status < 400,
            http_status: response.status,
            duration_ms: duration,
            payload: testPayload,
        });
    } catch (e) {
        res.json({ success: false, error: e.message, payload: testPayload });
    }
});

module.exports = router;
