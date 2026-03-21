'use strict';
/**
 * Parse inbound SMS/MMS for email relay triggers, send via SMTP.
 * Patterns (case-insensitive):
 *   $#email: user@domain.com
 *   email: user@domain.com
 * Optional:  message: ...   (rest of body or explicit line)
 */
const axios = require('axios');
const smtpRouter = require('../email/smtpRouter');
const { Devices, Plans, Users } = require('../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseSmsToEmailBody(body) {
    if (!body || typeof body !== 'string') return null;
    const b = body.trim();
    let m = b.match(/\$#email:\s*(\S+)/i);
    if (!m) m = b.match(/(?:^|[\r\n])\s*email:\s*(\S+)/i);
    if (!m) return null;
    let addr = m[1].replace(/[>,;\]]+$/g, '').trim();
    if (!EMAIL_RE.test(addr)) return null;

    let rest = b.slice(m.index + m[0].length).trim();
    const msgLine = rest.match(/^\s*message:\s*([\s\S]*)$/im);
    if (msgLine) rest = msgLine[1].trim();
    return { email: addr, message: rest || '(no text)' };
}

async function _fetchAttachment(url) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    try {
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 25000, maxContentLength: 15 * 1024 * 1024 });
        const ctype = r.headers['content-type'] || 'application/octet-stream';
        const ext = ctype.includes('png') ? 'png' : ctype.includes('jpeg') || ctype.includes('jpg') ? 'jpg' : ctype.includes('gif') ? 'gif' : 'bin';
        return { buffer: Buffer.from(r.data), contentType: ctype, filename: `attachment.${ext}` };
    } catch (e) {
        console.warn('[SMS→EMAIL] fetch attachment failed:', e.message);
        return null;
    }
}

/**
 * @param {object} data - message:inbound { from, to, body, deviceId, type, id }
 */
async function processInbound(data) {
    const parsed = parseSmsToEmailBody(data.body || '');
    if (!parsed) return false;

    const deviceId = data.deviceId;
    if (!deviceId) return false;
    const dev = Devices.findById(deviceId);
    if (!dev?.user_id) return false;

    const user = Users.findById(dev.user_id);
    if (!user) return false;
    const plan = user.plan_id ? Plans.findById(user.plan_id) : Plans.getDefault();
    if (!plan?.features?.imap_mail) return false;

    const subject = `[ApiX SMS] From ${data.from || 'unknown'} (${data.type || 'sms'})`;
    const text = parsed.message + (data.media_url ? `\n\nMedia: ${data.media_url}` : '');
    const html = `<pre style="font-family:system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(parsed.message)}</pre>${
        data.media_url ? `<p><a href="${escapeHtmlAttr(data.media_url)}">Media link</a></p>` : ''}`;

    const attachments = [];
    if (data.type === 'mms' && data.media_url) {
        const att = await _fetchAttachment(data.media_url);
        if (att) {
            attachments.push({
                filename: att.filename,
                content: att.buffer,
                contentType: att.contentType,
            });
        }
    }

    try {
        await smtpRouter.sendTransactional({
            to: parsed.email,
            subject,
            text,
            html,
            attachments: attachments.length ? attachments : undefined,
        });
        console.info(`[SMS→EMAIL] → ${parsed.email} (from ${data.from})`);
        return true;
    } catch (e) {
        console.error('[SMS→EMAIL]', e.message);
        return false;
    }
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeHtmlAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\r|\n/g, ' ');
}

module.exports = { processInbound, parseSmsToEmailBody };
