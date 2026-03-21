'use strict';
const { v4: uuidv4 }              = require('uuid');
const { Devices, Messages, Conversations, OptOuts, PairingTokens, KeywordRules, getDb, IpSecurity } = require('../db');
const { generateDeviceToken }     = require('../auth');
const cfg                         = require('../config');

// Map of deviceId → WebSocket connection
const clients = new Map();

function broadcast(data, excludeDeviceId = null) {
    const msg = JSON.stringify(data);
    for (const [id, ws] of clients) {
        if (id !== excludeDeviceId && ws.readyState === 1 /* OPEN */) {
            ws.send(msg);
        }
    }
}

function sendToDevice(deviceId, data) {
    const ws = clients.get(deviceId);
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(data));
        return true;
    }
    return false;
}

function getConnectedDeviceIds() {
    return [...clients.keys()];
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
        catch { ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' })); return; }

        switch (msg.type) {

            // ── Device registration ───────────────────────────
            case 'register': {
                const existing = msg.token ? Devices.findByToken(msg.token) : null;

                if (existing) {
                    deviceId = existing.id;
                    clients.set(deviceId, ws);
                    // Do NOT set status to "online" — DB uses pending|approved|suspended only.
                    // "online" breaks outbound dispatch (scheduler filters status === 'approved').
                    if (msg.sims?.length) Devices.upsertSims(deviceId, msg.sims);
                    try {
                        getDb().prepare("UPDATE devices SET last_seen=datetime('now') WHERE id=?").run(deviceId);
                    } catch (_) { /* ignore */ }
                    ws.send(JSON.stringify({ type: 'registered', deviceId, token: existing.token }));
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
                    });
                    if (msg.sims?.length) Devices.upsertSims(id, msg.sims);

                    deviceId = id;
                    clients.set(deviceId, ws);
                    ws.send(JSON.stringify({ type: 'registered', deviceId, token, status }));
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
                ws.send(JSON.stringify({ type: 'heartbeat_ack', ts: Date.now() }));
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
            Devices.updateStatus(deviceId, 'offline');
            emitter.emit('device:offline', { deviceId });
            console.log(`[WS] Device disconnected: ${deviceId}`);
        }
    });

    ws.on('error', (err) => {
        console.error(`[WS] Error for device ${deviceId}:`, err.message);
    });
}

module.exports = { handleConnection, broadcast, sendToDevice, dispatchSms, dispatchMms, getConnectedDeviceIds };
