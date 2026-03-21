'use strict';
require('dotenv').config();

const http        = require('http');
const cron        = require('node-cron');
const express     = require('express');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const EventEmitter        = require('events');
const path                = require('path');
const os                  = require('os');

const cfg         = require('./config');
const { startMdns, stopMdns } = require('./mdns');
const wsHandler   = require('./ws/handler');
const dispatcher  = require('./queue/dispatcher');
const scheduler   = require('./queue/scheduler');
const llmManager  = require('./llm/manager');
const security    = require('./security');

const {
    Messages, Devices, Campaigns, OptOuts, LLM, Plans, Roles,
} = require('./db');

// Seed default roles + plans on startup
try { Roles.seed(); } catch (_) {}
try { Plans.seed();  } catch (_) {}
// Start backup scheduler
try { require('./backup/engine').startScheduler(); } catch (e) { console.warn('[BACKUP] Scheduler start error:', e.message); }

// ── Logger ────────────────────────────────────────────────────
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const logLevel   = LOG_LEVELS[cfg.logLevel] ?? 2;
const log = {
    error: (...a) => logLevel >= 0 && console.error('[ERROR]', ...a),
    warn:  (...a) => logLevel >= 1 && console.warn ('[WARN ]', ...a),
    info:  (...a) => logLevel >= 2 && console.info ('[INFO ]', ...a),
    debug: (...a) => logLevel >= 3 && console.log  ('[DEBUG]', ...a),
};

// ── Express app ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// Trust proxy headers (needed for rate-limiting behind nginx/caddy)
if (cfg.trustedProxies > 0) app.set('trust proxy', cfg.trustedProxies);

const { ipFirewallMiddleware } = require('./middleware/ipFirewall');
app.use(ipFirewallMiddleware);

// ── Security middleware ───────────────────────────────────────
app.use(security.helmetMiddleware);
app.use(security.globalLimiter);
app.use(security.corsMiddleware);
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Serve management UI + docs
app.use(express.static(path.join(__dirname, '..', 'public'), {
    etag: true,
    maxAge: '1h',
}));

// ── Request logger ─────────────────────────────────────────────
app.use((req, _res, next) => {
    log.debug(`${req.method} ${req.path}`);
    next();
});

// ── Health check (no auth) ─────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.get('/docs', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'docs.html')));

// ── API auth (optional per-route) ─────────────────────────────
// Public routes (no key needed): GET status, GET events (SSE), POST inbound webhook
const publicApiAuth = security.apiKeyAuth(false);  // optional — attach key info if present
const strictAuth    = security.apiKeyAuth(true);   // required

// ── API Routes ────────────────────────────────────────────────
app.use('/api/v1/devices',    publicApiAuth, require('./routes/devices'));
app.use('/api/v1/messages',   publicApiAuth, require('./routes/messages'));
app.use('/api/v1/numbers',    publicApiAuth, require('./routes/numbers'));
app.use('/api/v1/campaigns',  publicApiAuth, require('./routes/campaigns'));
app.use('/api/v1/contacts',   publicApiAuth, require('./routes/contacts'));
app.use('/api/v1/optouts',    publicApiAuth, require('./routes/optouts'));
app.use('/api/v1/templates',  publicApiAuth, require('./routes/templates'));
app.use('/api/v1/webhooks',   publicApiAuth, require('./routes/webhooks'));
app.use('/api/v1/llm',        publicApiAuth, require('./routes/llm'));
app.use('/api/v1/analytics',  publicApiAuth, require('./routes/analytics'));
app.use('/api/v1/scheduled',  publicApiAuth, require('./routes/scheduled'));
app.use('/api/v1/lookup',     publicApiAuth, require('./routes/lookup'));
app.use('/api/v1/apikeys',    publicApiAuth, require('./routes/apikeys'));
app.use('/api/v1/groups',     publicApiAuth, require('./routes/groups'));
app.use('/api/v1/settings',   publicApiAuth, require('./routes/settings'));

