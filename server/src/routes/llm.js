'use strict';
const router  = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { LLM }        = require('../db');
const llmManager     = require('../llm/manager');
const { validateRequired, sanitizeString } = require('../security');

const VALID_TYPES = ['ollama', 'openai', 'lmstudio', 'localai', 'groq', 'together', 'openrouter', 'custom'];

// GET /api/v1/llm/instances
router.get('/instances', (req, res) => {
    const instances = LLM.findAll().map(i => ({ ...i, api_key: i.api_key ? '***' : null }));
    res.json({ instances });
});

// GET /api/v1/llm/instances/:id
router.get('/instances/:id', (req, res) => {
    const inst = LLM.findById(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    res.json({ ...inst, api_key: inst.api_key ? '***' : null });
});

// POST /api/v1/llm/instances
router.post('/instances', (req, res) => {
    const err = validateRequired(req.body, ['name', 'base_url', 'model']);
    if (err) return res.status(400).json({ error: err });

    const type = req.body.type || 'ollama';
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: `Invalid type. Valid: ${VALID_TYPES.join(', ')}` });

    const inst = {
        id:            'llm_' + uuidv4().replace(/-/g, '').slice(0, 12),
        name:          sanitizeString(req.body.name, 100),
        type,
        base_url:      req.body.base_url,
        model:         sanitizeString(req.body.model, 200),
        api_key:       req.body.api_key || null,
        system_prompt: sanitizeString(req.body.system_prompt, 2000),
        weight:        Math.max(1, Math.min(10, req.body.weight || 1)),
        timeout_ms:    req.body.timeout_ms || 30000,
        enabled:       req.body.enabled !== false ? 1 : 0,
    };
    LLM.insert(inst);
    res.status(201).json({ success: true, id: inst.id, name: inst.name });
});

// PUT /api/v1/llm/instances/:id
router.put('/instances/:id', (req, res) => {
    const existing = LLM.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Instance not found' });
    LLM.update(req.params.id, {
        name:          sanitizeString(req.body.name, 100)         || existing.name,
        type:          VALID_TYPES.includes(req.body.type) ? req.body.type : existing.type,
        base_url:      req.body.base_url      || existing.base_url,
        model:         req.body.model         || existing.model,
        api_key:       req.body.api_key !== undefined ? req.body.api_key : existing.api_key,
        system_prompt: req.body.system_prompt !== undefined ? req.body.system_prompt : existing.system_prompt,
        weight:        req.body.weight         ?? existing.weight,
        timeout_ms:    req.body.timeout_ms     ?? existing.timeout_ms,
        enabled:       req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled,
    });
    res.json({ success: true });
});

// DELETE /api/v1/llm/instances/:id
router.delete('/instances/:id', (req, res) => {
    LLM.delete(req.params.id);
    res.json({ success: true });
});

// POST /api/v1/llm/instances/:id/test
router.post('/instances/:id/test', async (req, res) => {
    const inst = LLM.findById(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    try {
        const reply = await llmManager.complete(inst.id, req.body.prompt || 'Reply with "OK" only.', null);
        res.json({ success: true, reply });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// POST /api/v1/llm/chat  — direct chat (picks best instance)
router.post('/chat', async (req, res) => {
    const err = validateRequired(req.body, ['message']);
    if (err) return res.status(400).json({ error: err });

    const inst = req.body.instance_id
        ? LLM.findById(req.body.instance_id)
        : llmManager.pickInstance();
    if (!inst) return res.status(503).json({ error: 'No healthy LLM instances available' });

    try {
        const reply = await llmManager.chat(inst.id, req.body.session_id || 'api_user', req.body.message);
        res.json({ reply, instance_id: inst.id, model: inst.model });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// ── Rules ──────────────────────────────────────────────────────
// GET /api/v1/llm/rules
router.get('/rules', (req, res) => {
    res.json({ rules: LLM.findRules() });
});

// POST /api/v1/llm/rules
router.post('/rules', (req, res) => {
    const err = validateRequired(req.body, ['name', 'llm_id']);
    if (err) return res.status(400).json({ error: err });

    const rule = {
        id:            'lrule_' + uuidv4().replace(/-/g, '').slice(0, 12),
        name:          sanitizeString(req.body.name, 100),
        trigger_type:  req.body.trigger_type  || 'all',
        trigger_value: req.body.trigger_value || null,
        llm_id:        req.body.llm_id,
        auto_reply:    req.body.auto_reply !== false ? 1 : 0,
        forward_to:    req.body.forward_to || null,
        enabled:       req.body.enabled !== false ? 1 : 0,
    };
    LLM.insertRule(rule);
    res.status(201).json({ success: true, rule });
});

// DELETE /api/v1/llm/rules/:id
router.delete('/rules/:id', (req, res) => {
    LLM.deleteRule(req.params.id);
    res.json({ success: true });
});

// GET /api/v1/llm/sessions/:contact
router.get('/sessions/:contact', (req, res) => {
    const instances = LLM.findAll();
    const sessions  = instances.map(i => LLM.getSession(req.params.contact, i.id)).filter(Boolean);
    res.json({ sessions });
});

// DELETE /api/v1/llm/sessions/:contact  — clear context
router.delete('/sessions/:contact', (req, res) => {
    const instances = LLM.findAll();
    for (const i of instances) LLM.upsertSession(req.params.contact, i.id, []);
    res.json({ success: true, message: 'All sessions cleared for this contact' });
});

module.exports = router;
