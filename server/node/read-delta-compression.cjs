'use strict';

const { createGzip, gzip, createBrotliCompress, brotliCompress, constants } = require('node:zlib');

const INPUT_CHUNK_BYTES = 64 * 1024;

const BROTLI_OPTIONS = { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } };

// A missing full snapshot must not delay a tiny DB update by seconds. This
// shortcut is bounded to 16 KiB on the wire AND 1% of the full raw value.
// Cached full encodings still get an exact size comparison. On a cold DB
// the maximum extra body over an exceptionally compressible full is 16 KiB.
const isSmallColdDatabaseDelta = (packet, compressed, full) =>
    compressed.length <= 16 * 1024 && packet.length <= full.length * 0.01;

// Count the compressed full value only until it exceeds the delta's exact
// encoded size. No flushes: preserve the normal whole-buffer representation.
// At most one bounded input write is pending; don't queue the entire DB in
// zlib before the consumer has a chance to stop the comparison.
function compressedSizeExceeds(value, limit, createStream) {
    return new Promise((resolve, reject) => {
        const stream = createStream();
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
            // its encoded size is strictly smaller than the complete full value.
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

const gzipSizeExceeds = (value, limit) => compressedSizeExceeds(value, limit, createGzip);
const brotliSizeExceeds = (value, limit) => compressedSizeExceeds(value, limit,
    // One-shot Brotli knows the total input size before PROCESS starts.
    // Supply it to the stream too, so chunking does not alter its encoding.
    () => createBrotliCompress({ params: { ...BROTLI_OPTIONS.params,
        [constants.BROTLI_PARAM_SIZE_HINT]: value.length } }));

async function compareReadDeltaGzip(packet, value, encoded) {
    const compressed = encoded ?? await new Promise((resolve, reject) => {
        gzip(packet, (error, result) => error ? reject(error) : resolve(result));
    });
    const comparison = await gzipSizeExceeds(value, compressed.length);
    return { smaller: comparison.exceeds, fullInputBytes: comparison.inputBytes };
}

async function compareReadDeltaBrotli(packet, value, encoded) {
    const compressed = encoded ?? await new Promise((resolve, reject) => {
        brotliCompress(packet, BROTLI_OPTIONS, (error, result) => error ? reject(error) : resolve(result));
    });
    const comparison = await brotliSizeExceeds(value, compressed.length);
    return { smaller: comparison.exceeds, fullInputBytes: comparison.inputBytes, compressed };
}

module.exports = { compareReadDeltaGzip, gzipSizeExceeds, compareReadDeltaBrotli, brotliSizeExceeds, isSmallColdDatabaseDelta };
