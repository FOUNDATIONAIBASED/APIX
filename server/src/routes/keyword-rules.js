'use strict';
/**
 * Keyword auto-responder rules
 * GET    /api/v1/keyword-rules       — list all rules
 * POST   /api/v1/keyword-rules       — create rule
 * PUT    /api/v1/keyword-rules/:id   — update rule
 * DELETE /api/v1/keyword-rules/:id   — delete rule
 * POST   /api/v1/keyword-rules/:id/toggle — toggle active
 * POST   /api/v1/keyword-rules/test  — test a body against rules
 */
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { KeywordRules, AuditLog } = require('../db');
const { requireAdmin } = require('../auth/middleware');

router.get('/', requireAdmin, (req, res) => {
    res.json({ rules: KeywordRules.findAll() });
});

router.post('/', requireAdmin, (req, res) => {
    const { keyword, match_type = 'exact', reply, active = 1, priority = 0 } = req.body;
    if (!keyword || !reply) return res.status(400).json({ error: 'keyword and reply required' });
    const id = 'kwr_' + uuidv4().replace(/-/g,'').slice(0,10);
    KeywordRules.insert({ id, keyword: keyword.trim(), match_type, reply: reply.trim(), active: active ? 1 : 0, priority });
    AuditLog.log({ user_id: req.user?.id, username: req.user?.username, action: 'keyword_rule.create', resource_id: id, ip: req.ip });
    res.status(201).json({ id });
});

router.put('/:id', requireAdmin, (req, res) => {
    const rule = KeywordRules.findById(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Not found' });
    KeywordRules.update(req.params.id, req.body);
    AuditLog.log({ user_id: req.user?.id, username: req.user?.username, action: 'keyword_rule.update', resource_id: req.params.id, ip: req.ip });
    res.json({ success: true });
});

router.post('/:id/toggle', requireAdmin, (req, res) => {
    const rule = KeywordRules.findById(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Not found' });
    KeywordRules.update(req.params.id, { active: rule.active ? 0 : 1 });
    res.json({ active: !rule.active });
});

router.delete('/:id', requireAdmin, (req, res) => {
    KeywordRules.delete(req.params.id);
    AuditLog.log({ user_id: req.user?.id, username: req.user?.username, action: 'keyword_rule.delete', resource_id: req.params.id, ip: req.ip });
    res.json({ success: true });
});

// Test body against all rules without side effects
router.post('/test', requireAdmin, (req, res) => {
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'body required' });
    const matched = KeywordRules.match(body);
    res.json({ matched: matched ? { id: matched.id, keyword: matched.keyword, reply: matched.reply } : null });
});

module.exports = router;
