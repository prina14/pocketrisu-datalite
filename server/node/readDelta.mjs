// Content-defined byte chunks keep their boundaries after insertions/deletions.
// Shared by browser and server. Hashes are injected: native SHA-256 on Node,
// pure JS SHA-256 on HTTP origins that cannot use crypto.subtle.
export const MIN_DELTA_BYTES = 128 * 1024
export const MAX_COPY_BYTES = 512 * 1024 * 1024
export const MAX_CHUNKS = 65536
const MIN_CHUNK = 2048, MAX_CHUNK = 32768, MASK = 8191
const gear = Array.from({ length: 256 }, (_, i) => {
    let n = (i + 1) >>> 0
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b)
    return Math.imul(n ^ (n >>> 16), 0x45d9f3b) >>> 0
})

export function chunks(data) {
    const result = []
    let start = 0, rolling = 0
    for (let i = 0; i < data.length; i++) {
        rolling = ((rolling << 1) + gear[data[i]]) >>> 0
        const size = i + 1 - start
        if (size >= MIN_CHUNK && ((rolling & MASK) === 0 || size >= MAX_CHUNK)) {
            result.push([start, size]); start = i + 1; rolling = 0
        }
    }
    if (start < data.length) result.push([start, data.length - start])
    return result
}

export function makeManifest(data, hash) {
    const blocks = chunks(data)
    if (blocks.length > MAX_CHUNKS) return null
    return { v: 1, size: data.length, chunks: blocks.map(([offset, size]) => [size, hash(data.subarray(offset, offset + size))]) }
}

export function validManifest(manifest) {
    if (manifest?.v !== 1 || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.size > MAX_COPY_BYTES ||
        !Array.isArray(manifest.chunks) || manifest.chunks.length > MAX_CHUNKS) return false
    let total = 0
    for (const row of manifest.chunks) {
        if (!Array.isArray(row) || row.length !== 2 || !Number.isInteger(row[0]) || row[0] <= 0 || row[0] > MAX_CHUNK ||
            typeof row[1] !== 'string' || !/^[a-f0-9]{64}$/.test(row[1])) return false
        total += row[0]
    }
    return total === manifest.size
}

// Packet: 4-byte little-endian JSON-header length, JSON header, literal bytes.
// Ops [0, index] reuse a base chunk; [1, length] consume literal bytes.
export function makeDelta(data, manifest, hash) {
    const known = new Map(manifest.chunks.map(([size, sha], i) => [`${size}:${sha}`, i]))
    const ops = [], literals = []
    let literalSize = 0
    for (const [offset, size] of chunks(data)) {
        const block = data.subarray(offset, offset + size)
        const index = known.get(`${size}:${hash(block)}`)
        if (index !== undefined) ops.push([0, index])
        else {
            if (ops.at(-1)?.[0] === 1) ops.at(-1)[1] += size
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

export function applyDelta(base, packet, hash) {
    if (packet.length < 4) throw new Error('Truncated read delta')
    const headerSize = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true)
    if (headerSize > 4 * 1024 * 1024 || headerSize > packet.length - 4) throw new Error('Invalid read delta header')
    const header = JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + headerSize)))
    if (header.v !== 1 || !Number.isSafeInteger(header.size) || header.size < 0 || header.size > MAX_COPY_BYTES ||
        !Array.isArray(header.ops) || header.ops.length > MAX_CHUNKS * 2 || !/^[a-f0-9]{64}$/.test(header.sha256)) throw new Error('Invalid read delta')
    const blocks = chunks(base)
    const output = new Uint8Array(header.size)
    let offset = 0, literal = 4 + headerSize
    for (const op of header.ops) {
        if (!Array.isArray(op) || op.length !== 2 || !Number.isSafeInteger(op[1]) || op[1] < 0) throw new Error('Invalid read delta op')
        let bytes
        if (op[0] === 0 && op[1] < blocks.length) {
            const [start, size] = blocks[op[1]]
            bytes = base.subarray(start, start + size)
        } else if (op[0] === 1 && op[1] <= packet.length - literal) {
            bytes = packet.subarray(literal, literal + op[1]); literal += op[1]
        } else throw new Error('Invalid read delta range')
        if (bytes.length > output.length - offset) throw new Error('Oversized read delta')
        output.set(bytes, offset); offset += bytes.length
    }
    if (offset !== output.length || literal !== packet.length || hash(output) !== header.sha256) throw new Error('Read delta checksum mismatch')
    return output
}
