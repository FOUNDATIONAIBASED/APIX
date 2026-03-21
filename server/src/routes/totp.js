'use strict';
/**
 * TOTP / Two-Factor Authentication routes
 * GET  /api/auth/2fa/status         — is 2FA enabled for current user?
 * POST /api/auth/2fa/setup          — generate secret + QR code (step 1)
 * POST /api/auth/2fa/enable         — confirm TOTP code, activate 2FA
 * POST /api/auth/2fa/disable        — disable 2FA (requires current password + TOTP)
 * GET  /api/auth/2fa/backup-codes   — regenerate backup codes
 * POST /api/auth/2fa/verify         — used at login when 2FA pending
 */
const router   = require('express').Router();
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { authenticator } = require('@otplib/preset-default');
const QRCode   = require('qrcode');
const { Users, Sessions, AuditLog } = require('../db');
const { sessionCookieOpts } = require('../cookies');
const { setCsrfCookie } = require('../middleware/csrf');
const fail2ban = require('../security/fail2banService');
const { requireAuth } = require('../auth/middleware');

const APP_NAME = process.env.APP_NAME || 'ApiX Gateway';
const BACKUP_COUNT = 10;

function genBackupCodes() {
    return Array.from({ length: BACKUP_COUNT }, () =>
        crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{4}/g).join('-')
    );
}

// ── Status ──────────────────────────────────────────────────────
router.get('/status', requireAuth(), (req, res) => {
    const u = Users.findById(req.user.id);
    res.json({ enabled: !!u.two_fa_enabled });
});

// ── Step 1: generate secret + QR ────────────────────────────────
router.post('/setup', requireAuth(), async (req, res) => {
    const u = Users.findById(req.user.id);
    if (u.two_fa_enabled) return res.status(409).json({ error: '2FA already enabled. Disable it first.' });

    const secret = authenticator.generateSecret(20);
    // Store secret (unconfirmed — not yet enabled)
    Users.update(req.user.id, { two_fa_secret: secret });

    const label   = encodeURIComponent(`${APP_NAME}:${u.username}`);
    const issuer  = encodeURIComponent(APP_NAME);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

    const qrDataUrl = await QRCode.toDataURL(otpauth, { width: 256 });

    AuditLog.log({ user_id: req.user.id, username: req.user.username, action: '2fa.setup_start', ip: req.ip });

    res.json({ secret, otpauth, qr: qrDataUrl });
});

// ── Step 2: confirm TOTP code → enable 2FA ───────────────────────
router.post('/enable', requireAuth(), (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });

    const u = Users.findById(req.user.id);
    if (!u.two_fa_secret) return res.status(400).json({ error: 'Run /setup first' });
    if (u.two_fa_enabled) return res.status(409).json({ error: '2FA already enabled' });

    if (!authenticator.verify({ token: code.replace(/\s/g,''), secret: u.two_fa_secret })) {
        return res.status(401).json({ error: 'Invalid code' });
    }

    const plainCodes = genBackupCodes();
    const hashedCodes = plainCodes.map(c => bcrypt.hashSync(c, 10));

    Users.update(req.user.id, {
        two_fa_enabled: 1,
        two_fa_backup_codes: JSON.stringify(hashedCodes),
    });

    AuditLog.log({ user_id: req.user.id, username: req.user.username, action: '2fa.enabled', ip: req.ip });

    res.json({ success: true, backup_codes: plainCodes });
});

