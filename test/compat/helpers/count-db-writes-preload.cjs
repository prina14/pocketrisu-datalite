// Test-only instrumentation. Keep the 5s persist debounce pending throughout
// each test, independently of machine load, while counting actual DB writes.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../server/node/db.cjs');
const originalSet = db.kvSet;
let writes = 0;
db.kvSet = (key, ...rest) => {
    if (key === 'database/database.bin') {
        fs.writeFileSync(path.join(process.cwd(), 'db-write-count'), String(++writes));
    }
    return originalSet(key, ...rest);
};
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 5000 ? 60000 : delay, ...args);
