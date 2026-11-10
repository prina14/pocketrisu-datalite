import { afterEach, expect, test, vi } from 'vitest'
import { utf8ByteLength } from './utf8Length'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

test.each([
    'a'.repeat(4096), '한글과 emoji 🙂 '.repeat(10000),
    'a'.repeat(65535) + '🙂' + 'b'.repeat(65537),
    'a'.repeat(65535) + '\uD800' + 'x'.repeat(65537),
    '\uDC00' + 'a'.repeat(65536) + '\uD800',
])('large strings retain exact UTF-8 byte counts across bounded writes (%#)', value => {
    expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value, 'utf8'))
})

test('native conversion reuses one fixed 64 KiB buffer rather than allocating the whole UTF-8 value', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encodeInto')
    const value = '가🙂x'.repeat(100000)
    expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value, 'utf8'))
    expect(encode.mock.calls.length).toBeGreaterThan(2)
    const buffer = encode.mock.calls[0][1]
    expect(buffer.byteLength).toBe(65536)
    expect(encode.mock.calls.every(([, target]) => target === buffer)).toBe(true)
    expect(encode.mock.calls.every(([input]) => input.length <= 16384)).toBe(true)
})

test('small strings do not need native encoder work', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encodeInto')
    expect(utf8ByteLength('짧은 문자열 🙂')).toBe(Buffer.byteLength('짧은 문자열 🙂'))
    expect(encode).not.toHaveBeenCalled()
})

test.each(['missing encoder', 'missing encodeInto'])('older browsers use the exact fallback: %s', kind => {
    const value = '한글🙂\uD800\uDC00\uDC00'.repeat(20000)
    const expected = Buffer.byteLength(value, 'utf8')
    vi.stubGlobal('TextEncoder', kind === 'missing encoder' ? undefined : class {})
    expect(utf8ByteLength(value)).toBe(expected)
})

test.each(['throws', 'stalls'])('a broken native API cannot stop saving: %s', failure => {
    const value = '한글🙂'.repeat(20000)
    const encode = vi.spyOn(TextEncoder.prototype, 'encodeInto')
    if (failure === 'throws') encode.mockImplementation(() => { throw new Error('unsupported') })
    else encode.mockReturnValue({ read: 0, written: 0 })
    expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value, 'utf8'))
})
