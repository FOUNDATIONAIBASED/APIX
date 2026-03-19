'use strict';
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Campaigns }  = require('../db');

// GET /api/v1/campaigns
router.get('/', (req, res) => {
    const camps = Campaigns.findAll();
    const parsed = camps.map(c => ({ ...c, numbers: safeJson(c.numbers, []) }));
    res.json({ campaigns: parsed, stats: Campaigns.stats() });
});

// GET /api/v1/campaigns/:id
router.get('/:id', (req, res) => {
    const c = Campaigns.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json({ ...c, numbers: safeJson(c.numbers, []) });
});

// POST /api/v1/campaigns
router.post('/', (req, res) => {
    const b = req.body;
    if (!b.name || !b.message_tpl) return res.status(400).json({ error: 'name and message_tpl required' });
    const id = 'camp_' + uuidv4().replace(/-/g, '').slice(0, 12);
    Campaigns.insert({
        id,
        name:          b.name,
        category:      b.category || 'Marketing',
        message_tpl:   b.message_tpl,
        status:        'draft',
        numbers:       JSON.stringify(b.numbers || []),
        strategy:      b.strategy      || 'round_robin',
        delay_min:     b.delay_min     ?? 8,
        delay_max:     b.delay_max     ?? 30,
        delay_type:    b.delay_type    || 'gaussian',
        rate_per_hr:   b.rate_per_hr   ?? 15,
        rate_per_day:  b.rate_per_day  ?? 150,
        window_start:  b.window_start  || '09:00',
        window_end:    b.window_end    || '20:00',
        schedule_type: b.schedule_type || 'immediate',
        schedule_at:   b.schedule_at   || null,
        total:         b.total         ?? 0,
    });
    res.status(201).json({ success: true, id });
});

// PATCH /api/v1/campaigns/:id/status
router.patch('/:id/status', (req, res) => {
    const { status } = req.body;
    const valid = ['draft', 'running', 'paused', 'scheduled', 'done'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    Campaigns.updateStatus(req.params.id, status);
    res.json({ success: true, id: req.params.id, status });
});

// DELETE /api/v1/campaigns/:id
router.delete('/:id', (req, res) => {
    Campaigns.delete(req.params.id);
    res.json({ success: true });
});

function safeJson(str, def) {
    try { return JSON.parse(str); } catch { return def; }
}

module.exports = router;