// ── Auth + account system (public + authenticated) ────────────
app.use('/api/auth',              require('./routes/auth'));
app.use('/api/auth/email-smtp',   require('./routes/emailSmtpAdmin'));
app.use('/api/auth/2fa',          require('./routes/totp'));
app.use('/api/v1/plans',          require('./routes/plans'));
app.use('/api/v1/accounts',       require('./routes/accounts'));
app.use('/api/v1/roles',          require('./routes/roles'));
app.use('/api/v1/backup',         require('./routes/backup'));
app.use('/api/v1/admin',          require('./routes/admin'));
app.use('/api/v1/admin/security', require('./routes/securityAdmin'));
app.use('/api/v1/keyword-rules',  require('./routes/keyword-rules'));
app.use('/api/v1/forwarding',     require('./routes/forwarding'));
app.use('/api/v1/mail',           require('./routes/mail'));
app.use('/api/v1/drip',           publicApiAuth, require('./routes/drip'));

// ── Plans page ────────────────────────────────────────────────
app.get('/plans',          (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'plans.html')));
app.get('/login',          (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.get('/reset-password', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'reset-password.html')));
app.get('/security.html', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'security.html')));

// ── Conversations ─────────────────────────────────────────────
app.get('/api/v1/conversations', publicApiAuth, (req, res) => {
    const { Conversations } = require('./db');
    const { limit = 50 } = req.query;
    res.json({ conversations: Conversations.findAll(+limit) });
});
app.get('/api/v1/conversations/:id', publicApiAuth, (req, res) => {
    const { Conversations } = require('./db');
    const conv = Conversations.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const msgs = Messages.findAll({ limit: 100 })
        .filter(m => m.from_number === conv.contact_number || m.to_number === conv.contact_number);
    res.json({ conversation: conv, messages: msgs });
});

// ── Twilio-compatible message endpoint alias ──────────────────
// Allows Twilio SDK clients to POST to /2010-04-01/Accounts/XXX/Messages.json
app.post('/2010-04-01/Accounts/:sid/Messages.json', publicApiAuth,
    security.sendLimiter, require('./routes/messages').twilioCompat || ((req, res) => {
        // Proxy to our send endpoint
        req.url = '/twilio-compat';
        require('./routes/messages')(req, res);
    })
);

// ── GET /api/v1/status ────────────────────────────────────────
app.get('/api/v1/status', (req, res) => {
    const stats     = Messages.todayStats();
    const devices   = Devices.findAll();
    const connected = wsHandler.getConnectedDeviceIds();
    const { Campaigns } = require('./db');
    const campStats = Campaigns.stats();
    const { LLM }   = require('./db');
    const llms      = LLM.findEnabled();
    const smtpConfig = require('./email/smtpConfig');
    const profiles = smtpConfig.getEffectiveProfiles();
    const primary = profiles[0];
    res.json({
        status:   'ok',
        uptime:   process.uptime(),
        ts:       new Date().toISOString(),
        version:  '2.0.0',
        messages: stats,
        campaigns: campStats,
        llm: { instances: llms.length, healthy: llms.filter(l => l.healthy).length },
        devices: {
            total:    devices.length,
            online:   connected.length,
            pending:  devices.filter(d => d.status === 'pending').length,
            approved: devices.filter(d => d.status === 'approved').length,
        },
        // SMTP summary (no credentials)
        smtp_configured: profiles.length > 0,
        smtp_profile_count: profiles.length,
        smtp_routing_mode: smtpConfig.getRoutingMode(),
        smtp_host: primary?.host || process.env.SMTP_HOST || null,
        smtp_port: primary ? String(primary.port) : (process.env.SMTP_PORT || null),
        smtp_from: primary?.from || process.env.SMTP_FROM || null,
        smtp_user: primary?.user
            ? primary.user.replace(/(?<=.).(?=[^@]*@)/g, '*')
            : (process.env.SMTP_USER ? process.env.SMTP_USER.replace(/(?<=.).(?=[^@]*@)/g, '*') : null),
    });
});

// ── SSE endpoint for real-time UI updates ─────────────────────
app.get('/api/v1/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx passthrough
    res.flushHeaders();

    const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    const handlers = {
        'device:online':     (d) => send('device:online',     d),
        'device:offline':    (d) => send('device:offline',    d),
        'device:registered': (d) => send('device:registered', d),
        'message:inbound':   (d) => send('message:inbound',   d),
        'message:status':    (d) => send('message:status',    d),
        'message:queued':    (d) => send('message:queued',    d),
        'message:sent':      (d) => send('message:sent',      d),
        'message:delivered': (d) => send('message:delivered', d),
        'message:failed':    (d) => send('message:failed',    d),
        'optout:received':   (d) => send('optout:received',   d),
        'device:heartbeat':  (d) => send('device:heartbeat',  d),
    };
    for (const [evt, fn] of Object.entries(handlers)) emitter.on(evt, fn);
    const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 20_000);

    req.on('close', () => {
        clearInterval(hb);
        for (const [evt, fn] of Object.entries(handlers)) emitter.off(evt, fn);
    });
});

