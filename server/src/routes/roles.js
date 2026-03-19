'use strict';
/**
 * Role management
 * GET    /api/v1/roles          — list all roles (admin + mod + support)
 * GET    /api/v1/roles/:id      — single role detail
 * POST   /api/v1/roles          — create custom role  (admin only)
 * PUT    /api/v1/roles/:id      — update role name/perms/color (admin only, cannot touch system roles' permissions)
 * DELETE /api/v1/roles/:id      — delete custom role  (admin only, system roles protected)
 * GET    /api/v1/roles/perms/all — list all valid permission keys
 */
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { Roles, Users, getDb } = require('../db');
const { requireAdmin, requirePerm } = require('../auth/middleware');

// All valid permission keys (for UI dropdowns)
const ALL_PERMISSIONS = [
    { key: 'devices:view',          label: 'Devices — View',           group: 'Devices' },
    { key: 'devices:manage',        label: 'Devices — Add/Approve/Delete', group: 'Devices' },
    { key: 'messages:read',         label: 'Messages — Read',          group: 'Messages' },
    { key: 'messages:send',         label: 'Messages — Send',          group: 'Messages' },
    { key: 'campaigns:manage',      label: 'Campaigns — Manage',       group: 'Campaigns' },
    { key: 'webhooks:manage',       label: 'Webhooks — Manage',        group: 'Automation' },
    { key: 'llm:manage',            label: 'LLM — Manage Instances',   group: 'Automation' },
    { key: 'templates:manage',      label: 'Templates — Manage',       group: 'Content' },
    { key: 'contacts:manage',       label: 'Contacts — Manage',        group: 'Content' },
    { key: 'analytics:view',        label: 'Analytics — View',         group: 'Analytics' },
    { key: 'settings:view',         label: 'Settings — View',          group: 'Settings' },
    { key: 'settings:edit',         label: 'Settings — Edit',          group: 'Settings' },
    { key: 'accounts:view',         label: 'Accounts — View List',     group: 'Accounts' },
    { key: 'accounts:edit_basic',   label: 'Accounts — Edit Basic Info (display name, email, notes)', group: 'Accounts' },
    { key: 'accounts:edit_plan',    label: 'Accounts — Change Plan',   group: 'Accounts' },
    { key: 'accounts:create',       label: 'Accounts — Create',        group: 'Accounts' },
    { key: 'accounts:delete',       label: 'Accounts — Delete',        group: 'Accounts' },
    { key: 'accounts:suspend',      label: 'Accounts — Suspend/Unsuspend', group: 'Accounts' },
    { key: 'roles:manage',          label: 'Roles — Manage',           group: 'Administration' },
    { key: 'plans:manage',          label: 'Plans — Manage',           group: 'Administration' },
];

// GET /api/v1/roles/perms/all  — must be before /:id
router.get('/perms/all', requirePerm('accounts:view'), (req, res) => {
    res.json({ permissions: ALL_PERMISSIONS });
});

// GET /api/v1/roles
router.get('/', requirePerm('accounts:view'), (req, res) => {
    const roles = Roles.findAll();
    // Count users per role
    const counts = {};
    getDb().prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all()
        .forEach(r => { counts[r.role] = r.n; });
    res.json({ roles: roles.map(r => ({ ...r, user_count: counts[r.id] || 0 })) });
});

// GET /api/v1/roles/:id
router.get('/:id', requirePerm('accounts:view'), (req, res) => {
    const role = Roles.findById(req.params.id);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    const users = getDb().prepare('SELECT id,username,display_name,avatar_color FROM users WHERE role=?').all(req.params.id);
    res.json({ ...role, users });
});

// POST /api/v1/roles  — admin only
router.post('/', requireAdmin, (req, res) => {
    const { name, description, permissions = {}, color = '#6b7280' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    // Validate perm keys
    const validKeys = new Set(ALL_PERMISSIONS.map(p => p.key));
    const invalid = Object.keys(permissions).filter(k => k !== '*' && !validKeys.has(k));
    if (invalid.length) return res.status(400).json({ error: `Unknown permissions: ${invalid.join(', ')}` });

    const id = 'role_' + uuidv4().replace(/-/g,'').slice(0,10);
    Roles.insert({ id, name, description, permissions, color });
    res.status(201).json({ success: true, role: Roles.findById(id) });
});

// PUT /api/v1/roles/:id  — admin only
router.put('/:id', requireAdmin, (req, res) => {
    const role = Roles.findById(req.params.id);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    // System roles: cannot change their permissions (only name/color/description)
    const updates = {};
    if (req.body.name)               updates.name        = req.body.name;
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.color)              updates.color       = req.body.color;
    if (req.body.permissions && !role.is_system) {
        const validKeys = new Set(ALL_PERMISSIONS.map(p => p.key));
        const invalid = Object.keys(req.body.permissions).filter(k => k !== '*' && !validKeys.has(k));
        if (invalid.length) return res.status(400).json({ error: `Unknown permissions: ${invalid.join(', ')}` });
        updates.permissions = req.body.permissions;
    } else if (req.body.permissions && role.is_system) {
        return res.status(400).json({ error: 'Cannot modify permissions of system roles. Clone the role first.' });
    }

    Roles.update(req.params.id, updates);
    res.json({ success: true, role: Roles.findById(req.params.id) });
});

// DELETE /api/v1/roles/:id  — admin only
router.delete('/:id', requireAdmin, (req, res) => {
    const role = Roles.findById(req.params.id);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.is_system) return res.status(400).json({ error: 'Cannot delete system roles' });

    const count = getDb().prepare('SELECT COUNT(*) AS n FROM users WHERE role=?').get(req.params.id)?.n || 0;
    if (count > 0) return res.status(409).json({ error: `${count} user(s) have this role. Reassign them first.` });

    try { Roles.delete(req.params.id); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    res.json({ success: true });
});

// POST /api/v1/roles/:id/clone  — create copy of a system role (admin)
router.post('/:id/clone', requireAdmin, (req, res) => {
    const role = Roles.findById(req.params.id);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    const id = 'role_' + uuidv4().replace(/-/g,'').slice(0,10);
    const name = req.body.name || `${role.name} (copy)`;
    Roles.insert({ id, name, description: role.description, permissions: { ...role.permissions }, color: role.color });
    res.status(201).json({ success: true, role: Roles.findById(id) });
});

module.exports = router;
