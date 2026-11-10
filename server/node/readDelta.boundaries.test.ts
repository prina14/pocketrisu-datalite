import { expect, test } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { chunks, makeManifest, makeDelta, applyDelta } from './readDelta.mjs'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// v10 reference, intentionally retaining unsigned state, ordinary arrays and
// every byte/min/max test. Old manifests/packets must stay byte-compatible.
const oldGear = Array.from({ length: 256 }, (_, i) => {
    let n = i + 1
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b)
    return Math.imul(n ^ (n >>> 16), 0x45d9f3b) >>> 0
})
function oldChunks(data: Uint8Array) {
    const result: number[][] = []
    let start = 0, rolling = 0
    for (let i = 0; i < data.length; i++) {
        rolling = ((rolling << 1) + oldGear[data[i]]) >>> 0
        const size = i + 1 - start
        if (size >= 2048 && ((rolling & 8191) === 0 || size >= 32768)) {
            result.push([start, size]); start = i + 1; rolling = 0
        }
    }
    if (start < data.length) result.push([start, data.length - start])
    return result
}
const oldManifest = (data: Uint8Array) => ({ v: 1, size: data.length,
    chunks: oldChunks(data).map(([start, size]) => [size, hash(data.subarray(start, start + size))]),
})
function oldPacket(data: Uint8Array, manifest: ReturnType<typeof oldManifest>) {
    const known = new Map(manifest.chunks.map(([size, sha], i) => [`${size}:${sha}`, i]))
    const ops: number[][] = [], literals: Uint8Array[] = []
    let literalSize = 0
    for (const [start, size] of oldChunks(data)) {
        const block = data.subarray(start, start + size), index = known.get(`${size}:${hash(block)}`)
        if (index !== undefined) ops.push([0, index])
        else {
            if (ops.at(-1)?.[0] === 1) ops.at(-1)![1] += size
            else ops.push([1, size])
            literals.push(block); literalSize += size
        }
    }
    const header = new TextEncoder().encode(JSON.stringify({ v: 1, size: data.length, sha256: hash(data), ops }))
    const packet = new Uint8Array(4 + header.length + literalSize)
    new DataView(packet.buffer).setUint32(0, header.length, true)
    packet.set(header, 4)
    let offset = 4 + header.length
    for (const block of literals) { packet.set(block, offset); offset += block.length }
    return packet
}

test('v10 boundaries are identical around the minimum, maximum, empty and tail lengths', () => {
    const data = randomBytes(3 * 32768 + 2048)
    for (const length of [0, 1, 31, 32, 33, 2015, 2016, 2017, 2047, 2048, 2049, 32767, 32768, 32769, data.length]) {
        const view = data.subarray(0, length)
        expect(chunks(view)).toEqual(oldChunks(view))
    }
})

test('all byte values preserve boundaries across repeated maximum chunks and a short tail', () => {
    for (let byte = 0; byte < 256; byte++) {
        const data = Buffer.alloc(2 * 32768 + 2047, byte)
        expect(chunks(data)).toEqual(oldChunks(data))
    }
})

test('mixed patterns and sliced Uint8Array/Buffer views preserve v10 manifests', () => {
    const data = randomBytes(512 * 1024 + 37)
    const text = Buffer.from(JSON.stringify({ text: '한글과 JSON 문자열 🎉'.repeat(20000) }))
    const patterned = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    const cases = [data, text, Buffer.concat(Array.from({ length: 1000 }, () => patterned)),
        data.subarray(13, data.length - 29), new Uint8Array(data.buffer, data.byteOffset + 19, data.length - 31)]
    for (const value of cases) {
        expect(chunks(value)).toEqual(oldChunks(value))
        expect(makeManifest(value, hash)).toEqual(oldManifest(value))
    }
})

test('v10 manifests generate identical packets for edits, deletes, repeated blocks and empty values', () => {
    const base = randomBytes(512 * 1024)
    const repeats = Buffer.alloc(300000, 42)
    for (const [old, next] of [
        [base, Buffer.concat([base.subarray(0, 9000), Buffer.from('insert'), base.subarray(9000)])],
        [base, base.subarray(7000, 300000)], [base, Buffer.concat([base.subarray(200000), base.subarray(0, 200000)])],
        [repeats, Buffer.concat([repeats, repeats.subarray(0, 11111)])],
        [Buffer.alloc(0), base], [base, Buffer.alloc(0)],
    ]) {
        const manifest = oldManifest(old)
        const packet = makeDelta(next, manifest, hash)
        expect(hash(packet)).toBe(hash(oldPacket(next, manifest)))
        expect(hash(applyDelta(old, packet, hash))).toBe(hash(next))
    }
})