// ── 404 for unknown API routes ────────────────────────────────
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ── WebSocket Server ──────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => wsHandler.handleConnection(ws, req, emitter));

// ── Event → Webhook dispatch ──────────────────────────────────
emitter.on('message:inbound', async (data) => {
    log.info(`MSG IN  ${data.from} → ${data.to}: ${(data.body || '').slice(0, 60)}`);
    await dispatcher.dispatch('message.inbound', data);

    // Telegram forward (if configured)
    try {
        const telegram = require('./telegram');
        if (await telegram.forwardInbound(data)) {
            log.debug('Forwarded to Telegram');
        }
    } catch (e) { log.debug('Telegram forward:', e.message); }

    // Per-user forwarding rules (plan-gated; uses devices.user_id)
    try {
        await require('./forwarding/engine').processInbound(data);
    } catch (e) { log.debug('Forwarding rules:', e.message); }

    // SMS/MMS → email ($#email: / email: …) plan imap_mail
    try {
        await require('./sms/smsToEmail').processInbound(data);
    } catch (e) { log.debug('SMS→email:', e.message); }

    // LLM auto-reply
    try {
        const result = await llmManager.processInbound(data);
        if (result?.rule?.auto_reply && result.reply) {
            const replyTo = data.from;
            await scheduler.dispatchSms({
                to:   replyTo,
                from: data.to,
                body: result.reply,
            });
            log.info(`LLM auto-reply → ${replyTo}: ${result.reply.slice(0, 60)}`);
        }
    } catch (e) { log.debug('LLM auto-reply error:', e.message); }
});

emitter.on('message:status', async (data) => {
    await dispatcher.dispatch(`message.${data.status}`, data);
});

emitter.on('device:registered', (data) => {
    log.info(`Device registered: ${data.deviceId} (${data.status})`);
    dispatcher.dispatch('device.registered', data);
});
emitter.on('device:online',  (data) => {
    log.info(`Device online: ${data.deviceId}`);
    dispatcher.dispatch('device.online', data);
});
emitter.on('device:offline', (data) => {
    log.info(`Device offline: ${data.deviceId}`);
    dispatcher.dispatch('device.offline', data);
});
emitter.on('optout:received', (data) => {
    log.info(`Opt-out received from ${data.from}`);
    dispatcher.dispatch('optout.received', data);
});

// ── Startup ───────────────────────────────────────────────────
function getLocalIps() {
    const ips = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
        }
    }
    return ips;
}

server.listen(cfg.port, cfg.host, () => {
    const ips = getLocalIps();
    log.info('════════════════════════════════════════════');
    log.info(' ApiX Gateway v2.0 started');
    log.info(`  Port      : ${cfg.port}`);
    ips.forEach(ip => {
        log.info(`  Web UI    : http://${ip}:${cfg.port}/`);
        log.info(`  API Docs  : http://${ip}:${cfg.port}/docs`);
        log.info(`  REST API  : http://${ip}:${cfg.port}/api/v1/`);
        log.info(`  WebSocket : ws://${ip}:${cfg.port}/ws`);
    });
    log.info('════════════════════════════════════════════');

    // Start subsystems
    dispatcher.start();
    scheduler.init(wsHandler, emitter);
    llmManager.start();
    if (cfg.mdnsEnabled) startMdns(cfg.port);

    // IMAP polling (per-account interval respected inside syncAll)
    cron.schedule('* * * * *', () => {
        require('./email/imapSync').syncAll().catch((e) => log.debug('[IMAP poll]', e.message));
    });
});

process.on('SIGTERM', graceful);
process.on('SIGINT',  graceful);
function graceful() {
    log.info('Shutting down...');
    dispatcher.stop();
    llmManager.stop();
    stopMdns();
    server.close(() => process.exit(0));
}
