'use strict';
const cfg = require('./config');

let _bonjour = null;
let _service = null;

function startMdns(port) {
    if (!cfg.mdnsEnabled) {
        console.log('[mDNS] Disabled by config');
        return;
    }

    try {
        const { Bonjour } = require('bonjour-service');
        _bonjour = new Bonjour();

        _service = _bonjour.publish({
            name: cfg.mdnsName,
            type: 'apix',
            port: port,
            txt: {
                version: '1',
                api:     `/api/v1`,
                ws:      `/ws`,
            },
        });

        console.log(`[mDNS] Broadcasting: "${cfg.mdnsName}" on _apix._tcp.local:${port}`);
    } catch (err) {
        console.warn('[mDNS] Could not start broadcast:', err.message);
        console.warn('[mDNS] Android auto-discovery will not work.');
    }
}

function stopMdns() {
    if (_service) {
        _service.stop();
        _service = null;
    }
    if (_bonjour) {
        _bonjour.destroy();
        _bonjour = null;
    }
}

/**
 * Discover other _apix._tcp services on the LAN (separate instances / test gateways).
 */
function browseApixOnLan(timeoutMs = 4000) {
    return new Promise((resolve) => {
        let b;
        try {
            const { Bonjour } = require('bonjour-service');
            b = new Bonjour();
        } catch (e) {
            return resolve([]);
        }
        const out = [];
        const browser = b.find({ type: 'apix', protocol: 'tcp' });
        browser.on('up', (s) => {
            out.push({
                name: s.name,
                host: s.host,
                port: s.port,
                addresses: s.addresses || [],
                txt: s.txt || {},
            });
        });
        setTimeout(() => {
            try { browser.stop(); } catch (_) {}
            try { b.destroy(); } catch (_) {}
            resolve(out);
        }, timeoutMs);
    });
}

module.exports = { startMdns, stopMdns, browseApixOnLan };
