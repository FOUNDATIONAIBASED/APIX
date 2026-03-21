'use strict';
const { v4: uuidv4 }              = require('uuid');
const { Devices, Messages, Conversations, OptOuts, PairingTokens, KeywordRules, getDb, IpSecurity, DeviceBatterySamples } = require('../db');
const { generateDeviceToken }     = require('../auth');
const cfg                         = require('../config');

// Map of deviceId → WebSocket connection
const clients = new Map();

/** ws.send can throw if the socket is closing; never let that crash the process */
function safeSend(ws, payload) {
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    try {
        const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
        ws.send(msg);
        return true;
    } catch (e) {
        console.warn('[WS] send failed:', e.message);
        return false;
    }
}

function broadcast(data, excludeDeviceId = null) {
    const msg = JSON.stringify(data);
    for (const [id, ws] of clients) {
        if (id !== excludeDeviceId && ws.readyState === 1 /* OPEN */) {
            if (!safeSend(ws, msg)) clients.delete(id);
        }
    }
}

function sendToDevice(deviceId, data) {
    const ws = clients.get(deviceId);
    if (!ws || ws.readyState !== 1) return false;
    if (safeSend(ws, data)) return true;
    clients.delete(deviceId);
    return false;
}

/** Close and drop a device connection (e.g. admin deleted device) */
function removeClient(deviceId) {
    const ws = clients.get(deviceId);
    if (ws) {
        try { ws.close(4000, 'device removed'); } catch (_) {}
        clients.delete(deviceId);
    }
}

function getConnectedDeviceIds() {
    return [...clients.keys()];
}

/** Stable client id from Android Settings.Secure.ANDROID_ID (prevents duplicate device rows if token not persisted). */
function normalizeAndroidId(raw) {
    if (raw == null) return '';
    const s = String(raw).trim().slice(0, 96);
    if (!s) return '';
    if (!/^[a-zA-Z0-9._-]+$/.test(s)) return '';
    return s;
}

const lastBatterySampleAt = new Map();
const BATTERY_SAMPLE_INTERVAL_MS = 60_000;

/** Throttled history rows for Power tab charts (one sample per device per minute max). */
function maybeRecordBatterySample(deviceId, msg) {
    const now = Date.now();
    const last = lastBatterySampleAt.get(deviceId) || 0;
    if (now - last < BATTERY_SAMPLE_INTERVAL_MS) return;
    lastBatterySampleAt.set(deviceId, now);
    DeviceBatterySamples.insert(deviceId, {
        battery: typeof msg.battery === 'number' ? msg.battery : null,
        signal_level: msg.signal_level != null ? msg.signal_level : null,
    });
    if (Math.random() < 0.02) DeviceBatterySamples.pruneOlderThan(7);
}

// Called from REST to queue a send through a connected device
function dispatchSms({ msgId, from, to, body }) {
    // Find which device owns this 'from' number
    const allDevices = Devices.findAll();
    for (const dev of allDevices) {
        if (dev.status !== 'approved') continue;
        if (dev.sims.some(s => s.number === from || !from)) {
            if (sendToDevice(dev.id, { type: 'send_sms', msgId, to, from, body })) {
                return dev.id;
            }
        }
    }
    // No specific match — send to first available approved device
    for (const dev of allDevices) {
        if (dev.status === 'approved' && sendToDevice(dev.id, { type: 'send_sms', msgId, to, from, body })) {
            return dev.id;
        }
    }
    return null;
}

function dispatchMms({ msgId, from, to, subject, media, mediaType }) {
    const allDevices = Devices.findAll();
    for (const dev of allDevices) {
        if (dev.status !== 'approved') continue;
        if (sendToDevice(dev.id, { type: 'send_mms', msgId, to, from, subject, media, mediaType })) {
            return dev.id;
        }
    }
    return null;
}

