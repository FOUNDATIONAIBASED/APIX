'use strict';
/**
 * ApiX Backup Engine
 *
 * Scopes:
 *   full          — entire SQLite DB (binary copy via backup API)
 *   json          — JSON export of all tables (passwords redacted)
 *   selective     — JSON export of chosen tables only
 *   user          — per-user data export (messages, contacts, templates) — AES-256-GCM encrypted ZIP
 *   user_all      — all users' data (admin only), each user encrypted separately
 *
 * Destinations:
 *   local  — writes to data/backups/
 *   s3     — AWS S3 or any S3-compatible (MinIO, Cloudflare R2, Backblaze B2, etc.)
 *   sftp   — SFTP (SSH file transfer)
 *   ftp    — plain FTP or FTPS
 *
 * Every job writes real-time log lines to the backup_jobs.log column so the UI can poll/stream them.
 */
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');
const { v4: uuidv4 } = require('uuid');
const cfg    = require('../config');
const { getDb, BackupJobs, BackupDestinations, Users, BackupSchedules, Devices, ForwardingRules } = require('../db');

// ── SSE broadcast map  jobId → Set<res> ────────────────────────
const _sse = new Map();
function subscribeSse(jobId, res) {
    if (!_sse.has(jobId)) _sse.set(jobId, new Set());
    _sse.get(jobId).add(res);
    res.on('close', () => { const s = _sse.get(jobId); if (s) { s.delete(res); if (!s.size) _sse.delete(jobId); } });
}
function _broadcast(jobId, event, data) {
    const set = _sse.get(jobId);
    if (!set || !set.size) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) { try { res.write(msg); } catch { set.delete(res); } }
}

// ── Helpers ────────────────────────────────────────────────────
const BACKUP_DIR = path.join(path.dirname(cfg.dbPath), 'backups');
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function log(jobId, line) {
    const ts = new Date().toISOString().slice(11,19);
    const full = `[${ts}] ${line}`;
    BackupJobs.appendLog(jobId, line);
    _broadcast(jobId, 'log', { line: full });
    console.info(`[BACKUP:${jobId.slice(-6)}] ${line}`);
}

function setStatus(jobId, status, extra = {}) {
    BackupJobs.update(jobId, { status, ...extra });
    _broadcast(jobId, 'status', { status, ...extra });
}

// AES-256-GCM encrypt a buffer → returns { iv, tag, data } as a single Buffer prefixed with header
function encrypt(buf, passphrase) {
    const key  = crypto.scryptSync(passphrase, 'apix-backup-salt', 32);
    const iv   = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc  = Buffer.concat([cipher.update(buf), cipher.final()]);
    const tag  = cipher.getAuthTag();
    // Format: 4B magic | 12B iv | 16B tag | encrypted data
    return Buffer.concat([Buffer.from('APBK'), iv, tag, enc]);
}

// ── JSON export helper ─────────────────────────────────────────
const SENSITIVE_COLS = {
    users:       ['password_hash', 'two_fa_secret'],
    user_sessions: ['token'],
    password_reset_tokens: ['token'],
};

function exportJson(tables, scope = 'all') {
    const db       = getDb();
    const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    const include  = tables && tables.length ? tables : allTables;
    const dump     = { exported_at: new Date().toISOString(), version: 2, scope, tables: {} };

    for (const t of include) {
        if (!allTables.includes(t)) continue;
        try {
            let rows = db.prepare(`SELECT * FROM "${t}"`).all();
            if (SENSITIVE_COLS[t]) rows = rows.map(r => { const c = { ...r }; SENSITIVE_COLS[t].forEach(k => delete c[k]); return c; });
            dump.tables[t] = rows;
        } catch { dump.tables[t] = []; }
    }
    return Buffer.from(JSON.stringify(dump, null, 2), 'utf8');
}

// Export one user's data as JSON
function exportUserData(userId) {
    const db   = getDb();
    const user = db.prepare('SELECT id,username,display_name,email,role,created_at FROM users WHERE id=?').get(userId);
    if (!user) return null;

    const msgs = db.prepare(`
        SELECT m.* FROM messages m
        LEFT JOIN devices d ON m.device_id = d.id
        WHERE (m.api_key_prefix IN (SELECT key_prefix FROM api_keys WHERE user_id=?))
           OR (d.user_id = ?)
        ORDER BY m.created_at DESC
    `).all(userId, userId);
    const keys   = db.prepare('SELECT id,name,key_prefix,enabled,plan_id,created_at FROM api_keys WHERE user_id=?').all(userId);
    const stats  = db.prepare('SELECT * FROM user_stats WHERE user_id=? ORDER BY date DESC').all(userId);
    const rules  = ForwardingRules.findByUser(userId);

    return Buffer.from(JSON.stringify({
        exported_at: new Date().toISOString(),
        version:     3,
        user,
        messages:    msgs,
        api_keys:    keys,
        stats,
        forwarding_rules: rules,
    }, null, 2), 'utf8');
}

