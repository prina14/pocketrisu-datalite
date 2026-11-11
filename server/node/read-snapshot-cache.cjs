'use strict';

const { gzip, brotliCompress, gzipSync, brotliCompressSync, constants } = require('node:zlib');
const { createHash } = require('node:crypto');
const Negotiator = require('negotiator');
const { prepareDelta, MIN_DELTA_BYTES, MAX_COPY_BYTES } = require('./readDelta.mjs');
const { createDeltaPreparer } = require('./read-delta-preparer.cjs');
const deltaPreparer = createDeltaPreparer();
// Start the small worker runtime during server boot, before the first large
// read needs it. No DB bytes, compression or storage access are performed here.
void deltaPreparer.prepare(Buffer.alloc(0)).catch(() => {});
const MAX_WORKER_INPUT_BYTES = 32 * 1024 * 1024;

const gzipBytes = bytes => new Promise((resolve, reject) => gzip(bytes, (error, result) => error ? reject(error) : resolve(result)));
// Match compression@1.8's Brotli quality, preserving the existing HTTPS
// browser representation rather than forcing gzip on Brotli-capable clients.
const brotliBytes = bytes => new Promise((resolve, reject) => brotliCompress(bytes,
    { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
    (error, result) => error ? reject(error) : resolve(result)));
// Bound synchronous work to one small packet so it cannot queue behind
// multi-MB background zlib jobs. Large packets retain asynchronous compression.
const compressDeltaBytes = async (bytes, encoding) => {
    if (bytes.length > 64 * 1024) return encoding === 'gzip' ? gzipBytes(bytes) : brotliBytes(bytes);
    return encoding === 'gzip' ? gzipSync(bytes) : brotliCompressSync(bytes,
        { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
};
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const preferredReadEncoding = req => req.headers['accept-encoding']
    ? new Negotiator(req).encoding(['br', 'gzip', 'deflate', 'identity'], ['br', 'gzip']) : 'identity';

// One immutable client-view artifact, never a history of full databases.
// In-flight requests own their references even after the retained entry changes.
function createReadSnapshotCache({ maxBytes = 64 * 1024 * 1024 } = {}) {
    const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : 64 * 1024 * 1024;
    let current = null;
    let backgroundAllowed = limit > 0;
    const fits = entry => {
        const bytes = entry.raw.length + (entry.compressed?.length || 0) + (entry.brotli?.length || 0) + (entry.prepared?.blocks.length || 0) * 256;
        if (current === entry && bytes > limit) { current = null; backgroundAllowed = false; }
    };
    return {
        get(view, etag) { return current && current.owner?.deref() === view && current.etag === etag ? current : null; },
        create(view, raw, etag) {
            const owner = view && typeof view === 'object' ? new WeakRef(view) : null;
            const entry = { owner, raw, etag, prepared: null, pendingPrepared: null, compressed: null, pendingGzip: null, brotli: null, pendingBrotli: null,
                getPrepared() {
                    if (!this.prepared && raw.length >= MIN_DELTA_BYTES && raw.length <= MAX_COPY_BYTES) {
                        this.prepared = prepareDelta(raw, hashBytes);
                        fits(this);
                    }
                    return this.prepared;
                },
                getPreparedAsync() {
                    if (this.prepared || raw.length < MIN_DELTA_BYTES || raw.length > MAX_COPY_BYTES) return Promise.resolve(this.prepared);
                    if (raw.length > MAX_WORKER_INPUT_BYTES) return Promise.resolve(this.getPrepared());
                    this.pendingPrepared ??= deltaPreparer.prepare(raw).then(index => {
                        // Attach the exact original byte identity used by makeDelta.
                        this.prepared ??= { data: raw, ...index };
                        fits(this);
                        return this.prepared;
                    }).catch(() => this.getPrepared()); // Worker failure must not prevent a valid read.
                    return this.pendingPrepared;
                },
                getGzip() {
                    if (!this.pendingGzip) {
                        this.pendingGzip = gzipBytes(raw).then(bytes => {
                            this.compressed = bytes;
                            fits(this);
                            return bytes;
                        }).catch(error => { this.pendingGzip = null; throw error; });
                    }
                    return this.pendingGzip;
                },
                getBrotli() {
                    if (!this.pendingBrotli) {
                        this.pendingBrotli = brotliBytes(raw).then(bytes => {
                            this.brotli = bytes;
                            fits(this);
                            return bytes;
                        }).catch(error => { this.pendingBrotli = null; throw error; });
                    }
                    return this.pendingBrotli;
                },
            };
            current = raw.length <= limit ? entry : null;
            backgroundAllowed = limit > 0 && raw.length <= limit;
            return entry;
        },
        clear() { current = null; backgroundAllowed = limit > 0; },
        canWarm() { return backgroundAllowed; },
        retainedBytes() {
            return current ? current.raw.length + (current.compressed?.length || 0) + (current.brotli?.length || 0) + (current.prepared?.blocks.length || 0) * 256 : 0;
        },
    };
}

module.exports = { createReadSnapshotCache, gzipBytes, brotliBytes, preferredReadEncoding, compressDeltaBytes };