// ── Disable 2FA ─────────────────────────────────────────────────
router.post('/disable', requireAuth(), async (req, res) => {
    const { password, code } = req.body;
    if (!password) return res.status(400).json({ error: 'password required' });

    const u = Users.findById(req.user.id);
    if (!u.two_fa_enabled) return res.status(400).json({ error: '2FA is not enabled' });
    if (!u.two_fa_secret) return res.status(400).json({ error: '2FA secret missing; cannot verify disable' });

    const pwOk = await bcrypt.compare(password, u.password_hash);
    if (!pwOk) return res.status(401).json({ error: 'Invalid password' });

    // Require TOTP code OR backup code
    const codeOk = Boolean(code) && authenticator.verify({ token: String(code).replace(/\s/g, ''), secret: u.two_fa_secret });
    if (!codeOk) {
        // Check backup code
        const plain = (code||'').toUpperCase().replace(/\s/g,'');
        const hashes = JSON.parse(u.two_fa_backup_codes || '[]');
        const idx = hashes.findIndex(h => bcrypt.compareSync(plain, h));
        if (idx === -1) return res.status(401).json({ error: 'Invalid 2FA code' });
        hashes.splice(idx, 1);
        Users.update(req.user.id, { two_fa_backup_codes: JSON.stringify(hashes) });
    }

    Users.update(req.user.id, { two_fa_enabled: 0, two_fa_secret: null, two_fa_backup_codes: '[]' });
    AuditLog.log({ user_id: req.user.id, username: req.user.username, action: '2fa.disabled', ip: req.ip });
    res.json({ success: true });
});

// ── Regenerate backup codes ──────────────────────────────────────
router.post('/backup-codes', requireAuth(), async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password required' });

    const u = Users.findById(req.user.id);
    if (!u.two_fa_enabled) return res.status(400).json({ error: '2FA not enabled' });

    const pwOk = await bcrypt.compare(password, u.password_hash);
    if (!pwOk) return res.status(401).json({ error: 'Invalid password' });

    const plainCodes = genBackupCodes();
    const hashedCodes = plainCodes.map(c => bcrypt.hashSync(c, 10));
    Users.update(req.user.id, { two_fa_backup_codes: JSON.stringify(hashedCodes) });

    AuditLog.log({ user_id: req.user.id, username: req.user.username, action: '2fa.backup_codes_regenerated', ip: req.ip });

    res.json({ backup_codes: plainCodes });
});

// ── Verify TOTP at login (called when session has pending_2fa flag) ─
router.post('/verify', async (req, res) => {
    const { token: sessionToken, code } = req.body;
    if (!sessionToken || !code) return res.status(400).json({ error: 'token and code required' });

    // The temp session token contains user_id but is not a full session
    let payload;
    try {
        payload = JSON.parse(Buffer.from(sessionToken, 'base64url').toString());
    } catch {
        return res.status(400).json({ error: 'Invalid token' });
    }
    if (!payload.user_id || !payload.exp || Date.now() > payload.exp) {
        return res.status(401).json({ error: 'Token expired' });
    }

    const u = Users.findById(payload.user_id);
    if (!u || !u.two_fa_enabled) return res.status(400).json({ error: 'Invalid state' });

    const codeClean = (code||'').replace(/\s/g,'').toUpperCase();
    const totpOk = authenticator.verify({ token: codeClean, secret: u.two_fa_secret });

    if (!totpOk) {
        // Check backup code
        const hashes = JSON.parse(u.two_fa_backup_codes || '[]');
        const idx = hashes.findIndex(h => bcrypt.compareSync(codeClean, h));
        if (idx === -1) {
            AuditLog.log({ user_id: u.id, username: u.username, action: '2fa.verify_failed', ip: req.ip, result: 'fail' });
            await fail2ban.onLoginFailure(req, u.username);
            return res.status(401).json({ error: 'Invalid 2FA code' });
        }
        hashes.splice(idx, 1);
        Users.update(u.id, { two_fa_backup_codes: JSON.stringify(hashes) });
    }

    const { Sessions } = require('../db');
    const newToken = Sessions.create(u.id, req.ip, req.headers['user-agent']);
    Users.recordLogin(u.id, req.ip);
    AuditLog.log({ user_id: u.id, username: u.username, action: '2fa.verify_ok', ip: req.ip });
    fail2ban.onLoginSuccess(req);

    const u2 = Users.findById(u.id);
    setCsrfCookie(req, res);
    res
        .cookie('apix_session', newToken, sessionCookieOpts(req))
        .json({
            success: true,
            token: newToken,
            user: u2 ? { must_change_password: !!u2.must_change_password } : undefined,
        });
});

module.exports = router;
