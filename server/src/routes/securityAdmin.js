'use strict';
/**
 * Admin-only security: IP rules, discovery hints, mDNS browse, GitHub ban export, fail2ban settings.
 */
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../auth/middleware');
const {
    getDb, IpSecurity, DiscoveryHints, Settings, Sessions,
} = require('../db');
const { browseApixOnLan } = require('../mdns');
const { syncBannedIpsToGitHub } = require('../security/githubBanSync');

router.use(requireAdmin);

// ── Fail2ban settings (stored in settings table) ───────────────
router.get('/settings', (_req, res) => {
    res.json({
        fail2ban_enabled: Settings.get('fail2ban_enabled', '1'),
        fail2ban_threshold: Settings.get('fail2ban_threshold', '8'),
        fail2ban_window_minutes: Settings.get('fail2ban_window_minutes', '15'),
        github_sync_repo: Settings.get('github_sync_repo', ''),
        github_sync_path: Settings.get('github_sync_path', 'security/banned-ips.txt'),
        github_sync_branch: Settings.get('github_sync_branch', 'main'),
        github_token_configured: !!Settings.get('github_sync_token', ''),
    });
});

router.put('/settings', (req, res) => {
    const b = req.body || {};
    if (b.fail2ban_enabled !== undefined) Settings.set('fail2ban_enabled', b.fail2ban_enabled ? '1' : '0');
    if (b.fail2ban_threshold !== undefined) Settings.set('fail2ban_threshold', String(Math.max(3, parseInt(b.fail2ban_threshold, 10) || 8)));
    if (b.fail2ban_window_minutes !== undefined) {
        Settings.set('fail2ban_window_minutes', String(Math.max(1, parseInt(b.fail2ban_window_minutes, 10) || 15)));
    }
    if (b.github_sync_repo !== undefined) Settings.set('github_sync_repo', String(b.github_sync_repo || '').trim());
    if (b.github_sync_path !== undefined) Settings.set('github_sync_path', String(b.github_sync_path || '').trim());
    if (b.github_sync_branch !== undefined) Settings.set('github_sync_branch', String(b.github_sync_branch || 'main').trim());
    res.json({ success: true });
});

router.put('/github-token', (req, res) => {
    const { token } = req.body || {};
    if (token === undefined) return res.status(400).json({ error: 'token field required (empty string to clear)' });
    Settings.set('github_sync_token', String(token));
    res.json({ success: true, github_token_configured: !!String(token).trim() });
});

// ── IP rules ───────────────────────────────────────────────────
router.get('/ip-rules', (_req, res) => {
    res.json({ rules: IpSecurity.listRules() });
});

router.post('/ip-rules', (req, res) => {
    const { cidr, mode, note, expires_at } = req.body || {};
    if (!cidr || !mode || !['allow', 'block'].includes(mode)) {
        return res.status(400).json({ error: 'cidr and mode (allow|block) required' });
    }
    const id = IpSecurity.addRule({
        cidr,
        mode,
        note: note || null,
        source: 'manual',
        expires_at: expires_at || null,
        created_by: req.user.uid || req.user.user_id || null,
    });
    res.json({ success: true, id });
});

router.delete('/ip-rules/:id', (req, res) => {
    IpSecurity.deleteRule(req.params.id);
    res.json({ success: true });
});

// ── Block IP from an active session row ─────────────────────────
router.post('/block-session-ip', (req, res) => {
    const { session_token } = req.body || {};
    if (!session_token) return res.status(400).json({ error: 'session_token required' });
    const row = getDb().prepare(
        'SELECT ip FROM user_sessions WHERE token=?',
    ).get(session_token);
    if (!row?.ip) return res.status(404).json({ error: 'Session not found' });
    const ip = IpSecurity.normalizeIp(row.ip);
    const cidr = ip.includes(':') ? ip : `${ip}/32`;
    const id = IpSecurity.addRule({
        cidr,
        mode: 'block',
        note: 'Blocked via session list',
        source: 'manual',
        created_by: req.user.uid || req.user.user_id,
    });
    try { Sessions.delete(session_token); } catch (_) {}
    res.json({ success: true, rule_id: id, cidr });
});

// ── Discovery hints (from Android clients) ─────────────────────
router.get('/discovery-hints', (_req, res) => {
    res.json({ hints: DiscoveryHints.findAll(200) });
});

router.delete('/discovery-hints', (_req, res) => {
    DiscoveryHints.clear();
    res.json({ success: true });
});

// ── mDNS browse (other gateways on LAN) ───────────────────────
router.get('/mdns-scan', async (_req, res) => {
    try {
        const services = await browseApixOnLan(4000);
        res.json({ services });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── GitHub export ─────────────────────────────────────────────
router.post('/github-sync', async (_req, res) => {
    try {
        const result = await syncBannedIpsToGitHub();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
