'use strict';
/**
 * Runtime Settings — key-value store for server configuration
 * Persisted in the SQLite database, takes effect immediately.
 *
 * Key settings:
 *   number_mode        : 'enterprise' | 'private'
 *   enterprise_number  : specific sender number for enterprise mode
 *   private_delay_min  : minimum per-message delay in private mode (ms)
 *   private_delay_max  : maximum per-message delay in private mode (ms)
 *   private_rate_per_hr: max sends per hour per number in private mode
 *   private_strategy   : 'round_robin' | 'least_recent' | 'random' | 'least_today'
 */
const router = require('express').Router();
const { Settings } = require('../db');

const ALLOWED_KEYS = new Set([
    'number_mode', 'enterprise_number',
    'private_delay_min', 'private_delay_max',
    'private_rate_per_hr', 'private_strategy',
    'auto_approve_devices', 'mdns_name',
    'log_level', 'server_name',
    'send_window_start', 'send_window_end',
    'max_daily_per_number',
    'telegram_bot_token', 'telegram_chat_id', 'telegram_forward_enabled', 'telegram_forward_to_number',
]);

// GET /api/v1/settings
router.get('/', (req, res) => {
    res.json({ settings: Settings.getAll() });
});

// PUT /api/v1/settings  — update one or many settings
router.put('/', (req, res) => {
    const updates = req.body;
    if (typeof updates !== 'object') return res.status(400).json({ error: 'Object required' });

    const invalid = Object.keys(updates).filter(k => !ALLOWED_KEYS.has(k));
    if (invalid.length) return res.status(400).json({ error: `Unknown settings: ${invalid.join(', ')}` });

    for (const [k, v] of Object.entries(updates)) Settings.set(k, v);
    res.json({ success: true, settings: Settings.getAll() });
});

// GET /api/v1/settings/:key
router.get('/:key', (req, res) => {
    if (!ALLOWED_KEYS.has(req.params.key)) return res.status(404).json({ error: 'Unknown setting' });
    res.json({ key: req.params.key, value: Settings.get(req.params.key) });
});

// PUT /api/v1/settings/:key
router.put('/:key', (req, res) => {
    if (!ALLOWED_KEYS.has(req.params.key)) return res.status(404).json({ error: 'Unknown setting' });
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value required' });
    Settings.set(req.params.key, value);
    res.json({ success: true, key: req.params.key, value });
});

module.exports = router;
