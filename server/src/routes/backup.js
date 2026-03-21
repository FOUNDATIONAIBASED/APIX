'use strict';
/**
 * Backup & Restore API  (admin only except user self-export)
 *
 * ── Quick downloads (legacy) ────────────────────────────────────
 * GET  /api/v1/backup/download          stream live SQLite .db
 * GET  /api/v1/backup/export            JSON dump of all tables
 * POST /api/v1/backup/snapshot          on-demand local snapshot
 * POST /api/v1/backup/restore           restore from JSON upload
 * POST /api/v1/backup/restore-db        replace DB from .db upload
 * GET  /api/v1/backup/info              DB stats + stored files
 * DELETE /api/v1/backup/file/:name      delete stored backup file
 *
 * ── Job-based backups ───────────────────────────────────────────
 * POST /api/v1/backup/jobs              create + run backup job
 * GET  /api/v1/backup/jobs              list jobs (admin)
 * GET  /api/v1/backup/jobs/:id          job detail + log
 * DELETE /api/v1/backup/jobs/:id        delete job record
 * GET  /api/v1/backup/jobs/:id/stream   SSE log stream
 *
 * ── Destinations ────────────────────────────────────────────────
 * GET  /api/v1/backup/destinations
 * POST /api/v1/backup/destinations
 * PUT  /api/v1/backup/destinations/:id
 * DELETE /api/v1/backup/destinations/:id
 * POST /api/v1/backup/destinations/:id/test    test connectivity
 *
 * ── Schedules ───────────────────────────────────────────────────
 * GET  /api/v1/backup/schedules
 * POST /api/v1/backup/schedules
 * PUT  /api/v1/backup/schedules/:id
 * DELETE /api/v1/backup/schedules/:id
 * POST /api/v1/backup/schedules/:id/toggle
 *
 * ── Per-user export ─────────────────────────────────────────────
 * POST /api/v1/backup/my-data           self-export (auth user)
 * POST /api/v1/backup/my-data-import    restore from JSON (merge|replace)
 * GET  /api/v1/backup/my-data-json       raw JSON download (for re-import / migration)
 * GET  /api/v1/backup/my-jobs           own jobs (auth user)
 */
const router   = require('express').Router();
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const cfg      = require('../config');
const { getDb, BackupDestinations, BackupJobs, BackupSchedules, Users } = require('../db');
const { requireAdmin, requireAuth, can } = require('../auth/middleware');
const engine   = require('../backup/engine');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

function stripPrototypePollution(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const out = {};
    for (const k of Object.keys(obj)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        out[k] = obj[k];
    }
    return out;
}

// ── GET /info ──────────────────────────────────────────────────
router.get('/info', requireAdmin, (req, res) => {
    engine.ensureDir ? null : null; // warmup
    const BACKUP_DIR = engine.BACKUP_DIR;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dbStat = fs.existsSync(cfg.dbPath) ? fs.statSync(cfg.dbPath) : null;
    const files  = fs.readdirSync(BACKUP_DIR)
        .filter(f => /\.(db|json|zip|apbk)$/.test(f))
        .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, created_at: st.mtime.toISOString() }; })
        .sort((a,b) => b.created_at.localeCompare(a.created_at));

    const db = getDb();
    const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
    const tables = {};
    for (const t of tableNames) { try { tables[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n; } catch { tables[t]=0; } }

    res.json({ db_path: cfg.dbPath, db_size: dbStat?.size||0, db_mtime: dbStat?.mtime.toISOString()||null, tables, backups: files, backup_dir: BACKUP_DIR });
});

