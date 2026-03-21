'use strict';
/**
 * Account management routes.
 *
 * Role capabilities:
 *   admin   → full CRUD + plan management + role assignment
 *   mod     → view accounts, suspend/unsuspend
 *   support → view + edit basic info (display_name, email, notes)
 *   user    → only self-service (apply-key)
 *
 * GET    /api/v1/accounts              — list  (admin/mod/support)
 * GET    /api/v1/accounts/:id          — detail (admin/mod/support)
 * POST   /api/v1/accounts              — create (admin)
 * PUT    /api/v1/accounts/:id          — update (admin = full; support = basic only)
 * DELETE /api/v1/accounts/:id          — delete (admin)
 * POST   /api/v1/accounts/:id/set-plan — assign plan (admin)
 * POST   /api/v1/accounts/:id/set-role — assign role (admin)
 * POST   /api/v1/accounts/:id/suspend  — suspend (admin + mod)
 * POST   /api/v1/accounts/:id/unsuspend— unsuspend (admin + mod)
 * POST   /api/v1/accounts/:id/reset-password (admin)
 * GET    /api/v1/accounts/:id/stats    (admin/mod/support)
 * POST   /api/v1/accounts/apply-key   — self-service plan activation (any auth)
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Users, Sessions, Plans, Roles, getDb } = require('../db');
const { requireAuth, requireAdmin, requirePerm, requireAnyRole, can } = require('../auth/middleware');
const mailer = require('../email/mailer');

const SALT_ROUNDS = 12;
const COLORS = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#ec4899'];

/** Email shape check without polynomial-time regex (ReDoS-safe). */
function isValidEmail(s) {
    const t = String(s || '').trim().toLowerCase();
    if (t.length < 5 || t.length > 254) return false;
    const at = t.indexOf('@');
    if (at < 1 || at === t.length - 1) return false;
    const local = t.slice(0, at);
    const domain = t.slice(at + 1);
    if (!domain.includes('.') || local.includes('@') || domain.includes('@')) return false;
    if (/[\s]/.test(local) || /[\s]/.test(domain)) return false;
    return true;
}

// ── helpers ────────────────────────────────────────────────────
function safe(user) {
    const u = { ...user };
    delete u.password_hash;
    delete u.two_fa_secret;
    return u;
}

function enrichUser(u) {
    return {
        ...safe(u),
        plan:  u.plan_id ? Plans.findById(u.plan_id) : Plans.getDefault(),
        stats: Users.getStatsSummary(u.id),
    };
}

// ── List accounts (admin / mod / support) ─────────────────────
router.get('/', requirePerm('accounts:view'), (req, res) => {
    const users = Users.findAll();
    res.json({ accounts: users.map(enrichUser), total: users.length });
});

// ── Get single account (admin / mod / support) ────────────────
router.get('/:id', requirePerm('accounts:view'), (req, res) => {
    const user = Users.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const keys = can(req.user, 'accounts:edit_plan')
        ? getDb().prepare('SELECT id,label,prefix,enabled,plan_id,created_at FROM api_keys WHERE user_id=?').all(req.params.id)
        : [];
    const recent = Users.getStats(req.params.id, 30);
    res.json({ ...safe(user), plan: user.plan_id ? Plans.findById(user.plan_id) : Plans.getDefault(), stats: Users.getStatsSummary(user.id), recent_stats: recent, api_keys: keys });
});

