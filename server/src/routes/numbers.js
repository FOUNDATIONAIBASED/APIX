'use strict';
const express = require('express');
const router  = express.Router();
const { Devices, getDb } = require('../db');
const { getConnectedDeviceIds } = require('../ws/handler');

// GET /api/v1/numbers  — return all SIM numbers from all approved devices
router.get('/', (req, res) => {
    const db        = getDb();
    const online    = new Set(getConnectedDeviceIds());
    const rows      = db.prepare(`
        SELECT s.*, d.status AS device_status, d.battery, d.last_seen, d.name AS device_name, d.id AS device_id
        FROM sim_cards s
        JOIN devices d ON d.id = s.device_id
        WHERE d.status = 'approved'
        ORDER BY d.last_seen DESC
    `).all();

    const numbers = rows.map(r => ({
        number:       r.number,
        carrier:      r.carrier,
        slot:         r.slot,
        deviceId:     r.device_id,
        deviceName:   r.device_name,
        signal:       r.signal,
        battery:      r.battery,
        online:       online.has(r.device_id),
        lastSeen:     r.last_seen,
    }));

    res.json({ numbers, total: numbers.length });
});

// GET /api/v1/numbers/available
router.get('/available', (req, res) => {
    const db    = getDb();
    const online = new Set(getConnectedDeviceIds());
    const rows  = db.prepare(`
        SELECT s.*, d.battery, d.id AS device_id, d.name AS device_name
        FROM sim_cards s JOIN devices d ON d.id = s.device_id
        WHERE d.status = 'approved'
    `).all();
    const available = rows.filter(r => online.has(r.device_id));
    res.json({ numbers: available, total: available.length });
});

module.exports = router;
