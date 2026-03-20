'use strict';
/**
 * Admin system routes
 * POST /api/v1/admin/factory-reset      — wipe all data, return to setup state
 * GET  /api/v1/admin/sessions           — list all active sessions (admin) or own (user)
 * DELETE /api/v1/admin/sessions/:token  — revoke a session
 * GET  /api/v1/admin/audit              — audit log
 * GET  /api/v1/admin/update-check       — semver compare to GitHub (incl. pre-releases unless GITHUB_RELEASES_STABLE_ONLY)
 * GET  /api/v1/admin/github-releases    — latest release + APK download URLs (auth)
 * GET  /api/v1/admin/system-info        — CPU, memory, disk, uptime
 * POST /api/v1/admin/audit/purge        — purge old audit logs (admin)
 */
const router = require('express').Router();
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const cfg = require('../config');
const { getDb, AuditLog, Sessions, Users } = require('../db');
const { requireAuth, requireAdmin } = require('../auth/middleware');
const githubVersion = require('../util/githubVersion');

/** Cached GitHub releases list + computed “newest” (includes pre-releases unless GITHUB_RELEASES_STABLE_ONLY=true). */
let _githubBundleCache = { ts: 0, key: '', bundle: null };
function _githubBundleTtlMs() {
    const n = parseInt(process.env.GITHUB_VERSION_CACHE_MS || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 900_000; // 15 min
}

async function fetchGithubReleaseBundle() {
    const repo = process.env.GITHUB_REPO || 'FOUNDATIONAIBASED/APIX';
    const stableOnly = process.env.GITHUB_RELEASES_STABLE_ONLY === 'true';
    const key = `${repo}|${stableOnly}`;
    const now = Date.now();
    if (_githubBundleCache.bundle && _githubBundleCache.key === key
        && (now - _githubBundleCache.ts) < _githubBundleTtlMs()) {
        return _githubBundleCache.bundle;
    }
    const axios = require('axios');
    const resp = await axios.get(`https://api.github.com/repos/${repo}/releases`, {
        params: { per_page: 100 },
        headers: { 'User-Agent': 'ApiX-Gateway', Accept: 'application/vnd.github+json' },
        timeout: 15000,
    });
    const newest = githubVersion.pickNewestRelease(resp.data, stableOnly);
    const bundle = { repo, stableOnly, releases: resp.data, newest };
    _githubBundleCache = { ts: now, key, bundle };
    return bundle;
}

// ── Factory Reset ────────────────────────────────────────────────
router.post('/factory-reset', requireAdmin, async (req, res) => {
    const { confirmation } = req.body;
    if (confirmation !== 'FACTORY RESET') {
        return res.status(400).json({ error: 'Type exactly: FACTORY RESET' });
    }

    AuditLog.log({
        user_id: req.user.id, username: req.user.username,
        action: 'admin.factory_reset', ip: req.ip,
        details: { user_agent: req.headers['user-agent'] },
    });

    try {
        const db = getDb();
        // Every application table (schema in db.js). FKs off so order is safe.
        const tables = [
            'drip_enrollments', 'drip_steps', 'drip_sequences',
            'webhook_deliveries', 'webhook_rules', 'webhooks',
            'sim_cards', 'messages', 'conversations',
            'contact_list_members', 'contact_lists', 'contacts',
            'opt_outs', 'message_templates', 'api_keys',
            'campaigns', 'scheduled_messages',
            'llm_rules', 'llm_sessions', 'llm_instances',
            'analytics_hourly',
            'number_group_members', 'number_groups',
            'recipient_group_members', 'recipient_groups',
            'password_reset_tokens', 'pairing_tokens',
            'backup_jobs', 'backup_schedules', 'backup_destinations',
            'audit_logs', 'keyword_rules',
            'user_sessions', 'user_stats', 'users',
            'devices',
            'plans', 'roles',
            'ip_security_rules', 'device_discovery_hints', 'login_fail_counters', 'unban_challenge_tokens',
            'settings',
        ];
        db.pragma('foreign_keys = OFF');
        db.transaction(() => {
            for (const t of tables) {
                try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
            }
            try { db.prepare('DELETE FROM sqlite_sequence').run(); } catch { /* no autoincrement tables */ }
        })();
        db.pragma('foreign_keys = ON');
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }

        const dataDir = path.dirname(cfg.dbPath);
        if (fs.existsSync(dataDir)) {
            for (const f of fs.readdirSync(dataDir)) {
                if (f.endsWith('.zip') || f.endsWith('.json') || f.endsWith('.enc')) {
                    try { fs.unlinkSync(path.join(dataDir, f)); } catch {}
                }
            }
            const backupsDir = path.join(dataDir, 'backups');
            if (fs.existsSync(backupsDir)) {
                try {
                    fs.rmSync(backupsDir, { recursive: true, force: true });
                    fs.mkdirSync(backupsDir, { recursive: true });
                } catch { /* ignore */ }
            }
        }

        res.json({ success: true, message: 'Factory reset complete. Please reload.' });

        // Delayed process exit so response can be sent; pm2/apix.sh will restart
        setTimeout(() => process.exit(0), 500);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Sessions ─────────────────────────────────────────────────────
router.get('/sessions', requireAuth(), (req, res) => {
    if (req.user.role === 'admin') {
        return res.json({ sessions: Sessions.findAll(200) });
    }
    res.json({ sessions: Sessions.findForUser(req.user.uid || req.user.user_id) });
});

router.delete('/sessions/:token', requireAuth(), (req, res) => {
    const { token } = req.params;
    if (req.user.role === 'admin') {
        Sessions.delete(token);
    } else {
        Sessions.deleteById(token, req.user.uid || req.user.user_id);
    }
    AuditLog.log({ user_id: req.user.id, username: req.user.username, action: 'session.revoke', resource: 'session', resource_id: token, ip: req.ip });
    res.json({ success: true });
});

router.patch('/sessions/:token/label', requireAuth(), (req, res) => {
    const { label } = req.body;
    Sessions.updateLabel(req.params.token, label || null);
    res.json({ success: true });
});

// ── Audit Log ────────────────────────────────────────────────────
router.get('/audit', requireAdmin, (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const filter = {};
    if (req.query.user_id) filter.user_id = req.query.user_id;
    if (req.query.action)  filter.action  = req.query.action;
    if (req.query.from)    filter.from    = req.query.from;
    const rows = AuditLog.findAll(limit, offset, filter);
    res.json({ logs: rows, limit, offset });
});

router.post('/audit/purge', requireAdmin, (req, res) => {
    const days = parseInt(req.body.older_than_days) || 90;
    AuditLog.purgeOlderThan(days);
    AuditLog.log({ user_id: req.user.id, username: req.user.username, action: 'audit.purge', ip: req.ip, details: { days } });
    res.json({ success: true });
});

// ── Update Checker (semver incl. pre-release, e.g. v0.0.1-rc1) ────
router.get('/update-check', requireAuth(), async (req, res) => {
    const pkg = require('../../package.json');
    const currentRaw = pkg.version || '0.0.0';
    const current = githubVersion.normalizePackageVersion(currentRaw);
    try {
        const bundle = await fetchGithubReleaseBundle();
        if (!bundle.newest) {
            return res.json({
                current_version: current,
                latest_version: null,
                latest_tag: null,
                update_available: false,
                local_ahead: false,
                up_to_date: true,
                no_releases: true,
                includes_prereleases: !bundle.stableOnly,
                github_repo: bundle.repo,
                message: 'No GitHub releases found (or all are draft).',
            });
        }
        const remoteSem = githubVersion.versionFromTag(bundle.newest.tag_name);
        const cmp = githubVersion.compareVersions(currentRaw, remoteSem);
        const data = {
            current_version: current,
            latest_version: remoteSem || bundle.newest.tag_name?.replace(/^v/i, '') || null,
            latest_tag: bundle.newest.tag_name,
            is_prerelease: !!bundle.newest.prerelease,
            release_name: bundle.newest.name,
            release_url: bundle.newest.html_url,
            published_at: bundle.newest.published_at,
            update_available: cmp.comparable && cmp.update_available,
            local_ahead: cmp.comparable && cmp.local_ahead,
            up_to_date: cmp.comparable && !cmp.update_available && !cmp.local_ahead,
            comparable: cmp.comparable,
            includes_prereleases: !bundle.stableOnly,
            github_repo: bundle.repo,
        };
        res.json(data);
    } catch (err) {
        res.json({
            error: 'Could not reach GitHub',
            message: err.message,
            current_version: current,
            update_available: false,
            local_ahead: false,
            up_to_date: null,
        });
    }
});

/** Score how likely an APK is the QKSMS / presentation build (higher = better match). */
function _qksmsApkScore(name) {
    const n = String(name).toLowerCase();
    if (!n.endsWith('.apk')) return -1;
    if (n.includes('qksms')) return 100;
    if (n.includes('noanalytics')) return 85;
    if (n.includes('presentation')) return 70;
    return 0;
}

/** Score ApiX Agent APK. */
function _agentApkScore(name) {
    const n = String(name).toLowerCase();
    if (!n.endsWith('.apk')) return -1;
    if (n.includes('apix') && n.includes('agent')) return 100;
    if (n.includes('agent') && n.includes('debug')) return 40;
    if (n.includes('client') && n.includes('debug')) return 35;
    return 0;
}

// ── GitHub releases (APK downloads — same “newest” logic as update-check) ──
router.get('/github-releases', requireAuth(), async (req, res) => {
    try {
        const bundle = await fetchGithubReleaseBundle();
        if (!bundle.newest) {
            const [owner, name] = String(bundle.repo).split('/');
            return res.json({
                repo: bundle.repo,
                tag: null,
                semver: null,
                is_prerelease: false,
                name: null,
                html_url: owner && name ? `https://github.com/${owner}/${name}/releases` : null,
                published_at: null,
                assets: [],
                qksms_best: null,
                agent_best: null,
                includes_prereleases: !bundle.stableOnly,
                no_releases: true,
            });
        }
        const rel = bundle.newest;
        const assets = (rel.assets || [])
            .filter((a) => /\.apk$/i.test(a.name || ''))
            .map((a) => {
                const name = a.name;
                const qs = _qksmsApkScore(name);
                const ag = _agentApkScore(name);
                let hint = '';
                if (qs > 0 && qs >= ag) hint = 'Likely QKSMS / presentation build';
                else if (ag > 0) hint = 'Likely ApiX Agent';
                return {
                    name,
                    url: a.browser_download_url,
                    size: a.size || 0,
                    hint,
                    qksms_score: qs,
                    agent_score: ag,
                };
            });

        let qksms_best = null;
        let agent_best = null;
        for (const a of assets) {
            if (a.qksms_score > 0 && (!qksms_best || a.qksms_score > qksms_best.qksms_score)) {
                qksms_best = a;
            }
            if (a.agent_score > 0 && (!agent_best || a.agent_score > agent_best.agent_score)) {
                agent_best = a;
            }
        }

        const remoteSem = githubVersion.versionFromTag(rel.tag_name);
        res.json({
            repo: bundle.repo,
            tag: rel.tag_name,
            semver: remoteSem,
            is_prerelease: !!rel.prerelease,
            name: rel.name,
            html_url: rel.html_url,
            published_at: rel.published_at,
            assets,
            qksms_best: qksms_best ? { name: qksms_best.name, url: qksms_best.url, size: qksms_best.size } : null,
            agent_best: agent_best ? { name: agent_best.name, url: agent_best.url, size: agent_best.size } : null,
            includes_prereleases: !bundle.stableOnly,
        });
    } catch (err) {
        const msg = err.response?.status === 404
            ? 'Repository or releases not found.'
            : (err.message || 'GitHub request failed');
        res.status(502).json({ error: msg, repo: process.env.GITHUB_REPO || 'FOUNDATIONAIBASED/APIX' });
    }
});

// ── System Info ───────────────────────────────────────────────────
router.get('/system-info', requireAdmin, (req, res) => {
    const uptime = process.uptime();
    const mem    = process.memoryUsage();
    const sysMem = { total: os.totalmem(), free: os.freemem() };

    let dbSize = null;
    const dbPath = path.join(__dirname, '../../data/apix.db');
    try { dbSize = fs.statSync(dbPath).size; } catch {}

    res.json({
        uptime_seconds: Math.floor(uptime),
        node_version:   process.version,
        platform:       process.platform,
        arch:           process.arch,
        memory: {
            heap_used:    mem.heapUsed,
            heap_total:   mem.heapTotal,
            rss:          mem.rss,
            system_total: sysMem.total,
            system_free:  sysMem.free,
        },
        db_size_bytes: dbSize,
        cpu_count:     os.cpus().length,
        load_avg:      os.loadavg(),
        hostname:      os.hostname(),
    });
});

module.exports = router;
