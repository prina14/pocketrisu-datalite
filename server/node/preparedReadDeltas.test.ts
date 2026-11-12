import { test, expect } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { makeManifest, applyDelta } from './readDelta.mjs'
const { createReadSnapshotCache } = require('./read-snapshot-cache.cjs')
const { createPreparedReadDeltas } = require('./prepared-read-deltas.cjs')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function fixture() {
    const base = randomBytes(350_000)
    const changed = Buffer.concat([base.subarray(0, 20000), Buffer.from('new text'), base.subarray(20000)])
    const snapshots = createReadSnapshotCache()
    const previous = snapshots.create({}, base, 'old')
    const current = snapshots.create({}, changed, 'latest')
    return { base, changed, previous, current }
}
test('warmup prepares exact old-to-current packets and both encodings before a browser asks', async () => {
    const { base, changed, previous, current } = fixture()
    const cache = createPreparedReadDeltas()
    await cache.warm(previous)
    await Promise.all([current.getGzip(), current.getBrotli()])
    await cache.warm(current)
    for (const encoding of ['identity', 'gzip', 'br']) {
        const ready = cache.peek(current, 'old', encoding)
        expect(ready).not.toBeNull()
        const packet = encoding === 'br' ? brotliDecompressSync(ready.bytes) : encoding === 'gzip' ? gunzipSync(ready.bytes) : ready.bytes
        expect(Buffer.from(applyDelta(base, packet, hash))).toEqual(changed)
    }
    const first = await cache.get(current, makeManifest(base, hash))
    expect(first.hit).toBe(true)
    const second = await cache.get(current, makeManifest(base, hash))
    expect(second.packet).toBe(first.packet)
    expect(second.getCompressed('br')).toBe(first.getCompressed('br'))
    expect(cache.peek(current, 'unknown-browser-version', 'br')).toBeNull()
})
test('packets never cross target identities; a failed/evicted base retains the normal checksum fallback', async () => {
    const { base, changed, previous, current } = fixture()
    const cache = createPreparedReadDeltas()
    await cache.warm(previous)
    await cache.warm(current)
    const snapshot = createReadSnapshotCache().create({}, Buffer.from(changed).fill(42, 0, 100), 'other')
    expect(cache.peek(snapshot, 'old', 'identity')).toBeNull()
    const delta = await cache.get(snapshot, makeManifest(base, hash))
    expect(Buffer.from(applyDelta(base, delta.packet, hash))).toEqual(snapshot.raw)
    const corrupt = Buffer.from(base); corrupt[250000] ^= 1
    expect(() => applyDelta(corrupt, delta.packet, hash)).toThrow()
    cache.clear()
    expect(cache.peek(current, 'old', 'identity')).toBeNull()
    expect(cache.baseCount()).toBe(0)
})
test('a just-served delta target is remembered before the idle timer can run again', async () => {
    const { base, changed, current } = fixture()
    const cache = createPreparedReadDeltas()
    await cache.get(current, makeManifest(base, hash))
    const newest = createReadSnapshotCache().create({}, Buffer.concat([changed, Buffer.from('next edit')]), 'newest')
    await cache.warm(newest)
    const ready = cache.peek(newest, 'latest', 'identity')
    expect(ready).not.toBeNull()
    expect(hash(applyDelta(changed, ready.packet, hash))).toBe(hash(newest.raw))
})
test('retention is bounded and oversized packets are valid but not cached', async () => {
    const { base, current } = fixture()
    const cache = createPreparedReadDeltas({ maxBases: 2, maxPacketBytes: 1024 })
    const unrelated = makeManifest(randomBytes(base.length), hash)
    expect((await cache.get(current, unrelated)).hit).toBe(false)
    expect((await cache.get(current, unrelated)).hit).toBe(false)
    for (let i = 0; i < 5; i++) await cache.get(current, makeManifest(randomBytes(base.length), hash))
    expect(cache.baseCount()).toBeLessThanOrEqual(2)
    const disabled = createPreparedReadDeltas({ maxBytes: 0 })
    await disabled.warm(current)
    expect(disabled.baseCount()).toBe(0)
})
test('warmup stops when foreground reads start and invalid manifests are rejected', async () => {
    const { previous, current } = fixture()
    const cache = createPreparedReadDeltas()
    await cache.warm(previous)
    await cache.warm(current, () => false)
    expect(cache.peek(current, 'old', 'identity')).toBeNull()
    await expect(cache.get(current, { v: 1 })).rejects.toThrow('Invalid read delta manifest')
})