// ── Invite by email (admin only) — sends OTP, must_change_password ──
router.post('/invite', requirePerm('accounts:create'), async (req, res) => {
    const { username, email, role = 'user', plan_id, display_name } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'username and email required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username too short (min 3)' });
    const emailTrim = String(email).trim().toLowerCase();
    if (!isValidEmail(emailTrim)) return res.status(400).json({ error: 'Valid email required' });
    if (Users.findByUsername(username)) return res.status(409).json({ error: 'Username already taken' });
    if (Users.findByEmail(emailTrim)) return res.status(409).json({ error: 'Email already registered' });

    const allRoles = Roles.findAll().map(r => r.id);
    const resolvedRole = allRoles.includes(role) ? role : 'user';
    const resolvedPlanId = plan_id || Plans.getDefault()?.id || null;

    const oneTimePassword = crypto.randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
    const hash = await bcrypt.hash(oneTimePassword, SALT_ROUNDS);
    const id = 'usr_' + uuidv4().replace(/-/g, '').slice(0, 12);
    Users.insert({
        id,
        username: username.trim(),
        email: emailTrim,
        password_hash: hash,
        role: resolvedRole,
        plan_id: resolvedPlanId,
        status: 'active',
        display_name: (display_name || username).trim(),
        avatar_color: COLORS[Math.floor(Math.random() * COLORS.length)],
        must_change_password: true,
    });

    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const loginUrl = `${proto}://${host}/login`;

    try {
        await mailer.sendInvite(emailTrim, username.trim(), oneTimePassword, loginUrl);
    } catch (err) {
        console.error('[ACCOUNTS] invite email error:', err.message);
        Users.delete(id);
        return res.status(500).json({ error: 'Account created but email failed. Check SMTP config.' });
    }

    const user = Users.findById(id);
    res.status(201).json({ success: true, user: safe(user), message: 'Invitation email sent. User must change password on first login.' });
});

// ── Create account (admin only) ───────────────────────────────
router.post('/', requirePerm('accounts:create'), async (req, res) => {
    const { username, password, email, role = 'user', plan_id, display_name } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username too short (min 3)' });
    if (password.length < 8) return res.status(400).json({ error: 'Password too short (min 8)' });
    if (Users.findByUsername(username)) return res.status(409).json({ error: 'Username already taken' });
    if (email && Users.findByEmail(email)) return res.status(409).json({ error: 'Email already registered' });

    // Validate role exists
    const allRoles = Roles.findAll().map(r => r.id);
    const resolvedRole = allRoles.includes(role) ? role : 'user';
    const resolvedPlanId = plan_id || Plans.getDefault()?.id || null;

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const id   = 'usr_' + uuidv4().replace(/-/g,'').slice(0,12);
    Users.insert({
        id,
        username:      username.trim(),
        email:         email?.trim() || null,
        password_hash: hash,
        role:          resolvedRole,
        plan_id:       resolvedPlanId,
        status:        'active',
        display_name:  display_name?.trim() || username,
        avatar_color:  COLORS[Math.floor(Math.random() * COLORS.length)],
    });
    const user = Users.findById(id);
    res.status(201).json({ success: true, user: safe(user) });
});

// ── Update account ─────────────────────────────────────────────
// admin → full update (role, plan, status, all fields)
// support → only display_name, email, notes  (accounts:edit_basic)
router.put('/:id', requirePerm('accounts:edit_basic'), (req, res) => {
    const user = Users.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updates = {};

    if (can(req.user, 'accounts:edit_plan')) {
        // admin / anyone with plan perm can change plan
        if (req.body.plan_id !== undefined) updates.plan_id = req.body.plan_id || null;
    }

    if (req.user.role === 'admin') {
        // Admin can change everything
        const allRoles = Roles.findAll().map(r => r.id);
        if (req.body.role && allRoles.includes(req.body.role)) updates.role = req.body.role;
        if (req.body.status && ['active','suspended'].includes(req.body.status)) updates.status = req.body.status;
        if (req.body.avatar_color) updates.avatar_color = req.body.avatar_color;
    }

    // All allowed roles can update basic info
    if (req.body.display_name) updates.display_name = req.body.display_name;
    if (req.body.email !== undefined) updates.email = req.body.email || null;
    if (req.body.notes !== undefined) updates.notes = req.body.notes;

    Users.update(req.params.id, updates);
    if (updates.status === 'suspended') Sessions.deleteAllForUser(req.params.id);

    res.json({ success: true });
});

