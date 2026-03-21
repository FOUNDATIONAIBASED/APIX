'use strict';
/**
 * Transactional email templates + send via multi-SMTP router.
 *
 * Legacy single-SMTP .env still works if no DB profiles are configured.
 * Admin: Settings → Email / SMTP (multi-profile, quotas, routing; max via SMTP_MAX_PROFILES).
 */
const smtpConfig = require('./smtpConfig');
const smtpRouter = require('./smtpRouter');
const smtpTransport = require('./smtpTransport');

function firstEffectiveFromEnv() {
    const p = smtpConfig.envLegacyProfile();
    if (!p) return { name: 'ApiX Gateway', addr: 'noreply@example.com' };
    return { name: p.from_name, addr: p.from || p.user || 'noreply@example.com' };
}

function fromAddress() {
    const profiles = smtpConfig.getEffectiveProfiles();
    if (profiles.length) {
        const p = profiles[0];
        return smtpTransport.fromHeader(p);
    }
    const { name, addr } = firstEffectiveFromEnv();
    return `"${name}" <${addr}>`;
}

function replyTo() {
    const profiles = smtpConfig.getEffectiveProfiles();
    if (profiles[0]?.reply_to) return profiles[0].reply_to;
    return process.env.SMTP_REPLY_TO || undefined;
}

function footerText() {
    return process.env.EMAIL_FOOTER || 'Sent by ApiX Gateway';
}

function brandColor() {
    return process.env.EMAIL_BRAND_COLOR || '#3b82f6';
}

/** Preset styles aligned with management UI (dark / light). Override with EMAIL_PRESET=dark|light */
const EMAIL_PRESETS = {
    dark: {
        pageBg:    '#07090f',
        cardBg:    '#0f1320',
        cardBorder:'#1c2640',
        headerBg:  'linear-gradient(135deg,#131a2c,#0b0e18)',
        title:     '#e1e8f5',
        text:      '#7e95bb',
        accent:    '#3b82f6',
        codeBg:    '#131a2c',
        codeBorder:'#253354',
        footer:    '#3d5070',
        warnBg:    'rgba(239,68,68,.1)',
        warnBorder:'rgba(239,68,68,.3)',
        warnText:  '#fca5a5',
    },
    light: {
        pageBg:    '#f0f2f7',
        cardBg:    '#ffffff',
        cardBorder:'#d0d8e8',
        headerBg:  'linear-gradient(135deg,#e8ecf4,#ffffff)',
        title:     '#1a2236',
        text:      '#4a5a7a',
        accent:    '#2563eb',
        codeBg:    '#e8ecf4',
        codeBorder:'#b8c4d8',
        footer:    '#8898b8',
        warnBg:    'rgba(220,38,38,.08)',
        warnBorder:'rgba(220,38,38,.25)',
        warnText:  '#dc2626',
    },
};

function activePreset() {
    const k = (process.env.EMAIL_PRESET || 'dark').toLowerCase();
    return EMAIL_PRESETS[k] || EMAIL_PRESETS.dark;
}

function logoUrl() {
    return process.env.EMAIL_LOGO_URL || '';
}

/**
 * Send a plain + HTML email.
 * @param {object} opts  - { to, subject, text, html }
 * @returns {Promise<boolean>} true = sent, false = skipped (no SMTP config)
 */
async function send({ to, subject, text, html }) {
    try {
        return await smtpRouter.sendTransactional({ to, subject, text, html });
    } catch (err) {
        console.error('[MAIL] Send error:', err.message);
        throw err;
    }
}

// ── Pre-built email templates ───────────────────────────────────

