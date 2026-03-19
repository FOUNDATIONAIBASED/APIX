'use strict';
/**
 * Message queue + scheduler
 *  - Priority queue for outbound SMS dispatch
 *  - Cron-based scheduled messages (every minute)
 *  - Enterprise mode: use fixed/specified number
 *  - Private mode: rotate across pool with human-like random delays
 */
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { Scheduled, Messages, Devices, Settings, Contacts, DripSequences, getDb } = require('../db');

let _wsHandler  = null;
let _emitter    = null;

// In-memory priority queue  { priority: 0-9, job: fn, id: string }
const _queue = [];
let _running = false;

// ── Public API ──────────────────────────────────────────────────
function init(wsHandler, emitter) {
    _wsHandler = wsHandler;
    _emitter   = emitter;

    // Poll for scheduled messages every 60 seconds
    cron.schedule('* * * * *', () => _processScheduled().catch(console.error));

    // Birthday reminders: check daily at 8:00 AM server time
    cron.schedule('0 8 * * *', () => _processBirthdayReminders().catch(console.error));

    // Drip sequence processor: check every 5 minutes
    cron.schedule('*/5 * * * *', () => _processDripSequences().catch(console.error));

    // Process queue continuously
    _runQueue();
}

function enqueue(job, priority = 5) {
    const id = uuidv4();
    _queue.push({ priority, job, id });
    _queue.sort((a, b) => a.priority - b.priority);
    return id;
}

// ── Scheduled message processor ────────────────────────────────
async function _processScheduled() {
    const pending = Scheduled.findPending();
    for (const sched of pending) {
        try {
            const sent = await _dispatchSms({
                to:   sched.to_number,
                from: sched.from_number,
                body: sched.body,
                type: sched.type,
                mediaUrl: sched.media_url,
            });
            Scheduled.markSent(sched.id, new Date().toISOString());
            if (_emitter) _emitter.emit('message:scheduled:sent', { schedId: sched.id, ...sent });
        } catch (err) {
            Scheduled.markFailed(sched.id, err.message);
        }
    }
}

// ── Core SMS dispatch (routes to connected Android device) ──────
async function _dispatchSms({ to, from, body, type = 'sms', mediaUrl, deviceId, campaignId, templateId, numberGroupId }) {
    if (!_wsHandler) throw new Error('WS handler not initialised');

    const msgId = 'msg_' + uuidv4().replace(/-/g, '').slice(0, 16);

    // ── Number mode resolution ──────────────────────────────────
    const numberMode      = Settings.get('number_mode', 'private');
    const enterpriseNum   = Settings.get('enterprise_number', null);

    // Explicit from overrides everything
    let fromNumber = from || null;

    // Enterprise mode: always use the configured enterprise number
    if (!fromNumber && numberMode === 'enterprise' && enterpriseNum) {
        fromNumber = enterpriseNum;
    }

    // Private mode: if a number group is specified, pick from it using the configured strategy
    if (!fromNumber && numberGroupId) {
        const { NumberGroups } = require('../db');
        const members = NumberGroups.getNumbers(numberGroupId);
        if (members.length) {
            const strategy = Settings.get('private_strategy', 'round_robin');
            fromNumber = _pickFromGroup(members, strategy);
        }
    }

    // ── Device selection ────────────────────────────────────────
    let targetDevice = null;
    if (deviceId && _wsHandler.getConnectedDeviceIds().includes(deviceId)) {
        targetDevice = deviceId;
    }
    if (!targetDevice) {
        const connected = _wsHandler.getConnectedDeviceIds();
        if (!connected.length) throw new Error('No devices online');
        const devs = Devices.findAll().filter(d => connected.includes(d.id) && d.status === 'approved');
        if (!devs.length) throw new Error('No approved devices online');

        const strategy = Settings.get('private_strategy', 'round_robin');
        if (strategy === 'random') {
            targetDevice = devs[Math.floor(Math.random() * devs.length)].id;
        } else if (strategy === 'least_today') {
            devs.sort((a, b) => (a.sent_today || 0) - (b.sent_today || 0));
            targetDevice = devs[0].id;
        } else if (strategy === 'least_recent') {
            devs.sort((a, b) => new Date(a.last_seen || 0) - new Date(b.last_seen || 0));
            targetDevice = devs[0].id;
        } else {
            // round_robin default
            devs.sort((a, b) => (a.sent_today || 0) - (b.sent_today || 0));
            targetDevice = devs[0].id;
        }
    }

    // Determine from number if still not set
    if (!fromNumber) {
        const dev = Devices.findById(targetDevice);
        fromNumber = dev?.sims?.find(s => s.number)?.number || 'Unknown';
    }

    // Private mode delay (human-like spacing)
    if (numberMode === 'private' && !from) {
        const delayMin = parseInt(Settings.get('private_delay_min', '2000'), 10);
        const delayMax = parseInt(Settings.get('private_delay_max', '8000'), 10);
        if (delayMin > 0) {
            const delay = delayMin + Math.random() * (delayMax - delayMin);
            await _sleep(delay);
        }
    }

    // Record in DB immediately as 'queued'
    Messages.insert({
        id: msgId, direction: 'outbound',
        from_number: fromNumber, to_number: to,
        body, type, status: 'queued',
        device_id: targetDevice,
        media_url: mediaUrl || null,
        campaign_id: campaignId || null,
        template_id: templateId || null,
        num_segments: Math.ceil((body || '').length / 160) || 1,
    });

    // Send command to device via WebSocket
    const sent = _wsHandler.sendToDevice(targetDevice, {
        type:    type === 'mms' ? 'send_mms' : 'send_sms',
        msgId,
        to,
        from:    fromNumber,
        body,
        mediaUrl,
    });

    if (!sent) {
        Messages.updateStatus(msgId, 'failed', { error_msg: 'Device unreachable' });
        throw new Error('Device unreachable');
    }

    if (_emitter) _emitter.emit('message:queued', { msgId, to, from: fromNumber, device: targetDevice });
    return { msgId, to, from: fromNumber, deviceId: targetDevice };
}

