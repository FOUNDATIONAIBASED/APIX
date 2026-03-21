'use strict';
/**
 * Poll IMAP mailboxes, store messages locally (SQLite + optional attachment files),
 * apply imap_forward_rules → Telegram / SMS.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { simpleParser } = require('mailparser');
const { ImapFlow } = require('imapflow');
const cfg = require('../config');
const imapCrypto = require('./imapCrypto');
const {
    ImapAccounts, ReceivedMailLocal, ImapForwardRules, Plans, Users,
} = require('../db');
const telegram = require('../telegram');
const scheduler = require('../queue/scheduler');

function _attachDir() {
    const d = path.join(path.dirname(cfg.dbPath), 'mail_attach');
    fs.mkdirSync(d, { recursive: true });
    return d;
}

/**
 * Whether an IMAP forward rule matches a stored mail row (dry-run / live).
 * @param {object} rule — imap_forward_rules row
 * @param {object} mail — received_emails_local row shape
 */
const MAX_IMAP_REGEX_LEN = 256;
/** Mitigate ReDoS / regex injection: bounded length + no nested quantifier traps (heuristic). */
function safeImapFromRegexTest(pattern, input) {
    const p = String(pattern || '').slice(0, MAX_IMAP_REGEX_LEN);
    if (!p) return false;
    if (/\(\([^)]+\)\+\)\+/.test(p) || /\(\.\*\)\{[0-9]+,/.test(p)) return false;
    try {
        return new RegExp(p, 'i').test(String(input || ''));
    } catch {
        return false;
    }
}

function matchImapRule(rule, mail) {
    if (rule.imap_account_id && rule.imap_account_id !== mail.imap_account_id) return false;
    if (rule.match_all) return true;
    const hasFilter = rule.match_from_regex || rule.match_subject_contains || rule.match_body_contains;
    if (!hasFilter) return false;
    let hit = false;
    if (rule.match_from_regex) {
        if (safeImapFromRegexTest(rule.match_from_regex, mail.from_addr || '')) hit = true;
    }
    if (rule.match_subject_contains && String(mail.subject || '').includes(rule.match_subject_contains)) hit = true;
    if (rule.match_body_contains && String(mail.body_text || mail.snippet || '').includes(rule.match_body_contains)) hit = true;
    return hit;
}

async function _applyForwardRules(mailRow) {
    const rules = ImapForwardRules.findByUser(mailRow.user_id).filter(r => r.enabled);
    const sorted = [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const rule of sorted) {
        if (!matchImapRule(rule, mailRow)) continue;
        const subj = mailRow.subject || '(no subject)';
        const preview = (mailRow.body_text || mailRow.snippet || '').slice(0, 1500);
        if (rule.channel === 'telegram') {
            const chatId = String(rule.dest_telegram_chat_id || '').trim();
            const tcfg = telegram.getConfig();
            if (!tcfg.botToken || !chatId) continue;
            const text = `📧 <b>IMAP</b>\n<b>From:</b> ${escapeHtml(mailRow.from_addr || '—')}\n<b>Subject:</b> ${escapeHtml(subj)}\n\n${escapeHtml(preview)}`;
            const tgOk = await telegram.sendMessage(tcfg.botToken, chatId, text);
            if (!tgOk) Users.setLastImapRuleError(mailRow.user_id, 'Telegram sendMessage failed (IMAP rule)');
            else Users.clearImapRuleError(mailRow.user_id);
        } else if (rule.channel === 'sms') {
            const dest = String(rule.dest_sms_to || '').trim();
            if (!dest) continue;
            const body = `[Mail] ${subj}\n${preview}`.slice(0, 700);
            scheduler.enqueue(async () => {
                try {
                    await scheduler.dispatchSms({ to: dest, from: null, body, type: 'sms' });
                    Users.clearImapRuleError(mailRow.user_id);
                } catch (e) {
                    console.warn('[IMAP→SMS]', e.message);
                    Users.setLastImapRuleError(mailRow.user_id, `SMS forward: ${e.message}`);
                }
            }, rule.priority || 5);
        }
    }
}

function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Sync one account; updates last_uid / last_sync_at.
 */
