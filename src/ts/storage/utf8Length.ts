let encoder: TextEncoder | undefined
let scratch: Uint8Array | undefined

/** Count large strings with native UTF-8 encoding and a fixed 64 KiB buffer.
 * encodeInto stops before splitting a surrogate pair; advance by its actual
 * UTF-16 read count. Small strings/older browsers use the allocation-free path.
 */
export function utf8ByteLength(str: string): number {
    if (str.length >= 4096 && typeof TextEncoder !== 'undefined' &&
        typeof TextEncoder.prototype.encodeInto === 'function') {
        try {
            encoder ??= new TextEncoder()
            scratch ??= new Uint8Array(64 * 1024)
            let offset = 0, bytes = 0
            while (offset < str.length) {
                // Passing the entire remaining string can force repeated
                // flattening/conversion of large JSON strings in browsers.
                // Bound the input too, preserving pairs across slice edges.
                let end = Math.min(offset + 16 * 1024, str.length)
                const last = str.charCodeAt(end - 1), next = str.charCodeAt(end)
                if (end < str.length && last >= 0xD800 && last <= 0xDBFF &&
                    next >= 0xDC00 && next <= 0xDFFF) end--
                const { read, written } = encoder.encodeInto(str.slice(offset, end), scratch)
                if (!read) return countUtf8(str)
                offset += read
                bytes += written
            }
            return bytes
        } catch { /* Native support failure must not break saving. */ }
    }
    return countUtf8(str)
}

function countUtf8(str: string): number {
    let bytes = str.length
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i)
        if (code < 0x80) continue
        if (code < 0x800) { bytes += 1; continue }
        if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
            const next = str.charCodeAt(i + 1)
            if (next >= 0xDC00 && next <= 0xDFFF) { bytes += 2; i++; continue }
        }
        bytes += 2
    }
    return bytes
}
