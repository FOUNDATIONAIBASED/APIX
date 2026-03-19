'use strict';
const router = require('express').Router();
const { ApiKeys, AuditLog } = require('../db');
const { validateRequired } = require('../security');
const { requireAuth } = require('../auth/middleware');

// GET /api/v1/apikeys
router.get('/', (req, res) => {
    const keys = ApiKeys.findAll().map(k => ({
        ...k,
        sandbox:    !!k.sandbox,
        enabled:    !!k.enabled,
    }));
    res.json({ keys });
});

// POST /api/v1/apikeys
router.post('/', requireAuth(), (req, res) => {
    const err = validateRequired(req.body, ['name']);
    if (err) return res.status(400).json({ error: err });

    const perms = req.body.permissions || ['messages:read', 'messages:write'];
    if (!Array.isArray(perms)) return res.status(400).json({ error: 'permissions must be array' });

    const key = ApiKeys.generate(req.body.name, perms);

    // Attach optional extras
    const updates = {};
    if (req.body.sandbox !== undefined) updates.sandbox = req.body.sandbox ? 1 : 0;
    if (req.body.label)                 updates.label   = req.body.label;
    if (req.body.rate_limit_override)   updates.rate_limit_override = parseInt(req.body.rate_limit_override);
    if (req.user?.id)                   updates.user_id = req.user.id;
    if (Object.keys(updates).length) {
        const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
        const vals = [...Object.values(updates), key.id];
        try { require('../db').getDb().prepare(`UPDATE api_keys SET ${sets} WHERE id=?`).run(...vals); } catch {}
    }

    AuditLog.log({ user_id: req.user?.id, username: req.user?.username, action: 'apikey.create', resource_id: key.id, ip: req.ip });

    res.status(201).json({
        message: 'API key created. Copy the key now — it will NOT be shown again.',
        ...key,
        sandbox: !!updates.sandbox,
    });
});

// PUT /api/v1/apikeys/:id  — update label, sandbox, rate limit
router.put('/:id', requireAuth(), (req, res) => {
    const key = ApiKeys.findAll().find(k => k.id === req.params.id);
    if (!key) return res.status(404).json({ error: 'Not found' });

    const allowed = ['label','sandbox','rate_limit_override','enabled'];
    const sets = [], vals = [];
    for (const f of allowed) {
        if (req.body[f] !== undefined) {
            sets.push(`${f}=?`);
            vals.push(f === 'sandbox' || f === 'enabled' ? (req.body[f] ? 1 : 0) : req.body[f]);
        }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    require('../db').getDb().prepare(`UPDATE api_keys SET ${sets.join(',')} WHERE id=?`).run(...vals);
    AuditLog.log({ user_id: req.user?.id, username: req.user?.username, action: 'apikey.update', resource_id: req.params.id, ip: req.ip });
    res.json({ success: true });
});

// POST /api/v1/apikeys/:id/rotate  — generate a new key value, invalidate old one
router.post('/:id/rotate', requireAuth(), (req, res) => {
    const existing = ApiKeys.findAll().find(k => k.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const crypto  = require('crypto');
    const newRaw  = 'apix_' + crypto.randomBytes(24).toString('hex');
    const newHash = require('crypto').createHash('sha256').update(newRaw).digest('hex');
    const prefix  = newRaw.slice(0, 10);

    require('../db').getDb().prepare(
        "UPDATE api_keys SET key_hash=?, key_prefix=?, updated_at=datetime('now') WHERE id=?"
    ).run(newHash, prefix, req.params.id);

    AuditLog.log({ user_id: req.user?.id, username: req.user?.username, action: 'apikey.rotate', resource_id: req.params.id, ip: req.ip });

    res.json({
        message: 'API key rotated. Copy the new key now — it will NOT be shown again.',
        id: req.params.id,
        key: newRaw,
        key_prefix: prefix,
    });
});

// DELETE /api/v1/apikeys/:id
router.delete('/:id', requireAuth(), (req, res) => {
    AuditLog.log({ user_id: req.user?.id, username: req.user?.username, action: 'apikey.delete', resource_id: req.params.id, ip: req.ip });
    ApiKeys.delete(req.params.id);
    res.json({ success: true });
});

// POST /api/v1/apikeys/:id/revoke
router.post('/:id/revoke', requireAuth(), (req, res) => {
    AuditLog.log({ user_id: req.user?.id, username: req.user?.username, action: 'apikey.revoke', resource_id: req.params.id, ip: req.ip });
    ApiKeys.revoke(req.params.id);
    res.json({ success: true, message: 'API key revoked.' });
});

module.exports = router;