// ── Assign plan (admin) ───────────────────────────────────────
router.post('/:id/set-plan', requirePerm('accounts:edit_plan'), (req, res) => {
    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
    const plan = Plans.findById(plan_id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    Users.update(req.params.id, { plan_id });
    res.json({ success: true, plan_id, plan_name: plan.name });
});

// ── Assign role (admin) ───────────────────────────────────────
router.post('/:id/set-role', requireAdmin, (req, res) => {
    const { role_id } = req.body;
    if (!role_id) return res.status(400).json({ error: 'role_id required' });

    const user = Users.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Cannot remove the last admin
    if (user.role === 'admin' && role_id !== 'admin') {
        const adminCount = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
        if (adminCount <= 1) return res.status(409).json({ error: 'Cannot demote the last admin account' });
    }

    const role = Roles.findById(role_id);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    Users.update(req.params.id, { role: role_id });
    res.json({ success: true, role_id, role_name: role.name });
});

// ── Suspend / unsuspend (admin + mod) ─────────────────────────
router.post('/:id/suspend', requirePerm('accounts:suspend'), (req, res) => {
    const user = Users.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const selfId = req.user.uid || req.user.user_id;
    if (req.params.id === selfId) return res.status(400).json({ error: 'Cannot suspend your own account' });
    Users.update(req.params.id, { status: 'suspended' });
    Sessions.deleteAllForUser(req.params.id);
    res.json({ success: true });
});

router.post('/:id/unsuspend', requirePerm('accounts:suspend'), (req, res) => {
    const user = Users.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    Users.update(req.params.id, { status: 'active' });
    res.json({ success: true });
});

// ── Reset password (admin) ────────────────────────────────────
router.post('/:id/reset-password', requireAdmin, async (req, res) => {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Password min 8 chars' });
    const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
    Users.update(req.params.id, { password_hash: hash });
    Sessions.deleteAllForUser(req.params.id);
    res.json({ success: true });
});

// ── Delete account (admin) ────────────────────────────────────
router.delete('/:id', requirePerm('accounts:delete'), (req, res) => {
    const selfId = req.user.uid || req.user.user_id;
    if (req.params.id === selfId) return res.status(400).json({ error: 'Cannot delete your own account' });

    const user = Users.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Prevent deleting last admin
    if (user.role === 'admin') {
        const adminCount = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
        if (adminCount <= 1) return res.status(409).json({ error: 'Cannot delete the last admin account' });
    }

    Sessions.deleteAllForUser(req.params.id);
    Users.delete(req.params.id);
    res.json({ success: true });
});

// ── Per-user stats (admin / mod / support) ───────────────────
router.get('/:id/stats', requirePerm('accounts:view'), (req, res) => {
    const days = parseInt(req.query.days || '30', 10);
    res.json({
        summary: Users.getStatsSummary(req.params.id),
        daily:   Users.getStats(req.params.id, days),
    });
});

// ── Self-service: apply API key to activate plan ──────────────
router.post('/apply-key', requireAuth(), async (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });

    const userId = req.user.uid || req.user.user_id;
    const crypto = require('crypto');
    const all    = getDb().prepare('SELECT * FROM api_keys WHERE enabled=1').all();
    let matched  = null;
    for (const row of all) {
        const testHash = crypto.createHash('sha256').update(key).digest('hex');
        if (row.key_hash === testHash) { matched = row; break; }
    }

    if (!matched) return res.status(401).json({ error: 'Invalid API key' });
    if (!matched.plan_id) return res.status(400).json({ error: 'This key has no plan assigned' });

    const plan = Plans.findById(matched.plan_id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    getDb().prepare('UPDATE api_keys SET user_id=? WHERE id=?').run(userId, matched.id);
    Users.update(userId, { plan_id: matched.plan_id });

    res.json({ success: true, plan_id: matched.plan_id, plan_name: plan.name, message: `Plan "${plan.name}" activated!` });
});

module.exports = router;
