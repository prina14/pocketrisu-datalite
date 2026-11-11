import { expect, test, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { gunzipSync, brotliDecompressSync, createBrotliCompress, constants } from 'node:zlib'
import { makeManifest, makeDelta, applyDelta, prepareDelta } from './readDelta.mjs'
const { createReadSnapshotCache, preferredReadEncoding, brotliBytes } = require('./read-snapshot-cache.cjs')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('encoding selection preserves the compression middleware preference and client quality/opt-out', () => {
    for (const [header, expected] of [
        ['gzip, deflate, br', 'br'], ['gzip;q=1,br;q=1', 'br'], ['br;q=0,gzip', 'gzip'],
        ['br;q=0.1,gzip;q=1', 'gzip'], ['gzip;q=0,identity', 'identity'], ['deflate', 'deflate'],
    ]) expect(preferredReadEncoding({ headers: { 'accept-encoding': header } })).toBe(expected)
    expect(preferredReadEncoding({ headers: {} })).toBe('identity')
})

test('prepared Brotli bytes match the existing middleware quality-4 stream', async () => {
    const bytes = Buffer.concat([randomBytes(200_000), Buffer.alloc(500_000, 65)])
    const stream = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
    const streamed = new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        stream.on('data', part => chunks.push(part))
        stream.on('error', reject)
        stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
    stream.end(bytes)
    expect(hash(await brotliBytes(bytes))).toBe(hash(await streamed))
})

test('one version shares immutable bytes, compression and prepared hashes; changed views/validators never hit', async () => {
    const cache = createReadSnapshotCache()
    const view = {}
    const bytes = randomBytes(200_000)
    const entry = cache.create(view, bytes, 'v1')
    expect(cache.get(view, 'v1')).toBe(entry)
    expect(cache.get({}, 'v1')).toBeNull()
    expect(cache.get(view, 'v2')).toBeNull()
    const a = entry.getGzip(), b = entry.getGzip()
    expect(a).toBe(b)
    expect(gunzipSync(await a)).toEqual(bytes)
    const br = entry.getBrotli()
    expect(br).toBe(entry.getBrotli())
    expect(brotliDecompressSync(await br)).toEqual(bytes)
    expect(entry.getPrepared()).toBe(entry.getPrepared())
    const replacement = cache.create({}, Buffer.from('new'), 'v2')
    await replacement.getGzip()
    // An older in-flight response still owns the exact bytes it started with.
    expect(gunzipSync(await entry.getGzip())).toEqual(bytes)
    expect(cache.get(view, 'v1')).toBeNull()
    expect(cache.retainedBytes()).toBeLessThan(100)
    cache.clear()
    expect(cache.retainedBytes()).toBe(0)
})

test('cache retention is bounded including compressed bytes and index metadata; disabling it retains nothing', async () => {
    const bytes = randomBytes(200_000)
    const view = {}
    const cache = createReadSnapshotCache({ maxBytes: bytes.length + 10 })
    const entry = cache.create(view, bytes, 'v1')
    await entry.getGzip()
    expect(cache.retainedBytes()).toBe(0)
    expect(cache.get(view, 'v1')).toBeNull()
    const zero = createReadSnapshotCache({ maxBytes: 0 })
    const transient = zero.create(view, bytes, 'v1')
    expect(gunzipSync(await transient.getGzip())).toEqual(bytes)
    expect(zero.retainedBytes()).toBe(0)
})

test('prepared delta is byte-identical to the original protocol and does not hash the full current value again', () => {
    const base = randomBytes(900_000)
    const current = Buffer.concat([base.subarray(0, 200_000), Buffer.from('new text'), base.subarray(200_000)])
    const manifest = makeManifest(base, hash)
    const prepared = prepareDelta(current, hash)
    const observed = vi.fn(hash)
    const packet = makeDelta(current, manifest, observed, prepared)
    expect(Buffer.from(packet)).toEqual(Buffer.from(makeDelta(current, manifest, hash)))
    expect(observed).not.toHaveBeenCalled()
    expect(Buffer.from(applyDelta(base, packet, hash))).toEqual(current)
    // Same-sized bytes from another version must not reuse this index.
    const different = Buffer.from(current)
    different[0] ^= 1
    expect(Buffer.from(makeDelta(different, manifest, hash, prepared))).toEqual(Buffer.from(makeDelta(different, manifest, hash)))
})

test('worker preparation shares pending work and preserves exact bytes across cache replacement', async () => {
    const cache = createReadSnapshotCache()
    const base = randomBytes(2 * 1024 * 1024)
    const changed = Buffer.concat([base.subarray(0, 50000), Buffer.from('insert'), base.subarray(50000)])
    const entry = cache.create({}, changed, 'first')
    const pending = entry.getPreparedAsync()
    expect(entry.getPreparedAsync()).toBe(pending)
    const replacement = cache.create({}, randomBytes(200000), 'second')
    const [index, next] = await Promise.all([pending, replacement.getPreparedAsync()])
    expect(index.data).toBe(changed)
    expect(index.sha256).toBe(hash(changed))
    const packet = makeDelta(changed, makeManifest(base, hash), hash, index)
    expect(hash(applyDelta(base, packet, hash))).toBe(hash(changed))
    expect(Buffer.from(packet).equals(Buffer.from(makeDelta(changed, makeManifest(base, hash), hash)))).toBe(true)
    expect(next.sha256).toBe(hash(replacement.raw))
    expect(entry.getPrepared()).toBe(index)
})
