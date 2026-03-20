'use strict';
require('dotenv').config();
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
    port:               parseInt(process.env.PORT  || '3000', 10),
    host:               process.env.HOST                || '0.0.0.0',
    nodeEnv:            process.env.NODE_ENV            || 'production',
    jwtSecret:          process.env.JWT_SECRET          || 'CHANGE-ME-jwt-secret-32-chars-min',
    hmacSecret:         process.env.HMAC_SECRET         || 'CHANGE-ME-hmac-secret-32-chars-min',
    mdnsName:           process.env.MDNS_NAME           || 'ApiX Gateway',
    mdnsEnabled:        process.env.MDNS_ENABLED        !== 'false',
    autoApproveDevices: process.env.AUTO_APPROVE_DEVICES === 'true',
    logLevel:           process.env.LOG_LEVEL           || 'info',
    // Security
    requireApiKey:      process.env.REQUIRE_API_KEY     !== 'false',
    trustedProxies:     parseInt(process.env.TRUSTED_PROXIES || '0', 10),
    /** Set USE_SSL=true when behind HTTPS reverse proxy (domain binding). Omit or false for HTTP/LAN/IP access. */
    useSsl:             process.env.USE_SSL            === 'true',
    /**
     * homelab  — permissive CORS; API keys may be passed as ?api_key= (still prefer X-API-Key).
     * production — strict CORS (requires CORS_ORIGINS); query-string API keys rejected.
     * Overridden by Settings key `deployment_mode` after first setup.
     */
    deploymentMode:     (process.env.DEPLOYMENT_MODE || 'homelab').toLowerCase() === 'production'
        ? 'production'
        : 'homelab',
    /** Comma-separated list of allowed browser Origins when deployment_mode is production */
    corsOrigins:        (process.env.CORS_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    /** Allow one-time admin setup when no users exist. Set ALLOW_INITIAL_SETUP=false to disable (e.g. pre-seeded DB). */
    allowInitialSetup:  process.env.ALLOW_INITIAL_SETUP !== 'false',
    // Paths
    dbPath:             process.env.DB_PATH
                            ? path.resolve(process.env.DB_PATH)
                            : path.join(ROOT, 'data', 'apix.db'),
    // Rate limits
    rateLimitGlobal:    parseInt(process.env.RATE_LIMIT_GLOBAL || '300', 10),
    rateLimitSend:      parseInt(process.env.RATE_LIMIT_SEND   || '60',  10),
    // Number mode (overridden at runtime from Settings table)
    // 'enterprise' = fixed/specified number, no rotation
    // 'private'    = rotate across pool with delays, human-like spacing
    numberMode:         process.env.NUMBER_MODE || 'private',
    enterpriseNumber:   process.env.ENTERPRISE_NUMBER || null,
};
