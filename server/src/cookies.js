'use strict';
/**
 * Session cookie options: Secure flag follows USE_SSL and X-Forwarded-Proto
 * so cookies work on HTTP (homelab) and are marked Secure when served over HTTPS.
 */
const cfg = require('./config');

function isHttpsRequest(req) {
    if (req.secure) return true;
    const fp = String(req.headers['x-forwarded-proto'] || '')
        .split(',')[0].trim().toLowerCase();
    return fp === 'https';
}

function sessionCookieShouldBeSecure(req) {
    return !!(cfg.useSsl || isHttpsRequest(req));
}

/** Options for res.cookie('apix_session', token, opts) */
function sessionCookieOpts(req) {
    return {
        httpOnly: true,
        sameSite: 'Lax',
        secure: sessionCookieShouldBeSecure(req),
        maxAge: 30 * 86_400_000,
        path: '/',
    };
}

/** Options for res.clearCookie('apix_session', opts) — must match path/secure/sameSite */
function clearSessionCookieOpts(req) {
    return {
        path: '/',
        secure: sessionCookieShouldBeSecure(req),
        sameSite: 'Lax',
    };
}

module.exports = {
    isHttpsRequest,
    sessionCookieOpts,
    clearSessionCookieOpts,
};
