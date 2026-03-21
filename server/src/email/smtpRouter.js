'use strict';
/**
 * Picks SMTP profile (fallback / round-robin / least-used), enforces quotas, logs sends, warns admins.
 */
const { Settings, SmtpSendLog, Users } = require('../db');
const smtpConfig = require('./smtpConfig');
const smtpLimits = require('./smtpLimits');
const smtpTransport = require('./smtpTransport');

const NOTIFY_STATE_KEY = 'smtp_quota_notify_state_json';

function loadNotifyState() {
    try {
        const raw = Settings.get(NOTIFY_STATE_KEY, '{}');
        return JSON.parse(raw || '{}');
    } catch {
        return {};
    }
}

function saveNotifyState(state) {
    Settings.set(NOTIFY_STATE_KEY, JSON.stringify(state));
}

function collectAdminEmails() {
    const extra = smtpConfig.getAdminNotifyExtraEmails();
    const rows = Users.findAll().filter(u => u.role === 'admin' && u.email && String(u.email).includes('@'));
    const fromUsers = rows.map(u => String(u.email).trim().toLowerCase());
    return [...new Set([...extra, ...fromUsers])];
}

async function sendQuotaAlert(profileUsed, summaryLines) {
    const recipients = collectAdminEmails();
    if (!recipients.length) {
        console.warn('[MAIL] Quota warning (no admin emails):', summaryLines.join('\n'));
        return;
    }
    const candidates = smtpConfig.getEffectiveProfiles().filter(p => smtpLimits.isUnderAllLimits(p));
    const sender = candidates[0] || smtpConfig.envLegacyProfile();
    if (!sender || !sender.host) {
        console.warn('[MAIL] Quota warning (no SMTP to send alert):', summaryLines.join('\n'));
        return;
    }
    const subject = `[ApiX Gateway] SMTP quota warning — ${profileUsed.name || profileUsed.id}`;
    const text = summaryLines.join('\n');
    const html = `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${text.replace(/</g, '&lt;')}</pre>`;
    for (const to of recipients) {
        try {
            await smtpTransport.sendMail(sender, { to, subject, text, html });
        } catch (e) {
            console.error('[MAIL] Failed quota alert to', to, e.message);
        }
    }
}

/** Notify at most once per profile per UTC day when usage crosses threshold (or any window full). */
function maybeNotifyThresholdSimple(profile, thresholdPct) {
    const { periods, ok } = smtpLimits.quotaStatus(profile);
    const lines = [`Profile: ${profile.name} (${profile.id})`, 'SMTP send quotas (UTC calendar windows):'];
    let anyLimited = false;
    let worstRatio = 0;
    for (const [w, v] of Object.entries(periods)) {
        if (v.limit <= 0) continue;
        anyLimited = true;
        const r = v.limit > 0 ? v.used / v.limit : 0;
        worstRatio = Math.max(worstRatio, r);
        const rem = v.remaining == null ? '∞' : v.remaining;
        lines.push(`  ${w}: ${v.used} / ${v.limit} sent (${rem} remaining)`);
    }
    if (!anyLimited) return;
    const pct = Math.floor(worstRatio * 100);
    if (pct < thresholdPct && ok) return;

    const dayKey = smtpLimits.windowKey('day');
    const stateKey = `${profile.id}:${dayKey}:t${thresholdPct}`;
    const state = loadNotifyState();
    if (state[stateKey]) return;
    state[stateKey] = new Date().toISOString();
    const keys = Object.keys(state);
    if (keys.length > 200) {
        keys.slice(0, keys.length - 200).forEach(k => { delete state[k]; });
    }
    saveNotifyState(state);

    lines.push(
        '',
        ok
            ? `Highest window usage: ${pct}% (notify threshold ${thresholdPct}%).`
            : 'At least one window is at its limit — this profile will be skipped until the window resets.',
    );

    sendQuotaAlert(profile, lines).catch(() => {});
}

function filterUnderQuota(profiles) {
    return profiles.filter(p => p.enabled && p.host && smtpLimits.isUnderAllLimits(p));
}

