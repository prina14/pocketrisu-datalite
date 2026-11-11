'use strict';

const { createHash } = require('node:crypto');
const PREFIX = 'metadata/character-activity/';
const MAX_ENTRIES = 10000;

// Tiny independent KV records: opening a character never updates database.bin
// or schedules DB encoding/compression. These rows use the existing backup store.
function createCharacterActivity(db, { kvSet, kvDel }) {
    const select = db.prepare('SELECT value FROM kv WHERE key >= ? AND key < ? ORDER BY updated_at DESC, key ASC LIMIT ?');
    const obsolete = db.prepare('SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY updated_at DESC LIMIT -1 OFFSET ?');
    function read() {
        const entries = [];
        for (const row of select.all(PREFIX, PREFIX + '\uffff', MAX_ENTRIES)) {
            try {
                const value = JSON.parse(Buffer.from(row.value).toString('utf8'));
                if (validId(value.chaId) && Number.isSafeInteger(value.lastInteraction) && value.lastInteraction > 0) entries.push(value);
            } catch { /* Ignore malformed optional metadata. */ }
        }
        const body = JSON.stringify({ entries });
        return { body, etag: 'W/"' + createHash('sha256').update(body).digest('hex') + '"' };
    }
    function record(ids) {
        const now = Date.now();
        const entries = ids.map((chaId, i) => ({ chaId, lastInteraction: now + i }));
        db.transaction(() => {
            for (const value of entries) kvSet(PREFIX + Buffer.from(value.chaId).toString('hex'), Buffer.from(JSON.stringify(value)));
            for (const row of obsolete.all(PREFIX, PREFIX + '\uffff', MAX_ENTRIES)) kvDel(row.key);
        })();
        return entries;
    }
    return {
        read, record,
        register(app, auth) {
            app.get('/api/character-activity', async (req, res, next) => {
                if (!await auth(req, res)) return;
                try {
                    res.setHeader('Cache-Control', 'private, no-store');
                    const value = read();
                    res.setHeader('ETag', value.etag);
                    if (req.headers['if-none-match'] === value.etag) return res.status(304).end();
                    res.type('json').send(value.body);
                } catch (error) { next(error); }
            });
            app.post('/api/character-activity', async (req, res, next) => {
                if (!await auth(req, res)) return;
                res.setHeader('Cache-Control', 'private, no-store');
                const ids = req.body?.ids;
                if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every(validId)) return res.status(400).json({ error: 'Invalid activity IDs' });
                try { res.json({ entries: record([...new Set(ids)]) }); }
                catch (error) { next(error); }
            });
        },
    };
}
function validId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 128 && !id.includes('\0') && !id.startsWith('§'); }
module.exports = { createCharacterActivity };
