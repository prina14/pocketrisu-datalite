'use strict';

const { createGzip, gzip } = require('node:zlib');

const INPUT_CHUNK_BYTES = 64 * 1024;

// Count the compressed full value only until it exceeds the delta's exact
// gzip size. No flushes: chunked input must produce the same stream as gzip().
// At most one bounded input write is pending; don't queue the entire DB in
// zlib before the consumer has a chance to stop the comparison.
function gzipSizeExceeds(value, limit) {
    return new Promise((resolve, reject) => {
        const stream = createGzip();
        let inputBytes = 0, outputBytes = 0, finished = false;
        const finish = (error, exceeds) => {
            if (finished) return;
            finished = true;
            stream.destroy();
            if (error) reject(error);
            else resolve({ exceeds, inputBytes });
        };
        stream.on('error', error => finish(error));
        stream.on('data', chunk => {
            outputBytes += chunk.length;
            // Equality is not enough: the old policy chooses delta only when
            // its gzip size is strictly smaller than the complete full value.
            if (outputBytes > limit) finish(null, true);
        });
        stream.on('end', () => finish(null, false));
        const writeNext = error => {
            if (finished) return;
            if (error) { finish(error); return; }
            if (inputBytes === value.length) { stream.end(); return; }
            const end = Math.min(inputBytes + INPUT_CHUNK_BYTES, value.length);
            const chunk = value.subarray(inputBytes, end);
            inputBytes = end;
            stream.write(chunk, writeNext);
        };
        writeNext();
    });
}

async function compareReadDeltaGzip(packet, value) {
    const compressed = await new Promise((resolve, reject) => {
        gzip(packet, (error, result) => error ? reject(error) : resolve(result));
    });
    const comparison = await gzipSizeExceeds(value, compressed.length);
    return { smaller: comparison.exceeds, fullInputBytes: comparison.inputBytes };
}

module.exports = { compareReadDeltaGzip, gzipSizeExceeds };
