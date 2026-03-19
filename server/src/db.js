'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const cfg      = require('./config');

let _db = null;

function getDb() {
    if (_db) return _db;
    const dir = path.dirname(cfg.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _db = new Database(cfg.dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
    migrate(_db);
    return _db;
}

function migrate(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL DEFAULT 'Unknown Device',
            token           TEXT NOT NULL,
            model           TEXT,
            android_version TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            battery         INTEGER,
            signal          TEXT,
            sent_today      INTEGER NOT NULL DEFAULT 0,
            received_today  INTEGER NOT NULL DEFAULT 0,
            last_seen       TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sim_cards (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            slot        INTEGER NOT NULL DEFAULT 1,
            number      TEXT,
            carrier     TEXT,
            signal      INTEGER,
            UNIQUE(device_id, slot)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id           TEXT PRIMARY KEY,
            direction    TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
            from_number  TEXT NOT NULL,
            to_number    TEXT NOT NULL,
            body         TEXT,
            type         TEXT NOT NULL DEFAULT 'sms' CHECK(type IN ('sms','mms')),
            status       TEXT NOT NULL DEFAULT 'queued'
                         CHECK(status IN ('queued','sent','delivered','failed','received','undelivered')),
            device_id    TEXT REFERENCES devices(id) ON DELETE SET NULL,
            media_url    TEXT,
            error_code   TEXT,
            error_msg    TEXT,
            campaign_id  TEXT,
            template_id  TEXT,
            price        REAL,
            num_segments INTEGER DEFAULT 1,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
            delivered_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_messages_created    ON messages(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_from       ON messages(from_number);
        CREATE INDEX IF NOT EXISTS idx_messages_to         ON messages(to_number);
        CREATE INDEX IF NOT EXISTS idx_messages_status     ON messages(status);
        CREATE INDEX IF NOT EXISTS idx_messages_device     ON messages(device_id);

        CREATE TABLE IF NOT EXISTS conversations (
            id               TEXT PRIMARY KEY,
            contact_number   TEXT NOT NULL UNIQUE,
            last_message_id  TEXT,
            last_message_at  TEXT,
            message_count    INTEGER NOT NULL DEFAULT 0,
            unread_count     INTEGER NOT NULL DEFAULT 0,
            updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS contacts (
            id          TEXT PRIMARY KEY,
            number      TEXT NOT NULL UNIQUE,
            first_name  TEXT,
            last_name   TEXT,
            email       TEXT,
            carrier     TEXT,
            line_type   TEXT DEFAULT 'mobile',
            opt_out     INTEGER NOT NULL DEFAULT 0,
            opt_out_at  TEXT,
            tags        TEXT DEFAULT '[]',
            custom_data TEXT DEFAULT '{}',
            notes       TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_contacts_number ON contacts(number);

        CREATE TABLE IF NOT EXISTS contact_lists (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT,
            count       INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS contact_list_members (
            list_id    TEXT NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
            contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
            added_at   TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (list_id, contact_id)
        );

        CREATE TABLE IF NOT EXISTS opt_outs (
            id         TEXT PRIMARY KEY,
            number     TEXT NOT NULL UNIQUE,
            reason     TEXT DEFAULT 'STOP',
            source     TEXT DEFAULT 'inbound',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_opt_outs_number ON opt_outs(number);

        CREATE TABLE IF NOT EXISTS message_templates (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL UNIQUE,
            body        TEXT NOT NULL,
            type        TEXT NOT NULL DEFAULT 'sms',
            variables   TEXT DEFAULT '[]',
            category    TEXT DEFAULT 'General',
            used_count  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            key_prefix  TEXT NOT NULL,
            key_hash    TEXT NOT NULL UNIQUE,
            permissions TEXT NOT NULL DEFAULT '["messages:read","messages:write"]',
            enabled     INTEGER NOT NULL DEFAULT 1,
            user_id     TEXT,
            plan_id     TEXT,
            last_used   TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS webhooks (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL DEFAULT 'Webhook',
            url         TEXT NOT NULL,
            events      TEXT NOT NULL DEFAULT '["message.inbound"]',
            secret      TEXT,
            format      TEXT NOT NULL DEFAULT 'json',
            enabled     INTEGER NOT NULL DEFAULT 1,
            retry_count INTEGER NOT NULL DEFAULT 0,
            total_sent  INTEGER NOT NULL DEFAULT 0,
            total_failed INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS webhook_rules (
            id          TEXT PRIMARY KEY,
            webhook_id  TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
            field       TEXT NOT NULL,
            operator    TEXT NOT NULL DEFAULT 'contains',
            value       TEXT NOT NULL,
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id           TEXT PRIMARY KEY,
            webhook_id   TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
            event        TEXT NOT NULL,
            payload      TEXT NOT NULL,
            status_code  INTEGER,
            status       TEXT NOT NULL DEFAULT 'pending',
            attempts     INTEGER NOT NULL DEFAULT 0,
            next_attempt TEXT,
            last_error   TEXT,
            duration_ms  INTEGER,
            delivered_at TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_wh_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_wh_deliveries_status  ON webhook_deliveries(status);

        CREATE TABLE IF NOT EXISTS campaigns (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            category     TEXT DEFAULT 'Marketing',
            message_tpl  TEXT NOT NULL,
            template_id  TEXT,
            status       TEXT NOT NULL DEFAULT 'draft',
            numbers      TEXT NOT NULL DEFAULT '[]',
            strategy     TEXT NOT NULL DEFAULT 'round_robin',
            delay_min    INTEGER NOT NULL DEFAULT 8,
            delay_max    INTEGER NOT NULL DEFAULT 30,
            delay_type   TEXT NOT NULL DEFAULT 'gaussian',
            rate_per_hr  INTEGER NOT NULL DEFAULT 15,
            rate_per_day INTEGER NOT NULL DEFAULT 150,
            window_start TEXT DEFAULT '09:00',
            window_end   TEXT DEFAULT '20:00',
            schedule_type TEXT DEFAULT 'immediate',
            schedule_at  TEXT,
            total        INTEGER NOT NULL DEFAULT 0,
            sent         INTEGER NOT NULL DEFAULT 0,
            delivered    INTEGER NOT NULL DEFAULT 0,
            failed       INTEGER NOT NULL DEFAULT 0,
            opted_out    INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            started_at   TEXT,
            completed_at TEXT
        );

        -- ── Drip Sequences ───────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS drip_sequences (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT,
            status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
            trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK(trigger_type IN ('manual','keyword','optin','tag')),
            trigger_value TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS drip_steps (
            id              TEXT PRIMARY KEY,
            sequence_id     TEXT NOT NULL REFERENCES drip_sequences(id) ON DELETE CASCADE,
            step_order      INTEGER NOT NULL DEFAULT 0,
            delay_hours     INTEGER NOT NULL DEFAULT 24,
            message         TEXT NOT NULL,
            media_url       TEXT,
            from_number     TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS drip_enrollments (
            id              TEXT PRIMARY KEY,
            sequence_id     TEXT NOT NULL REFERENCES drip_sequences(id) ON DELETE CASCADE,
            contact_number  TEXT NOT NULL,
            current_step    INTEGER NOT NULL DEFAULT 0,
            next_send_at    TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled','bounced')),
            enrolled_at     TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at    TEXT,
            UNIQUE(sequence_id, contact_number)
        );
        CREATE INDEX IF NOT EXISTS idx_drip_enroll_next ON drip_enrollments(next_send_at,status);

        CREATE TABLE IF NOT EXISTS scheduled_messages (
            id          TEXT PRIMARY KEY,
            to_number   TEXT NOT NULL,
            from_number TEXT,
            body        TEXT NOT NULL,
            type        TEXT NOT NULL DEFAULT 'sms',
            media_url   TEXT,
            status      TEXT NOT NULL DEFAULT 'pending',
            schedule_at TEXT NOT NULL,
            sent_at     TEXT,
            error       TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_sched_msgs_schedule ON scheduled_messages(schedule_at, status);

        CREATE TABLE IF NOT EXISTS llm_instances (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            type        TEXT NOT NULL DEFAULT 'ollama',
            base_url    TEXT NOT NULL,
            model       TEXT NOT NULL,
            api_key     TEXT,
            system_prompt TEXT,
            weight      INTEGER NOT NULL DEFAULT 1,
            timeout_ms  INTEGER NOT NULL DEFAULT 30000,
            enabled     INTEGER NOT NULL DEFAULT 1,
            healthy     INTEGER NOT NULL DEFAULT 1,
            fail_count  INTEGER NOT NULL DEFAULT 0,
            last_check  TEXT,
            total_reqs  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS llm_rules (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            trigger_type  TEXT NOT NULL DEFAULT 'all',
            trigger_value TEXT,
            llm_id        TEXT NOT NULL REFERENCES llm_instances(id) ON DELETE CASCADE,
            auto_reply    INTEGER NOT NULL DEFAULT 1,
            forward_to    TEXT,
            enabled       INTEGER NOT NULL DEFAULT 1,
            created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS llm_sessions (
            id             TEXT PRIMARY KEY,
            contact_number TEXT NOT NULL,
            llm_id         TEXT NOT NULL,
            context        TEXT NOT NULL DEFAULT '[]',
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_sessions_contact ON llm_sessions(contact_number, llm_id);

        CREATE TABLE IF NOT EXISTS analytics_hourly (
            hour        TEXT NOT NULL,
            sent        INTEGER NOT NULL DEFAULT 0,
            delivered   INTEGER NOT NULL DEFAULT 0,
            received    INTEGER NOT NULL DEFAULT 0,
            failed      INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (hour)
        );

        CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Sender number groups (pools of outbound SIM numbers)
        CREATE TABLE IF NOT EXISTS number_groups (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT,
            mode        TEXT NOT NULL DEFAULT 'private',
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS number_group_members (
            group_id   TEXT NOT NULL REFERENCES number_groups(id) ON DELETE CASCADE,
            number     TEXT NOT NULL,
            device_id  TEXT,
            added_at   TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (group_id, number)
        );

        -- Recipient groups (address book lists for targeting)
        CREATE TABLE IF NOT EXISTS recipient_groups (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT,
            count       INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS recipient_group_members (
            group_id   TEXT NOT NULL REFERENCES recipient_groups(id) ON DELETE CASCADE,
            number     TEXT NOT NULL,
            first_name TEXT,
            last_name  TEXT,
            vars       TEXT DEFAULT '{}',
            added_at   TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (group_id, number)
        );

        -- Password reset tokens (one-time, 1-hour TTL)
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            token       TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at  TEXT NOT NULL,
            used        INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Device pairing tokens (in-memory but persisted for multi-process)
        CREATE TABLE IF NOT EXISTS pairing_tokens (
            token      TEXT PRIMARY KEY,
            expires_at TEXT NOT NULL,
            used       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- ── Backup Destinations ────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS backup_destinations (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            type        TEXT NOT NULL CHECK(type IN ('local','s3','sftp','ftp','ssh')),
            config      TEXT NOT NULL DEFAULT '{}',
            enabled     INTEGER NOT NULL DEFAULT 1,
            last_used   TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- ── Backup Jobs ─────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS backup_jobs (
            id            TEXT PRIMARY KEY,
            type          TEXT NOT NULL DEFAULT 'full',
            status        TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','running','done','failed','cancelled')),
            destination_id TEXT REFERENCES backup_destinations(id) ON DELETE SET NULL,
            user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
            scope         TEXT NOT NULL DEFAULT 'full',
            options       TEXT NOT NULL DEFAULT '{}',
            bytes_written INTEGER NOT NULL DEFAULT 0,
            file_path     TEXT,
            file_name     TEXT,
            error         TEXT,
            log           TEXT NOT NULL DEFAULT '',
            started_at    TEXT,
            finished_at   TEXT,
            created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- ── Backup Schedules ────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS backup_schedules (
            id             TEXT PRIMARY KEY,
            name           TEXT NOT NULL,
            cron           TEXT NOT NULL,
            destination_id TEXT REFERENCES backup_destinations(id) ON DELETE CASCADE,
            scope          TEXT NOT NULL DEFAULT 'full',
            options        TEXT NOT NULL DEFAULT '{}',
            enabled        INTEGER NOT NULL DEFAULT 1,
            last_run       TEXT,
            next_run       TEXT,
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- ── Audit Log ──────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS audit_logs (
            id         TEXT PRIMARY KEY,
            user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
            username   TEXT,
            action     TEXT NOT NULL,
            resource   TEXT,
            resource_id TEXT,
            details    TEXT,
            ip         TEXT,
            result     TEXT NOT NULL DEFAULT 'ok',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

        -- ── Keyword Rules ───────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS keyword_rules (
            id          TEXT PRIMARY KEY,
            keyword     TEXT NOT NULL COLLATE NOCASE,
            match_type  TEXT NOT NULL DEFAULT 'exact' CHECK(match_type IN ('exact','contains','starts_with','regex')),
            reply       TEXT NOT NULL,
            active      INTEGER NOT NULL DEFAULT 1,
            priority    INTEGER NOT NULL DEFAULT 0,
            match_count INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- ── Roles ────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS roles (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL UNIQUE,
            description  TEXT,
            permissions  TEXT NOT NULL DEFAULT '{}',
            is_system    INTEGER NOT NULL DEFAULT 0,
            color        TEXT NOT NULL DEFAULT '#3b82f6',
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- ── Plans ────────────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS plans (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            description     TEXT,
            badge           TEXT,
            price_monthly   REAL NOT NULL DEFAULT 0,
            price_yearly    REAL NOT NULL DEFAULT 0,
            currency        TEXT NOT NULL DEFAULT 'USD',
            purchase_url    TEXT,
            limits          TEXT NOT NULL DEFAULT '{}',
            features        TEXT NOT NULL DEFAULT '{}',
            highlight       INTEGER NOT NULL DEFAULT 0,
            is_active       INTEGER NOT NULL DEFAULT 1,
            is_default      INTEGER NOT NULL DEFAULT 0,
            display_order   INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- ── Users / accounts ─────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS users (
            id              TEXT PRIMARY KEY,
            username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
            email           TEXT UNIQUE COLLATE NOCASE,
            password_hash   TEXT NOT NULL,
            role            TEXT NOT NULL DEFAULT 'user',
            plan_id         TEXT REFERENCES plans(id) ON DELETE SET NULL,
            status          TEXT NOT NULL DEFAULT 'active',
            display_name    TEXT,
            avatar_color    TEXT,
            two_fa_secret   TEXT,
            two_fa_enabled  INTEGER NOT NULL DEFAULT 0,
            last_login      TEXT,
            login_count     INTEGER NOT NULL DEFAULT 0,
            notes           TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- ── User sessions ─────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS user_sessions (
            token       TEXT PRIMARY KEY,
            user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            ip          TEXT,
            user_agent  TEXT,
            expires_at  TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Track per-user message stats (mirrors messages table but aggregated)
        CREATE TABLE IF NOT EXISTS user_stats (
            user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            date        TEXT NOT NULL,
            sent        INTEGER NOT NULL DEFAULT 0,
            delivered   INTEGER NOT NULL DEFAULT 0,
            received    INTEGER NOT NULL DEFAULT 0,
            failed      INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, date)
        );

        -- Link api_keys to users
    `);

    // Safe column migrations (ADD COLUMN IF NOT EXISTS via try/catch)
    const safeCols = [
        // Original migrations
        "ALTER TABLE api_keys ADD COLUMN user_id TEXT",
        "ALTER TABLE api_keys ADD COLUMN plan_id TEXT",
        "ALTER TABLE messages ADD COLUMN api_key_prefix TEXT",
        // TOTP + security
        "ALTER TABLE users ADD COLUMN two_fa_backup_codes TEXT DEFAULT '[]'",
        "ALTER TABLE users ADD COLUMN ip_allowlist TEXT DEFAULT '[]'",
        "ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'dark'",
        "ALTER TABLE user_sessions ADD COLUMN label TEXT",
        // API key extras
        "ALTER TABLE api_keys ADD COLUMN sandbox INTEGER DEFAULT 0",
        "ALTER TABLE api_keys ADD COLUMN rate_limit_override INTEGER",
        "ALTER TABLE api_keys ADD COLUMN label TEXT",
        // Messages
        "ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0",
        "ALTER TABLE messages ADD COLUMN send_after TEXT",
        // Contacts
        "ALTER TABLE contacts ADD COLUMN custom_fields TEXT DEFAULT '{}'",
        "ALTER TABLE contacts ADD COLUMN birthday TEXT",
        "ALTER TABLE contacts ADD COLUMN timezone TEXT",
        // Devices
        "ALTER TABLE devices ADD COLUMN network_type TEXT",
        "ALTER TABLE devices ADD COLUMN signal_level INTEGER",
        "ALTER TABLE devices ADD COLUMN sim_slots TEXT DEFAULT '[]'",
        "ALTER TABLE devices ADD COLUMN app_version TEXT",
        "ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0",
    ];
    for (const sql of safeCols) {
        try { _db.prepare(sql).run(); } catch (_) { /* already exists */ }
    }

    _db.exec(`
        CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_messages_apikey ON messages(api_key_prefix);
    `);

    // Migrations for existing installs — ignore errors on already-existing columns
    const alterCols = [
        "ALTER TABLE messages ADD COLUMN error_code TEXT",
        "ALTER TABLE messages ADD COLUMN error_msg TEXT",
        "ALTER TABLE messages ADD COLUMN campaign_id TEXT",
        "ALTER TABLE messages ADD COLUMN template_id TEXT",
        "ALTER TABLE messages ADD COLUMN price REAL",
        "ALTER TABLE messages ADD COLUMN num_segments INTEGER DEFAULT 1",
        "ALTER TABLE messages ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))",
        "ALTER TABLE conversations ADD COLUMN unread_count INTEGER DEFAULT 0",
        "ALTER TABLE webhooks ADD COLUMN name TEXT DEFAULT 'Webhook'",
        "ALTER TABLE webhooks ADD COLUMN format TEXT DEFAULT 'json'",
        "ALTER TABLE webhooks ADD COLUMN retry_count INTEGER DEFAULT 0",
        "ALTER TABLE webhooks ADD COLUMN total_sent INTEGER DEFAULT 0",
        "ALTER TABLE webhooks ADD COLUMN total_failed INTEGER DEFAULT 0",
    ];
    for (const sql of alterCols) {
        try { db.exec(sql); } catch { /* column already exists */ }
    }
}

// ── Device helpers ─────────────────────────────────────────────
const Devices = {
    findById: (id) => {
        const db = getDb();
        const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
        if (!dev) return null;
        dev.sims = db.prepare('SELECT * FROM sim_cards WHERE device_id = ?').all(id);
        return dev;
    },
    findAll: () => {
        const db = getDb();
        return db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all().map(d => {
            d.sims = db.prepare('SELECT * FROM sim_cards WHERE device_id = ?').all(d.id);
            return d;
        });
    },
    findByToken: (token) => getDb().prepare('SELECT * FROM devices WHERE token = ?').get(token),
    upsert: (dev) => getDb().prepare(`
        INSERT INTO devices (id, name, token, model, android_version, status, battery, last_seen)
        VALUES (@id, @name, @token, @model, @android_version, @status, @battery, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, model = excluded.model,
            android_version = excluded.android_version,
            battery = excluded.battery, last_seen = datetime('now')
    `).run(dev),
    updateStatus: (id, status) => getDb().prepare(
        "UPDATE devices SET status = ?, last_seen = datetime('now') WHERE id = ?"
    ).run(status, id),
    updateHeartbeat: (id, battery, signal, sentToday, receivedToday) => getDb().prepare(`
        UPDATE devices SET battery=?, signal=?, sent_today=?, received_today=?,
        last_seen=datetime('now') WHERE id=?
    `).run(battery, signal, sentToday, receivedToday, id),
    upsertSims: (deviceId, sims) => {
        const db   = getDb();
        const stmt = db.prepare(`
            INSERT INTO sim_cards (device_id, slot, number, carrier, signal)
            VALUES (@device_id, @slot, @number, @carrier, @signal)
            ON CONFLICT(device_id, slot) DO UPDATE SET
                number = excluded.number, carrier = excluded.carrier, signal = excluded.signal
        `);
        for (const sim of sims) stmt.run({ device_id: deviceId, ...sim });
    },
    delete: (id) => getDb().prepare('DELETE FROM devices WHERE id = ?').run(id),
    pendingCount: () => getDb().prepare("SELECT COUNT(*) AS n FROM devices WHERE status='pending'").get().n,
};

// ── Message helpers ────────────────────────────────────────────
const Messages = {
    insert: (msg) => getDb().prepare(`
        INSERT INTO messages (id, direction, from_number, to_number, body, type, status,
            device_id, media_url, campaign_id, template_id, num_segments)
        VALUES (@id, @direction, @from_number, @to_number, @body, @type, @status,
            @device_id, @media_url, @campaign_id, @template_id, @num_segments)
    `).run(msg),
    findById: (id) => getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id),
    findByNumber: (number, limit=20) => getDb().prepare("SELECT * FROM messages WHERE from_number=? OR to_number=? ORDER BY created_at DESC LIMIT ?").all(number, number, limit),
    cancel: (id) => getDb().prepare("UPDATE messages SET status='cancelled',updated_at=datetime('now') WHERE id=? AND status IN ('queued','pending','scheduled')").run(id),
    setPinned: (id, pinned) => getDb().prepare('UPDATE messages SET pinned=? WHERE id=?').run(pinned ? 1 : 0, id),
    updateStatus: (id, status, extra = {}) => {
        const db = getDb();
        const sets = ["status=?", "updated_at=datetime('now')"];
        const vals = [status];
        if (status === 'delivered') { sets.push("delivered_at=datetime('now')"); }
        if (extra.error_code) { sets.push('error_code=?'); vals.push(extra.error_code); }
        if (extra.error_msg)  { sets.push('error_msg=?');  vals.push(extra.error_msg); }
        vals.push(id);
        db.prepare(`UPDATE messages SET ${sets.join(',')} WHERE id=?`).run(...vals);
    },
    findAll: ({ direction, status, from, to, limit = 50, cursor, campaign_id } = {}) => {
        const db   = getDb();
        const conds = [], args = [];
        if (direction)   { conds.push('direction=?');   args.push(direction); }
        if (status)      { conds.push('status=?');      args.push(status); }
        if (from)        { conds.push('from_number=?'); args.push(from); }
        if (to)          { conds.push('to_number=?');   args.push(to); }
        if (cursor)      { conds.push('created_at<?');  args.push(cursor); }
        if (campaign_id) { conds.push('campaign_id=?'); args.push(campaign_id); }
        const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
        args.push(limit);
        return db.prepare(`SELECT * FROM messages${where} ORDER BY created_at DESC LIMIT ?`).all(...args);
    },
    todayStats: () => getDb().prepare(`
        SELECT
            COUNT(CASE WHEN direction='outbound' AND status IN ('sent','delivered') THEN 1 END) AS sent,
            COUNT(CASE WHEN direction='inbound'  THEN 1 END) AS received,
            COUNT(CASE WHEN status='failed'      THEN 1 END) AS failed,
            COUNT(CASE WHEN direction='outbound' THEN 1 END) AS outbound_total
        FROM messages WHERE date(created_at) = date('now')
    `).get(),
    statsRange: (from, to) => getDb().prepare(`
        SELECT
            COUNT(*) AS total,
            COUNT(CASE WHEN direction='outbound' AND status IN ('sent','delivered') THEN 1 END) AS sent,
            COUNT(CASE WHEN direction='inbound'  THEN 1 END) AS received,
            COUNT(CASE WHEN status='failed'      THEN 1 END) AS failed,
            COUNT(CASE WHEN status='delivered'   THEN 1 END) AS delivered,
            COUNT(CASE WHEN type='mms'           THEN 1 END) AS mms
        FROM messages WHERE created_at >= ? AND created_at < ?
    `).get(from, to),
    hourlyStats: (days = 7) => getDb().prepare(`
        SELECT
            strftime('%Y-%m-%dT%H:00:00', created_at) AS hour,
            COUNT(CASE WHEN direction='outbound' THEN 1 END) AS outbound,
            COUNT(CASE WHEN direction='inbound'  THEN 1 END) AS inbound,
            COUNT(CASE WHEN status='failed'      THEN 1 END) AS failed
        FROM messages
        WHERE created_at >= datetime('now', '-${days} days')
        GROUP BY hour ORDER BY hour
    `).all(),
};

// ── Conversation helpers ───────────────────────────────────────
const Conversations = {
    upsert: (contactNumber, messageId) => {
        const db  = getDb();
        const row = db.prepare('SELECT id FROM conversations WHERE contact_number=?').get(contactNumber);
        if (row) {
            db.prepare(`UPDATE conversations SET last_message_id=?,last_message_at=datetime('now'),
                message_count=message_count+1,updated_at=datetime('now') WHERE contact_number=?`
            ).run(messageId, contactNumber);
            return row.id;
        }
        const id = 'conv_' + Date.now();
        db.prepare(`INSERT INTO conversations (id,contact_number,last_message_id,last_message_at,message_count)
            VALUES (?,?,?,datetime('now'),1)`).run(id, contactNumber, messageId);
        return id;
    },
    findAll: (limit = 100) => getDb().prepare(
        'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?'
    ).all(limit),
    findById: (id) => getDb().prepare('SELECT * FROM conversations WHERE id=?').get(id),
};

// ── Contacts ───────────────────────────────────────────────────
const Contacts = {
    findAll: ({ limit = 100, cursor } = {}) => {
        const db  = getDb();
        const sql = cursor
            ? 'SELECT * FROM contacts WHERE created_at<? ORDER BY created_at DESC LIMIT ?'
            : 'SELECT * FROM contacts ORDER BY created_at DESC LIMIT ?';
        return cursor ? db.prepare(sql).all(cursor, limit) : db.prepare(sql).all(limit);
    },
    findByNumber: (number) => getDb().prepare('SELECT * FROM contacts WHERE number=?').get(number),
    findById: (id) => getDb().prepare('SELECT * FROM contacts WHERE id=?').get(id),
    upsert: (c) => getDb().prepare(`
        INSERT INTO contacts (id,number,first_name,last_name,email,carrier,line_type,tags,custom_data,notes)
        VALUES (@id,@number,@first_name,@last_name,@email,@carrier,@line_type,@tags,@custom_data,@notes)
        ON CONFLICT(number) DO UPDATE SET
            first_name=excluded.first_name, last_name=excluded.last_name,
            email=excluded.email, tags=excluded.tags,
            custom_data=excluded.custom_data, notes=excluded.notes,
            updated_at=datetime('now')
    `).run(c),
    setOptOut: (number, value) => getDb().prepare(
        "UPDATE contacts SET opt_out=?,opt_out_at=CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE number=?"
    ).run(value ? 1 : 0, value ? 1 : 0, number),
    delete: (id) => getDb().prepare('DELETE FROM contacts WHERE id=?').run(id),
    count: () => getDb().prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
};

// ── Opt-outs ───────────────────────────────────────────────────
const OptOuts = {
    isOptedOut: (number) => !!getDb().prepare('SELECT 1 FROM opt_outs WHERE number=?').get(number),
    add: (number, reason = 'STOP', source = 'inbound') => {
        const id = 'opt_' + Date.now();
        try {
            getDb().prepare(`INSERT INTO opt_outs (id,number,reason,source) VALUES (?,?,?,?)`
            ).run(id, number, reason, source);
        } catch { /* already exists */ }
        Contacts.setOptOut(number, true);
    },
    remove: (number) => {
        getDb().prepare('DELETE FROM opt_outs WHERE number=?').run(number);
        Contacts.setOptOut(number, false);
    },
    findAll: (limit = 100) => getDb().prepare(
        'SELECT * FROM opt_outs ORDER BY created_at DESC LIMIT ?'
    ).all(limit),
    count: () => getDb().prepare('SELECT COUNT(*) AS n FROM opt_outs').get().n,
};

// ── Message templates ──────────────────────────────────────────
const Templates = {
    findAll: () => getDb().prepare('SELECT * FROM message_templates ORDER BY name').all(),
    findById: (id) => getDb().prepare('SELECT * FROM message_templates WHERE id=?').get(id),
    findByName: (name) => getDb().prepare('SELECT * FROM message_templates WHERE name=?').get(name),
    insert: (t) => getDb().prepare(`
        INSERT INTO message_templates (id,name,body,type,variables,category)
        VALUES (@id,@name,@body,@type,@variables,@category)
    `).run(t),
    update: (id, t) => getDb().prepare(`
        UPDATE message_templates SET name=@name,body=@body,type=@type,
        variables=@variables,category=@category,updated_at=datetime('now') WHERE id=@id
    `).run({ ...t, id }),
    incrementUsed: (id) => getDb().prepare('UPDATE message_templates SET used_count=used_count+1 WHERE id=?').run(id),
    delete: (id) => getDb().prepare('DELETE FROM message_templates WHERE id=?').run(id),
    render: (id, vars = {}) => {
        const t = getDb().prepare('SELECT body FROM message_templates WHERE id=?').get(id);
        if (!t) return null;
        return t.body.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
    },
};

// ── API keys ───────────────────────────────────────────────────
const ApiKeys = {
    generate: (name, permissions = ['messages:read', 'messages:write']) => {
        const rawKey  = 'apix_' + crypto.randomBytes(32).toString('hex');
        const prefix  = rawKey.slice(0, 14);
        const hash    = crypto.createHash('sha256').update(rawKey).digest('hex');
        const id      = 'key_' + Date.now();
        getDb().prepare(`INSERT INTO api_keys (id,name,key_prefix,key_hash,permissions) VALUES (?,?,?,?,?)`
        ).run(id, name, prefix, hash, JSON.stringify(permissions));
        return { id, name, key: rawKey, prefix, permissions };
    },
    verify: (rawKey) => {
        if (!rawKey) return null;
        const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const row  = getDb().prepare('SELECT * FROM api_keys WHERE key_hash=? AND enabled=1').get(hash);
        if (row) {
            getDb().prepare("UPDATE api_keys SET last_used=datetime('now') WHERE id=?").run(row.id);
            row.permissions = JSON.parse(row.permissions || '[]');
        }
        return row || null;
    },
    findAll: () => getDb().prepare('SELECT id,name,key_prefix,permissions,enabled,last_used,created_at FROM api_keys ORDER BY created_at DESC').all()
        .map(k => ({ ...k, permissions: JSON.parse(k.permissions || '[]') })),
    revoke: (id) => getDb().prepare('UPDATE api_keys SET enabled=0 WHERE id=?').run(id),
    delete: (id) => getDb().prepare('DELETE FROM api_keys WHERE id=?').run(id),
};

// ── Webhooks ───────────────────────────────────────────────────
const Webhooks = {
    findAll: () => getDb().prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all()
        .map(w => ({ ...w, events: JSON.parse(w.events || '[]') })),
    findById: (id) => {
        const w = getDb().prepare('SELECT * FROM webhooks WHERE id=?').get(id);
        if (!w) return null;
        w.events = JSON.parse(w.events || '[]');
        w.rules  = getDb().prepare('SELECT * FROM webhook_rules WHERE webhook_id=? AND enabled=1').all(id);
        return w;
    },
    findEnabled: (event) => {
        const db  = getDb();
        const all = db.prepare("SELECT * FROM webhooks WHERE enabled=1 AND json_each.value=?")
            .all(event);
        // Fallback: manual filter
        return db.prepare("SELECT * FROM webhooks WHERE enabled=1").all()
            .filter(w => {
                const evts = JSON.parse(w.events || '[]');
                return evts.includes(event) || evts.includes('*');
            })
            .map(w => ({
                ...w,
                events: JSON.parse(w.events || '[]'),
                rules: db.prepare('SELECT * FROM webhook_rules WHERE webhook_id=? AND enabled=1').all(w.id),
            }));
    },
    insert: (w) => getDb().prepare(`
        INSERT INTO webhooks (id,name,url,events,secret,format,enabled) VALUES (@id,@name,@url,@events,@secret,@format,@enabled)
    `).run(w),
    update: (id, w) => getDb().prepare(`
        UPDATE webhooks SET name=@name,url=@url,events=@events,secret=@secret,format=@format,enabled=@enabled WHERE id=@id
    `).run({ ...w, id }),
    delete: (id) => getDb().prepare('DELETE FROM webhooks WHERE id=?').run(id),
    addRule: (r) => getDb().prepare(
        `INSERT INTO webhook_rules (id,webhook_id,field,operator,value) VALUES (@id,@webhook_id,@field,@operator,@value)`
    ).run(r),
    deleteRule: (id) => getDb().prepare('DELETE FROM webhook_rules WHERE id=?').run(id),
    incStats: (id, ok) => getDb().prepare(
        `UPDATE webhooks SET ${ok ? 'total_sent' : 'total_failed'}=${ok ? 'total_sent' : 'total_failed'}+1 WHERE id=?`
    ).run(id),
    logDelivery: (d) => getDb().prepare(`
        INSERT INTO webhook_deliveries (id,webhook_id,event,payload,status_code,status,attempts,duration_ms,last_error,delivered_at)
        VALUES (@id,@webhook_id,@event,@payload,@status_code,@status,@attempts,@duration_ms,@last_error,@delivered_at)
    `).run(d),
};

// ── LLM instances ──────────────────────────────────────────────
const LLM = {
    findAll: () => getDb().prepare('SELECT * FROM llm_instances ORDER BY name').all(),
    findById: (id) => getDb().prepare('SELECT * FROM llm_instances WHERE id=?').get(id),
    findEnabled: () => getDb().prepare('SELECT * FROM llm_instances WHERE enabled=1').all(),
    insert: (i) => getDb().prepare(`
        INSERT INTO llm_instances (id,name,type,base_url,model,api_key,system_prompt,weight,timeout_ms,enabled)
        VALUES (@id,@name,@type,@base_url,@model,@api_key,@system_prompt,@weight,@timeout_ms,@enabled)
    `).run(i),
    update: (id, i) => getDb().prepare(`
        UPDATE llm_instances SET name=@name,type=@type,base_url=@base_url,model=@model,
        api_key=@api_key,system_prompt=@system_prompt,weight=@weight,timeout_ms=@timeout_ms,enabled=@enabled WHERE id=@id
    `).run({ ...i, id }),
    setHealth: (id, healthy) => getDb().prepare(`
        UPDATE llm_instances SET healthy=?,fail_count=CASE WHEN ? THEN 0 ELSE fail_count+1 END,
        last_check=datetime('now') WHERE id=?
    `).run(healthy ? 1 : 0, healthy ? 1 : 0, id),
    incReqs: (id) => getDb().prepare('UPDATE llm_instances SET total_reqs=total_reqs+1 WHERE id=?').run(id),
    delete: (id) => getDb().prepare('DELETE FROM llm_instances WHERE id=?').run(id),
    findRules: () => getDb().prepare('SELECT * FROM llm_rules WHERE enabled=1 ORDER BY created_at').all(),
    insertRule: (r) => getDb().prepare(`
        INSERT INTO llm_rules (id,name,trigger_type,trigger_value,llm_id,auto_reply,forward_to,enabled)
        VALUES (@id,@name,@trigger_type,@trigger_value,@llm_id,@auto_reply,@forward_to,@enabled)
    `).run(r),
    deleteRule: (id) => getDb().prepare('DELETE FROM llm_rules WHERE id=?').run(id),
    getSession: (contactNumber, llmId) => {
        const s = getDb().prepare('SELECT * FROM llm_sessions WHERE contact_number=? AND llm_id=?').get(contactNumber, llmId);
        if (s) s.context = JSON.parse(s.context || '[]');
        return s;
    },
    upsertSession: (contactNumber, llmId, context) => getDb().prepare(`
        INSERT INTO llm_sessions (id,contact_number,llm_id,context)
        VALUES (?,?,?,?)
        ON CONFLICT(contact_number,llm_id) DO UPDATE SET context=excluded.context, updated_at=datetime('now')
    `).run('ses_' + Date.now(), contactNumber, llmId, JSON.stringify(context)),
};

// ── Scheduled messages ─────────────────────────────────────────
const Scheduled = {
    findPending: () => getDb().prepare(
        "SELECT * FROM scheduled_messages WHERE status='pending' AND schedule_at <= datetime('now') ORDER BY schedule_at LIMIT 50"
    ).all(),
    findAll: () => getDb().prepare('SELECT * FROM scheduled_messages ORDER BY schedule_at DESC').all(),
    findById: (id) => getDb().prepare('SELECT * FROM scheduled_messages WHERE id=?').get(id),
    insert: (s) => getDb().prepare(`
        INSERT INTO scheduled_messages (id,to_number,from_number,body,type,media_url,status,schedule_at)
        VALUES (@id,@to_number,@from_number,@body,@type,@media_url,@status,@schedule_at)
    `).run(s),
    markSent: (id, sentAt) => getDb().prepare("UPDATE scheduled_messages SET status='sent',sent_at=? WHERE id=?").run(sentAt, id),
    markFailed: (id, error) => getDb().prepare("UPDATE scheduled_messages SET status='failed',error=? WHERE id=?").run(error, id),
    cancel: (id) => getDb().prepare("UPDATE scheduled_messages SET status='cancelled' WHERE id=? AND status='pending'").run(id),
    delete: (id) => getDb().prepare('DELETE FROM scheduled_messages WHERE id=?').run(id),
};

// ── Campaign helpers ───────────────────────────────────────────
const Campaigns = {
    findAll: () => getDb().prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all(),
    findById: (id) => getDb().prepare('SELECT * FROM campaigns WHERE id=?').get(id),
    insert: (c) => getDb().prepare(`
        INSERT INTO campaigns (id,name,category,message_tpl,template_id,status,numbers,strategy,
            delay_min,delay_max,delay_type,rate_per_hr,rate_per_day,window_start,window_end,
            schedule_type,schedule_at,total)
        VALUES (@id,@name,@category,@message_tpl,@template_id,@status,@numbers,@strategy,
            @delay_min,@delay_max,@delay_type,@rate_per_hr,@rate_per_day,@window_start,@window_end,
            @schedule_type,@schedule_at,@total)
    `).run(c),
    updateStatus: (id, status) => {
        const db = getDb();
        const extra = status === 'running'
            ? ",started_at=datetime('now')"
            : status === 'done' ? ",completed_at=datetime('now')" : '';
        db.prepare(`UPDATE campaigns SET status=?${extra} WHERE id=?`).run(status, id);
    },
    incrementStats: (id, field) => getDb().prepare(`UPDATE campaigns SET ${field}=${field}+1 WHERE id=?`).run(id),
    delete: (id) => getDb().prepare('DELETE FROM campaigns WHERE id=?').run(id),
    stats: () => getDb().prepare(`
        SELECT COUNT(*) AS total,
            COUNT(CASE WHEN status='running'   THEN 1 END) AS running,
            COUNT(CASE WHEN status='scheduled' THEN 1 END) AS scheduled,
            COUNT(CASE WHEN status='paused'    THEN 1 END) AS paused,
            COUNT(CASE WHEN status='done'      THEN 1 END) AS done,
            COALESCE(SUM(sent),0)      AS total_sent,
            COALESCE(SUM(delivered),0) AS total_delivered
        FROM campaigns
    `).get(),
};

// ── Settings ───────────────────────────────────────────────────
const Settings = {
    get: (key, def = null) => {
        const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key);
        return row ? row.value : def;
    },
    set: (key, value) => getDb().prepare(`
        INSERT INTO settings (key,value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
    `).run(key, String(value)),
    getAll: () => {
        const rows = getDb().prepare('SELECT key,value FROM settings').all();
        return Object.fromEntries(rows.map(r => [r.key, r.value]));
    },
};

// ── Number groups ──────────────────────────────────────────────
const NumberGroups = {
    findAll: () => {
        const db = getDb();
        return db.prepare('SELECT * FROM number_groups ORDER BY name').all().map(g => ({
            ...g,
            members: db.prepare('SELECT * FROM number_group_members WHERE group_id=?').all(g.id),
        }));
    },
    findById: (id) => {
        const db = getDb();
        const g = db.prepare('SELECT * FROM number_groups WHERE id=?').get(id);
        if (!g) return null;
        g.members = db.prepare('SELECT * FROM number_group_members WHERE group_id=?').all(id);
        return g;
    },
    insert: (g) => getDb().prepare(
        'INSERT INTO number_groups (id,name,description,mode) VALUES (@id,@name,@description,@mode)'
    ).run(g),
    update: (id, g) => getDb().prepare(
        'UPDATE number_groups SET name=@name,description=@description,mode=@mode WHERE id=@id'
    ).run({ ...g, id }),
    addMember: (groupId, number, deviceId) => {
        try {
            getDb().prepare('INSERT INTO number_group_members (group_id,number,device_id) VALUES (?,?,?)').run(groupId, number, deviceId || null);
        } catch { /* duplicate */ }
    },
    removeMember: (groupId, number) => getDb().prepare('DELETE FROM number_group_members WHERE group_id=? AND number=?').run(groupId, number),
    getNumbers: (groupId) => getDb().prepare('SELECT number,device_id FROM number_group_members WHERE group_id=?').all(groupId),
    delete: (id) => getDb().prepare('DELETE FROM number_groups WHERE id=?').run(id),
};

// ── Recipient groups ───────────────────────────────────────────
const RecipientGroups = {
    findAll: () => getDb().prepare('SELECT * FROM recipient_groups ORDER BY name').all(),
    findById: (id) => {
        const db = getDb();
        const g = db.prepare('SELECT * FROM recipient_groups WHERE id=?').get(id);
        if (!g) return null;
        g.members = db.prepare('SELECT * FROM recipient_group_members WHERE group_id=?').all(id);
        return g;
    },
    insert: (g) => getDb().prepare(
        'INSERT INTO recipient_groups (id,name,description) VALUES (@id,@name,@description)'
    ).run(g),
    update: (id, g) => getDb().prepare(
        'UPDATE recipient_groups SET name=@name,description=@description WHERE id=@id'
    ).run({ ...g, id }),
    addMember: (groupId, number, firstName, lastName, vars) => {
        try {
            getDb().prepare('INSERT INTO recipient_group_members (group_id,number,first_name,last_name,vars) VALUES (?,?,?,?,?)').run(groupId, number, firstName || null, lastName || null, JSON.stringify(vars || {}));
            getDb().prepare('UPDATE recipient_groups SET count=count+1 WHERE id=?').run(groupId);
        } catch { /* duplicate */ }
    },
    bulkAdd: (groupId, members) => {
        const db = getDb();
        const stmt = db.prepare('INSERT OR IGNORE INTO recipient_group_members (group_id,number,first_name,last_name,vars) VALUES (?,?,?,?,?)');
        let added = 0;
        for (const m of members) {
            const r = stmt.run(groupId, m.number, m.first_name || null, m.last_name || null, JSON.stringify(m.vars || {}));
            added += r.changes;
        }
        db.prepare('UPDATE recipient_groups SET count=(SELECT COUNT(*) FROM recipient_group_members WHERE group_id=?) WHERE id=?').run(groupId, groupId);
        return added;
    },
    removeMember: (groupId, number) => {
        getDb().prepare('DELETE FROM recipient_group_members WHERE group_id=? AND number=?').run(groupId, number);
        getDb().prepare('UPDATE recipient_groups SET count=MAX(0,count-1) WHERE id=?').run(groupId);
    },
    getMembers: (groupId, limit = 10000) => getDb().prepare('SELECT * FROM recipient_group_members WHERE group_id=? LIMIT ?').all(groupId, limit),
    delete: (id) => getDb().prepare('DELETE FROM recipient_groups WHERE id=?').run(id),
    count: (groupId) => getDb().prepare('SELECT COUNT(*) AS n FROM recipient_group_members WHERE group_id=?').get(groupId)?.n || 0,
};

// ── Password reset tokens ──────────────────────────────────────
const PasswordResets = {
    create: (userId) => {
        const db = getDb();
        const crypto = require('crypto');
        // Invalidate prior tokens for this user
        db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(userId);
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString(); // 1 hour
        db.prepare('INSERT INTO password_reset_tokens (token,user_id,expires_at) VALUES (?,?,?)').run(token, userId, expiresAt);
        return token;
    },
    verify: (token) => {
        const row = getDb().prepare(
            "SELECT r.*,u.id as uid,u.username,u.email FROM password_reset_tokens r JOIN users u ON r.user_id=u.id WHERE r.token=? AND r.expires_at > datetime('now') AND r.used=0"
        ).get(token);
        return row || null;
    },
    consume: (token) => getDb().prepare('UPDATE password_reset_tokens SET used=1 WHERE token=?').run(token),
};

// ── Pairing tokens ─────────────────────────────────────────────
const PairingTokens = {
    create: (token, ttlMinutes = 10) => {
        // Clean up expired tokens first
        getDb().prepare("DELETE FROM pairing_tokens WHERE expires_at < datetime('now')").run();
        const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
        getDb().prepare('INSERT INTO pairing_tokens (token,expires_at) VALUES (?,?)').run(token, expiresAt);
    },
    verify: (token) => {
        const row = getDb().prepare("SELECT * FROM pairing_tokens WHERE token=? AND expires_at > datetime('now') AND used=0").get(token);
        if (row) getDb().prepare('UPDATE pairing_tokens SET used=1 WHERE token=?').run(token);
        return !!row;
    },
    isValid: (token) => !!getDb().prepare("SELECT 1 FROM pairing_tokens WHERE token=? AND expires_at > datetime('now') AND used=0").get(token),
};

// ── Drip Sequence Helpers ──────────────────────────────────────
const DripSequences = {
    findAll:   ()  => getDb().prepare('SELECT * FROM drip_sequences ORDER BY created_at DESC').all(),
    findById:  (id) => getDb().prepare('SELECT * FROM drip_sequences WHERE id=?').get(id),
    insert:    (s) => getDb().prepare('INSERT INTO drip_sequences (id,name,description,status,trigger_type,trigger_value) VALUES (@id,@name,@description,@status,@trigger_type,@trigger_value)').run(s),
    update:    (id, s) => {
        const sets=[],vals={id};
        if(s.name!==undefined){sets.push('name=@name');vals.name=s.name;}
        if(s.description!==undefined){sets.push('description=@description');vals.description=s.description;}
        if(s.status!==undefined){sets.push('status=@status');vals.status=s.status;}
        if(s.trigger_type!==undefined){sets.push('trigger_type=@trigger_type');vals.trigger_type=s.trigger_type;}
        if(s.trigger_value!==undefined){sets.push('trigger_value=@trigger_value');vals.trigger_value=s.trigger_value;}
        if(sets.length){sets.push("updated_at=datetime('now')");getDb().prepare(`UPDATE drip_sequences SET ${sets.join(',')} WHERE id=@id`).run(vals);}
    },
    delete:    (id) => getDb().prepare('DELETE FROM drip_sequences WHERE id=?').run(id),
    getSteps:  (seqId) => getDb().prepare('SELECT * FROM drip_steps WHERE sequence_id=? ORDER BY step_order').all(seqId),
    addStep:   (step) => getDb().prepare('INSERT INTO drip_steps (id,sequence_id,step_order,delay_hours,message,media_url,from_number) VALUES (@id,@sequence_id,@step_order,@delay_hours,@message,@media_url,@from_number)').run(step),
    deleteStep: (id) => getDb().prepare('DELETE FROM drip_steps WHERE id=?').run(id),
    // Enrollments
    enroll: (e) => {
        try {
            getDb().prepare('INSERT INTO drip_enrollments (id,sequence_id,contact_number,current_step,next_send_at,status) VALUES (@id,@sequence_id,@contact_number,0,@next_send_at,\'active\')').run(e);
            return true;
        } catch { return false; } // already enrolled
    },
    unenroll: (seqId, number) => getDb().prepare("UPDATE drip_enrollments SET status='cancelled' WHERE sequence_id=? AND contact_number=?").run(seqId, number),
    findDueEnrollments: () => getDb().prepare("SELECT e.*,s.id AS sid FROM drip_enrollments e JOIN drip_sequences s ON e.sequence_id=s.id WHERE e.status='active' AND e.next_send_at<=datetime('now')").all(),
    advanceStep: (id, nextSendAt) => getDb().prepare("UPDATE drip_enrollments SET current_step=current_step+1,next_send_at=? WHERE id=?").run(nextSendAt, id),
    completeEnrollment: (id) => getDb().prepare("UPDATE drip_enrollments SET status='completed',completed_at=datetime('now') WHERE id=?").run(id),
    getEnrollments: (seqId, limit=100) => getDb().prepare('SELECT * FROM drip_enrollments WHERE sequence_id=? ORDER BY enrolled_at DESC LIMIT ?').all(seqId, limit),
};

// ── Audit Log Helpers ──────────────────────────────────────────
const AuditLog = {
    log: (opts) => {
        const { v4: uuid } = require('uuid');
        getDb().prepare(
            'INSERT INTO audit_logs (id,user_id,username,action,resource,resource_id,details,ip,result) VALUES (?,?,?,?,?,?,?,?,?)'
        ).run(
            'al_'+uuid().replace(/-/g,'').slice(0,12),
            opts.user_id||null, opts.username||null, opts.action,
            opts.resource||null, opts.resource_id||null,
            opts.details ? JSON.stringify(opts.details) : null,
            opts.ip||null, opts.result||'ok'
        );
    },
    findAll: (limit=200, offset=0, filter={}) => {
        let q = 'SELECT * FROM audit_logs';
        const conds = [], vals = [];
        if (filter.user_id)  { conds.push('user_id=?');  vals.push(filter.user_id); }
        if (filter.action)   { conds.push('action LIKE ?'); vals.push(`%${filter.action}%`); }
        if (filter.from)     { conds.push('created_at>=?'); vals.push(filter.from); }
        if (conds.length) q += ' WHERE '+conds.join(' AND ');
        q += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        vals.push(limit, offset);
        return getDb().prepare(q).all(...vals);
    },
    purgeOlderThan: (days) => getDb().prepare("DELETE FROM audit_logs WHERE created_at < datetime('now',?)").run(`-${days} days`),
};

// ── Keyword Rules Helpers ──────────────────────────────────────
const KeywordRules = {
    findAll:     () => getDb().prepare('SELECT * FROM keyword_rules ORDER BY priority DESC, keyword').all(),
    findActive:  () => getDb().prepare('SELECT * FROM keyword_rules WHERE active=1 ORDER BY priority DESC').all(),
    findById:    (id) => getDb().prepare('SELECT * FROM keyword_rules WHERE id=?').get(id),
    insert:      (r) => getDb().prepare('INSERT INTO keyword_rules (id,keyword,match_type,reply,active,priority) VALUES (@id,@keyword,@match_type,@reply,@active,@priority)').run(r),
    update:      (id, r) => {
        const sets=[],vals={id};
        if(r.keyword!==undefined)   {sets.push('keyword=@keyword');     vals.keyword=r.keyword;}
        if(r.match_type!==undefined){sets.push('match_type=@match_type');vals.match_type=r.match_type;}
        if(r.reply!==undefined)     {sets.push('reply=@reply');         vals.reply=r.reply;}
        if(r.active!==undefined)    {sets.push('active=@active');       vals.active=r.active;}
        if(r.priority!==undefined)  {sets.push('priority=@priority');   vals.priority=r.priority;}
        if(sets.length) {sets.push("updated_at=datetime('now')"); getDb().prepare(`UPDATE keyword_rules SET ${sets.join(',')} WHERE id=@id`).run(vals);}
    },
    incrementMatch: (id) => getDb().prepare('UPDATE keyword_rules SET match_count=match_count+1 WHERE id=?').run(id),
    delete:      (id) => getDb().prepare('DELETE FROM keyword_rules WHERE id=?').run(id),
    // Match inbound message body against all active rules
    match:       (body) => {
        const rules = KeywordRules.findActive();
        const upper = (body||'').toUpperCase().trim();
        for (const r of rules) {
            const kw = (r.keyword||'').toUpperCase();
            let hit = false;
            switch (r.match_type) {
                case 'exact':       hit = upper === kw; break;
                case 'contains':    hit = upper.includes(kw); break;
                case 'starts_with': hit = upper.startsWith(kw); break;
                case 'regex':       try { hit = new RegExp(r.keyword,'i').test(body); } catch{} break;
            }
            if (hit) return r;
        }
        return null;
    },
};

// ── Backup DB Helpers ──────────────────────────────────────────
const BackupDestinations = {
    findAll:    () => getDb().prepare('SELECT * FROM backup_destinations ORDER BY name').all()
                    .map(r => ({ ...r, config: _jsonParse(r.config) })),
    findById:   (id) => { const r = getDb().prepare('SELECT * FROM backup_destinations WHERE id=?').get(id); return r ? { ...r, config: _jsonParse(r.config) } : null; },
    insert:     (d) => getDb().prepare('INSERT INTO backup_destinations (id,name,type,config,enabled) VALUES (@id,@name,@type,@config,@enabled)').run({ ...d, config: JSON.stringify(d.config||{}) }),
    update:     (id, d) => {
        const sets = []; const vals = { id };
        if (d.name    !== undefined) { sets.push('name=@name');       vals.name    = d.name; }
        if (d.config  !== undefined) { sets.push('config=@config');   vals.config  = JSON.stringify(d.config); }
        if (d.enabled !== undefined) { sets.push('enabled=@enabled'); vals.enabled = d.enabled; }
        if (d.last_used !== undefined) { sets.push('last_used=@last_used'); vals.last_used = d.last_used; }
        if (sets.length) { sets.push("updated_at=datetime('now')"); getDb().prepare(`UPDATE backup_destinations SET ${sets.join(',')} WHERE id=@id`).run(vals); }
    },
    delete: (id) => getDb().prepare('DELETE FROM backup_destinations WHERE id=?').run(id),
};

const BackupJobs = {
    findAll:      (limit=50) => getDb().prepare('SELECT * FROM backup_jobs ORDER BY created_at DESC LIMIT ?').all(limit)
                                .map(r => ({ ...r, options: _jsonParse(r.options) })),
    findAllForUser: (userId) => getDb().prepare('SELECT * FROM backup_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(userId)
                                .map(r => ({ ...r, options: _jsonParse(r.options) })),
    findById:     (id) => { const r = getDb().prepare('SELECT * FROM backup_jobs WHERE id=?').get(id); return r ? { ...r, options: _jsonParse(r.options) } : null; },
    insert:       (j) => getDb().prepare('INSERT INTO backup_jobs (id,type,status,destination_id,user_id,scope,options) VALUES (@id,@type,@status,@destination_id,@user_id,@scope,@options)')
                          .run({ ...j, options: JSON.stringify(j.options||{}), status: j.status||'pending' }),
    update:       (id, u) => {
        const sets = []; const vals = { id };
        const fields = ['status','bytes_written','file_path','file_name','error','started_at','finished_at'];
        for (const f of fields) if (u[f] !== undefined) { sets.push(`${f}=@${f}`); vals[f]=u[f]; }
        if (u.log !== undefined) { sets.push('log=@log'); vals.log=u.log; }
        if (sets.length) getDb().prepare(`UPDATE backup_jobs SET ${sets.join(',')} WHERE id=@id`).run(vals);
    },
    appendLog:    (id, line) => {
        const ts = new Date().toISOString().slice(11,19);
        getDb().prepare("UPDATE backup_jobs SET log=log||? WHERE id=?").run(`[${ts}] ${line}\n`, id);
    },
    delete:       (id) => getDb().prepare('DELETE FROM backup_jobs WHERE id=?').run(id),
};

const BackupSchedules = {
    findAll:    () => getDb().prepare('SELECT * FROM backup_schedules ORDER BY name').all()
                    .map(r => ({ ...r, options: _jsonParse(r.options) })),
    findById:   (id) => { const r = getDb().prepare('SELECT * FROM backup_schedules WHERE id=?').get(id); return r ? { ...r, options: _jsonParse(r.options) } : null; },
    findEnabled:() => getDb().prepare('SELECT * FROM backup_schedules WHERE enabled=1').all()
                    .map(r => ({ ...r, options: _jsonParse(r.options) })),
    insert:     (s) => getDb().prepare('INSERT INTO backup_schedules (id,name,cron,destination_id,scope,options,enabled) VALUES (@id,@name,@cron,@destination_id,@scope,@options,@enabled)')
                      .run({ ...s, options: JSON.stringify(s.options||{}), enabled: s.enabled!==false?1:0 }),
    update:     (id, s) => {
        const sets = []; const vals = { id };
        const fields = ['name','cron','destination_id','scope','enabled','last_run','next_run'];
        for (const f of fields) if (s[f] !== undefined) { sets.push(`${f}=@${f}`); vals[f]=s[f]; }
        if (s.options !== undefined) { sets.push('options=@options'); vals.options=JSON.stringify(s.options); }
        if (sets.length) { sets.push("updated_at=datetime('now')"); getDb().prepare(`UPDATE backup_schedules SET ${sets.join(',')} WHERE id=@id`).run(vals); }
    },
    delete:     (id) => getDb().prepare('DELETE FROM backup_schedules WHERE id=?').run(id),
};

function _jsonParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// ── Roles ──────────────────────────────────────────────────────
/**
 * Permission keys:
 *  devices:view            view device list
 *  devices:manage          add/edit/delete/approve devices  (admin + mod)
 *  messages:read           read messages and conversations
 *  messages:send           send SMS/MMS
 *  campaigns:manage        create/edit/delete campaigns
 *  webhooks:manage         manage webhooks
 *  llm:manage              manage LLM instances and rules
 *  templates:manage        create/edit/delete templates
 *  contacts:manage         manage contacts, opt-outs
 *  analytics:view          view analytics
 *  settings:view           view server settings
 *  settings:edit           edit server settings           (admin + mod)
 *  accounts:view           view user list
 *  accounts:edit_basic     edit display_name, email, notes (support)
 *  accounts:edit_plan      assign/change user plan        (admin only)
 *  accounts:create         create new user accounts       (admin only)
 *  accounts:delete         delete user accounts           (admin only)
 *  accounts:suspend        suspend/reactivate accounts    (admin + mod)
 *  roles:manage            manage roles                   (admin only)
 *  plans:manage            manage plans                   (admin only)
 *  *                       wildcard — all permissions     (admin only)
 */
const DEFAULT_ROLES = [
    {
        id: 'admin', name: 'Admin', color: '#10b981', is_system: 1,
        description: 'Full unrestricted access to everything',
        permissions: { '*': true },
    },
    {
        id: 'mod', name: 'Moderator', color: '#3b82f6', is_system: 1,
        description: 'Can manage devices, messages, campaigns and settings. Cannot manage accounts or plans.',
        permissions: {
            'devices:view': true, 'devices:manage': true,
            'messages:read': true, 'messages:send': true,
            'campaigns:manage': true, 'webhooks:manage': true,
            'llm:manage': true, 'templates:manage': true,
            'contacts:manage': true, 'analytics:view': true,
            'settings:view': true, 'settings:edit': true,
            'accounts:view': true, 'accounts:suspend': true,
        },
    },
    {
        id: 'support', name: 'Support', color: '#f59e0b', is_system: 1,
        description: 'Can view accounts and edit basic user info. Read-only on messages.',
        permissions: {
            'devices:view': true,
            'messages:read': true,
            'contacts:manage': true,
            'analytics:view': true,
            'accounts:view': true, 'accounts:edit_basic': true, 'accounts:suspend': true,
            'templates:manage': true,
        },
    },
    {
        id: 'user', name: 'User', color: '#8b5cf6', is_system: 1,
        description: 'Standard user — can send/receive messages within their plan limits.',
        permissions: {
            'messages:read': true, 'messages:send': true,
            'contacts:manage': true, 'templates:manage': true,
            'analytics:view': true,
        },
    },
    {
        id: 'viewer', name: 'Viewer', color: '#6b7280', is_system: 1,
        description: 'Read-only access to messages and analytics.',
        permissions: {
            'messages:read': true, 'analytics:view': true,
        },
    },
];

const Roles = {
    seed: () => {
        const db = getDb();
        for (const r of DEFAULT_ROLES) {
            const ex = db.prepare('SELECT id FROM roles WHERE id=?').get(r.id);
            if (!ex) {
                db.prepare('INSERT INTO roles (id,name,description,permissions,is_system,color) VALUES (?,?,?,?,?,?)')
                    .run(r.id, r.name, r.description, JSON.stringify(r.permissions), r.is_system, r.color);
            }
        }
    },
    findAll: () => getDb().prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all()
        .map(Roles._parse),
    findById: (id) => {
        const r = getDb().prepare('SELECT * FROM roles WHERE id=?').get(id);
        return r ? Roles._parse(r) : null;
    },
    insert: (r) => getDb().prepare(
        'INSERT INTO roles (id,name,description,permissions,is_system,color) VALUES (@id,@name,@description,@permissions,0,@color)'
    ).run({ ...r, permissions: JSON.stringify(r.permissions || {}) }),
    update: (id, r) => {
        const sets = []; const vals = { id };
        if (r.name)        { sets.push('name=@name');               vals.name = r.name; }
        if (r.description !== undefined) { sets.push('description=@description'); vals.description = r.description; }
        if (r.permissions) { sets.push('permissions=@permissions'); vals.permissions = JSON.stringify(r.permissions); }
        if (r.color)       { sets.push('color=@color');             vals.color = r.color; }
        if (sets.length) {
            sets.push("updated_at=datetime('now')");
            getDb().prepare(`UPDATE roles SET ${sets.join(',')} WHERE id=@id`).run(vals);
        }
    },
    delete: (id) => {
        const role = Roles.findById(id);
        if (role?.is_system) throw new Error('Cannot delete a system role');
        getDb().prepare('DELETE FROM roles WHERE id=?').run(id);
    },
    hasPerm: (roleId, perm) => {
        if (!roleId) return false;
        if (roleId === 'admin') return true;
        const role = Roles.findById(roleId);
        if (!role) return false;
        const p = role.permissions || {};
        return !!(p['*'] || p[perm]);
    },
    _parse: (row) => ({
        ...row,
        permissions: (() => { try { return JSON.parse(row.permissions); } catch { return {}; } })(),
    }),
};

// ── Plans ──────────────────────────────────────────────────────
const DEFAULT_PLANS = [
    {
        id: 'plan_free', name: 'Free', badge: null, description: 'Get started for free',
        price_monthly: 0, price_yearly: 0, currency: 'USD', purchase_url: null,
        highlight: 0, is_active: 1, is_default: 1, display_order: 0,
        limits: { messages_per_day: 50, messages_per_month: 500, devices: 1, contacts: 100, templates: 3, campaigns: 0, webhooks: 0, scheduled_messages: 0, llm_instances: 0, number_groups: 0, recipient_groups: 0, api_keys: 1 },
        features: { bulk_send: false, webhooks: false, llm_autoresponder: false, campaigns: false, scheduled_messages: false, analytics_advanced: false, number_groups: false, recipient_groups: false, mms: true, contacts_import: false, qr_pairing: false, api_access: true },
    },
    {
        id: 'plan_standard', name: 'Standard', badge: 'Popular', description: 'For growing businesses',
        price_monthly: 19, price_yearly: 190, currency: 'USD', purchase_url: null,
        highlight: 1, is_active: 1, is_default: 0, display_order: 1,
        limits: { messages_per_day: 1000, messages_per_month: 20000, devices: 5, contacts: 10000, templates: 50, campaigns: 10, webhooks: 5, scheduled_messages: 100, llm_instances: 2, number_groups: 3, recipient_groups: 10, api_keys: 5 },
        features: { bulk_send: true, webhooks: true, llm_autoresponder: true, campaigns: true, scheduled_messages: true, analytics_advanced: true, number_groups: true, recipient_groups: true, mms: true, contacts_import: true, qr_pairing: true, api_access: true },
    },
    {
        id: 'plan_enterprise', name: 'Enterprise', badge: 'Unlimited', description: 'Full power, no limits',
        price_monthly: 99, price_yearly: 990, currency: 'USD', purchase_url: null,
        highlight: 0, is_active: 1, is_default: 0, display_order: 2,
        limits: { messages_per_day: -1, messages_per_month: -1, devices: -1, contacts: -1, templates: -1, campaigns: -1, webhooks: -1, scheduled_messages: -1, llm_instances: -1, number_groups: -1, recipient_groups: -1, api_keys: -1 },
        features: { bulk_send: true, webhooks: true, llm_autoresponder: true, campaigns: true, scheduled_messages: true, analytics_advanced: true, number_groups: true, recipient_groups: true, mms: true, contacts_import: true, qr_pairing: true, api_access: true },
    },
];

const Plans = {
    seed: () => {
        const db = getDb();
        for (const p of DEFAULT_PLANS) {
            const existing = db.prepare('SELECT id FROM plans WHERE id=?').get(p.id);
            if (!existing) {
                db.prepare(`INSERT INTO plans (id,name,badge,description,price_monthly,price_yearly,currency,purchase_url,limits,features,highlight,is_active,is_default,display_order)
                    VALUES (@id,@name,@badge,@description,@price_monthly,@price_yearly,@currency,@purchase_url,@limits,@features,@highlight,@is_active,@is_default,@display_order)`)
                    .run({ ...p, limits: JSON.stringify(p.limits), features: JSON.stringify(p.features) });
            }
        }
    },
    findAll: (includeInactive = false) => {
        const rows = getDb().prepare(`SELECT * FROM plans ${includeInactive ? '' : 'WHERE is_active=1'} ORDER BY display_order`).all();
        return rows.map(Plans._parse);
    },
    findById: (id) => {
        const row = getDb().prepare('SELECT * FROM plans WHERE id=?').get(id);
        return row ? Plans._parse(row) : null;
    },
    getDefault: () => {
        const row = getDb().prepare("SELECT * FROM plans WHERE is_default=1 AND is_active=1 LIMIT 1").get()
            || getDb().prepare("SELECT * FROM plans WHERE is_active=1 ORDER BY display_order LIMIT 1").get();
        return row ? Plans._parse(row) : null;
    },
    insert: (p) => {
        getDb().prepare(`INSERT INTO plans (id,name,badge,description,price_monthly,price_yearly,currency,purchase_url,limits,features,highlight,is_active,is_default,display_order,purchase_url)
            VALUES (@id,@name,@badge,@description,@price_monthly,@price_yearly,@currency,@purchase_url,@limits,@features,@highlight,@is_active,@is_default,@display_order,@purchase_url)`)
            .run({ ...p, limits: JSON.stringify(p.limits||{}), features: JSON.stringify(p.features||{}) });
    },
    update: (id, p) => {
        const fields = [];
        const vals = { id };
        const allowed = ['name','badge','description','price_monthly','price_yearly','currency','purchase_url','highlight','is_active','is_default','display_order'];
        for (const k of allowed) if (p[k] !== undefined) { fields.push(`${k}=@${k}`); vals[k]=p[k]; }
        if (p.limits)   { fields.push('limits=@limits');     vals.limits   = JSON.stringify(p.limits); }
        if (p.features) { fields.push('features=@features'); vals.features = JSON.stringify(p.features); }
        if (fields.length) {
            fields.push("updated_at=datetime('now')");
            getDb().prepare(`UPDATE plans SET ${fields.join(',')} WHERE id=@id`).run(vals);
        }
    },
    delete: (id) => getDb().prepare('DELETE FROM plans WHERE id=?').run(id),
    _parse: (row) => ({ ...row, limits: (() => { try { return JSON.parse(row.limits); } catch { return {}; } })(), features: (() => { try { return JSON.parse(row.features); } catch { return {}; } })() }),

    // Check if user/key has a specific feature or within a limit
    hasFeature: (planId, feature) => {
        const plan = Plans.findById(planId);
        if (!plan) return false;
        return !!plan.features[feature];
    },
    checkLimit: (planId, limitKey, currentCount) => {
        const plan = Plans.findById(planId);
        if (!plan) return false;
        const limit = plan.limits[limitKey];
        if (limit === undefined || limit === -1) return true; // unlimited
        return currentCount < limit;
    },
};

// ── Users ──────────────────────────────────────────────────────
const Users = {
    count: () => getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n,
    findAll: () => getDb().prepare('SELECT id,username,email,role,plan_id,status,display_name,avatar_color,last_login,login_count,created_at FROM users ORDER BY created_at').all(),
    findById: (id) => getDb().prepare('SELECT * FROM users WHERE id=?').get(id),
    findByUsername: (username) => getDb().prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username),
    findByEmail: (email) => getDb().prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email),
    insert: (u) => {
        const row = { ...u, must_change_password: u.must_change_password ? 1 : 0 };
        getDb().prepare(
            'INSERT INTO users (id,username,email,password_hash,role,plan_id,status,display_name,avatar_color,must_change_password) VALUES (@id,@username,@email,@password_hash,@role,@plan_id,@status,@display_name,@avatar_color,@must_change_password)'
        ).run(row);
    },
    update: (id, fields) => {
        const allowed = ['username','email','password_hash','role','plan_id','status','display_name','avatar_color','notes','must_change_password'];
        const sets = []; const vals = { id };
        for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k}=@${k}`); vals[k]=fields[k]; }
        if (sets.length) {
            sets.push("updated_at=datetime('now')");
            getDb().prepare(`UPDATE users SET ${sets.join(',')} WHERE id=@id`).run(vals);
        }
    },
    recordLogin: (id, ip) => getDb().prepare("UPDATE users SET last_login=datetime('now'),login_count=login_count+1 WHERE id=?").run(id),
    delete: (id) => getDb().prepare('DELETE FROM users WHERE id=?').run(id),

    // Per-user stats helpers
    recordStat: (userId, type) => {
        const date = new Date().toISOString().slice(0,10);
        const col = { sent:'sent', delivered:'delivered', received:'received', failed:'failed' }[type];
        if (!col) return;
        getDb().prepare(`INSERT INTO user_stats (user_id,date,${col}) VALUES (?,?,1)
            ON CONFLICT(user_id,date) DO UPDATE SET ${col}=${col}+1`).run(userId, date);
    },
    getStats: (userId, days = 30) => {
        return getDb().prepare(`
            SELECT date, sent, delivered, received, failed
            FROM user_stats WHERE user_id=? AND date >= date('now','-${days} days')
            ORDER BY date
        `).all(userId);
    },
    getStatsSummary: (userId) => {
        return getDb().prepare(`
            SELECT SUM(sent) AS total_sent, SUM(delivered) AS total_delivered,
                   SUM(received) AS total_received, SUM(failed) AS total_failed
            FROM user_stats WHERE user_id=?
        `).get(userId) || {};
    },
};

// ── Sessions ───────────────────────────────────────────────────
const Sessions = {
    create: (userId, ip, userAgent, days = 30) => {
        const token = require('crypto').randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
        getDb().prepare("DELETE FROM user_sessions WHERE expires_at < datetime('now')").run();
        getDb().prepare('INSERT INTO user_sessions (token,user_id,ip,user_agent,expires_at) VALUES (?,?,?,?,?)').run(token, userId, ip || null, userAgent || null, expiresAt);
        return token;
    },
    verify: (token) => {
        const row = getDb().prepare("SELECT s.*,u.id as uid,u.username,u.email,u.role,u.plan_id,u.status,u.display_name,u.avatar_color,u.two_fa_enabled,u.theme FROM user_sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at > datetime('now')").get(token);
        return row || null;
    },
    delete: (token) => getDb().prepare('DELETE FROM user_sessions WHERE token=?').run(token),
    deleteAllForUser: (userId) => getDb().prepare('DELETE FROM user_sessions WHERE user_id=?').run(userId),
    deleteById: (id, userId) => getDb().prepare('DELETE FROM user_sessions WHERE token=? AND user_id=?').run(id, userId),
    findForUser: (userId) => getDb().prepare("SELECT token,ip,user_agent,created_at,expires_at,label FROM user_sessions WHERE user_id=? AND expires_at > datetime('now') ORDER BY created_at DESC").all(userId),
    findAll: (limit=100) => getDb().prepare("SELECT s.*,u.username,u.display_name FROM user_sessions s JOIN users u ON s.user_id=u.id WHERE s.expires_at > datetime('now') ORDER BY s.created_at DESC LIMIT ?").all(limit),
    updateLabel: (token, label) => getDb().prepare('UPDATE user_sessions SET label=? WHERE token=?').run(label, token),
};

module.exports = {
    getDb,
    Devices, Messages, Conversations,
    Contacts, OptOuts, Templates,
    ApiKeys, Webhooks,
    LLM, Scheduled, Campaigns,
    Settings, NumberGroups, RecipientGroups, PairingTokens,
    Plans, Users, Sessions, PasswordResets, Roles,
    BackupDestinations, BackupJobs, BackupSchedules,
    AuditLog, KeywordRules, DripSequences,
};
