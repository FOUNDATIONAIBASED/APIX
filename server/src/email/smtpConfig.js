'use strict';
/**
 * Multi-SMTP profiles stored in settings + optional legacy .env fallback.
 * Max count: env SMTP_MAX_PROFILES (default 25, clamped 1–100).
 */
const { Settings } = require('../db');

function getMaxProfiles() {
    const raw = process.env.SMTP_MAX_PROFILES;
    const n = raw != null && String(raw).trim() !== '' ? parseInt(raw, 10) : 25;
    if (!Number.isFinite(n) || n < 1) return 25;
    return Math.min(100, Math.max(1, n));
}

function envLegacyProfile() {
    if (!process.env.SMTP_HOST) return null;
    return normalizeProfile({
        id: 'env',
        enabled: true,
        name: 'Environment (.env)',
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
        from: process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@localhost',
        from_name: process.env.SMTP_FROM_NAME || 'ApiX Gateway',
        reply_to: process.env.SMTP_REPLY_TO || '',
        pool: process.env.SMTP_POOL === 'true',
        tls_reject_unauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
        priority: 0,
        limits: { hourly: 0, daily: 0, weekly: 0, monthly: 0 },
    }, 0);
}

function normalizeProfile(p, idx) {
    const id = p.id != null ? String(p.id) : `p${idx + 1}`;
    const lim = p.limits || {};
    return {
        id,
        enabled: p.enabled !== false,
        name: String(p.name || id),
        host: String(p.host || '').trim(),
        port: Math.max(1, parseInt(p.port, 10) || 587),
        secure: !!p.secure,
        user: String(p.user || ''),
        pass: String(p.pass || ''),
        from: String(p.from || p.user || '').trim(),
        from_name: String(p.from_name || 'ApiX Gateway').trim() || 'ApiX Gateway',
        reply_to: String(p.reply_to || '').trim(),
        pool: !!p.pool,
        tls_reject_unauthorized: p.tls_reject_unauthorized !== false,
        priority: Number.isFinite(parseInt(p.priority, 10)) ? parseInt(p.priority, 10) : (idx + 1) * 10,
        limits: {
            hourly: Math.max(0, parseInt(lim.hourly, 10) || 0),
            daily: Math.max(0, parseInt(lim.daily, 10) || 0),
            weekly: Math.max(0, parseInt(lim.weekly, 10) || 0),
            monthly: Math.max(0, parseInt(lim.monthly, 10) || 0),
        },
    };
}

function parseStoredProfiles() {
    const raw = Settings.get('smtp_profiles_json', '');
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.slice(0, getMaxProfiles()).map((p, i) => normalizeProfile(p, i));
    } catch {
        return [];
    }
}

/** Enabled profiles with host set (DB-configured). */
function getDbProfiles() {
    return parseStoredProfiles().filter(p => p.enabled && p.host);
}

/**
 * Profiles used for sending: DB list if any, else single .env profile.
 */
function getEffectiveProfiles() {
    const dbp = getDbProfiles();
    if (dbp.length) return dbp;
    const e = envLegacyProfile();
    return e ? [e] : [];
}

function getRoutingMode() {
    const m = String(Settings.get('smtp_routing_mode', 'fallback') || 'fallback').toLowerCase();
    if (m === 'round_robin' || m === 'least_used') return m;
    return 'fallback';
}

function getWarnThresholdPct() {
    const n = parseInt(Settings.get('smtp_limit_warn_threshold_pct', '80'), 10);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
    return 80;
}

/** Comma-separated extra notify addresses; may be empty. */
function getAdminNotifyExtraEmails() {
    const raw = String(Settings.get('smtp_admin_notify_emails', '') || '').trim();
    if (!raw) return [];
    return raw.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

function maskProfileForApi(p) {
    const o = { ...p };
    if (o.pass) o.pass = '********';
    return o;
}

module.exports = {
    getMaxProfiles,
    /** @deprecated use getMaxProfiles() */
    get MAX_PROFILES() { return getMaxProfiles(); },
    envLegacyProfile,
    normalizeProfile,
    parseStoredProfiles,
    getDbProfiles,
    getEffectiveProfiles,
    getRoutingMode,
    getWarnThresholdPct,
    getAdminNotifyExtraEmails,
    maskProfileForApi,
};
