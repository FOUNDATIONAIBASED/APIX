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

module.exports = { startMdns, stopMdns };
