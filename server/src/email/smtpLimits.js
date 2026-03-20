'use strict';
const { SmtpSendLog } = require('../db');

/** UTC calendar bucket starts as ISO strings for SQLite comparison. */
function startOfPeriod(period, d = new Date()) {
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth();
    const day = d.getUTCDate();
    const h = d.getUTCHours();
    if (period === 'hour') return new Date(Date.UTC(y, mo, day, h, 0, 0, 0)).toISOString();
    if (period === 'day') return new Date(Date.UTC(y, mo, day, 0, 0, 0, 0)).toISOString();
    if (period === 'week') {
        const dow = d.getUTCDay();
        const daysFromMonday = (dow + 6) % 7;
        return new Date(Date.UTC(y, mo, day - daysFromMonday, 0, 0, 0, 0)).toISOString();
    }
    if (period === 'month') return new Date(Date.UTC(y, mo, 1, 0, 0, 0, 0)).toISOString();
    return new Date(0).toISOString();
}

function windowKey(period, d = new Date()) {
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth();
    const day = d.getUTCDate();
    const h = d.getUTCHours();
    if (period === 'hour') return `${y}-${mo + 1}-${day}h${h}`;
    if (period === 'day') return `${y}-${mo + 1}-${day}`;
    if (period === 'week') {
        const dow = d.getUTCDay();
        const daysFromMonday = (dow + 6) % 7;
        const mon = new Date(Date.UTC(y, mo, day - daysFromMonday));
        return `w${mon.getUTCFullYear()}-${mon.getUTCMonth() + 1}-${mon.getUTCDate()}`;
    }
    if (period === 'month') return `m${y}-${mo + 1}`;
    return '';
}

function countInWindow(profileId, period) {
    const since = startOfPeriod(period);
    return SmtpSendLog.countSince(profileId, since);
}

/**
 * @returns {{ ok: boolean, periods: Record<string, { used: number, limit: number, remaining: number|null }> }}
 */
function quotaStatus(profile) {
    const lim = profile.limits || {};
    const periods = {};
    let blocked = false;
    const periodMap = { hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month' };
    for (const key of ['hourly', 'daily', 'weekly', 'monthly']) {
        const limit = lim[key] || 0;
        const p = periodMap[key];
        const used = countInWindow(profile.id, p);
        const remaining = limit > 0 ? Math.max(0, limit - used) : null;
        periods[key] = { used, limit, remaining };
        if (limit > 0 && used >= limit) blocked = true;
    }
    return { ok: !blocked, periods };
}

function isUnderAllLimits(profile) {
    return quotaStatus(profile).ok;
}

/** Highest usage ratio (0..1) among limited windows, or 0 if none. */
function maxUsageRatio(profile) {
    const { periods } = quotaStatus(profile);
    let max = 0;
    for (const v of Object.values(periods)) {
        if (v.limit > 0) max = Math.max(max, v.used / v.limit);
    }
    return max;
}

module.exports = {
    startOfPeriod,
    windowKey,
    countInWindow,
    quotaStatus,
    isUnderAllLimits,
    maxUsageRatio,
};
