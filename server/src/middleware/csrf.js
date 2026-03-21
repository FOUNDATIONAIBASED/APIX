'use strict';
/**
 * Double-submit CSRF protection for cookie-based sessions (apix_session).
 * Bearer / API-key auth is not affected (cookies not auto-sent cross-site).
 */
const crypto = require('crypto');

function timingSafeCsrfEqual(a, b) {
    if (a == null || b == null) return false;
    const x = Buffer.from(String(a), 'utf8');
    const y = Buffer.from(String(b), 'utf8');
    if (x.length === 0 || x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
}
const { sessionCookieShouldBeSecure } = require('../cookies');

const CSRF_COOKIE = 'apix_csrf';

function csrfCookieOpts(req) {
    return {
        httpOnly: false,
        sameSite: 'Lax',
        secure: sessionCookieShouldBeSecure(req),
        path: '/',
        maxAge: 30 * 86_400_000,
    };
}

function setCsrfCookie(req, res) {
    const t = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, t, csrfCookieOpts(req));
    return t;
}

/** Ensure readable CSRF cookie exists whenever a session cookie is present (migration / first load). */
function ensureCsrfCookie(req, res, next) {
    if (req.cookies?.apix_session && !req.cookies?.[CSRF_COOKIE]) {
        setCsrfCookie(req, res);
    }
    next();
}

/** Require X-CSRF-Token to match apix_csrf when using cookie session auth. */
function requireCsrfForCookieSession(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!req.cookies?.apix_session) return next();

    const cookie = req.cookies[CSRF_COOKIE];
    const header = req.headers['x-csrf-token'] || req.headers['x-xsrf-token'];
    const bodyTok = req.body && typeof req.body === 'object' && req.body._csrf != null
        ? String(req.body._csrf)
        : null;
    const candidate = header || bodyTok;
    if (!cookie || !candidate || !timingSafeCsrfEqual(cookie, candidate)) {
        return res.status(403).json({
            error: 'CSRF validation failed. Send header X-CSRF-Token (or JSON _csrf) matching the apix_csrf cookie.',
            code: 'CSRF',
        });
    }
    next();
}

function clearCsrfCookie(req, res) {
    res.clearCookie(CSRF_COOKIE, {
        path: '/',
        secure: sessionCookieShouldBeSecure(req),
        sameSite: 'Lax',
    });
}

module.exports = {
    CSRF_COOKIE,
    csrfCookieOpts,
    setCsrfCookie,
    clearCsrfCookie,
    ensureCsrfCookie,
    requireCsrfForCookieSession,
    timingSafeCsrfEqual,
};