// ── WebSocket connection handler ──────────────────────────────
function handleConnection(ws, req, emitter) {
    let deviceId = null;

    const clientIp = IpSecurity.normalizeIp(req.socket.remoteAddress);
    if (IpSecurity.evaluate(clientIp) === 'block') {
        console.warn(`[WS] Rejected blocked IP ${clientIp}`);
        try { ws.close(4003, 'IP blocked'); } catch (_) {}
        return;
    }

    console.log(`[WS] New connection from ${req.socket.remoteAddress}`);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); }
        catch { safeSend(ws, { type: 'error', message: 'Invalid JSON' }); return; }

        switch (msg.type) {

            // ── Device registration ───────────────────────────
            case 'register': {
                const androidId = normalizeAndroidId(msg.androidId ?? msg.android_id);
                let existing = msg.token ? Devices.findByToken(msg.token) : null;
                if (!existing && androidId) {
                    existing = Devices.findByAndroidId(androidId);
                }

                if (existing) {
                    deviceId = existing.id;
                    clients.set(deviceId, ws);
                    // Do NOT set status to "online" — DB uses pending|approved|suspended only.
                    // "online" breaks outbound dispatch (scheduler filters status === 'approved').
                    if (msg.sims?.length) Devices.upsertSims(deviceId, msg.sims);
                    if (androidId) Devices.setAndroidId(deviceId, androidId);
                    try {
                        const bat = typeof msg.battery === 'number' ? msg.battery : null;
                        getDb().prepare(`
                            UPDATE devices SET last_seen=datetime('now'),
                                model=COALESCE(?, model),
                                android_version=COALESCE(?, android_version),
                                battery=COALESCE(?, battery)
                            WHERE id=?`).run(
                            msg.model || null,
                            msg.androidVersion || null,
                            bat,
                            deviceId,
                        );
                    } catch (_) { /* ignore */ }
                    const st = existing.status || 'pending';
                    safeSend(ws, { type: 'registered', deviceId, token: existing.token, status: st });
                    emitter.emit('device:online', { deviceId });
                    console.log(`[WS] Device re-registered: ${deviceId}`);
                } else {
                    const id    = 'dev_' + uuidv4().replace(/-/g, '').slice(0, 12);
                    const token = generateDeviceToken();

                    // If a pairing token was supplied (QR scan flow), verify it and auto-approve
                    const pairingValid = msg.pairingToken && PairingTokens.verify(msg.pairingToken);
                    const status = (cfg.autoApproveDevices || pairingValid) ? 'approved' : 'pending';

                    Devices.upsert({
                        id,
                        name: msg.model || 'Android Device',
                        token,
                        model: msg.model || null,
                        android_version: msg.androidVersion || null,
                        status,
                        battery: msg.battery || null,
                        android_id: androidId || null,
                    });
                    if (msg.sims?.length) Devices.upsertSims(id, msg.sims);

                    deviceId = id;
                    clients.set(deviceId, ws);
                    safeSend(ws, { type: 'registered', deviceId, token, status });
                    emitter.emit('device:registered', { deviceId, status });
                    console.log(`[WS] New device registered: ${id} (status: ${status})`);
                }
                break;
            }

            // ── Heartbeat ────────────────────────────────────
            case 'heartbeat': {
                if (!deviceId) break;
                const signal = Array.isArray(msg.signal) ? JSON.stringify(msg.signal) : (msg.signal || null);
                Devices.updateHeartbeat(deviceId, msg.battery, signal, msg.sentToday || 0, msg.receivedToday || 0);
                try { maybeRecordBatterySample(deviceId, msg); } catch (e) { console.warn('[WS] battery sample:', e.message); }
                // Update extended device health fields
                try {
                    const updates = [];
                    const vals = [];
                    if (msg.network_type !== undefined) { updates.push('network_type=?'); vals.push(msg.network_type); }
                    if (msg.signal_level !== undefined) { updates.push('signal_level=?'); vals.push(msg.signal_level); }
                    if (msg.sim_slots    !== undefined) { updates.push('sim_slots=?');    vals.push(JSON.stringify(msg.sim_slots)); }
                    if (msg.app_version  !== undefined) { updates.push('app_version=?');  vals.push(msg.app_version); }
                    if (updates.length) {
                        vals.push(deviceId);
                        getDb().prepare(`UPDATE devices SET ${updates.join(',')} WHERE id=?`).run(...vals);
                    }
                } catch {}
                emitter.emit('device:heartbeat', { id: deviceId, battery: msg.battery, signal_level: msg.signal_level, network_type: msg.network_type });
                safeSend(ws, { type: 'heartbeat_ack', ts: Date.now() });
                break;
            }

            // ── Inbound SMS ───────────────────────────────────
            case 'sms_received': {
                if (!deviceId) break;
                const id = 'msg_' + uuidv4().replace(/-/g, '').slice(0, 16);
                Messages.insert({
                    id,
                    direction:    'inbound',
                    from_number:  msg.from,
                    to_number:    msg.to,
                    body:         msg.body,
                    type:         'sms',
                    status:       'received',
                    device_id:    deviceId,
                    media_url:    null,
                    campaign_id:  null,
                    template_id:  null,
                    num_segments: 1,
                });
                Conversations.upsert(msg.from, id);

                // Auto STOP/UNSTOP handling
                const bodyTrimmed = (msg.body || '').trim().toUpperCase();
                if (bodyTrimmed === 'STOP' || bodyTrimmed === 'STOPALL' || bodyTrimmed === 'UNSUBSCRIBE') {
                    OptOuts.add(msg.from, 'STOP', 'inbound');
                    emitter.emit('optout:received', { from: msg.from, to: msg.to, keyword: bodyTrimmed });
                } else if (bodyTrimmed === 'START' || bodyTrimmed === 'UNSTOP') {
                    OptOuts.remove(msg.from);
                } else {
                    // Keyword auto-responder rules
                    try {
                        const rule = KeywordRules.match(msg.body);
                        if (rule) {
                            KeywordRules.incrementMatch(rule.id);
                            // Queue auto-reply back to sender
                            const { enqueue } = require('../queue/scheduler');
                            if (typeof enqueue === 'function') {
                                enqueue({ to: msg.from, from: msg.to, body: rule.reply, priority: 5 });
                            }
                        }
                    } catch (e) {
                        console.warn('[WS] Keyword rule error:', e.message);
                    }
                }

                emitter.emit('message:inbound', { id, from: msg.from, to: msg.to, body: msg.body, deviceId, type: 'sms' });
                console.log(`[WS] SMS in  ${msg.from} → ${msg.to}: ${(msg.body || '').slice(0, 40)}`);
                break;
            }

            // ── Inbound MMS ───────────────────────────────────
            case 'mms_received': {
                if (!deviceId) break;
                const id = 'msg_' + uuidv4().replace(/-/g, '').slice(0, 16);
                Messages.insert({
                    id,
                    direction:    'inbound',
                    from_number:  msg.from,
                    to_number:    msg.to,
                    body:         msg.body || '',
                    type:         'mms',
                    status:       'received',
                    device_id:    deviceId,
                    media_url:    msg.mediaUrl || null,
                    campaign_id:  null,
                    template_id:  null,
                    num_segments: 1,
                });
                Conversations.upsert(msg.from, id);
                emitter.emit('message:inbound', { id, from: msg.from, to: msg.to, body: msg.body, type: 'mms', deviceId, media_url: msg.mediaUrl || null });
                console.log(`[WS] MMS in  ${msg.from} → ${msg.to}`);
                break;
            }

            // ── Delivery receipt ──────────────────────────────
            case 'sms_delivered':
            case 'sms_sent': {
                if (msg.msgId) {
                    const status = msg.type === 'sms_delivered' ? 'delivered' : 'sent';
                    Messages.updateStatus(msg.msgId, status);
                    emitter.emit('message:status', { msgId: msg.msgId, status });
                }
                break;
            }

            case 'sms_failed': {
                if (msg.msgId) {
                    Messages.updateStatus(msg.msgId, 'failed');
                    emitter.emit('message:status', { msgId: msg.msgId, status: 'failed', error: msg.error });
                }
                break;
            }

            default:
                console.warn(`[WS] Unknown message type: ${msg.type}`);
        }
    });

    ws.on('close', () => {
        if (deviceId) {
            clients.delete(deviceId);
            // Do NOT set devices.status to 'offline' — dispatch/scheduler require 'approved'|'pending'|'suspended'.
            // Connection state is tracked via clients map + device:offline event only.
            try {
                getDb().prepare("UPDATE devices SET last_seen=datetime('now') WHERE id=?").run(deviceId);
            } catch (_) { /* device row may have been deleted */ }
            try {
                emitter.emit('device:offline', { deviceId });
            } catch (e) {
                console.warn('[WS] device:offline emitter error:', e.message);
            }
            console.log(`[WS] Device disconnected: ${deviceId}`);
        }
    });

    ws.on('error', (err) => {
        console.error(`[WS] Error for device ${deviceId}:`, err.message);
    });
}

module.exports = { handleConnection, broadcast, sendToDevice, dispatchSms, dispatchMms, getConnectedDeviceIds, removeClient };
