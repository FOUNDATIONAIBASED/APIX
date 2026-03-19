'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const { parse } = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const { Contacts, OptOuts, Messages, getDb } = require('../db');
const { sanitizePhone, sanitizeString } = require('../security');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// GET /api/v1/contacts
router.get('/', (req, res) => {
    const { limit = 100, cursor, tag, q } = req.query;
    let contacts = Contacts.findAll({ limit: +limit, cursor });
    if (tag) contacts = contacts.filter(c => {
        try { return JSON.parse(c.tags || '[]').includes(tag); } catch { return false; }
    });
    if (q) {
        const lq = q.toLowerCase();
        contacts = contacts.filter(c =>
            (c.first_name||'').toLowerCase().includes(lq) ||
            (c.last_name||'').toLowerCase().includes(lq) ||
            (c.number||'').includes(lq) ||
            (c.email||'').toLowerCase().includes(lq)
        );
    }
    res.json({ contacts, total: Contacts.count() });
});

// GET /api/v1/contacts/tags  — all distinct tags
router.get('/tags', (req, res) => {
    const all = Contacts.findAll({ limit: 5000 });
    const tagSet = new Set();
    for (const c of all) {
        try { for (const t of JSON.parse(c.tags || '[]')) tagSet.add(t); } catch {}
    }
    res.json({ tags: [...tagSet].sort() });
});

// GET /api/v1/contacts/:id
router.get('/:id', (req, res) => {
    const c = Contacts.findById(req.params.id) || Contacts.findByNumber(req.params.id);
    if (!c) return res.status(404).json({ error: 'Contact not found' });
    // Attach recent messages
    const msgs = Messages.findByNumber(c.number, 10);
    res.json({ ...c, recent_messages: msgs });
});

// POST /api/v1/contacts
router.post('/', (req, res) => {
    const number = sanitizePhone(req.body.number);
    if (!number) return res.status(400).json({ error: 'Valid phone number required' });

    const contact = {
        id:            req.body.id || 'con_' + uuidv4().replace(/-/g, '').slice(0, 12),
        number,
        first_name:    sanitizeString(req.body.first_name, 100),
        last_name:     sanitizeString(req.body.last_name, 100),
        email:         sanitizeString(req.body.email, 200),
        carrier:       sanitizeString(req.body.carrier, 50),
        line_type:     req.body.line_type || 'mobile',
        tags:          JSON.stringify(req.body.tags || []),
        custom_data:   JSON.stringify(req.body.custom_data || {}),
        custom_fields: JSON.stringify(req.body.custom_fields || {}),
        birthday:      req.body.birthday || null,
        timezone:      req.body.timezone || null,
        notes:         sanitizeString(req.body.notes, 2000),
    };
    Contacts.upsert(contact);
    res.status(201).json({ success: true, contact });
});

// PUT /api/v1/contacts/:id
router.put('/:id', (req, res) => {
    const c = Contacts.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Contact not found' });
    const merged = {
        ...c,
        first_name:    sanitizeString(req.body.first_name, 100) ?? c.first_name,
        last_name:     sanitizeString(req.body.last_name, 100)  ?? c.last_name,
        email:         sanitizeString(req.body.email, 200)       ?? c.email,
        tags:          req.body.tags          ? JSON.stringify(req.body.tags)          : c.tags,
        custom_fields: req.body.custom_fields ? JSON.stringify(req.body.custom_fields) : (c.custom_fields || '{}'),
        custom_data:   req.body.custom_data   ? JSON.stringify(req.body.custom_data)   : c.custom_data,
        birthday:      req.body.birthday !== undefined ? req.body.birthday  : c.birthday,
        timezone:      req.body.timezone !== undefined ? req.body.timezone  : c.timezone,
        notes:         sanitizeString(req.body.notes, 2000) ?? c.notes,
    };
    Contacts.upsert(merged);
    res.json({ success: true });
});

// POST /api/v1/contacts/import  — bulk JSON import
router.post('/import', (req, res) => {
    const { contacts } = req.body;
    if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts[] required' });

    let imported = 0, failed = 0;
    for (const c of contacts) {
        const number = sanitizePhone(c.number);
        if (!number) { failed++; continue; }
        try {
            Contacts.upsert({
                id:            'con_' + uuidv4().replace(/-/g, '').slice(0, 12),
                number,
                first_name:    sanitizeString(c.first_name, 100),
                last_name:     sanitizeString(c.last_name, 100),
                email:         sanitizeString(c.email, 200),
                carrier:       null,
                line_type:     c.line_type || 'mobile',
                tags:          JSON.stringify(c.tags || []),
                custom_data:   JSON.stringify(c.custom_data || {}),
                custom_fields: JSON.stringify(c.custom_fields || {}),
                birthday:      c.birthday || null,
                timezone:      c.timezone || null,
                notes:         null,
            });
            imported++;
        } catch { failed++; }
    }
    res.json({ imported, failed, total: contacts.length });
});

