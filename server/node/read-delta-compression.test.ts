import { expect, test } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import { gzipSync, brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { makeManifest, makeDelta, applyDelta } from './readDelta.mjs'
const { gzipSizeExceeds, compareReadDeltaGzip, brotliSizeExceeds, compareReadDeltaBrotli, isSmallColdDatabaseDelta } = require('./read-delta-compression.cjs')
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const br = (value: Uint8Array) => brotliCompressSync(value, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })

test('cold DB shortcut requires both small wire bytes and a tiny fraction of the full DB', () => {
    const full = Buffer.alloc(4 * 1024 * 1024)
    expect(isSmallColdDatabaseDelta(Buffer.alloc(23000), Buffer.alloc(3895), full)).toBe(true)
    expect(isSmallColdDatabaseDelta(Buffer.alloc(23000), Buffer.alloc(17483), full)).toBe(true)
    expect(isSmallColdDatabaseDelta(Buffer.alloc(23000), Buffer.alloc(65537), full)).toBe(false)
    expect(isSmallColdDatabaseDelta(Buffer.alloc(50000), Buffer.alloc(100), full)).toBe(false)
})

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

test('bounded Brotli comparison matches quality-4 whole-buffer encoding including equality', async () => {
    for (const value of [Buffer.alloc(0), randomBytes(100), randomBytes(200_000), Buffer.alloc(500_000),
        Buffer.from('repeated text '.repeat(80_000))]) {
        const size = br(value).length
        for (const limit of [0, size - 1, size, size + 1]) {
            expect((await brotliSizeExceeds(value, limit)).exceeds).toBe(size > limit)
        }
    }
})

test('small Brotli delta comparison stops early on a large encoded-text value', async () => {
    // JSON/base64 text resembles a large DB value; fully incompressible input
    // can remain buffered in Brotli until end, so early exit is not universal.
    const value = Buffer.from(randomBytes(18 * 1024 * 1024).toString('base64'))
    const packet = randomBytes(4096)
    const result = await compareReadDeltaBrotli(packet, value)
    expect(result.smaller).toBe(br(packet).length < br(value).length)
    expect(result.fullInputBytes).toBeLessThan(value.length)
    expect(result.fullInputBytes).toBeGreaterThan(0)
    expect(result.compressed.equals(br(packet))).toBe(true)
    expect(brotliDecompressSync(result.compressed).equals(packet)).toBe(true)
})

test('Brotli keeps full responses for better full compression and ties', async () => {
    const full = Buffer.alloc(1024 * 1024)
    const result = await compareReadDeltaBrotli(randomBytes(16_384), full)
    expect(result.smaller).toBe(false)
    expect(result.fullInputBytes).toBe(full.length)
    const same = randomBytes(200_000)
    expect((await compareReadDeltaBrotli(same, same)).smaller).toBe(false)
})
