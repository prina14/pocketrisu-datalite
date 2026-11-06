// Test-only instrumentation, loaded with NODE_OPTIONS=--require. Count full
// database BLOB reads so memory regressions are deterministic without RSS limits.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../server/node/db.cjs');
const countPath = path.join(process.cwd(), 'db-read-count');
const original = db.kvGet;
let count = 0;
db.kvGet = (key, ...rest) => {
    if (key === 'database/database.bin') {
        fs.writeFileSync(countPath, String(++count));
    }
    return original(key, ...rest);
};