/**
 * Import user-scope backup (merge or replace). Keeps login account; restores messages, stats, forwarding rules.
 * API keys in export have no secret — existing keys are left in place on merge; replace clears user's keys.
 */
function importUserData(userId, data, mode = 'merge') {
    const db = getDb();
    const me = Users.findById(userId);
    if (!me) return { ok: false, error: 'User not found' };
    if (!data || (data.version !== 2 && data.version !== 3)) return { ok: false, error: 'Invalid backup (expected version 2 or 3)' };
    if (!data.user || data.user.username !== me.username) {
        return { ok: false, error: 'Backup username does not match this account' };
    }

    const messages = data.messages || [];
    const stats    = data.stats || [];
    const rules    = data.forwarding_rules || [];
    const apiKeys  = data.api_keys || [];

    const run = () => {
        if (mode === 'replace') {
            db.prepare('DELETE FROM messages WHERE device_id IN (SELECT id FROM devices WHERE user_id=?)').run(userId);
            db.prepare(`DELETE FROM messages WHERE api_key_prefix IN (SELECT key_prefix FROM api_keys WHERE user_id=?)`).run(userId);
            db.prepare('DELETE FROM user_stats WHERE user_id=?').run(userId);
            ForwardingRules.deleteAllForUser(userId);
            db.prepare('DELETE FROM api_keys WHERE user_id=?').run(userId);
        }

        const msgCols = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
        for (const row of messages) {
            const r = { ...row };
            if (r.device_id && !Devices.findById(r.device_id)) r.device_id = null;
            const cols = Object.keys(r).filter(k => msgCols.has(k) && r[k] !== undefined);
            if (!cols.length) continue;
            const placeholders = cols.map(() => '?').join(',');
            try {
                db.prepare(`INSERT OR REPLACE INTO messages (${cols.map(c => `"${c}"`).join(',')}) VALUES (${placeholders})`).run(...cols.map(c => r[c]));
            } catch (e) {
                console.warn('[IMPORT] message row skipped:', e.message);
            }
        }

        for (const row of stats) {
            if (!row.date) continue;
            try {
                db.prepare(`INSERT OR REPLACE INTO user_stats (user_id,date,sent,delivered,received,failed) VALUES (?,?,?,?,?,?)`).run(
                    userId, row.date, row.sent || 0, row.delivered || 0, row.received || 0, row.failed || 0
                );
            } catch (e) { console.warn('[IMPORT] stat row skipped:', e.message); }
        }

        for (const row of rules) {
            const id = row.id || `fr_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
            try {
                ForwardingRules.delete(id, userId);
                ForwardingRules.insert({
                    id,
                    user_id: userId,
                    name: row.name || 'Rule',
                    enabled: row.enabled !== 0,
                    channel: row.channel === 'sms' ? 'sms' : 'telegram',
                    priority: row.priority ?? 0,
                    match_from_regex: row.match_from_regex || null,
                    match_to_regex: row.match_to_regex || null,
                    match_body_contains: row.match_body_contains || null,
                    dest_telegram_chat_id: row.dest_telegram_chat_id || null,
                    dest_sms_to: row.dest_sms_to || null,
                });
            } catch (e) {
                console.warn('[IMPORT] forwarding rule skipped:', e.message);
            }
        }

        if (mode === 'replace') {
            for (const row of apiKeys) {
                if (!row.id || !row.key_prefix || !row.name) continue;
                const existing = db.prepare('SELECT id FROM api_keys WHERE key_prefix=?').get(row.key_prefix);
                if (existing) continue;
                const ph = 'apix_import_' + uuidv4().replace(/-/g, '');
                const hash = crypto.createHash('sha256').update(ph).digest('hex');
                try {
                    db.prepare(`
                        INSERT INTO api_keys (id,name,key_prefix,key_hash,permissions,enabled,user_id,plan_id,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?)
                    `).run(
                        row.id,
                        row.name,
                        row.key_prefix,
                        hash,
                        '["messages:read","messages:write"]',
                        row.enabled !== 0 ? 1 : 0,
                        userId,
                        row.plan_id || null,
                        row.created_at || new Date().toISOString()
                    );
                } catch (e) { console.warn('[IMPORT] api key skipped:', e.message); }
            }
        }
    };

    db.transaction(run)();
    return { ok: true, imported: { messages: messages.length, stats: stats.length, forwarding_rules: rules.length, api_keys: mode === 'replace' ? apiKeys.length : 0 } };
}

// ── Upload to destination ──────────────────────────────────────
async function uploadToDestination(dest, localPath, remoteName, jobId) {
    if (!dest) {
        log(jobId, `No destination — keeping local copy only: ${localPath}`);
        return localPath;
    }

    const cfg2 = dest.config || {};
    log(jobId, `Uploading to ${dest.type.toUpperCase()} destination: ${dest.name}`);

    switch (dest.type) {
        case 'local': {
            const targetDir = cfg2.path || BACKUP_DIR;
            ensureDir(targetDir);
            const target = path.join(targetDir, remoteName);
            fs.copyFileSync(localPath, target);
            log(jobId, `Copied to ${target}`);
            BackupDestinations.update(dest.id, { last_used: new Date().toISOString() });
            return target;
        }

        case 's3': {
            const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
            const { Upload } = require('@aws-sdk/lib-storage');
            const client = new S3Client({
                region:   cfg2.region || 'us-east-1',
                endpoint: cfg2.endpoint || undefined,
                forcePathStyle: !!cfg2.endpoint,
                credentials: { accessKeyId: cfg2.access_key, secretAccessKey: cfg2.secret_key },
            });
            const key    = (cfg2.prefix ? cfg2.prefix.replace(/\/$/, '') + '/' : '') + remoteName;
            const stream = fs.createReadStream(localPath);
            const upload = new Upload({ client, params: { Bucket: cfg2.bucket, Key: key, Body: stream } });
            upload.on('httpUploadProgress', p => _broadcast(jobId, 'progress', { loaded: p.loaded, total: p.total }));
            await upload.done();
            log(jobId, `Uploaded to s3://${cfg2.bucket}/${key}`);
            BackupDestinations.update(dest.id, { last_used: new Date().toISOString() });
            return `s3://${cfg2.bucket}/${key}`;
        }

        case 'sftp': {
            const SftpClient = require('ssh2-sftp-client');
            const sftp = new SftpClient();
            await sftp.connect({
                host:       cfg2.host,
                port:       cfg2.port || 22,
                username:   cfg2.username,
                password:   cfg2.password || undefined,
                privateKey: cfg2.private_key ? fs.readFileSync(cfg2.private_key) : undefined,
                passphrase: cfg2.passphrase || undefined,
            });
            const remoteDir  = cfg2.remote_path || '/backups';
            const remoteFull = `${remoteDir}/${remoteName}`;
            await sftp.mkdir(remoteDir, true).catch(() => {});
            await sftp.fastPut(localPath, remoteFull);
            await sftp.end();
            log(jobId, `Uploaded via SFTP to ${cfg2.host}:${remoteFull}`);
            BackupDestinations.update(dest.id, { last_used: new Date().toISOString() });
            return `sftp://${cfg2.host}${remoteFull}`;
        }

        case 'ftp': {
            const ftp = require('basic-ftp');
            const client = new ftp.Client();
            client.ftp.verbose = false;
            await client.access({
                host:     cfg2.host,
                port:     cfg2.port || 21,
                user:     cfg2.username,
                password: cfg2.password,
                secure:   cfg2.secure === true || cfg2.secure === 'true',
            });
            const remoteDir = cfg2.remote_path || '/backups';
            await client.ensureDir(remoteDir);
            await client.uploadFrom(localPath, `${remoteDir}/${remoteName}`);
            client.close();
            log(jobId, `Uploaded via FTP to ${cfg2.host}:${remoteDir}/${remoteName}`);
            BackupDestinations.update(dest.id, { last_used: new Date().toISOString() });
            return `ftp://${cfg2.host}${remoteDir}/${remoteName}`;
        }

        default:
            log(jobId, `Unknown destination type: ${dest.type} — skipping upload`);
            return localPath;
    }
}

