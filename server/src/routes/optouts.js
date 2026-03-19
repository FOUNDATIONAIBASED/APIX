'use strict';
const router = require('express').Router();
const { OptOuts } = require('../db');
const { sanitizePhone } = require('../security');

// GET /api/v1/optouts
router.get('/', (req, res) => {
    const { limit = 100 } = req.query;
    res.json({ opt_outs: OptOuts.findAll(+limit), total: OptOuts.count() });
});

// POST /api/v1/optouts  — manually add to stop list
router.post('/', (req, res) => {
    const number = sanitizePhone(req.body.number);
    if (!number) return res.status(400).json({ error: 'Valid phone number required' });
    OptOuts.add(number, req.body.reason || 'manual', req.body.source || 'api');
    res.status(201).json({ success: true, number });
});

// DELETE /api/v1/optouts/:number  — remove from stop list (re-subscribe)
router.delete('/:number', (req, res) => {
    OptOuts.remove(req.params.number);
    res.json({ success: true });
});

// POST /api/v1/optouts/check  — check if a number is opted out
router.post('/check', (req, res) => {
    const number = sanitizePhone(req.body.number);
    if (!number) return res.status(400).json({ error: 'Valid phone number required' });
    res.json({ number, opted_out: OptOuts.isOptedOut(number) });
});

module.exports = router;
