'use strict';
/**
 * Phone Number Lookup
 * Returns carrier info and line type from the phone number format.
 * For real carrier lookups you'd integrate HLR/CNAM APIs (e.g. Twilio Lookup, NumVerify, etc.)
 * This implementation provides:
 *  - Number formatting and validation
 *  - Opt-out status check
 *  - Contact info from local database
 *  - Basic country/area-code detection
 */
const router = require('express').Router();
const { Contacts, OptOuts } = require('../db');
const { sanitizePhone } = require('../security');

// GET /api/v1/lookup/:number
router.get('/:number', (req, res) => {
    const number = sanitizePhone(decodeURIComponent(req.params.number));
    if (!number) return res.status(400).json({ error: 'Invalid phone number' });

    const contact  = Contacts.findByNumber(number);
    const optedOut = OptOuts.isOptedOut(number);
    const parsed   = parseNumber(number);

    res.json({
        number,
        ...parsed,
        opt_out:    optedOut,
        contact:    contact ? {
            id:         contact.id,
            first_name: contact.first_name,
            last_name:  contact.last_name,
            tags:       JSON.parse(contact.tags || '[]'),
        } : null,
    });
});

// POST /api/v1/lookup/batch  — lookup multiple numbers
router.post('/batch', (req, res) => {
    const { numbers } = req.body;
    if (!Array.isArray(numbers) || numbers.length > 100) {
        return res.status(400).json({ error: 'numbers[] required, max 100' });
    }
    const results = numbers.map(n => {
        const number = sanitizePhone(n);
        if (!number) return { input: n, error: 'Invalid number' };
        const contact  = Contacts.findByNumber(number);
        const optedOut = OptOuts.isOptedOut(number);
        return { number, ...parseNumber(number), opt_out: optedOut, has_contact: !!contact };
    });
    res.json({ results });
});

// Basic number parsing without external API
function parseNumber(number) {
    const cleaned = number.replace(/[^\d+]/g, '');
    const cc = detectCountry(cleaned);
    return {
        formatted:   formatNumber(cleaned),
        country_code: cc.code,
        country:     cc.name,
        line_type:   'mobile',  // Would require CNAM/HLR lookup for accurate type
        valid:       cleaned.length >= 10 && cleaned.length <= 15,
    };
}

function detectCountry(num) {
    if (num.startsWith('+1') || (num.length === 10 && !num.startsWith('+')))  return { code: '+1',   name: 'US/Canada' };
    if (num.startsWith('+44'))  return { code: '+44',  name: 'United Kingdom' };
    if (num.startsWith('+49'))  return { code: '+49',  name: 'Germany' };
    if (num.startsWith('+33'))  return { code: '+33',  name: 'France' };
    if (num.startsWith('+39'))  return { code: '+39',  name: 'Italy' };
    if (num.startsWith('+34'))  return { code: '+34',  name: 'Spain' };
    if (num.startsWith('+31'))  return { code: '+31',  name: 'Netherlands' };
    if (num.startsWith('+61'))  return { code: '+61',  name: 'Australia' };
    if (num.startsWith('+64'))  return { code: '+64',  name: 'New Zealand' };
    if (num.startsWith('+81'))  return { code: '+81',  name: 'Japan' };
    if (num.startsWith('+82'))  return { code: '+82',  name: 'South Korea' };
    if (num.startsWith('+86'))  return { code: '+86',  name: 'China' };
    if (num.startsWith('+91'))  return { code: '+91',  name: 'India' };
    if (num.startsWith('+55'))  return { code: '+55',  name: 'Brazil' };
    if (num.startsWith('+52'))  return { code: '+52',  name: 'Mexico' };
    return { code: '?', name: 'Unknown' };
}

function formatNumber(num) {
    const d = num.replace(/[^\d]/g, '');
    if (d.length === 10) return `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
    if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
    return num;
}

module.exports = router;