// ── Main job runner ────────────────────────────────────────────
async function runJob(jobId) {
    const job = BackupJobs.findById(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const startedAt = new Date().toISOString();
    setStatus(jobId, 'running', { started_at: startedAt });
    log(jobId, `Job started  scope=${job.scope}  type=${job.type}`);
    ensureDir(BACKUP_DIR);

    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const dest     = job.destination_id ? BackupDestinations.findById(job.destination_id) : null;
    const opts     = job.options || {};
    let   localTmp = null;
    let   fileName = null;
    let   finalPath = null;

    try {
        switch (job.scope) {
            // ── Full binary DB backup ────────────────────────────────
            case 'full': {
                fileName = `apix-full-${ts}.db`;
                localTmp = path.join(BACKUP_DIR, fileName);
                log(jobId, 'Creating consistent SQLite backup...');
                await getDb().backup(localTmp);
                const size = fs.statSync(localTmp).size;
                log(jobId, `Database captured: ${(size/1024/1024).toFixed(2)} MB`);
                BackupJobs.update(jobId, { bytes_written: size });
                finalPath = await uploadToDestination(dest, localTmp, fileName, jobId);
                break;
            }

            // ── Full JSON export ─────────────────────────────────────
            case 'json': {
                fileName = `apix-json-${ts}.json`;
                localTmp = path.join(BACKUP_DIR, fileName);
                log(jobId, 'Exporting all tables to JSON...');
                const buf = exportJson(null, 'full');
                fs.writeFileSync(localTmp, buf);
                log(jobId, `JSON export complete: ${(buf.length/1024).toFixed(1)} KB`);
                BackupJobs.update(jobId, { bytes_written: buf.length });
                finalPath = await uploadToDestination(dest, localTmp, fileName, jobId);
                break;
            }

            // ── Selective table export ────────────────────────────────
            case 'selective': {
                const tables = opts.tables || [];
                if (!tables.length) throw new Error('No tables specified for selective backup');
                fileName = `apix-selective-${ts}.json`;
                localTmp = path.join(BACKUP_DIR, fileName);
                log(jobId, `Exporting tables: ${tables.join(', ')}`);
                const buf = exportJson(tables, 'selective');
                fs.writeFileSync(localTmp, buf);
                log(jobId, `Selective export complete: ${(buf.length/1024).toFixed(1)} KB`);
                BackupJobs.update(jobId, { bytes_written: buf.length });
                finalPath = await uploadToDestination(dest, localTmp, fileName, jobId);
                break;
            }

            // ── Per-user encrypted export ────────────────────────────
            case 'user': {
                const userId   = job.user_id || opts.user_id;
                if (!userId) throw new Error('user_id required for user scope');
                const user     = Users.findById(userId);
                if (!user) throw new Error(`User ${userId} not found`);
                const passphrase = opts.passphrase || crypto.randomBytes(16).toString('hex');

                log(jobId, `Exporting data for user: ${user.username}`);
                const rawData  = exportUserData(userId);
                if (!rawData)  throw new Error(`No data found for user ${userId}`);

                log(jobId, 'Encrypting with AES-256-GCM...');
                const encrypted = encrypt(rawData, passphrase);
                fileName = `apix-user-${user.username}-${ts}.apbk`;
                localTmp = path.join(BACKUP_DIR, fileName);
                fs.writeFileSync(localTmp, encrypted);
                log(jobId, `Encrypted export: ${(encrypted.length/1024).toFixed(1)} KB`);
                BackupJobs.update(jobId, { bytes_written: encrypted.length });

                // Store passphrase in job options for admin retrieval (only if generated)
                if (!opts.passphrase) {
                    const j = BackupJobs.findById(jobId);
                    BackupJobs.update(jobId, {});
                    getDb().prepare('UPDATE backup_jobs SET options=? WHERE id=?')
                        .run(JSON.stringify({ ...j.options, passphrase, note: 'auto-generated' }), jobId);
                }
                finalPath = await uploadToDestination(dest, localTmp, fileName, jobId);
                break;
            }

            // ── All users — each encrypted separately ────────────────
            case 'user_all': {
                const db      = getDb();
                const allUsers = db.prepare('SELECT id,username FROM users ORDER BY username').all();
                log(jobId, `Exporting ${allUsers.length} user accounts...`);

                const archive = require('archiver')('zip', { zlib: { level: 9 } });
                fileName = `apix-all-users-${ts}.zip`;
                localTmp = path.join(BACKUP_DIR, fileName);
                const output = fs.createWriteStream(localTmp);

                await new Promise((resolve, reject) => {
                    output.on('close', resolve);
                    archive.on('error', reject);
                    archive.pipe(output);

                    for (const u of allUsers) {
                        const data = exportUserData(u.id);
                        if (!data) continue;
                        const passphrase = crypto.randomBytes(16).toString('hex');
                        const enc = encrypt(data, passphrase);
                        // Each user's file contains their encrypted data; passphrase is stored in manifest
                        archive.append(enc, { name: `users/${u.username}.apbk` });
                        log(jobId, `  ✓ ${u.username}  (${(enc.length/1024).toFixed(1)} KB encrypted)`);
                        // Passphrase manifest entry — only available to admin
                        archive.append(
                            Buffer.from(JSON.stringify({ user_id: u.id, username: u.username, passphrase })),
                            { name: `manifest/${u.username}.json` }
                        );
                    }
                    archive.finalize();
                });

                const size = fs.statSync(localTmp).size;
                log(jobId, `Archive created: ${(size/1024/1024).toFixed(2)} MB`);
                BackupJobs.update(jobId, { bytes_written: size });
                finalPath = await uploadToDestination(dest, localTmp, fileName, jobId);
                break;
            }

            default:
                throw new Error(`Unknown scope: ${job.scope}`);
        }

        setStatus(jobId, 'done', {
            finished_at: new Date().toISOString(),
            file_path: finalPath,
            file_name: fileName,
        });
        log(jobId, `✓ Backup complete → ${finalPath}`);

    } catch (err) {
        setStatus(jobId, 'failed', { finished_at: new Date().toISOString(), error: err.message });
        log(jobId, `✗ Backup failed: ${err.message}`);
        // Clean up temp file on failure
        if (localTmp && fs.existsSync(localTmp)) {
            try { fs.unlinkSync(localTmp); } catch (_) {}
        }
        throw err;
    }
}

// ── Create + enqueue a job ─────────────────────────────────────
async function createAndRun(opts) {
    const jobId = 'bk_' + uuidv4().replace(/-/g,'').slice(0,12);
    BackupJobs.insert({
        id: jobId,
        type: opts.type || 'manual',
        scope: opts.scope || 'full',
        destination_id: opts.destination_id || null,
        user_id: opts.user_id || null,
        options: opts.options || {},
    });
    // Run async — caller can subscribe to SSE for progress
    setImmediate(() => runJob(jobId).catch(e => console.error('[BACKUP] job error:', e.message)));
    return jobId;
}

// ── Scheduler ─────────────────────────────────────────────────
const _schedulerTasks = new Map();

function startScheduler() {
    const cron = require('node-cron');
    const schedules = BackupSchedules.findEnabled();
    let started = 0;
    for (const s of schedules) {
        if (!cron.validate(s.cron)) { console.warn(`[BACKUP] Invalid cron for schedule ${s.id}: ${s.cron}`); continue; }
        const task = cron.schedule(s.cron, async () => {
            console.info(`[BACKUP] Scheduled trigger: ${s.name} (${s.cron})`);
            try {
                await createAndRun({ type: 'scheduled', scope: s.scope, destination_id: s.destination_id, options: s.options });
                BackupSchedules.update(s.id, { last_run: new Date().toISOString() });
            } catch (e) { console.error('[BACKUP] scheduled job failed:', e.message); }
        });
        _schedulerTasks.set(s.id, task);
        started++;
    }
    if (started) console.info(`[BACKUP] Scheduler started — ${started} active schedule(s)`);
}

function reloadSchedule(scheduleId) {
    const cron = require('node-cron');
    const existing = _schedulerTasks.get(scheduleId);
    if (existing) { existing.stop(); _schedulerTasks.delete(scheduleId); }
    const s = BackupSchedules.findById(scheduleId);
    if (!s || !s.enabled) return;
    if (!cron.validate(s.cron)) return;
    const task = cron.schedule(s.cron, async () => {
        try {
            await createAndRun({ type: 'scheduled', scope: s.scope, destination_id: s.destination_id, options: s.options });
            BackupSchedules.update(s.id, { last_run: new Date().toISOString() });
        } catch (e) { console.error('[BACKUP] scheduled job failed:', e.message); }
    });
    _schedulerTasks.set(scheduleId, task);
}

function stopSchedule(scheduleId) {
    const t = _schedulerTasks.get(scheduleId);
    if (t) { t.stop(); _schedulerTasks.delete(scheduleId); }
}

module.exports = { createAndRun, subscribeSse, startScheduler, reloadSchedule, stopSchedule, BACKUP_DIR, exportUserData, importUserData, encrypt };
