'use strict';
const nodemailer = require('nodemailer');

function buildOpts(profile) {
    const rejectUnauthorized = profile.tls_reject_unauthorized !== false;
    const opts = {
        host: profile.host,
        port: profile.port,
        secure: !!profile.secure,
        tls: { rejectUnauthorized },
    };
    if (profile.pool) {
        opts.pool = true;
        opts.maxConnections = 5;
        opts.maxMessages = 100;
    }
    if (profile.user || profile.pass) {
        opts.auth = { user: profile.user, pass: profile.pass };
    }
    return opts;
}

function fromHeader(profile) {
    const name = (profile.from_name || 'ApiX Gateway').replace(/"/g, '\\"');
    const addr = profile.from || profile.user || 'noreply@localhost';
    return `"${name}" <${addr}>`;
}

function createTransport(profile) {
    return nodemailer.createTransport(buildOpts(profile));
}

async function verify(profile) {
    const t = createTransport(profile);
    await t.verify();
}

/**
 * @param {object} profile - normalized profile
 * @param {object} mail - { to, subject, text, html }
 */
async function sendMail(profile, mail) {
    const t = createTransport(profile);
    const msg = {
        from: fromHeader(profile),
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
    };
    if (profile.reply_to) msg.replyTo = profile.reply_to;
    await t.sendMail(msg);
}

module.exports = { buildOpts, createTransport, verify, sendMail, fromHeader };
