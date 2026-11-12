'use strict';

const { createHash } = require('node:crypto');
const { validManifest, makeDelta } = require('./readDelta.mjs');
const { compressDeltaBytes } = require('./read-snapshot-cache.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Remember chunk descriptions, never device identities or historical DB bodies.
// Every response is still authenticated and selected by the manifest supplied
// by the browser. A remembered/sent version is NOT proof of a successful save.
function createPreparedReadDeltas({ maxBases = 4, maxManifestBytes = 2 * 1024 * 1024,
    maxPacketBytes = 1024 * 1024, maxBytes = 16 * 1024 * 1024 } = {}) {
    const bases = new Map();
    const etagBases = new Map();
    let targets = new WeakMap();
    let ready = new WeakMap();
    let manifestBytes = 0;
    function describe(manifest) {
        if (!validManifest(manifest)) return null;
        const text = JSON.stringify({ v: 1, size: manifest.size, chunks: manifest.chunks });
        return { key: hash(text), bytes: Buffer.byteLength(text), manifest: JSON.parse(text) };
    }
    function remember(manifest) {
        const base = describe(manifest);
        if (!base) throw new Error('Invalid read delta manifest');
        if (maxBases > 0 && base.bytes <= maxManifestBytes && maxBytes > 0) {
            const previous = bases.get(base.key);
            if (previous) manifestBytes -= previous.bytes;
            bases.delete(base.key);
            bases.set(base.key, base);
            manifestBytes += base.bytes;
            while (bases.size > maxBases || manifestBytes > maxManifestBytes) {
                const [key, oldest] = bases.entries().next().value;
                bases.delete(key); manifestBytes -= oldest.bytes;
            }
        }
        return base;
    }
    function rememberSnapshot(snapshot, prepared) {
        if (!prepared || prepared.data !== snapshot.raw || maxBytes <= 0 || maxBases <= 0) return null;
        const current = remember({ v: 1, size: snapshot.raw.length, chunks: prepared.blocks.map(([, size, sha]) => [size, sha]) });
        etagBases.delete(snapshot.etag);
        if (bases.has(current.key)) etagBases.set(snapshot.etag, current.key);
        for (const [etag, key] of etagBases) if (!bases.has(key)) etagBases.delete(etag);
        while (etagBases.size > maxBases) etagBases.delete(etagBases.keys().next().value);
        return current;
    }
    async function get(snapshot, manifest, observed = true) {
        const base = observed ? remember(manifest) : describe(manifest);
        let target = targets.get(snapshot);
        if (!target) { target = new Map(); targets.set(snapshot, target); }
        const previous = target.get(base.key);
        if (previous) return { ...await previous, hit: true };
        const pending = (async () => {
            const prepared = await snapshot.getPreparedAsync();
            // A browser can consume this result and another write can arrive
            // before the idle debounce fires. Register that exact served view
            // now so the next warmup can prepare its successor too.
            rememberSnapshot(snapshot, prepared);
            const bytes = makeDelta(snapshot.raw, base.manifest, hash, prepared);
            const packet = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const compressed = new Map();
            const encoded = new Map();
            return { packet, compressed, encoded,
                getCompressed(encoding) {
                    if (!compressed.has(encoding)) {
                        const job = compressDeltaBytes(packet, encoding).then(bytes => { encoded.set(encoding, bytes); return bytes; })
                            .catch(error => { compressed.delete(encoding); throw error; });
                        compressed.set(encoding, job);
                    }
                    return compressed.get(encoding);
                },
            };
        })();
        const slots = Math.min(maxBases, Math.floor(maxBytes / (maxPacketBytes * 3 + 1024)));
        if (bases.has(base.key) && slots > 0) target.set(base.key, pending);
        while (target.size > slots) target.delete(target.keys().next().value);
        try {
            const result = await pending;
            // Reserve raw + two compressed representations conservatively.
            // Oversized deltas use the existing request path, not the cache.
            if (result.packet.length > maxPacketBytes || result.packet.length * 3 + 1024 > maxBytes) target.delete(base.key);
            while (target.size > slots) {
                target.delete(target.keys().next().value);
            }
            let completed = ready.get(snapshot);
            if (!completed) { completed = new Map(); ready.set(snapshot, completed); }
            for (const key of completed.keys()) if (!target.has(key)) completed.delete(key);
            if (target.get(base.key) === pending) completed.set(base.key, result);
            return { ...result, hit: false };
        } catch (error) { target.delete(base.key); throw error; }
    }
    return {
        get,
        peek(snapshot, etag, encoding) {
            const key = etagBases.get(etag);
            if (!key || !targets.get(snapshot)?.has(key)) return null;
            const delta = ready.get(snapshot)?.get(key);
            if (!delta || delta.packet.length >= snapshot.raw.length * 0.8) return null;
            if (encoding === 'identity') return { packet: delta.packet, encoding, bytes: delta.packet };
            const bytes = delta.encoded.get(encoding);
            const full = encoding === 'br' ? snapshot.brotli : encoding === 'gzip' ? snapshot.compressed : null;
            return bytes && full && bytes.length < full.length ? { packet: delta.packet, encoding, bytes } : null;
        },
        async warm(snapshot, shouldContinue = () => true) {
            if (maxBytes <= 0 || maxBases <= 0) return;
            const prepared = await snapshot.getPreparedAsync();
            if (!prepared || !shouldContinue()) return;
            // A served full snapshot is a potential base on the next visit.
            const current = rememberSnapshot(snapshot, prepared);
            for (const base of [...bases.values()].filter(base => base.key !== current.key)) {
                if (!shouldContinue()) break;
                const existing = targets.get(snapshot)?.has(base.key) && ready.get(snapshot)?.get(base.key);
                if (existing && existing.encoded.has('gzip') && existing.encoded.has('br')) continue;
                // Do not allocate a near-full historical delta merely to
                // discover it exceeds the optional preparation budget.
                const known = new Set(base.manifest.chunks.map(([size, sha]) => `${size}:${sha}`));
                let estimatedBytes = 256 + prepared.blocks.length * 24;
                for (const [, size, sha] of prepared.blocks) {
                    if (!known.has(`${size}:${sha}`)) estimatedBytes += size;
                    if (estimatedBytes > maxPacketBytes) break;
                }
                if (estimatedBytes > maxPacketBytes) continue;
                const delta = await get(snapshot, base.manifest, false);
                if (delta.packet.length <= maxPacketBytes && delta.packet.length < snapshot.raw.length * 0.8) {
                    await Promise.all([delta.getCompressed('gzip'), delta.getCompressed('br')]);
                }
                await new Promise(resolve => setImmediate(resolve));
            }
        },
        clear() { bases.clear(); etagBases.clear(); manifestBytes = 0; targets = new WeakMap(); ready = new WeakMap(); },
        baseCount() { return bases.size; },
    };
}
module.exports = { createPreparedReadDeltas };