function baseHtml(title, bodyHtml, presetName) {
    const color  = brandColor();
    const logo   = logoUrl();
    const footer = footerText();
    const P      = EMAIL_PRESETS[presetName] || activePreset();
    const logoEl = logo
        ? `<img src="${logo}" alt="Logo" style="height:36px;display:block;margin-bottom:10px;">`
        : `<div class="logo">Api<em>X</em> Gateway</div>`;
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,sans-serif;background:${P.pageBg};color:${P.title};padding:40px 20px;}
.card{max-width:520px;margin:0 auto;background:${P.cardBg};border:1px solid ${P.cardBorder};border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);}
.header{padding:28px 32px;background:${P.headerBg};border-bottom:1px solid ${P.cardBorder};}
.logo{font-family:ui-monospace,monospace;font-weight:700;font-size:20px;color:${color};letter-spacing:-0.5px;}
.logo em{font-style:normal;color:${P.accent};}
.body{padding:32px;}
h2{font-size:20px;font-weight:700;margin-bottom:10px;color:${P.title};}
p{font-size:14px;line-height:1.65;color:${P.text};margin-bottom:16px;}
.btn{display:inline-block;padding:13px 28px;background:${color};color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin:8px 0 20px;}
.code{font-family:ui-monospace,monospace;background:${P.codeBg};border:1px solid ${P.codeBorder};border-radius:6px;padding:12px 16px;font-size:13px;color:${color};word-break:break-all;margin:12px 0;}
.footer{padding:20px 32px;border-top:1px solid ${P.cardBorder};font-size:11px;color:${P.footer};line-height:1.5;}
.warn{background:${P.warnBg};border:1px solid ${P.warnBorder};border-radius:6px;padding:10px 14px;font-size:12px;color:${P.warnText};margin-top:12px;}
</style></head>
<body><div class="card">
<div class="header">${logoEl}</div>
<div class="body">${bodyHtml}</div>
<div class="footer">
  ${footer} — If you did not request this, you can safely ignore it.<br>
  Do not share this link with anyone.
</div>
</div></body></html>`;
}

/**
 * Send a password reset email.
 * @param {string} toEmail
 * @param {string} username
 * @param {string} resetUrl  — full URL to the reset page with token
 */
async function sendPasswordReset(toEmail, username, resetUrl) {
    const preset = process.env.EMAIL_PRESET || 'dark';
    const subject = 'Reset your ApiX Gateway password';
    const text = `Hi ${username},\n\nYou requested a password reset.\n\nClick the link below to set a new password (valid for 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email.`;
    const html = baseHtml('Password Reset', `
        <h2>Reset your password</h2>
        <p>Hi <strong>${username}</strong>,</p>
        <p>You requested a password reset for your ApiX Gateway account. Click the button below to set a new password.</p>
        <a href="${resetUrl}" class="btn">Reset Password</a>
        <p>Or copy this link into your browser:</p>
        <div class="code">${resetUrl}</div>
        <p>This link is valid for <strong>1 hour</strong>.</p>
        <div class="warn">⚠ If you didn't request a password reset, your account is safe — just ignore this email.</div>
    `, preset);
    return send({ to: toEmail, subject, text, html });
}

/**
 * Send a welcome / account-created email.
 */
async function sendWelcome(toEmail, username, loginUrl) {
    const preset = process.env.EMAIL_PRESET || 'dark';
    const subject = 'Welcome to ApiX Gateway';
    const text = `Hi ${username},\n\nYour account has been created.\nLogin at: ${loginUrl}`;
    const html = baseHtml('Welcome', `
        <h2>Welcome to ApiX Gateway!</h2>
        <p>Hi <strong>${username}</strong>,</p>
        <p>Your account has been created. Click below to sign in.</p>
        <a href="${loginUrl}" class="btn">Sign In</a>
    `, preset);
    return send({ to: toEmail, subject, text, html });
}

/**
 * Send one-time password (invitation) email. User must change password on first login.
 */
async function sendInvite(toEmail, username, oneTimePassword, loginUrl) {
    const preset = process.env.EMAIL_PRESET || 'dark';
    const subject = 'Your ApiX Gateway account — one-time password';
    const text = `Hi ${username},\n\nYour ApiX Gateway account has been created. Use this one-time password to sign in (you will be prompted to change it):\n\nPassword: ${oneTimePassword}\n\nLogin at: ${loginUrl}\n\nThis password is single-use — change it immediately after signing in.`;
    const html = baseHtml('Your ApiX Gateway Account', `
        <h2>Your account has been created</h2>
        <p>Hi <strong>${username}</strong>,</p>
        <p>Your ApiX Gateway account is ready. Use this <strong>one-time password</strong> to sign in. You will be prompted to set a new password after login.</p>
        <div class="code">${oneTimePassword}</div>
        <a href="${loginUrl}" class="btn">Sign In</a>
        <div class="warn">⚠ Change this password after your first login. Do not share it.</div>
    `, preset);
    return send({ to: toEmail, subject, text, html });
}

/**
 * Test SMTP connection (admin diagnostic).
 */
async function testConnection() {
    const profiles = smtpConfig.getEffectiveProfiles();
    if (!profiles.length) return { ok: false, reason: 'SMTP not configured' };
    const r = await smtpRouter.testProfile(profiles[0]);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason || 'verify failed' };
}

module.exports = {
    send, sendPasswordReset, sendWelcome, sendInvite, testConnection,
    baseHtml, EMAIL_PRESETS,
};