// ── GET /download ──────────────────────────────────────────────
router.get('/download', requireAdmin, async (req, res) => {
    if (!fs.existsSync(cfg.dbPath)) return res.status(404).json({ error: 'Database file not found' });
    const ts   = new Date().toISOString().replace(/[:.]/g,'-');
    const dest = path.join(engine.BACKUP_DIR, `apix-${ts}.db`);
    fs.mkdirSync(engine.BACKUP_DIR, { recursive: true });
    try {
        await getDb().backup(dest);
        res.setHeader('Content-Disposition', `attachment; filename="apix-backup-${ts}.db"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        fs.createReadStream(dest).pipe(res);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /export ────────────────────────────────────────────────
router.get('/export', requireAdmin, (req, res) => {
    const db   = getDb();
    const tbls = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
    const REDACT = { users: ['password_hash','two_fa_secret'], user_sessions: ['token'], password_reset_tokens: ['token'] };
    const dump = { exported_at: new Date().toISOString(), version: 2, tables: {} };
    for (const t of tbls) {
        try {
            let rows = db.prepare(`SELECT * FROM "${t}"`).all();
            if (REDACT[t]) rows = rows.map(r => { const c={...r}; REDACT[t].forEach(k=>delete c[k]); return c; });
            dump.tables[t] = rows;
        } catch { dump.tables[t] = []; }
    }
    const ts   = new Date().toISOString().replace(/[:.]/g,'-');
    fs.mkdirSync(engine.BACKUP_DIR, { recursive: true });
    const dest = path.join(engine.BACKUP_DIR, `apix-export-${ts}.json`);
    fs.writeFileSync(dest, JSON.stringify(dump, null, 2));
    res.setHeader('Content-Disposition', `attachment; filename="apix-export-${ts}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(dest);
});

// ── POST /snapshot ─────────────────────────────────────────────
router.post('/snapshot', requireAdmin, async (req, res) => {
    fs.mkdirSync(engine.BACKUP_DIR, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g,'-');
    const dest = path.join(engine.BACKUP_DIR, `apix-snapshot-${ts}.db`);
    try {
        await getDb().backup(dest);
        const size = fs.statSync(dest).size;
        res.json({ success: true, file: path.basename(dest), size, path: dest });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /restore (JSON) ───────────────────────────────────────
router.post('/restore', requireAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let dump;
    try { dump = JSON.parse(req.file.buffer.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!dump.tables) return res.status(400).json({ error: 'Not an ApiX JSON export' });

    const db = getDb();
    fs.mkdirSync(engine.BACKUP_DIR, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g,'-');
    const snap = path.join(engine.BACKUP_DIR, `pre-restore-${ts}.db`);
    try { db.backup(snap); } catch (_) {}

    const allowedTables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name),
    );
    const restored = {}, errors = {};
    db.transaction(() => {
        for (const [t, rows] of Object.entries(dump.tables)) {
            if (!allowedTables.has(t)) { errors[t] = 'Unknown or invalid table name'; continue; }
            if (!Array.isArray(rows) || !rows.length) { restored[t]=0; continue; }
            try {
                const ex = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
                if (!ex) { errors[t]='Table not in schema'; continue; }
                const row0 = stripPrototypePollution(rows[0]);
                const cols = Object.keys(row0).join(',');
                const phs  = Object.keys(row0).map(()=>'?').join(',');
                const stmt = db.prepare(`INSERT OR REPLACE INTO "${t}" (${cols}) VALUES (${phs})`);
                let n=0;
                for (const r of rows) {
                    try {
                        const safe = stripPrototypePollution(r);
                        stmt.run(Object.values(safe));
                        n++;
                    } catch (e) { errors[`${t}[${n}]`]=e.message; }
                }
                restored[t]=n;
            } catch(e) { errors[t]=e.message; }
        }
    })();
    res.json({ success: true, pre_restore_snapshot: path.basename(snap), restored, errors: Object.keys(errors).length ? errors : undefined });
});

// ── POST /restore-db ───────────────────────────────────────────
router.post('/restore-db', requireAdmin, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!req.file.buffer.slice(0,16).toString().startsWith('SQLite format 3')) return res.status(400).json({ error: 'Not a valid SQLite file' });
    fs.mkdirSync(engine.BACKUP_DIR, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g,'-');
    const snap = path.join(engine.BACKUP_DIR, `pre-restore-db-${ts}.db`);
    try { await getDb().backup(snap); } catch (_) {}
    const tmp = path.resolve(`${cfg.dbPath}.restore-tmp`);
    const dbDir = path.resolve(path.dirname(cfg.dbPath));
    if (!tmp.startsWith(dbDir + path.sep) && tmp !== path.resolve(cfg.dbPath)) {
        return res.status(500).json({ error: 'Invalid restore path' });
    }
    fs.writeFileSync(tmp, req.file.buffer, { mode: 0o600 });
    try {
        const Database = require('better-sqlite3');
        const test = new Database(tmp, { readonly: true });
        test.pragma('integrity_check');
        test.close();
    } catch(e) { fs.unlinkSync(tmp); return res.status(400).json({ error: `Integrity check failed: ${e.message}` }); }
    try { fs.renameSync(tmp, cfg.dbPath); } catch(e) { return res.status(500).json({ error: e.message }); }
    res.json({ success: true, pre_restore_snapshot: path.basename(snap), message: 'Database replaced. Restart the server.', restart_required: true });
});

// ── DELETE /file/:name ─────────────────────────────────────────
router.delete('/file/:name', requireAdmin, (req, res) => {
    const name   = path.basename(req.params.name);
    const target = path.join(engine.BACKUP_DIR, name);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'File not found' });
    fs.unlinkSync(target);
    res.json({ success: true });
});