function pickLeastUsedFrom(avail) {
    let best = avail[0];
    let bestCount = smtpLimits.countInWindow(best.id, 'hour');
    for (let i = 1; i < avail.length; i++) {
        const c = smtpLimits.countInWindow(avail[i].id, 'hour');
        if (c < bestCount) {
            best = avail[i];
            bestCount = c;
        }
    }
    return best;
}

/**
 * Ordered list: preferred first, then others as fallback (priority order).
 * @returns {{ order: object[], advanceRoundRobin: boolean }}
 */
function buildTryOrder(profiles) {
    const enabled = profiles.filter(p => p.enabled && p.host);
    const avail = filterUnderQuota(enabled);
    const mode = smtpConfig.getRoutingMode();

    let first = null;
    let advanceRoundRobin = false;
    if (mode === 'round_robin' && avail.length) {
        let idx = parseInt(Settings.get('smtp_rr_index', '0'), 10) || 0;
        if (idx < 0 || idx > 1e9) idx = 0;
        first = avail[idx % avail.length];
        advanceRoundRobin = true;
    } else if (mode === 'least_used' && avail.length) {
        first = pickLeastUsedFrom(avail);
    } else if (avail.length) {
        first = [...avail].sort((a, b) => a.priority - b.priority)[0];
    }

    if (!first) return { order: [], advanceRoundRobin: false };
    const rest = [...enabled]
        .filter(p => p.id !== first.id)
        .sort((a, b) => a.priority - b.priority);
    return { order: [first, ...rest], advanceRoundRobin };
}

/**
 * @param {object} opts - { to, subject, text, html, skipQuota?: boolean }
 */
async function sendTransactional(opts) {
    const { to, subject, text, html, skipQuota, attachments } = opts;
    const profiles = smtpConfig.getEffectiveProfiles();
    if (!profiles.length) {
        console.info(`[MAIL] No SMTP configured — would send to ${to}: ${subject}`);
        if (text) console.info('[MAIL]', text);
        return false;
    }

    if (skipQuota) {
        const p = profiles.find(x => x.enabled && x.host) || profiles[0];
        if (!p?.host) return false;
        await smtpTransport.sendMail(p, { to, subject, text, html, attachments });
        return true;
    }

    const threshold = smtpConfig.getWarnThresholdPct();
    const { order, advanceRoundRobin } = buildTryOrder(profiles);
    let lastErr = null;

    for (const p of order) {
        maybeNotifyThresholdSimple(p, threshold);
        if (!smtpLimits.isUnderAllLimits(p)) {
            lastErr = new Error(`Profile ${p.id} over quota`);
            continue;
        }
        try {
            await smtpTransport.sendMail(p, { to, subject, text, html, attachments });
            SmtpSendLog.record(p.id);
            if (advanceRoundRobin) {
                let idx = parseInt(Settings.get('smtp_rr_index', '0'), 10) || 0;
                Settings.set('smtp_rr_index', String(idx + 1));
            }
            maybeNotifyThresholdSimple(p, threshold);
            return true;
        } catch (err) {
            lastErr = err;
            console.error('[MAIL] Send error profile', p.id, err.message);
        }
    }

    if (lastErr) throw lastErr;
    throw new Error('No SMTP profile available (all over quota or misconfigured)');
}

function getUsageSnapshot() {
    const profiles = smtpConfig.getEffectiveProfiles();
    return profiles.map(p => ({
        profile: { id: p.id, name: p.name, enabled: p.enabled, host: p.host, priority: p.priority, limits: p.limits },
        ...smtpLimits.quotaStatus(p),
    }));
}

async function testProfile(profile) {
    if (!profile.host) return { ok: false, reason: 'No host' };
    try {
        await smtpTransport.verify(profile);
        return { ok: true, profile_id: profile.id };
    } catch (e) {
        return { ok: false, profile_id: profile.id, reason: e.message };
    }
}

module.exports = {
    sendTransactional,
    getUsageSnapshot,
    testProfile,
    collectAdminEmails,
};
