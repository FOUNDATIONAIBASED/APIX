'use strict';
const crypto = require('crypto');
const cfg    = require('./config');

// ── HMAC token for device ↔ server messages ──────────────────
function signPayload(payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto.createHmac('sha256', cfg.hmacSecret).update(data).digest('hex');
}

function verifySignature(payload, sig) {
    const expected = signPayload(payload);
    try {
        return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
    } catch {
        return false;
    }
}

// ── Generate a device pairing token ──────────────────────────
function generateDeviceToken() {
    return crypto.randomBytes(32).toString('hex');
}

// ── Simple API key middleware ─────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.apiKey;
    if (!key) return res.status(401).json({ error: 'API key required' });
    // In a real deployment you'd look this up in a DB; for now accept any key
    // that matches the HMAC_SECRET as a master key (bootstrap)
    if (key === cfg.hmacSecret) return next();
    return res.status(403).json({ error: 'Invalid API key' });
}

module.exports = { signPayload, verifySignature, generateDeviceToken, requireApiKey };
