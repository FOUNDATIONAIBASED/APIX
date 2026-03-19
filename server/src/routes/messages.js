'use strict';
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Messages, Conversations, OptOuts, Templates, Scheduled } = require('../db');
const { sanitizePhone, sanitizeString, sendLimiter }              = require('../security');
const scheduler = require('../queue/scheduler');

// ── GET /api/v1/messages ─────────────────────────────────────────
router.get('/', (req, res) => {
    const { direction, status, from, to, limit = 50, cursor, campaign_id } = req.query;
    const msgs = Messages.findAll({
        direction, status, from, to, campaign_id,
        limit:  Math.min(parseInt(limit, 10) || 50, 500),
        cursor,
    });
    res.json({ messages: msgs, count: msgs.length });
});

// GET /api/v1/messages/stats
router.get('/stats', (req, res) => {
    res.json(Messages.todayStats());
});

// GET /api/v1/messages/export-csv
router.get('/export-csv', (req, res) => {
    const { direction, status, from, to, limit = 10000, cursor } = req.query;
    const msgs = Messages.findAll({
        direction, status, from, to,
        limit: Math.min(parseInt(limit) || 10000, 50000),
        cursor,
    });
    const header = 'id,direction,from_number,to_number,body,type,status,device_id,created_at,delivered_at,error_code';
    const csvEscape = s => '"' + String(s || '').replace(/"/g, "'") + '"';
    const lines = msgs.map(m => [
        m.id, m.direction, m.from_number, m.to_number,
        csvEscape(m.body),
        m.type, m.status, m.device_id || '',
        m.created_at || '', m.delivered_at || '', m.error_code || '',
    ].join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="messages-${Date.now()}.csv"`);
    res.send([header, ...lines].join('\n'));
});

// ── POST /api/v1/messages/send ───────────────────────────────────
router.post('/send', sendLimiter, async (req, res) => {
    const to = sanitizePhone(req.body.to);
    if (!to) return res.status(400).json({ error: 'Valid to number required' });

    let body = sanitizeString(req.body.body, 1600) || '';
    const type = req.body.type === 'mms' ? 'mms' : 'sms';

    if (type === 'sms' && !body && !req.body.template_id) {
        return res.status(400).json({ error: 'body or template_id required for SMS' });
    }

    // Opt-out check
    if (OptOuts.isOptedOut(to)) {
        return res.status(422).json({
            error: `${to} has opted out. Remove from opt-out list to send.`,
            code: 'OPT_OUT',
        });
    }

    // Template rendering
    let templateId = null;
    if (req.body.template_id) {
        const rendered = Templates.render(req.body.template_id, req.body.variables || {});
        if (!rendered) return res.status(404).json({ error: 'Template not found' });
        body = rendered;
        templateId = req.body.template_id;
        Templates.incrementUsed(templateId);
    }

    // Smart scheduling: if outside business hours and enforce_business_hours is set, queue for next window
    const { isWithinBusinessHours } = scheduler;
    const enforceHours = require('../db').Settings.get('enforce_business_hours');
    if (enforceHours === '1' && typeof isWithinBusinessHours === 'function' && !isWithinBusinessHours()) {
        // Auto-schedule for next business hours window instead of sending immediately
        const { Scheduled } = require('../db');
        const schedId = 'sched_' + require('uuid').v4().replace(/-/g,'').slice(0,12);
        const nextBh = _getNextBusinessHoursTime();
        Scheduled.insert?.({
            id: schedId, to_number: to,
            from_number: sanitizePhone(req.body.from) || null,
            body, type, media_url: req.body.media_url || null,
            send_at: nextBh, status: 'pending',
        });
        return res.status(202).json({ success: true, queued: true, send_at: nextBh, message: 'Outside business hours — message queued for next window.' });
    }

    try {
        const result = await scheduler.dispatchSms({
            to,
            from:       sanitizePhone(req.body.from),
            body,
            type,
            mediaUrl:   req.body.media_url || null,
            deviceId:   req.body.device_id || null,
            templateId,
        });
        res.status(202).json({
            success:  true,
            msgId:    result.msgId,
            to:       result.to,
            from:     result.from,
            deviceId: result.deviceId,
            status:   'queued',
        });
    } catch (e) {
        res.status(503).json({ error: e.message, code: 'DISPATCH_FAILED' });
    }
});

// ── POST /api/v1/messages/bulk ───────────────────────────────────
router.post('/bulk', sendLimiter, async (req, res) => {
    const { messages, from, template_id, variables = {} } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
        return res.status(400).json({ error: 'messages[] required' });
    }
    if (messages.length > 10000) {
        return res.status(400).json({ error: 'Max 10,000 messages per bulk request' });
    }

    let templateBody = null;
    if (template_id) {
        const t = Templates.findById(template_id);
        if (!t) return res.status(404).json({ error: 'Template not found' });
        templateBody = t.body;
        Templates.incrementUsed(template_id);
    }

    const queued = [], skipped = [];
    for (const m of messages) {
        const to = sanitizePhone(m.to);
        if (!to) { skipped.push({ input: m.to, reason: 'invalid_number' }); continue; }
        if (OptOuts.isOptedOut(to)) { skipped.push({ to, reason: 'opted_out' }); continue; }

        const body = templateBody
            ? templateBody.replace(/\{(\w+)\}/g, (_, k) => ({ ...variables, ...m.variables })[k] ?? `{${k}}`)
            : sanitizeString(m.body, 1600);
        if (!body) { skipped.push({ to, reason: 'no_body' }); continue; }

        // Queue async to avoid blocking response
        const priority = m.priority || 5;
        scheduler.enqueue(async () => {
            try { await scheduler.dispatchSms({ to, from: sanitizePhone(from), body, type: 'sms' }); }
            catch {}
        }, priority);
        queued.push({ to });
    }

    res.status(202).json({
        success: true,
        queued:  queued.length,
        skipped: skipped.length,
        skipped_details: skipped,
    });
});

// ── GET /api/v1/messages/:id ─────────────────────────────────────
router.get('/:id', (req, res) => {
    const msg = Messages.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    res.json(msg);
});

// ── POST /api/v1/messages/:id/cancel  ──────────────────────────
router.post('/:id/cancel', (req, res) => {
    const msg = Messages.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    const result = Messages.cancel(req.params.id);
    if (!result.changes) return res.status(409).json({ error: 'Message cannot be cancelled (already sent or not cancellable)' });
    res.json({ success: true });
});

// ── POST /api/v1/messages/:id/pin  ─────────────────────────────
router.post('/:id/pin', (req, res) => {
    const msg = Messages.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    Messages.setPinned(req.params.id, true);
    res.json({ success: true, pinned: true });
});

router.delete('/:id/pin', (req, res) => {
    Messages.setPinned(req.params.id, false);
    res.json({ success: true, pinned: false });
});

// ── POST /api/v1/messages/:id/status  ── (device callback) ──────
router.post('/:id/status', (req, res) => {
    const { status, error_code, error_msg } = req.body;
    const valid = ['sent', 'delivered', 'failed', 'undelivered'];
    if (!valid.includes(status)) return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
    Messages.updateStatus(req.params.id, status, { error_code, error_msg });
    res.json({ success: true });
});

// ── Twilio-compatible endpoint aliases ───────────────────────────
// POST /api/v1/Messages  (Twilio SDK compatible)
router.post('/twilio-compat', sendLimiter, async (req, res) => {
    const to   = sanitizePhone(req.body.To || req.body.to);
    const from = sanitizePhone(req.body.From || req.body.from);
    const body = sanitizeString(req.body.Body || req.body.body, 1600);
    if (!to || !body) return res.status(400).json({ message: 'To and Body required' });
    if (OptOuts.isOptedOut(to)) return res.status(422).json({ message: 'Number opted out', code: 21610 });
    try {
        const result = await scheduler.dispatchSms({ to, from, body, type: 'sms' });
        res.status(201).json({
            sid:          result.msgId,
            account_sid:  'AC_apix',
            from:         result.from,
            to:           result.to,
            body,
            status:       'queued',
            direction:    'outbound-api',
            date_created: new Date().toISOString(),
            num_segments: String(Math.ceil(body.length / 160)),
        });
    } catch (e) {
        res.status(503).json({ message: e.message, code: 30001 });
    }
});

function _getNextBusinessHoursTime() {
    const { Settings } = require('../db');
    let bh;
    try { bh = JSON.parse(Settings.get('business_hours') || '{}'); } catch { bh = {}; }
    const [startH, startM] = (bh.start || '09:00').split(':').map(Number);
    const [endH]   = (bh.end   || '17:00').split(':').map(Number);
    const days = bh.days || [1,2,3,4,5];

    const d = new Date();
    // If before start today and today is a valid day, use today's start
    if (days.includes(d.getDay())) {
        const todayStart = new Date(d);
        todayStart.setHours(startH, startM, 0, 0);
        if (d < todayStart) return todayStart.toISOString();
    }
    // Find next valid day
    for (let i = 1; i <= 7; i++) {
        const next = new Date(d);
        next.setDate(d.getDate() + i);
        next.setHours(startH, startM, 0, 0);
        if (days.includes(next.getDay())) return next.toISOString();
    }
    return new Date(Date.now() + 3600_000).toISOString(); // fallback: 1 hour
}

module.exports = router;
