'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const router  = express.Router();
const crypto  = require('crypto');
const os      = require('os');
const { Devices, PairingTokens, DiscoveryHints } = require('../db');
const { getConnectedDeviceIds }  = require('../ws/handler');
const { requirePerm, requireAnyRole } = require('../auth/middleware');
const cfg = require('../config');

// Shorthand: must have devices:manage perm (admin or mod)
const canManage = requirePerm('devices:manage');

const announceLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many announce requests from this IP', code: 'ANNOUNCE_RATE_LIMIT' },
});

// GET /api/v1/devices  — requires at least devices:view
router.get('/', requirePerm('devices:view'), (req, res) => {
    const devs     = Devices.findAll();
    const online   = new Set(getConnectedDeviceIds());
    const enriched = devs.map(d => ({
        ...d,
        connected: online.has(d.id),
        signal: d.signal ? (() => { try { return JSON.parse(d.signal); } catch { return d.signal; } })() : null,
    }));
    res.json({ devices: enriched, total: enriched.length });
});

// GET /api/v1/devices/server-info — WebSocket URLs & mDNS (no token; read-only)
router.get('/server-info', requirePerm('devices:view'), (req, res) => {
    const wsUrls = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) {
                wsUrls.push(`ws://${iface.address}:${cfg.port}/ws`);
            }
        }
    }
    if (!wsUrls.length) wsUrls.push(`ws://127.0.0.1:${cfg.port}/ws`);

    const xfProto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = xfProto || (req.secure ? 'https' : 'http');
    const host = req.get('host') || `127.0.0.1:${cfg.port}`;
    const managementUrl = `${proto}://${host}`;

    res.json({
        port: cfg.port,
        mdns_name: cfg.mdnsName || 'ApiX Gateway',
        mdns_enabled: cfg.mdnsEnabled,
        mdns_service: '_apix._tcp.local',
        ws_urls: wsUrls,
        management_url: managementUrl,
        manual_pairing: {
            summary: 'Generate a pairing token (Devices → Pair via QR, or GET /api/v1/devices/pair with devices:manage). Enter the WebSocket URL reachable from the phone and the token in the Agent app.',
            verify_http: `${managementUrl}/api/v1/devices/verify-token`,
            websocket_path: '/ws',
        },
    });
});

// GET /api/v1/devices/pair  — admin or mod can generate QR pairing token
router.get('/pair', canManage, (req, res) => {
    const token = crypto.randomBytes(16).toString('hex');
    PairingTokens.create(token, 10);

    const urls = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) {
                urls.push(`ws://${iface.address}:${cfg.port}/ws`);
            }
        }
    }
    if (!urls.length) urls.push(`ws://127.0.0.1:${cfg.port}/ws`);

    const payload = { v: 2, urls, token, name: cfg.mdnsName || 'ApiX Gateway', port: cfg.port };
    res.json({ payload, qr_data: JSON.stringify(payload), expires_in: 600 });
});

// POST /api/v1/devices/announce — public: client tells server it will connect (for admin discovery UI)
router.post('/announce', announceLimiter, (req, res) => {
    const { ws_host, ws_port, android_model } = req.body || {};
    DiscoveryHints.upsert({
        client_ip: req.ip,
        ws_host: ws_host || null,
        ws_port: ws_port != null ? parseInt(ws_port, 10) : null,
        android_model: android_model || null,
    });
    res.json({ success: true });
});

// POST /api/v1/devices/verify-token  — public (Android uses this)
router.post('/verify-token', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    res.json({ valid: PairingTokens.isValid(token) });
});

// GET /api/v1/devices/:id  — requires devices:view
router.get('/:id', requirePerm('devices:view'), (req, res) => {
    const dev = Devices.findById(req.params.id);
    if (!dev) return res.status(404).json({ error: 'Device not found' });
    res.json(dev);
});

// POST /api/v1/devices/:id/approve  — requires devices:manage (admin or mod)
router.post('/:id/approve', canManage, (req, res) => {
    const dev = Devices.findById(req.params.id);
    if (!dev) return res.status(404).json({ error: 'Device not found' });
    Devices.updateStatus(req.params.id, 'approved');
    const { sendToDevice } = require('../ws/handler');
    sendToDevice(req.params.id, { type: 'approved' });
    res.json({ success: true, deviceId: req.params.id, status: 'approved' });
});

// POST /api/v1/devices/:id/suspend  — requires devices:manage
router.post('/:id/suspend', canManage, (req, res) => {
    Devices.updateStatus(req.params.id, 'suspended');
    res.json({ success: true, deviceId: req.params.id, status: 'suspended' });
});

// DELETE /api/v1/devices/:id  — requires devices:manage
router.delete('/:id', canManage, (req, res) => {
    Devices.delete(req.params.id);
    res.json({ success: true });
});

// PATCH /api/v1/devices/:id  — requires devices:manage
router.patch('/:id', canManage, (req, res) => {
    const { status, name, user_id } = req.body;
    const db = require('../db').getDb();
    const { Devices } = require('../db');
    if (status) db.prepare('UPDATE devices SET status=? WHERE id=?').run(status, req.params.id);
    if (name)   db.prepare('UPDATE devices SET name=? WHERE id=?').run(name, req.params.id);
    if (user_id !== undefined) Devices.setUserId(req.params.id, user_id || null);
    res.json({ success: true, device: Devices.findById(req.params.id) });
});

module.exports = router;
