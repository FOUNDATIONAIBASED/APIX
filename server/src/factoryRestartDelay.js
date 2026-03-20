#!/usr/bin/env node
'use strict';
/**
 * Detached helper: wait for the parent ApiX process to exit (free the port),
 * then start a new server instance and update .apix.pid.
 * Used after POST /api/v1/admin/factory-reset when no systemd/pm2 supervises the process.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const delayMs = Math.max(500, parseInt(process.argv[2], 10) || 1500);
const serverRoot = process.argv[3];
const indexJs = process.argv[4];

if (!serverRoot || !indexJs) {
    console.error('[factoryRestartDelay] usage: node factoryRestartDelay.js <delayMs> <serverRoot> <index.js>');
    process.exit(1);
}

setTimeout(() => {
    const logPath = path.join(serverRoot, 'logs', 'apix.log');
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
    } catch { /* ignore */ }

    let outFd = 'ignore';
    try {
        outFd = fs.openSync(logPath, 'a');
    } catch { /* ignore */ }

    const child = spawn(process.execPath, [indexJs], {
        cwd: serverRoot,
        detached: true,
        stdio: ['ignore', outFd, outFd],
        env: process.env,
    });

    if (outFd !== 'ignore') {
        try { fs.closeSync(outFd); } catch { /* ignore */ }
    }

    if (child.pid) {
        try {
            fs.writeFileSync(path.join(serverRoot, '.apix.pid'), String(child.pid));
        } catch { /* ignore */ }
    }
    child.unref();
    process.exit(0);
}, delayMs);
