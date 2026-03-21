'use strict';
/**
 * AES-256-GCM encrypt/decrypt for IMAP passwords at rest.
 * Set IMAP_SECRET_KEY (32+ bytes recommended) or falls back to JWT_SECRET hash.
 */
const crypto = require('crypto');
const cfg = require('../config');

function _key() {
    const raw = process.env.IMAP_SECRET_KEY || cfg.jwtSecret || 'apix-imap';
    return crypto.createHash('sha256').update(String(raw), 'utf8').digest();
}

function encrypt(plain) {
    if (plain == null || plain === '') return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', _key(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
    if (!b64) return '';
    try {
        const buf = Buffer.from(b64, 'base64');
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const data = buf.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', _key(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
        return '';
    }
}

module.exports = { encrypt, decrypt };
