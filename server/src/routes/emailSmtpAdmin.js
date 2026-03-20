'use strict';
/**
 * Admin API: multi-SMTP profiles (max via SMTP_MAX_PROFILES), quotas, routing, usage.
 * GET/PUT /api/auth/email-smtp/config
 * GET     /api/auth/email-smtp/usage
 * POST    /api/auth/email-smtp/test
 */
const router = require('express').Router();
const { requireAdmin } = require('../auth/middleware');
const { Settings } = require('../db');
const smtpConfig = require('../email/smtpConfig');
const smtpRouter = require('../email/smtpRouter');

router.use(requireAdmin);

function mergeIncomingProfiles(incoming) {
    const existing = smtpConfig.parseStoredProfiles();
    const byId = new Map(existing.map(p => [p.id, p]));
    const out = [];
    const arr = Array.isArray(incoming) ? incoming : [];
    for (let i = 0; i < Math.min(arr.length, smtpConfig.getMaxProfiles()); i++) {
        const raw = arr[i];
        const n = smtpConfig.normalizeProfile(raw, i);
        const pRaw = raw && raw.pass != null ? String(raw.pass) : '';
        const skipPass = !pRaw || pRaw === '********' || pRaw.replace(/\*/g, '').trim() === '';
        if (skipPass) {
            const prev = byId.get(n.id) || existing[i];
            if (prev && prev.pass) n.pass = prev.pass;
        }
        out.push(n);
    }
    return out;
}

// GET /api/auth/email-smtp/config
router.get('/config', (_req, res) => {
    const stored = smtpConfig.parseStoredProfiles();
    const profiles = stored.map(smtpConfig.maskProfileForApi);
    const dbCount = smtpConfig.getDbProfiles().length;
    const legacy = smtpConfig.envLegacyProfile();
    res.json({
        profiles,
        routing_mode: smtpConfig.getRoutingMode(),
        limit_warn_threshold_pct: smtpConfig.getWarnThresholdPct(),
        admin_notify_emails: Settings.get('smtp_admin_notify_emails', ''),
        using_env_fallback: !dbCount && !!legacy,
        max_profiles: smtpConfig.getMaxProfiles(),
    });
});

// PUT /api/auth/email-smtp/config
router.put('/config', (req, res) => {
    const { profiles, routing_mode, limit_warn_threshold_pct, admin_notify_emails } = req.body || {};

    if (profiles !== undefined) {
        if (!Array.isArray(profiles)) return res.status(400).json({ error: 'profiles must be an array' });
        if (profiles.length > smtpConfig.getMaxProfiles()) {
            return res.status(400).json({ error: `At most ${smtpConfig.getMaxProfiles()} SMTP profiles (set SMTP_MAX_PROFILES in .env to raise, max 100)` });
        }
        const merged = mergeIncomingProfiles(profiles);
        Settings.set('smtp_profiles_json', JSON.stringify(merged));
    }

    if (routing_mode !== undefined) {
        const m = String(routing_mode).toLowerCase();
        if (!['fallback', 'round_robin', 'least_used'].includes(m)) {
            return res.status(400).json({ error: 'routing_mode must be fallback, round_robin, or least_used' });
        }
        Settings.set('smtp_routing_mode', m);
    }

    if (limit_warn_threshold_pct !== undefined) {
        const n = parseInt(limit_warn_threshold_pct, 10);
        if (!Number.isFinite(n) || n < 1 || n > 100) {
            return res.status(400).json({ error: 'limit_warn_threshold_pct must be 1–100' });
        }
        Settings.set('smtp_limit_warn_threshold_pct', String(n));
    }

    if (admin_notify_emails !== undefined) {
        Settings.set('smtp_admin_notify_emails', String(admin_notify_emails || '').trim());
    }

    const stored = smtpConfig.parseStoredProfiles();
    res.json({
        success: true,
        profiles: stored.map(smtpConfig.maskProfileForApi),
        routing_mode: smtpConfig.getRoutingMode(),
        limit_warn_threshold_pct: smtpConfig.getWarnThresholdPct(),
        admin_notify_emails: Settings.get('smtp_admin_notify_emails', ''),
        using_env_fallback: !smtpConfig.getDbProfiles().length && !!smtpConfig.envLegacyProfile(),
    });
});

// GET /api/auth/email-smtp/usage
router.get('/usage', (_req, res) => {
    res.json({ usage: smtpRouter.getUsageSnapshot(), routing_mode: smtpConfig.getRoutingMode() });
});

// POST /api/auth/email-smtp/test  body: { profile_id?: string }
router.post('/test', async (req, res) => {
    const id = req.body?.profile_id;
    const all = smtpConfig.getEffectiveProfiles();
    const targets = id ? all.filter(p => p.id === id) : all;
    if (!targets.length) return res.json({ ok: false, reason: 'No SMTP profiles', results: [] });

    const results = [];
    for (const p of targets) {
        results.push(await smtpRouter.testProfile(p));
    }
    const ok = results.length > 0 && results.every(r => r.ok);
    res.json({ ok, results });
});

module.exports = router;
