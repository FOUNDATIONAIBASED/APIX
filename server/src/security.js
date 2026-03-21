'use strict';
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const cors       = require('cors');
const crypto     = require('crypto');
const { ApiKeys, Settings } = require('./db');
const cfg        = require('./config');

// ── Helmet security headers ────────────────────────────────────
// upgrade-insecure-requests: null = allow HTTP (for LAN/IP access). Set USE_SSL=true when behind HTTPS proxy.
const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc:   ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'],
    scriptSrcAttr: ["'unsafe-inline'"],  // Required for onclick handlers in the admin UI
    styleSrc:   ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'fonts.gstatic.com'],
    fontSrc:    ["'self'", 'fonts.gstatic.com'],
    imgSrc:     ["'self'", 'data:'],
    connectSrc: ["'self'"],
};
// Explicitly disable upgrade-insecure-requests when not behind HTTPS (avoids SSL_ERROR_RX_RECORD_TOO_LONG on HTTP)
cspDirectives['upgrade-insecure-requests'] = cfg.useSsl ? [] : null;

const helmetMiddleware = helmet({
    contentSecurityPolicy: {
        directives: cspDirectives,
    },
    crossOriginEmbedderPolicy: false,
    hsts: cfg.useSsl
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
        : false,
});

/** Effective mode: DB setting wins after setup; env is fallback for fresh installs / API-only. */
function getDeploymentMode() {
    try {
        const v = Settings.get('deployment_mode');
        if (v === 'production' || v === 'homelab') return v;
    } catch (_) { /* DB not ready */ }
    return cfg.deploymentMode === 'production' ? 'production' : 'homelab';
}

const corsMiddleware = cors({
    origin(origin, callback) {
        if (getDeploymentMode() !== 'production') {
            return callback(null, true);
        }
        if (!origin) return callback(null, true);
        if (cfg.corsOrigins.length === 0) {
            console.warn('[CORS] deployment_mode=production but CORS_ORIGINS is empty — blocking browser cross-origin requests');
            return callback(null, false);
        }
        if (cfg.corsOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

// ── Rate limiters ──────────────────────────────────────────────
const globalLimiter = rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' },
    skip: (req) => req.path.startsWith('/api/v1/events'), // SSE exempt
});

const sendLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Send rate limit exceeded (60/min).' },
    keyGenerator: (req) => req.apiKey?.id || req.ip,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many auth attempts.' },
});

// ── Per-API-key rate limiter (in-memory sliding window) ────────
const _keyWindows = new Map();
function _checkKeyRateLimit(keyId, limitPerMin) {
    const now = Date.now();
    if (!_keyWindows.has(keyId)) _keyWindows.set(keyId, []);
    const window = _keyWindows.get(keyId).filter(t => now - t < 60_000);
    window.push(now);
    _keyWindows.set(keyId, window);
    return window.length <= limitPerMin;
}
// Prune old windows every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of _keyWindows) {
        const fresh = arr.filter(t => now - t < 60_000);
        if (fresh.length === 0) _keyWindows.delete(k);
        else _keyWindows.set(k, fresh);
    }
}, 300_000);

// ── API Key authentication middleware ──────────────────────────
function apiKeyAuth(required = true) {
    return (req, res, next) => {
        const header = req.headers['x-api-key'] || req.headers.authorization;
        let rawKey = null;

        if (header) {
            rawKey = header.startsWith('Bearer ') ? header.slice(7) : header;
        } else if (Object.prototype.hasOwnProperty.call(req.query || {}, 'api_key')) {
            // Reject without reading the secret value from the query string (no GET logging / accidental leaks).
            return res.status(400).json({
                error: 'API key in query string is not supported. Use the X-API-Key header or Authorization: Bearer.',
                code: 'API_KEY_QUERY_UNSUPPORTED',
            });
        }

        if (!rawKey) {
            if (required) return res.status(401).json({ error: 'API key required. Pass X-API-Key header or Authorization: Bearer.' });
            // Intentional: routes using apiKeyAuth(false) allow anonymous access when no key is sent.
            return next();
        }

        const key = ApiKeys.verify(rawKey);
        if (!key) {
            if (required) return res.status(403).json({ error: 'Invalid or revoked API key.' });
            return next();
        }

        // Sandbox mode: block destructive ops (device status callback is exempt)
        const DEVICE_MSG_STATUS = /^\/api\/v1\/messages\/[^/]+\/status\/?$/;
        if (key.sandbox) {
            const blocked = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
                && !DEVICE_MSG_STATUS.test(req.path);
            if (blocked && req.path.includes('/messages/send')) {
                // Simulate but don't actually send
                req.sandboxMode = true;
            }
        }

        // Per-key rate limit override
        if (key.rate_limit_override) {
            if (!_checkKeyRateLimit(key.id, key.rate_limit_override)) {
                return res.status(429).json({
                    error: `API key rate limit exceeded (${key.rate_limit_override}/min).`,
                    code: 'RATE_LIMIT_EXCEEDED',
                });
            }
        }

        req.apiKey = key;
        next();
    };
}

// ── Permission check middleware ────────────────────────────────
function requirePermission(perm) {
    return (req, res, next) => {
        if (!req.apiKey) return res.status(401).json({ error: 'Authentication required.' });
        const perms = req.apiKey.permissions || [];
        if (!perms.includes(perm) && !perms.includes('*')) {
            return res.status(403).json({ error: `Permission required: ${perm}` });
        }
        next();
    };
}

// ── HMAC webhook signature ─────────────────────────────────────
function signPayload(secret, payload) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function verifySignature(secret, payload, sig) {
    const expected = signPayload(secret, payload);
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    } catch {
        return false;
    }
}

// ── Input sanitisation helpers ─────────────────────────────────
function sanitizePhone(num) {
    if (!num) return null;
    const cleaned = String(num).replace(/[^\d+]/g, '');
    if (cleaned.length < 7 || cleaned.length > 16) return null;
    return cleaned;
}

function sanitizeString(s, maxLen = 1000) {
    if (s == null) return null;
    return String(s).slice(0, maxLen).trim();
}

function validateRequired(body, fields) {
    const missing = fields.filter(f => !body[f]);
    if (missing.length) return `Missing required fields: ${missing.join(', ')}`;
    return null;
}

module.exports = {
    helmetMiddleware,
    corsMiddleware,
    getDeploymentMode,
    globalLimiter,
    sendLimiter,
    authLimiter,
    apiKeyAuth,
    requirePermission,
    signPayload,
    verifySignature,
    sanitizePhone,
    sanitizeString,
    validateRequired,
};