// POST /api/v1/contacts/import-csv  — CSV file upload
router.post('/import-csv', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'CSV file required (field: file)' });

    let rows;
    try {
        rows = parse(req.file.buffer.toString(), {
            columns: true, skip_empty_lines: true, trim: true, bom: true,
        });
    } catch (e) {
        return res.status(400).json({ error: 'Invalid CSV: ' + e.message });
    }

    let imported = 0, failed = 0;
    const errors = [];
    for (const row of rows) {
        const number = sanitizePhone(row.number || row.phone || row.mobile || row.Phone || row.Mobile);
        if (!number) { failed++; errors.push(`Row missing number: ${JSON.stringify(row).slice(0,50)}`); continue; }
        try {
            Contacts.upsert({
                id:         'con_' + uuidv4().replace(/-/g,'').slice(0,12),
                number,
                first_name: sanitizeString(row.first_name || row.FirstName || '', 100),
                last_name:  sanitizeString(row.last_name  || row.LastName  || '', 100),
                email:      sanitizeString(row.email      || row.Email     || '', 200),
                carrier:    null,
                line_type:  row.line_type || 'mobile',
                tags:       JSON.stringify(row.tags ? row.tags.split(';').map(t=>t.trim()) : []),
                custom_data:'{}',
                custom_fields: '{}',
                birthday:   row.birthday || null,
                timezone:   row.timezone || null,
                notes:      sanitizeString(row.notes || '', 2000),
            });
            imported++;
        } catch (e) { failed++; errors.push(e.message); }
    }
    res.json({ imported, failed, total: rows.length, errors: errors.slice(0, 10) });
});

// POST /api/v1/contacts/export-csv
router.post('/export-csv', (req, res) => {
    const all = Contacts.findAll({ limit: 50000 });
    const header = 'number,first_name,last_name,email,line_type,tags,birthday,timezone,notes';
    const lines  = all.map(c => [
        c.number, c.first_name||'', c.last_name||'', c.email||'',
        c.line_type||'', (JSON.parse(c.tags||'[]')).join(';'),
        c.birthday||'', c.timezone||'', (c.notes||'').replace(/"/g,"'"),
    ].map(v => `"${v}"`).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.send([header, ...lines].join('\n'));
});

// DELETE /api/v1/contacts/:id  — standard delete
router.delete('/:id', (req, res) => {
    Contacts.delete(req.params.id);
    res.json({ success: true });
});

// DELETE /api/v1/contacts/:id/gdpr  — GDPR erasure: scrub all personal data
router.delete('/:id/gdpr', (req, res) => {
    const c = Contacts.findById(req.params.id) || Contacts.findByNumber(req.params.id);
    if (!c) return res.status(404).json({ error: 'Contact not found' });

    // Anonymize the contact record
    const db = getDb();
    const anon = `REDACTED_${require('crypto').randomBytes(4).toString('hex')}`;
    db.prepare(`
        UPDATE contacts SET
            first_name='[Removed]', last_name='[Removed]',
            email=NULL, carrier=NULL,
            tags='[]', custom_data='{}', custom_fields='{}',
            birthday=NULL, timezone=NULL, notes='[GDPR erased]',
            number=?
        WHERE id=?
    `).run(anon, c.id);

    // Anonymize number in messages too
    db.prepare("UPDATE messages SET from_number=? WHERE from_number=?").run(anon, c.number);
    db.prepare("UPDATE messages SET to_number=?   WHERE to_number=?").run(anon, c.number);
    db.prepare("DELETE FROM opt_outs WHERE number=?").run(c.number);

    res.json({ success: true, message: 'Contact personal data erased.' });
});

// POST /api/v1/contacts/:number/optout
router.post('/:number/optout', (req, res) => {
    OptOuts.add(req.params.number, req.body.reason || 'manual', 'manual');
    res.json({ success: true });
});

// DELETE /api/v1/contacts/:number/optout
router.delete('/:number/optout', (req, res) => {
    OptOuts.remove(req.params.number);
    res.json({ success: true });
});

module.exports = router;
