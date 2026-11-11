import { afterEach, expect, test, vi } from 'vitest'
import { webcrypto, randomBytes, createHash } from 'node:crypto'
import { readHash, readHashAsync } from './readDeltaHash'
afterEach(() => vi.unstubAllGlobals())

test('native digest hashes only the requested view and matches the fallback', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const bytes = randomBytes(300_000).subarray(13, 299_987)
    const expected = createHash('sha256').update(bytes).digest('hex')
    expect(await readHashAsync(bytes)).toBe(expected)
    expect(readHash(bytes)).toBe(expected)
})

test('missing or rejected WebCrypto keeps verified reads available on HTTP', async () => {
    const bytes = randomBytes(100_000)
    const expected = readHash(bytes)
    vi.stubGlobal('crypto', {})
    expect(await readHashAsync(bytes)).toBe(expected)
    vi.stubGlobal('crypto', { subtle: { digest: () => Promise.reject(new Error('unavailable')) } })
    expect(await readHashAsync(bytes)).toBe(expected)
})