async function syncAccount(account) {
    const pass = imapCrypto.decrypt(account.password_enc);
    if (!pass) throw new Error('Could not decrypt password (set IMAP_SECRET_KEY if passwords were encrypted with another key)');

    const client = new ImapFlow({
        host: account.host,
        port: account.port || 993,
        secure: account.tls !== 0,
        auth: { user: account.username, pass },
        logger: false,
    });

    await client.connect();
    const mbox = account.mailbox || 'INBOX';
    let maxSeen = account.last_uid || 0;

    try {
        await client.mailboxOpen(mbox);
        const lastUid = account.last_uid || 0;
        const range = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';

        for await (const msg of client.fetch(range, { source: true }, { uid: true })) {
            const uid = msg.uid;
            if (!uid) continue;
            maxSeen = Math.max(maxSeen, uid);

            let parsed;
            try {
                parsed = await simpleParser(msg.source);
            } catch (e) {
                console.warn('[IMAP] parse failed uid', uid, e.message);
                continue;
            }

            const fromAddr = parsed.from?.value?.map(v => v.address || v.name).join(', ') || '';
            const subject = parsed.subject || '';
            const bodyText = parsed.text || '';
            const snippet = (bodyText || parsed.html || '').slice(0, 500);

            const id = 'eml_' + uuidv4().replace(/-/g, '').slice(0, 14);
            const attPaths = [];
            let hasAtt = false;

            if (parsed.attachments?.length) {
                const base = path.join(_attachDir(), account.id, String(uid));
                fs.mkdirSync(base, { recursive: true });
                for (const a of parsed.attachments) {
                    if (!a.content || a.size > 12 * 1024 * 1024) continue;
                    const fname = (a.filename || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120);
                    const fp = path.join(base, fname);
                    try {
                        fs.writeFileSync(fp, a.content);
                        attPaths.push(path.relative(path.dirname(cfg.dbPath), fp));
                        hasAtt = true;
                    } catch (e) {
                        console.warn('[IMAP] attachment write', e.message);
                    }
                }
            }

            const receivedAt = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();

            try {
                ReceivedMailLocal.insert({
                    id,
                    user_id: account.user_id,
                    imap_account_id: account.id,
                    imap_uid: uid,
                    from_addr: fromAddr,
                    subject,
                    body_text: bodyText.slice(0, 500_000),
                    snippet,
                    received_at: receivedAt,
                    has_attachments: hasAtt,
                    attachment_paths: JSON.stringify(attPaths),
                });
            } catch (e) {
                if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(e.message).includes('UNIQUE')) continue;
                throw e;
            }

            const row = {
                id,
                user_id: account.user_id,
                imap_account_id: account.id,
                from_addr: fromAddr,
                subject,
                body_text: bodyText,
                snippet,
            };
            try {
                await _applyForwardRules(row);
            } catch (e) {
                console.warn('[IMAP] forward rules', e.message);
                try { Users.setLastImapRuleError(row.user_id, e.message); } catch (_) {}
            }
        }
    } finally {
        try { await client.logout(); } catch (_) {}
    }

    ImapAccounts.update(account.id, account.user_id, {
        last_uid: maxSeen,
        last_sync_at: new Date().toISOString(),
        last_sync_error: null,
    });
}

const _lastPoll = new Map();

async function syncAll() {
    const accounts = ImapAccounts.findEnabledAll();
    for (const raw of accounts) {
        const user = Users.findById(raw.user_id);
        if (!user) continue;
        const plan = user.plan_id ? Plans.findById(user.plan_id) : Plans.getDefault();
        if (!plan?.features?.imap_mail) continue;

        const interval = Math.max(60, raw.poll_interval_sec || 120) * 1000;
        const key = raw.id;
        const last = _lastPoll.get(key) || 0;
        if (Date.now() - last < interval) continue;
        _lastPoll.set(key, Date.now());

        try {
            await syncAccount(raw);
        } catch (e) {
            console.error(`[IMAP] sync ${raw.id} (${raw.host}):`, e.message);
            try {
                ImapAccounts.update(raw.id, raw.user_id, {
                    last_sync_error: String(e.message || 'sync failed').slice(0, 500),
                });
            } catch (_) { /* ignore */ }
        }
    }
}

module.exports = { syncAccount, syncAll, matchImapRule };
