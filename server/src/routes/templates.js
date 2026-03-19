'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { Templates } = require('../db');
const { sanitizeString, validateRequired } = require('../security');

// GET /api/v1/templates
router.get('/', (req, res) => {
    const templates = Templates.findAll().map(t => ({
        ...t, variables: JSON.parse(t.variables || '[]'),
    }));
    res.json({ templates });
});

// GET /api/v1/templates/:id
router.get('/:id', (req, res) => {
    const t = Templates.findById(req.params.id) || Templates.findByName(req.params.id);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    t.variables = JSON.parse(t.variables || '[]');
    res.json(t);
});

// POST /api/v1/templates
router.post('/', (req, res) => {
    const err = validateRequired(req.body, ['name', 'body']);
    if (err) return res.status(400).json({ error: err });

    const t = {
        id:        'tpl_' + uuidv4().replace(/-/g, '').slice(0, 12),
        name:      sanitizeString(req.body.name, 100),
        body:      sanitizeString(req.body.body, 1600),
        type:      req.body.type === 'mms' ? 'mms' : 'sms',
        variables: JSON.stringify(
            req.body.variables || extractVariables(req.body.body)
        ),
        category:  sanitizeString(req.body.category, 50) || 'General',
    };
    Templates.insert(t);
    res.status(201).json({ success: true, template: { ...t, variables: JSON.parse(t.variables) } });
});

// PUT /api/v1/templates/:id
router.put('/:id', (req, res) => {
    const existing = Templates.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    Templates.update(req.params.id, {
        name:      sanitizeString(req.body.name, 100) || existing.name,
        body:      sanitizeString(req.body.body, 1600) || existing.body,
        type:      req.body.type || existing.type,
        variables: JSON.stringify(req.body.variables || extractVariables(req.body.body || existing.body)),
        category:  sanitizeString(req.body.category, 50) || existing.category,
    });
    res.json({ success: true });
});

// POST /api/v1/templates/:id/render  — preview with variables
router.post('/:id/render', (req, res) => {
    const rendered = Templates.render(req.params.id, req.body.variables || {});
    if (!rendered) return res.status(404).json({ error: 'Template not found' });
    res.json({ rendered, char_count: rendered.length, sms_segments: Math.ceil(rendered.length / 160) });
});

// DELETE /api/v1/templates/:id
router.delete('/:id', (req, res) => {
    Templates.delete(req.params.id);
    res.json({ success: true });
});

function extractVariables(body) {
    if (!body) return [];
    const matches = body.match(/\{(\w+)\}/g) || [];
    return [...new Set(matches.map(m => m.slice(1, -1)))];
}

module.exports = router;
