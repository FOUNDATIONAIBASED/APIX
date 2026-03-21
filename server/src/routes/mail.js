'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
    ImapAccounts, ReceivedMailLocal, ImapForwardRules,
} = require('../db');
const { requireAuth, requireFeature } = require('../auth/middleware');
const imapCrypto = require('../email/imapCrypto');
const imapSync = require('../email/imapSync');

const router = express.Router();
router.use(requireAuth());
router.use(requireFeature('imap_mail'));

function uid(req) {
    return req.user.uid || req.user.user_id;
}

function stripSecrets(acc) {
    if (!acc) return acc;
    const { password_enc, ...rest } = acc;
    return { ...rest, has_password: !!password_enc };
}

// ── IMAP accounts ─────────────────────────────────────────────
router.get('/imap-accounts', (req, res) => {
    const rows = ImapAccounts.findByUser(uid(req)).map(stripSecrets);
    res.json({ accounts: rows });
});

router.post('/imap-accounts', (req, res) => {
    const {
        name = 'IMAP',
        host,
        port = 993,
        username,
        password,
        tls = true,
        mailbox = 'INBOX',
        poll_interval_sec = 120,
        enabled = true,
    } = req.body || {};
    if (!host || !username || !password) {
        return res.status(400).json({ error: 'host, username, and password are required' });
    }
    const id = 'imap_' + uuidv4().replace(/-/g, '').slice(0, 12);
    ImapAccounts.insert({
        id,
        user_id: uid(req),
        name,
        host,
        port,
        username,
        password_enc: imapCrypto.encrypt(password),
        tls,
        mailbox,
        poll_interval_sec,
        enabled,
        last_uid: 0,
    });
    res.status(201).json({ success: true, id, account: stripSecrets(ImapAccounts.findByIdForUser(id, uid(req))) });
});

router.patch('/imap-accounts/:id', (req, res) => {
    const acc = ImapAccounts.findByIdForUser(req.params.id, uid(req));
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const u = { ...req.body };
    if (u.password) {
        u.password_enc = imapCrypto.encrypt(u.password);
        delete u.password;
    }
    delete u.id;
    delete u.user_id;
    ImapAccounts.update(req.params.id, uid(req), u);
    res.json({ success: true, account: stripSecrets(ImapAccounts.findByIdForUser(req.params.id, uid(req))) });
});

router.delete('/imap-accounts/:id', (req, res) => {
    const n = ImapAccounts.delete(req.params.id, uid(req));
    if (!n) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
});

router.post('/imap-accounts/:id/sync', async (req, res) => {
    const acc = ImapAccounts.findByIdForUser(req.params.id, uid(req));
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    try {
        await imapSync.syncAccount(acc);
        res.json({ success: true, account: stripSecrets(ImapAccounts.findByIdForUser(req.params.id, uid(req))) });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Sync failed' });
    }
});

// ── Local mailbox (delete = local index only; IMAP server unchanged) ──
router.get('/local', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    const rows = ReceivedMailLocal.findByUser(uid(req), { limit, includeDeleted: false });
    res.json({ messages: rows });
});

router.delete('/local/:id', (req, res) => {
    const n = ReceivedMailLocal.markLocalDeleted(req.params.id, uid(req));
    if (!n) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, note: 'Removed from local index only; messages remain on the IMAP server.' });
});

// ── IMAP → SMS/Telegram rules ───────────────────────────────────
router.get('/imap-rules', (req, res) => {
    res.json({ rules: ImapForwardRules.findByUser(uid(req)) });
});

router.post('/imap-rules', (req, res) => {
    const {
        name = 'Rule',
        enabled = true,
        imap_account_id = null,
        match_all = false,
        match_from_regex,
        match_subject_contains,
        match_body_contains,
        channel,
        dest_telegram_chat_id,
        dest_sms_to,
        priority = 0,
    } = req.body || {};
    if (!channel || !['telegram', 'sms'].includes(channel)) {
        return res.status(400).json({ error: 'channel must be telegram or sms' });
    }
    if (channel === 'telegram' && !String(dest_telegram_chat_id || '').trim()) {
        return res.status(400).json({ error: 'dest_telegram_chat_id required' });
    }
    if (channel === 'sms' && !String(dest_sms_to || '').trim()) {
        return res.status(400).json({ error: 'dest_sms_to required' });
    }
    const id = 'ifr_' + uuidv4().replace(/-/g, '').slice(0, 12);
    ImapForwardRules.insert({
        id,
        user_id: uid(req),
        imap_account_id: imap_account_id || null,
        name,
        enabled,
        match_all: !!match_all,
        match_from_regex: match_from_regex || null,
        match_subject_contains: match_subject_contains || null,
        match_body_contains: match_body_contains || null,
        channel,
        dest_telegram_chat_id: dest_telegram_chat_id || null,
        dest_sms_to: dest_sms_to || null,
        priority,
    });
    res.status(201).json({ success: true, id, rule: ImapForwardRules.findByIdForUser(id, uid(req)) });
});

router.patch('/imap-rules/:id', (req, res) => {
    const rule = ImapForwardRules.findByIdForUser(req.params.id, uid(req));
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    ImapForwardRules.update(req.params.id, uid(req), req.body || {});
    res.json({ success: true, rule: ImapForwardRules.findByIdForUser(req.params.id, uid(req)) });
});

router.delete('/imap-rules/:id', (req, res) => {
    const n = ImapForwardRules.delete(req.params.id, uid(req));
    if (!n) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
});

module.exports = router;
