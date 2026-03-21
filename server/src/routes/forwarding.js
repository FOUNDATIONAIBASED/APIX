'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { ForwardingRules } = require('../db');
const { requireAuth, requireFeature } = require('../auth/middleware');

const router = express.Router();

router.use(requireAuth());
router.use(requireFeature('forwarding_rules'));

function uid(req) {
    return req.user.uid || req.user.user_id;
}

// GET /api/v1/forwarding/rules
router.get('/rules', (req, res) => {
    const rules = ForwardingRules.findByUser(uid(req));
    res.json({ rules });
});

// POST /api/v1/forwarding/rules
router.post('/rules', (req, res) => {
    const {
        name = 'Rule',
        enabled = true,
        channel,
        priority = 0,
        match_from_regex,
        match_to_regex,
        match_body_contains,
        dest_telegram_chat_id,
        dest_sms_to,
    } = req.body || {};
    if (!channel || !['telegram', 'sms'].includes(channel)) {
        return res.status(400).json({ error: 'channel must be "telegram" or "sms"' });
    }
    if (channel === 'telegram' && !String(dest_telegram_chat_id || '').trim()) {
        return res.status(400).json({ error: 'dest_telegram_chat_id required for Telegram' });
    }
    if (channel === 'sms' && !String(dest_sms_to || '').trim()) {
        return res.status(400).json({ error: 'dest_sms_to required for SMS forwarding' });
    }
    const id = 'fr_' + uuidv4().replace(/-/g, '').slice(0, 12);
    ForwardingRules.insert({
        id,
        user_id: uid(req),
        name,
        enabled,
        channel,
        priority,
        match_from_regex: match_from_regex || null,
        match_to_regex: match_to_regex || null,
        match_body_contains: match_body_contains || null,
        dest_telegram_chat_id: dest_telegram_chat_id || null,
        dest_sms_to: dest_sms_to || null,
    });
    res.status(201).json({ success: true, id, rule: ForwardingRules.findByIdForUser(id, uid(req)) });
});

// PATCH /api/v1/forwarding/rules/:id
router.patch('/rules/:id', (req, res) => {
    const rule = ForwardingRules.findByIdForUser(req.params.id, uid(req));
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    ForwardingRules.update(req.params.id, uid(req), req.body || {});
    res.json({ success: true, rule: ForwardingRules.findByIdForUser(req.params.id, uid(req)) });
});

// DELETE /api/v1/forwarding/rules/:id
router.delete('/rules/:id', (req, res) => {
    const n = ForwardingRules.delete(req.params.id, uid(req));
    if (!n) return res.status(404).json({ error: 'Rule not found' });
    res.json({ success: true });
});

module.exports = router;
