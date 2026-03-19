'use strict';
const router    = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { Scheduled, OptOuts } = require('../db');
const { sanitizePhone, sanitizeString, validateRequired } = require('../security');

// GET /api/v1/scheduled
router.get('/', (req, res) => {
    res.json({ messages: Scheduled.findAll() });
});

// GET /api/v1/scheduled/:id
router.get('/:id', (req, res) => {
    const s = Scheduled.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
});

// POST /api/v1/scheduled
router.post('/', (req, res) => {
    const err = validateRequired(req.body, ['to', 'body', 'schedule_at']);
    if (err) return res.status(400).json({ error: err });

    const to = sanitizePhone(req.body.to);
    if (!to) return res.status(400).json({ error: 'Invalid to number' });

    if (OptOuts.isOptedOut(to)) {
        return res.status(422).json({ error: `${to} has opted out` });
    }

    const schedAt = new Date(req.body.schedule_at);
    if (isNaN(schedAt) || schedAt <= new Date()) {
        return res.status(400).json({ error: 'schedule_at must be a future datetime' });
    }

    const s = {
        id:          'sched_' + uuidv4().replace(/-/g, '').slice(0, 12),
        to_number:   to,
        from_number: sanitizePhone(req.body.from) || null,
        body:        sanitizeString(req.body.body, 1600),
        type:        req.body.type === 'mms' ? 'mms' : 'sms',
        media_url:   req.body.media_url || null,
        status:      'pending',
        schedule_at: schedAt.toISOString(),
    };
    Scheduled.insert(s);
    res.status(201).json({ success: true, id: s.id, schedule_at: s.schedule_at });
});

// DELETE /api/v1/scheduled/:id  — cancel
router.delete('/:id', (req, res) => {
    const result = Scheduled.cancel(req.params.id);
    if (!result?.changes) return res.status(404).json({ error: 'Not found or already sent' });
    res.json({ success: true });
});

module.exports = router;
