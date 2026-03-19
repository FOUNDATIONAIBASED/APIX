'use strict';
/**
 * Telegram Bot integration — forwards inbound SMS/MMS to a Telegram chat/channel.
 * Configure via Settings: telegram_bot_token, telegram_chat_id, telegram_forward_to_number (optional)
 * Or env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_FORWARD_TO_NUMBER
 */
const https = require('https');

function getConfig() {
    try {
        const { Settings } = require('./db');
        const enabled = Settings.get('telegram_forward_enabled');
        const envEnabled = process.env.TELEGRAM_FORWARD_ENABLED !== 'false';
        return {
            enabled:   (enabled !== 'false' && enabled !== '0') && envEnabled,
            botToken:  Settings.get('telegram_bot_token')  || process.env.TELEGRAM_BOT_TOKEN,
            chatId:    Settings.get('telegram_chat_id')    || process.env.TELEGRAM_CHAT_ID,
            toNumber:  Settings.get('telegram_forward_to_number') || process.env.TELEGRAM_FORWARD_TO_NUMBER || null,
        };
    } catch {
        return {
            enabled:   process.env.TELEGRAM_FORWARD_ENABLED !== 'false',
            botToken:  process.env.TELEGRAM_BOT_TOKEN,
            chatId:    process.env.TELEGRAM_CHAT_ID,
            toNumber:  process.env.TELEGRAM_FORWARD_TO_NUMBER || null,
        };
    }
}

function escapeHtml(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Forward an inbound message to Telegram.
 * @param {object} data - { from, to, body, type }
 * @returns {Promise<boolean>} true if sent, false if skipped
 */
async function forwardInbound(data) {
    const { enabled, botToken, chatId, toNumber } = getConfig();
    if (!enabled || !botToken || !chatId) return false;

    // Optional: only forward messages TO a specific number (the number you text to trigger forwarding)
    if (toNumber) {
        const toNorm = (data.to || '').replace(/\D/g, '');
        const filterNorm = toNumber.replace(/\D/g, '');
        const minLen = Math.min(toNorm.length, filterNorm.length, 10);
        const toSuffix = toNorm.slice(-minLen);
        const filterSuffix = filterNorm.slice(-minLen);
        if (!toNorm || !filterNorm || toSuffix !== filterSuffix) return false;
    }

    const from = escapeHtml((data.from || 'unknown').slice(-15));
    const to = escapeHtml((data.to || '').slice(-15));
    const body = escapeHtml((data.body || '').slice(0, 2000));
    const type = (data.type || 'sms').toUpperCase();
    const text = `📱 <b>${type} from ${from}</b>\n→ to ${to}\n\n${body || '(no text)'}`;

    return sendMessage(botToken, chatId, text);
}

/**
 * Send a message via Telegram Bot API.
 */
function sendMessage(botToken, chatId, text, parseMode = 'HTML') {
    return new Promise((resolve) => {
        const body = JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: parseMode,
            disable_web_page_preview: true,
        });
        const req = https.request(
            {
                hostname: 'api.telegram.org',
                path: `/bot${botToken}/sendMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let buf = '';
                res.on('data', (c) => { buf += c; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
                    else {
                        console.warn('[TELEGRAM]', res.statusCode, buf.slice(0, 200));
                        resolve(false);
                    }
                });
            }
        );
        req.on('error', (e) => {
            console.warn('[TELEGRAM]', e.message);
            resolve(false);
        });
        req.setTimeout(10000, () => { req.destroy(); resolve(false); });
        req.write(body);
        req.end();
    });
}

module.exports = { forwardInbound, sendMessage, getConfig };
