'use strict';
const router = require('express').Router();
const { Messages, Devices, Campaigns, OptOuts, Contacts } = require('../db');

// GET /api/v1/analytics/overview
router.get('/overview', (req, res) => {
    const today    = Messages.todayStats();
    const devices  = Devices.findAll();
    const campStat = Campaigns.stats();
    const optouts  = OptOuts.count();
    const contacts = Contacts.count();
    res.json({
        today,
        devices: {
            total:    devices.length,
            approved: devices.filter(d => d.status === 'approved').length,
            pending:  devices.filter(d => d.status === 'pending').length,
        },
        campaigns: campStat,
        opt_outs:  optouts,
        contacts,
    });
});

// GET /api/v1/analytics/messages  — stats for a date range
router.get('/messages', (req, res) => {
    const { from, to, granularity = 'day' } = req.query;
    const fromTs = from ? new Date(from).toISOString() : new Date(Date.now() - 30 * 86400_000).toISOString();
    const toTs   = to   ? new Date(to).toISOString()   : new Date().toISOString();

    const stats = Messages.statsRange(fromTs, toTs);
    const hourly = Messages.hourlyStats(30);
    res.json({ stats, hourly, from: fromTs, to: toTs });
});

// GET /api/v1/analytics/hourly  — last N days, per-hour breakdown
router.get('/hourly', (req, res) => {
    const days = Math.min(30, +(req.query.days || 7));
    res.json({ data: Messages.hourlyStats(days) });
});

// GET /api/v1/analytics/devices  — per-device message stats
router.get('/devices', (req, res) => {
    const { getDb } = require('../db');
    const db = getDb();
    const data = db.prepare(`
        SELECT d.id, d.name, d.model,
            COUNT(m.id) AS total_messages,
            COUNT(CASE WHEN m.direction='outbound' THEN 1 END) AS outbound,
            COUNT(CASE WHEN m.direction='inbound'  THEN 1 END) AS inbound,
            COUNT(CASE WHEN m.status='failed'      THEN 1 END) AS failed,
            MAX(m.created_at) AS last_message_at
        FROM devices d
        LEFT JOIN messages m ON m.device_id = d.id
        GROUP BY d.id ORDER BY total_messages DESC
    `).all();
    res.json({ devices: data });
});

// GET /api/v1/analytics/numbers  — per-sender-number stats
router.get('/numbers', (req, res) => {
    const { getDb } = require('../db');
    const db = getDb();
    const data = db.prepare(`
        SELECT from_number AS number,
            COUNT(*) AS total_sent,
            COUNT(CASE WHEN status='delivered' THEN 1 END) AS delivered,
            COUNT(CASE WHEN status='failed' THEN 1 END) AS failed,
            ROUND(COUNT(CASE WHEN status='delivered' THEN 1 END) * 100.0 / COUNT(*), 2) AS delivery_rate
        FROM messages WHERE direction='outbound'
        GROUP BY from_number ORDER BY total_sent DESC LIMIT 50
    `).all();
    res.json({ numbers: data });
});

module.exports = router;
