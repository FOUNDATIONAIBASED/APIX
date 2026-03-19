'use strict';
/**
 * Number Groups  — pools of sender SIM numbers (for private/rotation mode)
 * Recipient Groups — lists of destination numbers for campaigns & bulk sends
 */
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { NumberGroups, RecipientGroups, OptOuts } = require('../db');
const { sanitizePhone, sanitizeString, validateRequired } = require('../security');

// ══════════════════════════════════════════════
// NUMBER GROUPS  —  /api/v1/groups/numbers/...
// ══════════════════════════════════════════════

// GET /api/v1/groups/numbers
router.get('/numbers', (req, res) => {
    res.json({ groups: NumberGroups.findAll() });
});

// GET /api/v1/groups/numbers/:id
router.get('/numbers/:id', (req, res) => {
    const g = NumberGroups.findById(req.params.id);
    if (!g) return res.status(404).json({ error: 'Group not found' });
    res.json(g);
});

// POST /api/v1/groups/numbers
router.post('/numbers', (req, res) => {
    const err = validateRequired(req.body, ['name']);
    if (err) return res.status(400).json({ error: err });

    const g = {
        id:          'ng_' + uuidv4().replace(/-/g, '').slice(0, 12),
        name:        sanitizeString(req.body.name, 100),
        description: sanitizeString(req.body.description, 500),
        mode:        ['enterprise', 'private'].includes(req.body.mode) ? req.body.mode : 'private',
    };
    NumberGroups.insert(g);

    // Optionally seed with numbers from request
    if (Array.isArray(req.body.numbers)) {
        for (const entry of req.body.numbers) {
            const num = sanitizePhone(typeof entry === 'string' ? entry : entry.number);
            if (num) NumberGroups.addMember(g.id, num, entry.device_id || null);
        }
    }
    res.status(201).json({ success: true, group: NumberGroups.findById(g.id) });
});

// PUT /api/v1/groups/numbers/:id
router.put('/numbers/:id', (req, res) => {
    const existing = NumberGroups.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Group not found' });
    NumberGroups.update(req.params.id, {
        name:        sanitizeString(req.body.name, 100)        || existing.name,
        description: sanitizeString(req.body.description, 500) ?? existing.description,
        mode:        ['enterprise', 'private'].includes(req.body.mode) ? req.body.mode : existing.mode,
    });
    res.json({ success: true });
});

// DELETE /api/v1/groups/numbers/:id
router.delete('/numbers/:id', (req, res) => {
    NumberGroups.delete(req.params.id);
    res.json({ success: true });
});

// POST /api/v1/groups/numbers/:id/members
router.post('/numbers/:id/members', (req, res) => {
    const number = sanitizePhone(req.body.number);
    if (!number) return res.status(400).json({ error: 'Valid number required' });
    NumberGroups.addMember(req.params.id, number, req.body.device_id || null);
    res.status(201).json({ success: true, number });
});

// DELETE /api/v1/groups/numbers/:id/members/:number
router.delete('/numbers/:id/members/:number', (req, res) => {
    NumberGroups.removeMember(req.params.id, decodeURIComponent(req.params.number));
    res.json({ success: true });
});

// ══════════════════════════════════════════════
// RECIPIENT GROUPS  —  /api/v1/groups/recipients/...
// ══════════════════════════════════════════════

// GET /api/v1/groups/recipients
router.get('/recipients', (req, res) => {
    res.json({ groups: RecipientGroups.findAll() });
});

// GET /api/v1/groups/recipients/:id
router.get('/recipients/:id', (req, res) => {
    const g = RecipientGroups.findById(req.params.id);
    if (!g) return res.status(404).json({ error: 'Group not found' });
    res.json(g);
});

// POST /api/v1/groups/recipients
router.post('/recipients', (req, res) => {
    const err = validateRequired(req.body, ['name']);
    if (err) return res.status(400).json({ error: err });

    const g = {
        id:          'rg_' + uuidv4().replace(/-/g, '').slice(0, 12),
        name:        sanitizeString(req.body.name, 100),
        description: sanitizeString(req.body.description, 500),
    };
    RecipientGroups.insert(g);

    let added = 0;
    if (Array.isArray(req.body.members)) {
        const valid = req.body.members.filter(m => sanitizePhone(m.number)).map(m => ({
            number:     sanitizePhone(m.number),
            first_name: sanitizeString(m.first_name, 50),
            last_name:  sanitizeString(m.last_name, 50),
            vars:       m.vars || {},
        }));
        added = RecipientGroups.bulkAdd(g.id, valid);
    }
    res.status(201).json({ success: true, group: { ...g, count: added } });
});

// PUT /api/v1/groups/recipients/:id
router.put('/recipients/:id', (req, res) => {
    const existing = RecipientGroups.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Group not found' });
    RecipientGroups.update(req.params.id, {
        name:        sanitizeString(req.body.name, 100)        || existing.name,
        description: sanitizeString(req.body.description, 500) ?? existing.description,
    });
    res.json({ success: true });
});

// DELETE /api/v1/groups/recipients/:id
router.delete('/recipients/:id', (req, res) => {
    RecipientGroups.delete(req.params.id);
    res.json({ success: true });
});

// POST /api/v1/groups/recipients/:id/members  — add single member
router.post('/recipients/:id/members', (req, res) => {
    const number = sanitizePhone(req.body.number);
    if (!number) return res.status(400).json({ error: 'Valid number required' });
    if (OptOuts.isOptedOut(number)) {
        return res.status(422).json({ error: `${number} has opted out` });
    }
    RecipientGroups.addMember(req.params.id, number, req.body.first_name, req.body.last_name, req.body.vars);
    res.status(201).json({ success: true, number });
});

// POST /api/v1/groups/recipients/:id/import  — bulk import
router.post('/recipients/:id/import', (req, res) => {
    const { members } = req.body;
    if (!Array.isArray(members) || !members.length) return res.status(400).json({ error: 'members[] required' });
    if (members.length > 100000) return res.status(400).json({ error: 'Max 100,000 members per import' });

    const valid = [];
    let skipped = 0;
    for (const m of members) {
        const num = sanitizePhone(m.number);
        if (!num || OptOuts.isOptedOut(num)) { skipped++; continue; }
        valid.push({
            number:     num,
            first_name: sanitizeString(m.first_name, 50),
            last_name:  sanitizeString(m.last_name, 50),
            vars:       m.vars || {},
        });
    }
    const added = RecipientGroups.bulkAdd(req.params.id, valid);
    res.json({ success: true, added, skipped, total: members.length });
});

// DELETE /api/v1/groups/recipients/:id/members/:number
router.delete('/recipients/:id/members/:number', (req, res) => {
    RecipientGroups.removeMember(req.params.id, decodeURIComponent(req.params.number));
    res.json({ success: true });
});

// GET /api/v1/groups/recipients/:id/members  — paginated member list
router.get('/recipients/:id/members', (req, res) => {
    const { limit = 1000 } = req.query;
    const members = RecipientGroups.getMembers(req.params.id, +limit);
    res.json({ members, count: members.length, total: RecipientGroups.count(req.params.id) });
});

module.exports = router;
