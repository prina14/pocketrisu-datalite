import { expect, test } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { makeManifest, makeDelta, applyDelta } from './readDelta.mjs'
const { gzipSizeExceeds, compareReadDeltaGzip } = require('./read-delta-compression.cjs')
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

test('bounded stream comparison matches whole-buffer gzip at both sides of equality', async () => {
    const inputs = [Buffer.alloc(0), randomBytes(100), randomBytes(200_000), Buffer.alloc(500_000),
        Buffer.from('repeated text '.repeat(80_000))]
    for (const value of inputs) {
        const actualSize = gzipSync(value).length
        for (const limit of [0, actualSize - 1, actualSize, actualSize + 1]) {
            expect((await gzipSizeExceeds(value, limit)).exceeds).toBe(actualSize > limit)
        }
    }
})

test('small delta comparisons stop before compressing the entire large value', async () => {
    const value = randomBytes(8 * 1024 * 1024)
    const packet = randomBytes(4096)
    const result = await compareReadDeltaGzip(packet, value)
    expect(result.smaller).toBe(gzipSync(packet).length < gzipSync(value).length)
    expect(result.fullInputBytes).toBeLessThan(value.length / 8)
    expect(result.fullInputBytes).toBeGreaterThan(0)
})

test('highly compressible full values still win over a larger compressed delta', async () => {
    const value = Buffer.alloc(1024 * 1024)
    const packet = randomBytes(16384)
    expect(packet.length).toBeLessThan(value.length * 0.8)
    const result = await compareReadDeltaGzip(packet, value)
    expect(result.smaller).toBe(false)
    expect(result.fullInputBytes).toBe(value.length)
})

test('identical compressed sizes preserve the strict full-response preference', async () => {
    const value = randomBytes(200_000)
    expect((await compareReadDeltaGzip(value, value)).smaller).toBe(false)
})

test('selection preserves exact delta reconstruction for edits and replacement cases', async () => {
    const base = randomBytes(1024 * 1024)
    const edited = Buffer.concat([base.subarray(0, 9000), Buffer.from('a small insertion'), base.subarray(9000)])
    for (const next of [edited, randomBytes(base.length), Buffer.alloc(base.length)]) {
        const packet = makeDelta(next, makeManifest(base, hash), hash)
        expect((await compareReadDeltaGzip(packet, next)).smaller).toBe(gzipSync(packet).length < gzipSync(next).length)
        expect(hash(applyDelta(base, packet, hash))).toBe(hash(next))
    }
})

test('native compression yields to unrelated event-loop work', async () => {
    const events: string[] = []
    const compared = compareReadDeltaGzip(randomBytes(100_000), Buffer.alloc(8 * 1024 * 1024))
        .then(() => events.push('comparison'))
    const otherWork = new Promise<void>(resolve => setImmediate(() => { events.push('other'); resolve() }))
    await Promise.all([compared, otherWork])
    expect(events).toEqual(['other', 'comparison'])
})
