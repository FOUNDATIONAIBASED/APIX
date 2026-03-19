'use strict';
/**
 * Drip sequence (message sequence / automation) routes
 * GET    /api/v1/drip                          — list sequences
 * POST   /api/v1/drip                          — create sequence
 * GET    /api/v1/drip/:id                      — get + steps
 * PUT    /api/v1/drip/:id                      — update
 * DELETE /api/v1/drip/:id                      — delete
 * POST   /api/v1/drip/:id/steps                — add step
 * DELETE /api/v1/drip/:id/steps/:stepId        — remove step
 * GET    /api/v1/drip/:id/enrollments          — list enrollments
 * POST   /api/v1/drip/:id/enroll               — enroll contact(s)
 * DELETE /api/v1/drip/:id/enroll/:number       — unenroll
 */
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { DripSequences, OptOuts, AuditLog } = require('../db');

router.get('/', (req, res) => {
    const seqs = DripSequences.findAll().map(s => ({
        ...s,
        steps: DripSequences.getSteps(s.id),
        enrollments: DripSequences.getEnrollments(s.id, 5).length,
    }));
    res.json({ sequences: seqs });
});

router.get('/:id', (req, res) => {
    const s = DripSequences.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Sequence not found' });
    res.json({ ...s, steps: DripSequences.getSteps(s.id) });
});

router.post('/', (req, res) => {
    const { name, description, status = 'active', trigger_type = 'manual', trigger_value } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = 'drip_' + uuidv4().replace(/-/g,'').slice(0,12);
    DripSequences.insert({ id, name, description: description||null, status, trigger_type, trigger_value: trigger_value||null });
    AuditLog.log({ username: req.user?.username, action: 'drip.create', resource_id: id, ip: req.ip });
    res.status(201).json({ id });
});

router.put('/:id', (req, res) => {
    const s = DripSequences.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    DripSequences.update(req.params.id, req.body);
    res.json({ success: true });
});

router.delete('/:id', (req, res) => {
    DripSequences.delete(req.params.id);
    res.json({ success: true });
});

// Steps
router.post('/:id/steps', (req, res) => {
    const { message, delay_hours = 24, step_order, media_url, from_number } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    const steps = DripSequences.getSteps(req.params.id);
    const id = 'step_' + uuidv4().replace(/-/g,'').slice(0,12);
    DripSequences.addStep({
        id, sequence_id: req.params.id,
        step_order: step_order !== undefined ? step_order : steps.length,
        delay_hours: parseInt(delay_hours)||24,
        message: message.trim(),
        media_url: media_url || null,
        from_number: from_number || null,
    });
    res.status(201).json({ id });
});

router.delete('/:id/steps/:stepId', (req, res) => {
    DripSequences.deleteStep(req.params.stepId);
    res.json({ success: true });
});

// Enrollments
router.get('/:id/enrollments', (req, res) => {
    res.json({ enrollments: DripSequences.getEnrollments(req.params.id, 200) });
});

router.post('/:id/enroll', (req, res) => {
    const { numbers } = req.body; // array of phone numbers
    if (!Array.isArray(numbers) || !numbers.length) return res.status(400).json({ error: 'numbers[] required' });

    const seq = DripSequences.findById(req.params.id);
    if (!seq) return res.status(404).json({ error: 'Sequence not found' });
    const steps = DripSequences.getSteps(seq.id);
    if (!steps.length) return res.status(400).json({ error: 'Sequence has no steps' });

    let enrolled = 0, skipped = 0;
    for (const num of numbers) {
        if (OptOuts.isOptedOut(num)) { skipped++; continue; }
        const firstDelay = steps[0].delay_hours * 3600_000;
        const nextSendAt = new Date(Date.now() + firstDelay).toISOString().replace('T',' ').slice(0,19);
        const ok = DripSequences.enroll({
            id: 'enr_' + uuidv4().replace(/-/g,'').slice(0,12),
            sequence_id: seq.id,
            contact_number: num,
            next_send_at: nextSendAt,
        });
        if (ok) enrolled++; else skipped++;
    }
    res.json({ enrolled, skipped });
});

router.delete('/:id/enroll/:number', (req, res) => {
    DripSequences.unenroll(req.params.id, req.params.number);
    res.json({ success: true });
});

module.exports = router;
