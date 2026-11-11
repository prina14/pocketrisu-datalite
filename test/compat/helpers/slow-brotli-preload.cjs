// Regression fixture: leave whole-DB Brotli warmup pending while a small
// delta is requested. Native streaming and small packet compression run normally.
const zlib = require('node:zlib');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const original = zlib.brotliCompress;
zlib.brotliCompress = (input, options, callback) => {
    if (input.length <= 512 * 1024) return original(input, options, callback);
    const id = createHash('sha256').update(input).digest('hex');
    fs.writeFileSync('pending-brotli-' + id, 'pending');
    return original(input, options, (error, bytes) => {
        setTimeout(() => {
            fs.writeFileSync('pending-brotli-' + id, 'done');
            callback(error, bytes);
        }, 30_000);
    });
};
