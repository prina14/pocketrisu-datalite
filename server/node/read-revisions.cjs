'use strict';
const { randomBytes } = require('node:crypto');

function createReadRevisions(db) {
    const scope = alias => `(${alias}.key = 'database/database.bin' OR substr(${alias}.key, 1, 15) = 'plugin-storage/')`;
    // Triggers also cover imports, snapshot restores, direct SQL copies and
    // chunk-store marker writes, in the SAME transaction as the value write.
    db.exec(`
        CREATE TABLE IF NOT EXISTS datalite_read_revisions (key TEXT PRIMARY KEY, token BLOB NOT NULL);
        CREATE TRIGGER IF NOT EXISTS datalite_read_insert AFTER INSERT ON kv WHEN ${scope('NEW')} BEGIN
            INSERT OR REPLACE INTO datalite_read_revisions VALUES (NEW.key, randomblob(16));
        END;
        CREATE TRIGGER IF NOT EXISTS datalite_read_update AFTER UPDATE ON kv WHEN ${scope('OLD')} OR ${scope('NEW')} BEGIN
            DELETE FROM datalite_read_revisions WHERE key = OLD.key;
            INSERT OR REPLACE INTO datalite_read_revisions SELECT NEW.key, randomblob(16) WHERE ${scope('NEW')};
        END;
        CREATE TRIGGER IF NOT EXISTS datalite_read_delete AFTER DELETE ON kv WHEN ${scope('OLD')} BEGIN
            DELETE FROM datalite_read_revisions WHERE key = OLD.key;
        END;
        INSERT OR IGNORE INTO datalite_read_revisions SELECT key, randomblob(16) FROM kv
            WHERE key = 'database/database.bin' OR substr(key, 1, 15) = 'plugin-storage/';
    `);
    // A restored database must not reuse a validator from another process.
    const epoch = randomBytes(16).toString('hex');
    const select = db.prepare('SELECT hex(r.token) AS token FROM datalite_read_revisions r JOIN kv k ON k.key = r.key WHERE r.key = ?');
    return key => { const row = select.get(key); return row ? `${epoch}.${row.token}` : null; };
}

module.exports = { createReadRevisions };
