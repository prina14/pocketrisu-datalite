'use strict';

const { gzip, brotliCompress, constants } = require('node:zlib');
const { createHash } = require('node:crypto');
const Negotiator = require('negotiator');
const { prepareDelta, MIN_DELTA_BYTES, MAX_COPY_BYTES } = require('./readDelta.mjs');

const gzipBytes = bytes => new Promise((resolve, reject) => gzip(bytes, (error, result) => error ? reject(error) : resolve(result)));
// Match compression@1.8's Brotli quality, preserving the existing HTTPS
// browser representation rather than forcing gzip on Brotli-capable clients.
const brotliBytes = bytes => new Promise((resolve, reject) => brotliCompress(bytes,
    { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
    (error, result) => error ? reject(error) : resolve(result)));
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
            const entry = { owner, raw, etag, prepared: null, compressed: null, pendingGzip: null, brotli: null, pendingBrotli: null,
                getPrepared() {
                    if (!this.prepared && raw.length >= MIN_DELTA_BYTES && raw.length <= MAX_COPY_BYTES) {
                        this.prepared = prepareDelta(raw, hashBytes);
                        fits(this);
                    }
                    return this.prepared;
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

module.exports = { createReadSnapshotCache, gzipBytes, brotliBytes, preferredReadEncoding };