// ════ JOB-BASED API ════════════════════════════════════════════

// POST /jobs — create + run a job
router.post('/jobs', requireAdmin, async (req, res) => {
    const { scope = 'full', destination_id, options = {}, user_id } = req.body;
    const validScopes = ['full','json','selective','user','user_all'];
    if (!validScopes.includes(scope)) return res.status(400).json({ error: `scope must be one of: ${validScopes.join(', ')}` });
    const jobId = await engine.createAndRun({ type: 'manual', scope, destination_id, user_id, options });
    res.status(202).json({ success: true, job_id: jobId, stream_url: `/api/v1/backup/jobs/${jobId}/stream` });
});

// GET /jobs — list jobs
router.get('/jobs', requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit || '50', 10);
    const jobs  = BackupJobs.findAll(limit);
    res.json({ jobs });
});

// GET /jobs/:id
router.get('/jobs/:id', requireAdmin, (req, res) => {
    const job = BackupJobs.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// DELETE /jobs/:id
router.delete('/jobs/:id', requireAdmin, (req, res) => {
    BackupJobs.delete(req.params.id);
    res.json({ success: true });
});

// GET /jobs/:id/stream — SSE live log
router.get('/jobs/:id/stream', requireAdmin, (req, res) => {
    const job = BackupJobs.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    // Replay existing log lines immediately
    if (job.log) {
        for (const line of job.log.trim().split('\n')) {
            if (line) res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
        }
    }

    // Send current status
    res.write(`event: status\ndata: ${JSON.stringify({ status: job.status })}\n\n`);

    if (['done','failed','cancelled'].includes(job.status)) {
        res.write('event: done\ndata: {}\n\n');
        res.end();
        return;
    }

    engine.subscribeSse(req.params.id, res);
    const hb = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => clearInterval(hb));
});

// ════ DESTINATIONS ═════════════════════════════════════════════

router.get('/destinations', requireAdmin, (req, res) => {
    const dests = BackupDestinations.findAll().map(d => {
        // Redact secrets from response
        const c = { ...d.config };
        if (c.secret_key) c.secret_key = '***';
        if (c.password)   c.password   = '***';
        if (c.private_key) c.private_key = '(file path)';
        return { ...d, config: c };
    });
    res.json({ destinations: dests });
});

router.post('/destinations', requireAdmin, (req, res) => {
    const { name, type, config = {}, enabled = true } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    const valid = ['local','s3','sftp','ftp'];
    if (!valid.includes(type)) return res.status(400).json({ error: `type must be one of: ${valid.join(', ')}` });
    const id = 'dest_' + uuidv4().replace(/-/g,'').slice(0,10);
    BackupDestinations.insert({ id, name, type, config, enabled: enabled?1:0 });
    res.status(201).json({ success: true, id });
});

router.put('/destinations/:id', requireAdmin, (req, res) => {
    const dest = BackupDestinations.findById(req.params.id);
    if (!dest) return res.status(404).json({ error: 'Destination not found' });
    const { name, config, enabled } = req.body;
    // Merge config so secrets not re-sent as *** aren't overwritten
    let mergedConfig = dest.config || {};
    if (config && typeof config === 'object') {
        for (const [k, v] of Object.entries(config)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (v !== '***' && v !== '(file path)') mergedConfig[k] = v;
        }
    }
    BackupDestinations.update(req.params.id, { name, config: mergedConfig, enabled: enabled!==undefined ? (enabled?1:0) : undefined });
    res.json({ success: true });
});

router.delete('/destinations/:id', requireAdmin, (req, res) => {
    BackupDestinations.delete(req.params.id);
    res.json({ success: true });
});

// POST /destinations/:id/test — test connectivity
router.post('/destinations/:id/test', requireAdmin, async (req, res) => {
    const dest = BackupDestinations.findById(req.params.id);
    if (!dest) return res.status(404).json({ error: 'Destination not found' });
    const c = dest.config || {};
    try {
        switch (dest.type) {
            case 'local': {
                const p = c.path || engine.BACKUP_DIR;
                fs.mkdirSync(p, { recursive: true });
                fs.accessSync(p, fs.constants.W_OK);
                return res.json({ ok: true, message: `Path writable: ${p}` });
            }
            case 's3': {
                const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
                const client = new S3Client({ region: c.region||'us-east-1', endpoint: c.endpoint||undefined, forcePathStyle: !!c.endpoint, credentials: { accessKeyId: c.access_key, secretAccessKey: c.secret_key } });
                await client.send(new ListBucketsCommand({}));
                return res.json({ ok: true, message: 'S3 credentials valid' });
            }
            case 'sftp': {
                const SftpClient = require('ssh2-sftp-client');
                const sftp = new SftpClient();
                await sftp.connect({ host: c.host, port: c.port||22, username: c.username, password: c.password||undefined });
                await sftp.end();
                return res.json({ ok: true, message: `SFTP connected to ${c.host}` });
            }
            case 'ftp': {
                const ftp = require('basic-ftp');
                const client = new ftp.Client();
                await client.access({ host: c.host, port: c.port||21, user: c.username, password: c.password, secure: c.secure===true||c.secure==='true' });
                client.close();
                return res.json({ ok: true, message: `FTP connected to ${c.host}` });
            }
            default:
                return res.json({ ok: false, message: `Unknown type: ${dest.type}` });
        }
    } catch (err) {
        res.json({ ok: false, message: err.message });
    }
});

// ════ SCHEDULES ════════════════════════════════════════════════

router.get('/schedules', requireAdmin, (req, res) => {
    res.json({ schedules: BackupSchedules.findAll() });
});

router.post('/schedules', requireAdmin, (req, res) => {
    const { name, cron, destination_id, scope = 'full', options = {}, enabled = true } = req.body;
    if (!name || !cron) return res.status(400).json({ error: 'name and cron required' });
    const nodeCron = require('node-cron');
    if (!nodeCron.validate(cron)) return res.status(400).json({ error: `Invalid cron expression: ${cron}` });
    const id = 'sched_' + uuidv4().replace(/-/g,'').slice(0,10);
    BackupSchedules.insert({ id, name, cron, destination_id: destination_id||null, scope, options, enabled });
    engine.reloadSchedule(id);
    res.status(201).json({ success: true, id });
});

router.put('/schedules/:id', requireAdmin, (req, res) => {
    if (!BackupSchedules.findById(req.params.id)) return res.status(404).json({ error: 'Schedule not found' });
    const { name, cron, destination_id, scope, options, enabled } = req.body;
    if (cron) {
        const nodeCron = require('node-cron');
        if (!nodeCron.validate(cron)) return res.status(400).json({ error: `Invalid cron: ${cron}` });
    }
    BackupSchedules.update(req.params.id, { name, cron, destination_id, scope, options, enabled: enabled!==undefined?(enabled?1:0):undefined });
    engine.reloadSchedule(req.params.id);
    res.json({ success: true });
});

router.delete('/schedules/:id', requireAdmin, (req, res) => {
    engine.stopSchedule(req.params.id);
    BackupSchedules.delete(req.params.id);
    res.json({ success: true });
});

router.post('/schedules/:id/toggle', requireAdmin, (req, res) => {
    const s = BackupSchedules.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Schedule not found' });
    const newEnabled = s.enabled ? 0 : 1;
    BackupSchedules.update(req.params.id, { enabled: newEnabled });
    if (newEnabled) engine.reloadSchedule(req.params.id);
    else            engine.stopSchedule(req.params.id);
    res.json({ success: true, enabled: !!newEnabled });
});

// ════ PER-USER EXPORT ══════════════════════════════════════════

// GET /my-data-json — synchronous JSON (same payload as encrypted export, for import / merge)
router.get('/my-data-json', requireAuth(), (req, res) => {
    const userId = req.user.uid || req.user.user_id;
    const buf = engine.exportUserData(userId);
    if (!buf) return res.status(404).json({ error: 'User not found' });
    const u = Users.findById(userId);
    const uname = (u?.username || 'user').replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="apix-user-export-${uname}.json"`);
    res.send(buf);
});

// POST /my-data — authenticated user exports their own data
router.post('/my-data', requireAuth(), async (req, res) => {
    const userId     = req.user.uid || req.user.user_id;
    const passphrase = req.body.passphrase; // optional; if omitted, auto-generate
    const jobId      = await engine.createAndRun({
        type:    'user-export',
        scope:   'user',
        user_id: userId,
        options: { passphrase: passphrase || undefined },
    });
    res.status(202).json({ success: true, job_id: jobId, stream_url: `/api/v1/backup/jobs/${jobId}/stream` });
});

// POST /my-data-import — JSON body { mode: 'merge'|'replace', data: { version, user, ... } }
router.post('/my-data-import', requireAuth(), (req, res) => {
    const userId = req.user.uid || req.user.user_id;
    const mode = (req.body?.mode || 'merge').toLowerCase();
    const data = req.body?.data;
    if (!['merge', 'replace'].includes(mode)) return res.status(400).json({ error: 'mode must be merge or replace' });
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required (same schema as user JSON export)' });
    try {
        const result = engine.importUserData(userId, data, mode);
        if (!result.ok) return res.status(400).json(result);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Import failed' });
    }
});

// GET /my-jobs — own backup jobs
router.get('/my-jobs', requireAuth(), (req, res) => {
    const userId = req.user.uid || req.user.user_id;
    res.json({ jobs: BackupJobs.findAllForUser(userId) });
});

// GET /my-jobs/:id/download — download own completed backup (non-admin)
router.get('/my-jobs/:id/download', requireAuth(), (req, res) => {
    const userId = req.user.uid || req.user.user_id;
    const job    = BackupJobs.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    // Users can only download their own jobs; admin can download any
    if (job.user_id !== userId && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    if (job.status !== 'done') return res.status(409).json({ error: 'Job not completed yet' });
    if (!job.file_path || !fs.existsSync(job.file_path)) return res.status(404).json({ error: 'Backup file not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${job.file_name}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(job.file_path).pipe(res);
});

module.exports = router;
