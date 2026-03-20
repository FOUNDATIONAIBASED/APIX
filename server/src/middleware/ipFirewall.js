'use strict';
const { IpSecurity } = require('../db');

const EXEMPT_PATHS = new Set([
    '/health',
    '/api/auth/unban-challenge',
    '/docs',
]);

function pathExempt(path) {
    if (EXEMPT_PATHS.has(path)) return true;
    if (path.startsWith('/api/auth/unban-challenge')) return true;
    if (path === '/api/v1/devices/announce' || path.startsWith('/api/v1/devices/announce')) return true;
    if (path === '/api/v1/devices/verify-token') return true;
    // Static login / reset so users can read unban instructions
    if (path === '/login' || path === '/reset-password' || path === '/plans') return true;
    if (path.endsWith('.html') && (path.includes('login') || path.includes('reset'))) return true;
    return false;
}

/**
 * Block requests from IPs with an active block rule (unless overridden by allow rule).
 */
function ipFirewallMiddleware(req, res, next) {
    if (pathExempt(req.path)) return next();
    const verdict = IpSecurity.evaluate(req.ip);
    if (verdict === 'block') {
        return res.status(403).json({
            error: 'Access denied from this IP address',
            code: 'IP_BLOCKED',
        });
    }
    next();
}

module.exports = { ipFirewallMiddleware, pathExempt };
