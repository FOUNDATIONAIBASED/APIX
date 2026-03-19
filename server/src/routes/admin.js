'use strict';
/**
 * Admin system routes
 * POST /api/v1/admin/factory-reset      — wipe all data, return to setup state
 * GET  /api/v1/admin/sessions           — list all active sessions (admin) or own (user)
 * DELETE /api/v1/admin/sessions/:token  — revoke a session
 * GET  /api/v1/admin/audit              — audit log
 * GET  /api/v1/admin/update-check       — check for new GitHub release
 * GET  /api/v1/admin/system-info        — CPU, memory, disk, uptime
 * POST /api/v1/admin/audit/purge        — purge old audit logs (admin)
 */
const router = require('express').Router();
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const { getDb, AuditLog, Sessions, Users } = require('../db');
const { requireAuth, requireAdmin } = require('../auth/middleware');

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
        // Wipe all user-data tables, preserve structure
        const tables = [
            'messages', 'conversations', 'contacts', 'contact_list_members',
            'contact_lists', 'opt_outs', 'message_templates', 'api_keys',
            'webhooks', 'webhook_rules', 'webhook_deliveries', 'campaigns',
            'scheduled_messages', 'llm_instances', 'llm_rules', 'llm_sessions',
            'analytics_hourly', 'number_groups', 'number_group_members',
            'recipient_groups', 'recipient_group_members', 'pairing_tokens',
            'password_reset_tokens', 'backup_destinations', 'backup_jobs',
            'backup_schedules', 'user_sessions', 'user_stats', 'users',
            'plans', 'roles', 'keyword_rules', 'audit_logs',
        ];
        db.transaction(() => {
            for (const t of tables) {
                try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
            }
            // Reset settings to defaults
            try { db.prepare('DELETE FROM settings').run(); } catch {}
            // Delete SQLite sequences
            try { db.prepare("DELETE FROM sqlite_sequence").run(); } catch {}
        })();

        // Delete any local backup files
        const dataDir = path.join(__dirname, '../../data');
        if (fs.existsSync(dataDir)) {
            for (const f of fs.readdirSync(dataDir)) {
                if (f.endsWith('.zip') || f.endsWith('.json') || f.endsWith('.enc')) {
                    try { fs.unlinkSync(path.join(dataDir, f)); } catch {}
                }
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

// ── Update Checker ────────────────────────────────────────────────
let _updateCache = null;
let _updateCacheTs = 0;

router.get('/update-check', requireAuth(), async (req, res) => {
    const CACHE_TTL = 3600_000; // 1 hour
    if (_updateCache && Date.now() - _updateCacheTs < CACHE_TTL) {
        return res.json(_updateCache);
    }
    try {
        const axios = require('axios');
        const repo  = process.env.GITHUB_REPO || 'ApiX-Gateway/ApiX-Gateway';
        const resp  = await axios.get(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { 'User-Agent': 'ApiX-Gateway' },
            timeout: 8000,
        });
        const pkg = require('../../package.json');
        const data = {
            current_version: pkg.version || '1.0.0',
            latest_version:  resp.data.tag_name?.replace(/^v/,'') || '?',
            release_name:    resp.data.name,
            release_url:     resp.data.html_url,
            published_at:    resp.data.published_at,
            update_available: _newerVersion(resp.data.tag_name?.replace(/^v/,''), pkg.version || '1.0.0'),
        };
        _updateCache = data;
        _updateCacheTs = Date.now();
        res.json(data);
    } catch (err) {
        res.json({ error: 'Could not reach GitHub', message: err.message });
    }
});

function _newerVersion(latest, current) {
    if (!latest || !current) return false;
    const a = latest.split('.').map(Number);
    const b = current.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((a[i]||0) > (b[i]||0)) return true;
        if ((a[i]||0) < (b[i]||0)) return false;
    }
    return false;
}

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
