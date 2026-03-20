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

function baseHtml(title, bodyHtml) {
    const color  = brandColor();
    const logo   = logoUrl();
    const footer = footerText();
    const logoEl = logo
        ? `<img src="${logo}" alt="Logo" style="height:36px;display:block;margin-bottom:10px;">`
        : `<div class="logo">Api<em>X</em> Gateway</div>`;
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;padding:40px 20px;}
.card{max-width:520px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;}
.header{padding:28px 32px;background:linear-gradient(135deg,#1d2d50,#0d1117);border-bottom:1px solid #30363d;}
.logo{font-family:monospace;font-weight:700;font-size:20px;color:${color};letter-spacing:-0.5px;}
.logo em{font-style:normal;}
.body{padding:32px;}
h2{font-size:20px;font-weight:700;margin-bottom:10px;color:#f0f6fc;}
p{font-size:14px;line-height:1.65;color:#8b949e;margin-bottom:16px;}
.btn{display:inline-block;padding:13px 28px;background:${color};color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin:8px 0 20px;}
.code{font-family:monospace;background:#21262d;border:1px solid #30363d;border-radius:6px;padding:12px 16px;font-size:13px;color:${color};word-break:break-all;margin:12px 0;}
.footer{padding:20px 32px;border-top:1px solid #30363d;font-size:11px;color:#484f58;line-height:1.5;}
.warn{background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.3);border-radius:6px;padding:10px 14px;font-size:12px;color:#ffa198;margin-top:12px;}
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
    `);
    return send({ to: toEmail, subject, text, html });
}

/**
 * Send a welcome / account-created email.
 */
async function sendWelcome(toEmail, username, loginUrl) {
    const subject = 'Welcome to ApiX Gateway';
    const text = `Hi ${username},\n\nYour account has been created.\nLogin at: ${loginUrl}`;
    const html = baseHtml('Welcome', `
        <h2>Welcome to ApiX Gateway!</h2>
        <p>Hi <strong>${username}</strong>,</p>
        <p>Your account has been created. Click below to sign in.</p>
        <a href="${loginUrl}" class="btn">Sign In</a>
    `);
    return send({ to: toEmail, subject, text, html });
}

/**
 * Send one-time password (invitation) email. User must change password on first login.
 */
async function sendInvite(toEmail, username, oneTimePassword, loginUrl) {
    const subject = 'Your ApiX Gateway account — one-time password';
    const text = `Hi ${username},\n\nYour ApiX Gateway account has been created. Use this one-time password to sign in (you will be prompted to change it):\n\nPassword: ${oneTimePassword}\n\nLogin at: ${loginUrl}\n\nThis password is single-use — change it immediately after signing in.`;
    const html = baseHtml('Your ApiX Gateway Account', `
        <h2>Your account has been created</h2>
        <p>Hi <strong>${username}</strong>,</p>
        <p>Your ApiX Gateway account is ready. Use this <strong>one-time password</strong> to sign in. You will be prompted to set a new password after login.</p>
        <div class="code">${oneTimePassword}</div>
        <a href="${loginUrl}" class="btn">Sign In</a>
        <div class="warn">⚠ Change this password after your first login. Do not share it.</div>
    `);
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

module.exports = { send, sendPasswordReset, sendWelcome, sendInvite, testConnection };
