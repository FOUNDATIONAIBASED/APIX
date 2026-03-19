'use strict';
/**
 * Authentication routes
 * POST /api/auth/setup           — first-time admin account creation
 * POST /api/auth/login           — login, set session cookie (2FA-aware)
 * POST /api/auth/logout          — invalidate session
 * GET  /api/auth/me              — current session info + plan
 * POST /api/auth/change-password
 * POST /api/auth/forgot-password — send reset email
 * POST /api/auth/reset-password  — consume token + set new password
 * POST /api/auth/smtp-test       — test SMTP connection (admin)
 */
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const cfg         = require('../config');
const { Users, Sessions, Plans, ApiKeys, PasswordResets, AuditLog } = require('../db');
const { requireAuth } = require('../auth/middleware');
const mailer  = require('../email/mailer');

const SALT_ROUNDS = 12;
const COLORS = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#ec4899'];

function randColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

// ── Setup check (public) ─────────────────────────────────────
router.get('/setup-status', (req, res) => {
    const noUsers = Users.count() === 0;
    const needsSetup = cfg.allowInitialSetup && noUsers;
    res.json({ needs_setup: needsSetup });
});

// ── First-time admin creation ────────────────────────────────
router.post('/setup', async (req, res) => {
    if (!cfg.allowInitialSetup) return res.status(403).json({ error: 'Initial setup is disabled' });
    if (Users.count() > 0) return res.status(409).json({ error: 'Setup already completed' });

    const { username, password, email, display_name } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Seed default plans first
    Plans.seed();

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const id = 'usr_' + uuidv4().replace(/-/g,'').slice(0,12);
    Users.insert({
        id,
        username:      username.trim(),
        email:         email?.trim() || null,
        password_hash: hash,
        role:          'admin',
        plan_id:       'plan_enterprise', // admin gets enterprise
        status:        'active',
        display_name:  display_name?.trim() || username,
        avatar_color:  randColor(),
    });

    const token = Sessions.create(id, req.ip, req.headers['user-agent']);
    res
        .cookie('apix_session', token, { httpOnly: true, sameSite: 'Lax', maxAge: 30 * 86_400_000 })
        .json({ success: true, token, user: { id, username, role: 'admin', display_name: display_name || username } });
});

// ── Login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

    const user = Users.findByUsername(username) || Users.findByEmail(username);
    if (!user) {
        AuditLog.log({ username, action: 'auth.login_failed', ip: req.ip, result: 'fail', details: { reason: 'user not found' } });
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
        AuditLog.log({ user_id: user.id, username: user.username, action: 'auth.login_failed', ip: req.ip, result: 'fail', details: { reason: 'bad password' } });
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 2FA check: if enabled, issue a short-lived challenge token
    if (user.two_fa_enabled) {
        const payload = JSON.stringify({ user_id: user.id, exp: Date.now() + 5 * 60_000 });
        const challengeToken = Buffer.from(payload).toString('base64url');
        AuditLog.log({ user_id: user.id, username: user.username, action: 'auth.login_2fa_challenge', ip: req.ip });
        return res.json({ requires_2fa: true, challenge_token: challengeToken });
    }

    Users.recordLogin(user.id, req.ip);
    const token = Sessions.create(user.id, req.ip, req.headers['user-agent']);
    const plan = user.plan_id ? Plans.findById(user.plan_id) : Plans.getDefault();
    AuditLog.log({ user_id: user.id, username: user.username, action: 'auth.login_ok', ip: req.ip });

    res
        .cookie('apix_session', token, { httpOnly: true, sameSite: 'Lax', maxAge: 30 * 86_400_000 })
        .json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                display_name: user.display_name,
                avatar_color: user.avatar_color,
                plan_id: user.plan_id,
                two_fa_enabled: !!user.two_fa_enabled,
                must_change_password: !!user.must_change_password,
                plan: plan ? { id: plan.id, name: plan.name, badge: plan.badge, features: plan.features, limits: plan.limits } : null,
            },
        });
});

// ── Logout ────────────────────────────────────────────────────
router.post('/logout', requireAuth(), (req, res) => {
    const { getToken } = require('../auth/middleware');
    Sessions.delete(getToken(req));
    res.clearCookie('apix_session').json({ success: true });
});

// ── Current user ──────────────────────────────────────────────
router.get('/me', requireAuth(), (req, res) => {
    const user = Users.findById(req.user.uid || req.user.user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const plan = user.plan_id ? Plans.findById(user.plan_id) : Plans.getDefault();
    const stats = Users.getStatsSummary(user.id);
    const recentStats = Users.getStats(user.id, 30);
    const apiKeys = require('../db').ApiKeys.findAll().filter(k => k.user_id === user.id);

    res.json({
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            display_name: user.display_name,
            avatar_color: user.avatar_color,
            plan_id: user.plan_id,
            two_fa_enabled: !!user.two_fa_enabled,
            must_change_password: !!user.must_change_password,
            theme: user.theme || 'dark',
            last_login: user.last_login,
            login_count: user.login_count,
            created_at: user.created_at,
        },
        plan: plan ? { id: plan.id, name: plan.name, badge: plan.badge, description: plan.description, price_monthly: plan.price_monthly, price_yearly: plan.price_yearly, currency: plan.currency, purchase_url: plan.purchase_url, features: plan.features, limits: plan.limits } : null,
        stats,
        recent_stats: recentStats,
        api_keys: apiKeys.map(k => ({ id: k.id, name: k.name, prefix: k.key_prefix, enabled: k.enabled, created_at: k.created_at })),
    });
});

