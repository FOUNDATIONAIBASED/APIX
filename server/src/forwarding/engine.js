'use strict';
/**
 * Run per-user forwarding rules after inbound SMS/MMS (plan feature: forwarding_rules).
 * Requires device.user_id to associate traffic with an account.
 */
const { Devices, ForwardingRules, Plans, Users } = require('../db');
const telegram = require('../telegram');
const scheduler = require('../queue/scheduler');

function _matchRule(rule, data) {
    const from = data.from || '';
    const to = data.to || '';
    const body = data.body || '';

    if (rule.match_from_regex) {
        try {
            if (!new RegExp(rule.match_from_regex, 'i').test(from)) return false;
        } catch { return false; }
    }
    if (rule.match_to_regex) {
        try {
            if (!new RegExp(rule.match_to_regex, 'i').test(to)) return false;
        } catch { return false; }
    }
    if (rule.match_body_contains) {
        const needle = String(rule.match_body_contains);
        if (!body.includes(needle)) return false;
    }
    return true;
}

function _formatBody(data) {
    const from = String(data.from || 'unknown').slice(-20);
    const to = String(data.to || '').slice(-20);
    const body = String(data.body || '').slice(0, 2000);
    const type = (data.type || 'sms').toUpperCase();
    return `📱 <b>${type} ${from} → ${to}</b>\n\n${body || '(no text)'}`;
}

/**
 * @param {object} data — message:inbound payload (from, to, body, deviceId, type)
 */
async function processInbound(data) {
    const deviceId = data.deviceId;
    if (!deviceId) return;

    const dev = Devices.findById(deviceId);
    if (!dev?.user_id) return;

    const user = Users.findById(dev.user_id);
    if (!user) return;

    const plan = user.plan_id ? Plans.findById(user.plan_id) : Plans.getDefault();
    if (!plan?.features?.forwarding_rules) return;

    const rules = ForwardingRules.findByUser(dev.user_id).filter(r => r.enabled);
    if (!rules.length) return;

    for (const rule of rules) {
        if (!_matchRule(rule, data)) continue;

        if (rule.channel === 'telegram') {
            const chatId = rule.dest_telegram_chat_id || '';
            const cfg = telegram.getConfig();
            const token = cfg.botToken;
            if (!token || !chatId) continue;
            const text = _formatBody(data);
            const ok = await telegram.sendMessage(token, String(chatId).trim(), text);
            if (ok) Users.clearSmsForwardError(dev.user_id);
            else Users.setLastSmsForwardError(dev.user_id, 'Telegram sendMessage failed (forwarding rule)');
        } else if (rule.channel === 'sms') {
            const dest = (rule.dest_sms_to || '').trim();
            if (!dest) continue;
            const fromNum = data.to || null;
            await new Promise((resolve) => {
                scheduler.enqueue(async () => {
                    try {
                        await scheduler.dispatchSms({
                            to: dest,
                            from: fromNum,
                            body: `[Fwd ${data.type || 'sms'}] ${data.from}: ${(data.body || '').slice(0, 500)}`,
                            type: 'sms',
                            deviceId,
                        });
                        Users.clearSmsForwardError(dev.user_id);
                    } catch (e) {
                        console.warn('[FORWARD] SMS rule failed:', e.message);
                        Users.setLastSmsForwardError(dev.user_id, `SMS forward: ${e.message}`);
                    }
                    resolve();
                }, rule.priority || 5);
            });
        }
    }
}

module.exports = { processInbound, _matchRule };
