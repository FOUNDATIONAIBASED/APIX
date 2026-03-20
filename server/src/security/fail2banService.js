'use strict';
const crypto = require('crypto');
const {
    Settings, Users, IpSecurity, LoginFailCounters, UnbanChallenges, Sessions,
} = require('../db');
const mailer = require('../email/mailer');

function _thresholds() {
    const enabled = Settings.get('fail2ban_enabled', '1') !== '0';
    const threshold = Math.max(3, parseInt(Settings.get('fail2ban_threshold', '8'), 10) || 8);
    const windowMin = Math.max(1, parseInt(Settings.get('fail2ban_window_minutes', '15'), 10) || 15);
    return { enabled, threshold, windowMin };
}

async function onLoginFailure(req, usernameAttempted) {
    const { enabled, threshold, windowMin } = _thresholds();
    if (!enabled) return;

    const ip = IpSecurity.normalizeIp(req.ip);
    if (!ip) return;

    const count = LoginFailCounters.recordOrIncrement(ip, windowMin);
    if (count < threshold) return;

    // Ban IP (IPv4 /32); IPv6 use full address string
    const cidr = ip.includes(':') ? ip : `${ip}/32`;
    const existing = IpSecurity.listRules().some(
        (r) => r.mode === 'block' && r.source === 'fail2ban' && (r.cidr === cidr || r.cidr === ip),
    );
    let newlyBanned = false;
    if (!existing) {
        newlyBanned = true;
        IpSecurity.addRule({
            cidr,
            mode: 'block',
            note: `Automatic block after ${count} failed logins in ${windowMin}m`,
            source: 'fail2ban',
            created_by: null,
        });
        try { Sessions.deleteAllForIp(ip); } catch (_) {}
    }

    LoginFailCounters.clear(ip);

    const user = usernameAttempted
        ? (Users.findByUsername(usernameAttempted) || Users.findByEmail(usernameAttempted))
        : null;
    if (!newlyBanned || !user?.email) return;

    const plain = crypto.randomBytes(24).toString('hex');
    UnbanChallenges.create(plain, ip, user.id, 48);

    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const url = `${proto}://${host}/api/auth/unban-challenge?token=${encodeURIComponent(plain)}`;

    const subject = 'Security alert: login attempts blocked for your account';
    const text = [
        `Hello ${user.username},`,
        '',
        `We blocked the address ${ip} after repeated failed login attempts to ApiX Gateway.`,
        'If this was you trying to sign in, you can lift the block for that IP:',
        url,
        '',
        'If this was not you, ignore this message — the IP remains blocked.',
    ].join('\n');

    const html = `<p>Hello <strong>${escapeHtml(user.username)}</strong>,</p>
<p>We blocked the address <code>${escapeHtml(ip)}</code> after repeated failed login attempts.</p>
<p>If this was you, click below to <strong>unblock that IP</strong>:</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#3b82f6;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Unblock my IP</a></p>
<p style="font-size:12px;color:#666;">If you did not try to log in, you can ignore this email.</p>`;

    await mailer.send({ to: user.email, subject, text, html });
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function onLoginSuccess(req) {
    const { enabled } = _thresholds();
    if (!enabled) return;
    LoginFailCounters.clear(IpSecurity.normalizeIp(req.ip));
}

module.exports = { onLoginFailure, onLoginSuccess };