// ── Change password ───────────────────────────────────────────
router.post('/change-password', requireAuth(), async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const user = Users.findById(req.user.uid || req.user.user_id);
    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    Users.update(user.id, { password_hash: hash, must_change_password: 0 });
    // Invalidate all other sessions
    Sessions.deleteAllForUser(user.id);
    const newToken = Sessions.create(user.id, req.ip, req.headers['user-agent']);
    res.cookie('apix_session', newToken, { httpOnly: true, sameSite: 'Lax', maxAge: 30 * 86_400_000 })
        .json({ success: true, token: newToken });
});

// ── Forgot password ───────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    // Always respond success to prevent user enumeration
    const user = Users.findByEmail(email) || Users.findByUsername(email);
    if (user && user.email) {
        try {
            const token = PasswordResets.create(user.id);
            const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
            const host  = req.headers['x-forwarded-host'] || req.headers.host;
            const resetUrl = `${proto}://${host}/reset-password?token=${token}`;
            await mailer.sendPasswordReset(user.email, user.username, resetUrl);
        } catch (err) {
            console.error('[AUTH] forgot-password error:', err.message);
        }
    }
    // Always return 200 — don't reveal if email exists
    res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
});

// ── Reset password (consume token) ───────────────────────────
router.post('/reset-password', async (req, res) => {
    const { token, new_password } = req.body;
    if (!token || !new_password) return res.status(400).json({ error: 'token and new_password required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const row = PasswordResets.verify(token);
    if (!row) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    Users.update(row.user_id, { password_hash: hash });
    PasswordResets.consume(token);
    Sessions.deleteAllForUser(row.user_id);

    res.json({ success: true, message: 'Password updated. Please sign in.' });
});

// ── Verify reset token (GET, used by reset page) ─────────────
router.get('/reset-password', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token required' });
    const row = PasswordResets.verify(token);
    if (!row) return res.json({ valid: false, reason: 'Invalid or expired token' });
    res.json({ valid: true, username: row.username });
});

// ── SMTP test (admin) ─────────────────────────────────────────
router.post('/smtp-test', requireAuth('admin'), async (req, res) => {
    const result = await mailer.testConnection();
    res.json(result);
});

// ── Theme preference ──────────────────────────────────────────
router.put('/theme', requireAuth(), (req, res) => {
    const { theme } = req.body;
    if (!['dark','light'].includes(theme)) return res.status(400).json({ error: 'theme must be dark or light' });
    Users.update(req.user.uid || req.user.user_id, { theme });
    res.json({ success: true, theme });
});

// ── Update profile (display_name, email, avatar_color) ────────
router.put('/profile', requireAuth(), async (req, res) => {
    const userId = req.user.uid || req.user.user_id;
    const u = Users.findById(userId);
    const updates = {};
    if (req.body.display_name !== undefined) updates.display_name = req.body.display_name?.trim().slice(0,80) || u.display_name;
    if (req.body.email        !== undefined) updates.email = req.body.email?.trim().toLowerCase() || null;
    if (req.body.avatar_color !== undefined) updates.avatar_color = req.body.avatar_color;
    Users.update(userId, updates);
    AuditLog.log({ user_id: userId, username: u.username, action: 'profile.update', ip: req.ip });
    res.json({ success: true });
});

// ── IP Allowlist ──────────────────────────────────────────────
router.put('/ip-allowlist', requireAuth(), (req, res) => {
    const userId = req.user.uid || req.user.user_id;
    const { ips } = req.body;
    if (!Array.isArray(ips)) return res.status(400).json({ error: 'ips must be an array of strings' });
    // Validate entries
    const cleaned = ips.map(s => String(s).trim()).filter(Boolean);
    Users.update(userId, { ip_allowlist: JSON.stringify(cleaned) });
    AuditLog.log({ user_id: userId, username: req.user.username, action: 'profile.ip_allowlist_update', ip: req.ip, details: { count: cleaned.length } });
    res.json({ success: true, count: cleaned.length });
});

router.get('/ip-allowlist', requireAuth(), (req, res) => {
    const u = Users.findById(req.user.uid || req.user.user_id);
    let ips = [];
    try { ips = JSON.parse(u.ip_allowlist || '[]'); } catch {}
    res.json({ ips });
});

module.exports = router;
