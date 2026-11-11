import { describe, expect, test } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { chunks, makeManifest, makeManifestAsync, validManifest, makeDelta, applyDelta, applyDeltaAsync } from './readDelta.mjs'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('content-defined read deltas', () => {
    test('native async hashes produce the identical manifest and verify reconstruction using the existing boundaries', async () => {
        const base = randomBytes(2 * 1024 * 1024)
        const next = Buffer.concat([base.subarray(0, 12000), Buffer.from('inserted'), base.subarray(12000)])
        const asyncHash = async (bytes: Uint8Array) => hash(bytes)
        const manifest = await makeManifestAsync(base, asyncHash)
        expect(manifest).toEqual(makeManifest(base, hash))
        const packet = makeDelta(next, manifest, hash)
        expect(hash(await applyDeltaAsync(base, packet, asyncHash, manifest))).toBe(hash(next))
        expect(hash(applyDelta(base, packet, hash, manifest))).toBe(hash(next))
        expect(packet.length).toBeLessThan(base.length / 2)
        const corrupt = Buffer.alloc(base.length)
        expect(await applyDeltaAsync(corrupt, packet, asyncHash, manifest).then(() => false, () => true)).toBe(true)
        const stale = { ...manifest, chunks: manifest.chunks.map(row => [...row]) }
        const headerSize = new DataView(packet.buffer, packet.byteOffset).getUint32(0, true)
        const header = JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + headerSize)))
        const used = header.ops.find(op => op[0] === 0)[1]
        const other = used === 0 ? 1 : 0
        const change = stale.chunks[used][0] === 32768 ? -1 : 1
        stale.chunks[used][0] += change; stale.chunks[other][0] -= change
        expect(validManifest(stale)).toBe(true)
        // Moving a boundary between adjacent copied chunks can legitimately
        // reconstruct the identical bytes. Wrong output must never be accepted.
        const result = await applyDeltaAsync(base, packet, asyncHash, stale).then(bytes => hash(bytes), () => null)
        expect([null, hash(next)]).toContain(result)
    })
    test('a small edit plus an insertion into a 3 MiB value transfers less than 5%', () => {
        const old = randomBytes(3 * 1024 * 1024)
        const next = Buffer.concat([old.subarray(0, 12345), Buffer.from('inserted text'), old.subarray(12345)])
        next.fill(42, 1700000, 1700100)
        const manifest = makeManifest(old, hash)!
        expect(validManifest(manifest)).toBe(true)
        const packet = makeDelta(next, manifest, hash)
        expect(packet.length).toBeLessThan(next.length * 0.05)
        expect(hash(applyDelta(old, packet, hash))).toBe(hash(next))
    })
    test('handles deletes, appends, repeated data, reordering and empty values', () => {
        const original = randomBytes(150000)
        for (const [old, next] of [
            [original, original.subarray(5000, 140000)],
            [original, Buffer.concat([original, Buffer.from('tail')])],
            [Buffer.alloc(300000), Buffer.concat([Buffer.alloc(10000), Buffer.from('x'), Buffer.alloc(290000)])],
            [original, Buffer.concat([original.subarray(90000), original.subarray(0, 90000)])],
            [Buffer.alloc(0), original], [original, Buffer.alloc(0)],
        ]) {
            const packet = makeDelta(next, makeManifest(old, hash)!, hash)
            expect(Buffer.from(applyDelta(old, packet, hash))).toEqual(next)
        }
    })
    test('reconstructed data must match the server SHA-256 even with a corrupt local copy', () => {
        const old = randomBytes(200000)
        const packet = makeDelta(old, makeManifest(old, hash)!, hash)
        const corrupt = Buffer.from(old); corrupt[10000] ^= 1
        expect(() => applyDelta(corrupt, packet, hash)).toThrow()
        expect(() => applyDelta(old, packet.subarray(0, 8), hash)).toThrow()
        expect(() => applyDelta(old, Buffer.concat([packet, Buffer.from('extra')]), hash)).toThrow()
    })
    test('rejects invalid, oversized or inconsistent manifests', () => {
        for (const value of [null, {}, { v: 1, size: 1, chunks: [] },
            { v: 1, size: 0, chunks: [[-1, 'a'.repeat(64)]] },
            { v: 1, size: 1, chunks: [[1, '__proto__']] },
            { v: 1, size: 1024 ** 4, chunks: [] }]) expect(validManifest(value)).toBe(false)
        expect(chunks(new Uint8Array())).toEqual([])
    })
})