// ── Queue runner ────────────────────────────────────────────────
async function _runQueue() {
    if (_running) return;
    _running = true;
    while (true) {
        if (_queue.length === 0) {
            await _sleep(200);
            continue;
        }
        const item = _queue.shift();
        try { await item.job(); } catch (e) { console.error('[Queue]', e.message); }
    }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Pick a number from a group using the given strategy
function _pickFromGroup(members, strategy) {
    if (!members.length) return null;
    if (strategy === 'random') return members[Math.floor(Math.random() * members.length)].number;
    // Default: round-robin (simplest: just pick first, caller should track index externally)
    return members[0].number;
}

// ── Birthday reminder processor ─────────────────────────────────
async function _processBirthdayReminders() {
    // Check if birthday reminders are enabled in settings
    const enabled = Settings.get('birthday_reminders_enabled');
    if (!enabled || enabled === '0' || enabled === 'false') return;

    const template = Settings.get('birthday_reminder_template') || 'Happy Birthday {first_name}! 🎉';
    const fromNumber = Settings.get('birthday_reminder_from') || null;

    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayMD = `${mm}-${dd}`; // Matches MM-DD in birthday field

    let contacts;
    try {
        contacts = getDb().prepare(
            "SELECT * FROM contacts WHERE birthday IS NOT NULL AND (birthday LIKE ? OR birthday LIKE ?)"
        ).all(`%-${mm}-${dd}`, `%-${mm}-${dd}T%`);
    } catch { return; }

    for (const c of contacts) {
        if (!c.number) continue;
        const body = template
            .replace(/\{first_name\}/gi, c.first_name || 'Friend')
            .replace(/\{last_name\}/gi,  c.last_name  || '')
            .replace(/\{full_name\}/gi,  [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Friend');
        try {
            await _dispatchSms({ to: c.number, from: fromNumber, body, type: 'sms' });
            console.log(`[Scheduler] Birthday SMS sent to ${c.number}`);
        } catch (e) {
            console.warn(`[Scheduler] Birthday SMS failed for ${c.number}: ${e.message}`);
        }
        await _sleep(2000 + Math.random() * 3000);
    }
}

/**
 * Check if current time is within allowed business hours.
 * businessHours setting: JSON { start: "09:00", end: "17:00", days: [1,2,3,4,5] }
 * Returns true if within hours or setting not configured.
 */
function isWithinBusinessHours() {
    const setting = Settings.get('business_hours');
    if (!setting) return true;
    let bh;
    try { bh = JSON.parse(setting); } catch { return true; }
    if (!bh.start || !bh.end) return true;

    const now = new Date();
    const day = now.getDay(); // 0=Sun, 6=Sat
    if (bh.days && !bh.days.includes(day)) return false;

    const [startH, startM] = bh.start.split(':').map(Number);
    const [endH,   endM  ] = bh.end.split(':').map(Number);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const startMins = startH * 60 + startM;
    const endMins   = endH * 60 + endM;
    return nowMins >= startMins && nowMins < endMins;
}

// ── Drip sequence processor ──────────────────────────────────────
async function _processDripSequences() {
    const due = DripSequences.findDueEnrollments();
    for (const enr of due) {
        const steps = DripSequences.getSteps(enr.sequence_id);
        const step  = steps[enr.current_step];
        if (!step) {
            // All steps done
            DripSequences.completeEnrollment(enr.id);
            continue;
        }
        try {
            await _dispatchSms({
                to:   enr.contact_number,
                from: step.from_number || null,
                body: step.message,
                type: 'sms',
                mediaUrl: step.media_url || null,
            });

            const nextStep = steps[enr.current_step + 1];
            if (nextStep) {
                const nextTime = new Date(Date.now() + nextStep.delay_hours * 3600_000)
                    .toISOString().replace('T',' ').slice(0,19);
                DripSequences.advanceStep(enr.id, nextTime);
            } else {
                DripSequences.completeEnrollment(enr.id);
            }
        } catch (e) {
            console.warn(`[Drip] Failed step for ${enr.contact_number}: ${e.message}`);
        }
        await _sleep(500);
    }
}

module.exports = { init, enqueue, dispatchSms: _dispatchSms, isWithinBusinessHours };
