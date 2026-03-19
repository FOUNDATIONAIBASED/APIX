'use strict';
/**
 * Plans management
 * GET  /api/v1/plans          — list active plans (public)
 * GET  /api/v1/plans/:id      — single plan (public)
 * POST /api/v1/plans          — create plan (admin)
 * PUT  /api/v1/plans/:id      — update plan (admin)
 * DELETE /api/v1/plans/:id    — delete plan (admin)
 */
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { Plans } = require('../db');
const { requireAuth } = require('../auth/middleware');

// Public: list plans
router.get('/', (req, res) => {
    const plans = Plans.findAll(req.query.all === 'true');
    res.json({ plans });
});

// Public: single plan
router.get('/:id', (req, res) => {
    const plan = Plans.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    res.json(plan);
});

// Admin: create plan
router.post('/', requireAuth('admin'), (req, res) => {
    const { name, description, badge, price_monthly = 0, price_yearly = 0, currency = 'USD',
            purchase_url, limits = {}, features = {}, highlight = 0, is_active = 1, display_order = 99 } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const plan = {
        id: 'plan_' + uuidv4().replace(/-/g,'').slice(0,10),
        name, description: description || null, badge: badge || null,
        price_monthly: +price_monthly, price_yearly: +price_yearly, currency,
        purchase_url: purchase_url || null, limits, features,
        highlight: +highlight, is_active: +is_active, is_default: 0, display_order: +display_order,
    };
    Plans.insert(plan);
    res.status(201).json({ success: true, plan: Plans.findById(plan.id) });
});

// Admin: update plan
router.put('/:id', requireAuth('admin'), (req, res) => {
    const plan = Plans.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    // If setting as default, clear existing default first
    if (req.body.is_default) {
        const { getDb } = require('../db');
        getDb().prepare('UPDATE plans SET is_default=0').run();
    }

    Plans.update(req.params.id, req.body);
    res.json({ success: true, plan: Plans.findById(req.params.id) });
});

// Admin: delete plan
router.delete('/:id', requireAuth('admin'), (req, res) => {
    const { getDb } = require('../db');
    // Check if users have this plan
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM users WHERE plan_id=?').get(req.params.id)?.n || 0;
    if (count > 0) return res.status(409).json({ error: `${count} user(s) are on this plan. Reassign them first.` });
    Plans.delete(req.params.id);
    res.json({ success: true });
});

module.exports = router;
