import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { gunzipSync } from 'fflate'
import { makeDelta, makeManifest } from '../../../server/node/readDelta.mjs'

vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (c: any) => c }))
vi.mock('./transferCache', () => ({ transferCache: { get: vi.fn(), put: vi.fn(), versions: vi.fn(), revisions: vi.fn(), updateRevision: vi.fn() } }))
const { NodeStorage } = await import('./nodeStorage')
const { transferCache } = await import('./transferCache')
const copies = new Map<string, any>()
const bytes = (text: string) => new TextEncoder().encode(text)
const ndjson = (rows: any[]) => new Response(rows.map(r => JSON.stringify(r)).join('\n') + '\n')
function storage(fetcher: any) {
    ;(NodeStorage as any).sessionInitialized = true
    const s = new NodeStorage(fetcher)
    s.authChecked = true
    vi.spyOn(s, 'createAuth').mockResolvedValue('token')
    return s
}
beforeEach(() => {
    vi.clearAllMocks()
    delete transferCache.putBatch // Older adapters/mocks keep their per-key API.
    delete transferCache.validators
    copies.clear()
    vi.mocked(transferCache.get).mockImplementation(async k => copies.get(k) ?? null)
    vi.mocked(transferCache.put).mockImplementation(async (key, etag, data, revision) => { copies.set(key, { key, etag, data, revision }) })
    vi.mocked(transferCache.versions).mockImplementation(async prefix => [...copies.values()].filter(v => v.key.startsWith(prefix)).map(v => [v.key.slice(prefix.length), v.etag]))
    vi.mocked(transferCache.revisions).mockImplementation(async prefix => [...copies.values()].filter(v => v.key.startsWith(prefix) && v.revision).map(v => [v.key.slice(prefix.length), v.revision]))
    vi.mocked(transferCache.updateRevision).mockImplementation(async (key, etag, revision) => { if (copies.get(key)?.etag === etag) copies.get(key).revision = revision })
})

describe('validated boot copies', () => {
    test('a prepared delta in the version probe completes the read without uploading a manifest', async () => {
        const old = randomBytes(300000)
        const next = Buffer.concat([old.subarray(0, 12345), Buffer.from('changed'), old.subarray(12345)])
        const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
        const manifest = makeManifest(old, hash)
        copies.set('db:database/database.bin', { etag: 'old', revision: 'r1', data: old, manifest })
        const fetcher = vi.fn().mockResolvedValue(new Response(makeDelta(next, manifest, hash), {
            headers: { 'x-read-delta': '1', 'x-read-prepared-delta': 'probe-hit', 'x-db-etag': 'new', 'x-read-revision': 'r2' },
        }))
        const s = storage(fetcher)
        expect(await s.getItem('database/database.bin')).toEqual(next)
        expect(fetcher).toHaveBeenCalledOnce()
        expect(fetcher.mock.calls[0][0]).toBe('/api/read')
        expect(fetcher.mock.calls[0][1].headers.get('x-read-prepared-accept')).toBe('1')
        expect(s._lastDbEtag).toBe('new')
    })
    test('a broken prepared probe packet still fetches a full authenticated value', async () => {
        const old = randomBytes(200000)
        copies.set('db:database/database.bin', { etag: 'old', revision: 'r1', data: old })
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'x-read-delta': '1' } }))
            .mockResolvedValueOnce(new Response('safe full', { headers: { 'x-db-etag': 'full' } }))
        expect((await storage(fetcher).getItem('database/database.bin')).toString()).toBe('safe full')
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(fetcher.mock.calls[1][1].headers.has('if-none-match')).toBe(false)
    })
    test('an in-flight deferred copy cannot finish after and overwrite a newer immediate DB copy', async () => {
        const normalPut = vi.mocked(transferCache.put).getMockImplementation()!
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        vi.mocked(transferCache.put).mockImplementationOnce(async (...args) => {
            await gate
            return normalPut(...args)
        })
        const fetcher = vi.fn().mockImplementation(async () => new Response('old', { headers: { 'x-db-etag': 'old' } }))
        const s = storage(fetcher)
        await s.getItem('database/database.bin', { deferCacheWrite: true })
        const first = s.flushDeferredCacheWrites()
        await vi.waitFor(() => expect(transferCache.put).toHaveBeenCalledOnce())
        fetcher.mockImplementation(async () => new Response('new', { headers: { 'x-db-etag': 'new' } }))
        const newer = s.getItem('database/database.bin')
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
        expect(transferCache.put).toHaveBeenCalledOnce()
        release()
        await Promise.all([first, newer])
        expect(vi.mocked(transferCache.put).mock.calls.map(args => args[1])).toEqual(['old', 'new'])
        expect(copies.get('db:database/database.bin').etag).toBe('new')
    })

    test('controlled 300ms download and 800ms persistence return boot data at 300ms instead of 1100ms', async () => {
        vi.useFakeTimers()
        try {
            const elapsed: number[] = []
            vi.mocked(transferCache.put).mockImplementation(async () => {
                await new Promise(resolve => setTimeout(resolve, 800))
            })
            for (const deferCacheWrite of [false, true]) {
                const fetcher = vi.fn(async () => {
                    await new Promise(resolve => setTimeout(resolve, 300))
                    return new Response('current', { headers: { 'x-db-etag': 'new' } })
                })
                const s = storage(fetcher)
                const start = Date.now()
                let readyAt = -1
                const result = s.getItem('database/database.bin', { deferCacheWrite }).then(data => {
                    readyAt = Date.now() - start
                    return data
                })
                await vi.runAllTimersAsync()
                expect((await result).toString()).toBe('current')
                elapsed.push(readyAt)
                const flush = s.flushDeferredCacheWrites()
                await vi.runAllTimersAsync()
                await flush
            }
            expect(elapsed).toEqual([1100, 300])
        } finally { vi.useRealTimers() }
    })

    test('controlled 300ms cache and 600ms validation complete in 600ms instead of 900ms', async () => {
        vi.useFakeTimers()
        try {
            const copy = { etag: 'hash', revision: 'r1', data: bytes('cached') }
            const elapsed: number[] = []
            for (const overlap of [false, true]) {
                vi.mocked(transferCache.get).mockImplementation(async (_key, onVersion) => {
                    if (overlap) onVersion?.(copy)
                    await new Promise(resolve => setTimeout(resolve, 300))
                    return copy as any
                })
                const fetcher = vi.fn(async () => {
                    await new Promise(resolve => setTimeout(resolve, 600))
                    return new Response(null, { status: 304 })
                })
                const start = Date.now()
                const result = storage(fetcher).getItem('database/database.bin')
                await vi.runAllTimersAsync()
                expect((await result).toString()).toBe('cached')
                elapsed.push(Date.now() - start)
            }
            expect(elapsed).toEqual([900, 600])
        } finally { vi.useRealTimers() }
    })

    test('a legacy server body returned to the early probe is consumed without downloading twice', async () => {
        const copy = { etag: 'hash', revision: 'r1', data: bytes('old') }
        vi.mocked(transferCache.get).mockImplementation(async (_key, onVersion) => {
            onVersion?.(copy)
            return copy as any
        })
        const fetcher = vi.fn().mockResolvedValue(new Response('current', { headers: { 'x-db-etag': 'new' } }))
        expect((await storage(fetcher).getItem('database/database.bin')).toString()).toBe('current')
        expect(fetcher).toHaveBeenCalledOnce()
    })

    test('starts revision validation before a delayed cache body is available', async () => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const copy = { etag: 'hash', revision: 'r1', data: bytes('cached') }
        vi.mocked(transferCache.get).mockImplementation(async (_key, onVersion) => {
            onVersion?.({ etag: copy.etag, revision: copy.revision })
            await gate
            return copy as any
        })
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 304 }))
        const reading = storage(fetcher).getItem('database/database.bin')
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
        let finished = false
        void reading.then(() => { finished = true })
        await Promise.resolve()
        expect(finished).toBe(false)
        release()
        expect((await reading).toString()).toBe('cached')
        expect(fetcher).toHaveBeenCalledOnce()
    })

    test.each([false, true])('an early 304 never serves a missing or mismatched copy (missing=%s)', async missing => {
        vi.mocked(transferCache.get).mockImplementation(async (_key, onVersion) => {
            onVersion?.({ etag: 'meta-hash', revision: 'meta-r' })
            return missing ? null : { etag: 'other-hash', data: bytes('other') } as any
        })
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 304 }))
            .mockResolvedValueOnce(new Response('server-current', { headers: { 'x-db-etag': 'current' } }))
        expect((await storage(fetcher).getItem('database/database.bin')).toString()).toBe('server-current')
        expect(fetcher).toHaveBeenCalledTimes(2)
    })

    test('failed early authentication is not masked by a cached body', async () => {
        vi.mocked(transferCache.get).mockImplementation(async (_key, onVersion) => {
            onVersion?.({ etag: 'hash', revision: 'r1' })
            return { etag: 'hash', revision: 'r1', data: bytes('private') } as any
        })
        const fetcher = vi.fn().mockResolvedValue(new Response('{"error":"Denied"}', { status: 403 }))
        await expect(storage(fetcher).getItem('database/database.bin')).rejects.toMatchObject({ status: 403 })
    })

    test('boot reads return before optional cache persistence and flush a defensive snapshot later', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response('server-data', { headers: { 'x-db-etag': 'new', 'x-read-revision': 'r1' } }))
        const s = storage(fetcher)
        const data = await s.getItem('database/database.bin', { deferCacheWrite: true })
        expect(data.toString()).toBe('server-data')
        expect(transferCache.put).not.toHaveBeenCalled()
        data[0] = 0
        await s.flushDeferredCacheWrites()
        expect(transferCache.put).toHaveBeenCalledOnce()
        expect(new TextDecoder().decode(copies.get('db:database/database.bin').data)).toBe('server-data')
        await s.flushDeferredCacheWrites()
        expect(transferCache.put).toHaveBeenCalledOnce()
    })

    test('only the newest deferred DB copy is flushed; a newer immediate read cancels an older pending copy', async () => {
        const fetcher = vi.fn().mockImplementation(async () => new Response('new', { headers: { 'x-db-etag': 'new' } }))
        const s = storage(fetcher)
        await s.getItem('database/database.bin', { deferCacheWrite: true })
        fetcher.mockImplementation(async () => new Response('latest', { headers: { 'x-db-etag': 'latest' } }))
        await s.getItem('database/database.bin', { deferCacheWrite: true })
        await s.flushDeferredCacheWrites()
        expect(transferCache.put).toHaveBeenCalledOnce()
        expect(copies.get('db:database/database.bin').etag).toBe('latest')
        copies.clear()
        await s.getItem('database/database.bin', { deferCacheWrite: true })
        fetcher.mockImplementation(async () => new Response('immediate', { headers: { 'x-db-etag': 'immediate' } }))
        await s.getItem('database/database.bin')
        await s.flushDeferredCacheWrites()
        expect(transferCache.put).toHaveBeenCalledTimes(2)
        expect(copies.get('db:database/database.bin').etag).toBe('immediate')
    })

    test('slow or failed optional persistence does not hold a boot read or poison subsequent writes', async () => {
        let reject!: (error: Error) => void
        vi.mocked(transferCache.put).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
        const fetcher = vi.fn().mockImplementation(async () => new Response('new', { headers: { 'x-db-etag': 'new' } }))
        const s = storage(fetcher)
        expect((await s.getItem('database/database.bin', { deferCacheWrite: true })).toString()).toBe('new')
        const flushing = s.flushDeferredCacheWrites()
        await vi.waitFor(() => expect(transferCache.put).toHaveBeenCalledOnce())
        reject(new Error('quota'))
        await flushing
        await s.getItem('database/database.bin', { deferCacheWrite: true })
        await s.flushDeferredCacheWrites()
        expect(transferCache.put).toHaveBeenCalledTimes(3)
    })

    test('a known revision validates a large copy without uploading chunk hashes', async () => {
        const data = randomBytes(1024 * 1024)
        copies.set('db:database/database.bin', { etag: 'hash', revision: 'r1', data })
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 304, headers: { 'x-read-revision': 'r1', 'x-read-version-check': '1' } }))
        expect(createHash('sha256').update(await storage(fetcher).getItem('database/database.bin')).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'))
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(fetcher.mock.calls[0][0]).toBe('/api/read')
        expect(fetcher.mock.calls[0][1].body).toBeUndefined()
        expect(fetcher.mock.calls[0][1].headers.get('if-read-revision')).toBe('r1')
    })
    test('an unchanged body with a new revision updates metadata for the next probe', async () => {
        copies.set('db:database/database.bin', { etag: 'hash', revision: 'r1', data: bytes('body') })
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { headers: { 'x-read-version-check': '1', 'x-read-revision': 'r2' } }))
            .mockResolvedValueOnce(new Response(null, { status: 304, headers: { 'x-read-revision': 'r2' } }))
            .mockResolvedValueOnce(new Response(null, { status: 304, headers: { 'x-read-revision': 'r2' } }))
        await storage(fetcher).getItem('database/database.bin')
        expect(copies.get('db:database/database.bin').revision).toBe('r2')
        await storage(fetcher).getItem('database/database.bin')
        expect(fetcher.mock.calls[2][1].headers.get('if-read-revision')).toBe('r2')
    })
    test('a server ignoring revision probes returns its normal body without a second download', async () => {
        copies.set('db:database/database.bin', { etag: 'old', revision: 'r1', data: bytes('old') })
        const fetcher = vi.fn().mockResolvedValue(new Response('current', { headers: { 'x-db-etag': 'new' } }))
        expect((await storage(fetcher).getItem('database/database.bin')).toString()).toBe('current')
        expect(fetcher).toHaveBeenCalledTimes(1)
    })
    test('a reload validates the DB and reuses its bytes on 304', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(bytes('database'), { headers: { 'x-db-etag': 'v1' } }))
            .mockResolvedValueOnce(new Response(null, { status: 304 }))
        expect((await storage(fetcher).getItem('database/database.bin')).toString()).toBe('database')
        const reloaded = storage(fetcher)
        expect((await reloaded.getItem('database/database.bin')).toString()).toBe('database')
        expect(new Headers(fetcher.mock.calls[1][1].headers).get('if-none-match')).toBe('v1')
        expect(reloaded._lastDbEtag).toBe('v1')
    })
    test('changed DB replaces the copy; unrelated keys never use its validator', async () => {
        copies.set('db:database/database.bin', { etag: 'old', data: bytes('old') })
        const fetcher = vi.fn().mockImplementation(async () => new Response(bytes('new'), { headers: { 'x-db-etag': 'new' } }))
        const s = storage(fetcher)
        expect((await s.getItem('database/database.bin')).toString()).toBe('new')
        await s.getItem('another-key')
        expect(new Headers(fetcher.mock.calls[1][1].headers).has('if-none-match')).toBe(false)
        expect(copies.get('db:database/database.bin').etag).toBe('new')
    })
    test('server/auth failures never fall back to stale local data', async () => {
        copies.set('db:database/database.bin', { etag: 'old', data: bytes('private') })
        const s = storage(vi.fn().mockResolvedValue(new Response('unavailable', { status: 500 })))
        await expect(s.getItem('database/database.bin')).rejects.toThrow()
    })
    test('V3 per-key reads share copies with bulk preload without changing the DB validator', async () => {
        copies.set('plugin:기억', { etag: 'sha', data: bytes('"stored"') })
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 304 }))
            .mockResolvedValueOnce(new Response('"updated"', { headers: { 'x-storage-etag': 'next' } }))
        const s = storage(fetcher)
        const key = 'plugin-storage/' + Buffer.from('기억').toString('base64url')
        expect((await s.getItem(key)).toString()).toBe('"stored"')
        expect(s._lastDbEtag).toBeNull()
        expect((await s.getItem(key)).toString()).toBe('"updated"')
        expect(copies.get('plugin:기억').etag).toBe('next')
    })
})

describe('plugin delta preload', () => {
    test('uses a single combined validator snapshot when the cache supports it', async () => {
        transferCache.validators = vi.fn().mockResolvedValue({
            versions: [['a', 'h1']], revisions: [['a', 'r1']],
        })
        const fetcher = vi.fn().mockResolvedValue(ndjson([{ done: true }]))
        await storage(fetcher).getPluginStorageAll(() => {})
        expect(transferCache.validators).toHaveBeenCalledExactlyOnceWith('plugin:')
        expect(transferCache.versions).not.toHaveBeenCalled()
        expect(transferCache.revisions).not.toHaveBeenCalled()
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
            versions: [['a', 'h1']], revisions: [['a', 'r1']], readDelta: true,
        })
    })
    test('starts both legacy validator reads before waiting for either result', async () => {
        let releaseVersions!: (value: [string, string][]) => void
        let releaseRevisions!: (value: [string, string][]) => void
        vi.mocked(transferCache.versions).mockImplementation(() => new Promise(resolve => { releaseVersions = resolve }))
        vi.mocked(transferCache.revisions).mockImplementation(() => new Promise(resolve => { releaseRevisions = resolve }))
        const fetcher = vi.fn().mockResolvedValue(ndjson([{ done: true }]))
        const preload = storage(fetcher).getPluginStorageAll(() => {})
        expect(transferCache.versions).toHaveBeenCalledWith('plugin:')
        expect(transferCache.revisions).toHaveBeenCalledWith('plugin:')
        releaseRevisions([['a', 'r1']])
        await Promise.resolve()
        expect(fetcher).not.toHaveBeenCalled()
        releaseVersions([['a', 'h1']])
        await preload
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
            versions: [['a', 'h1']], revisions: [['a', 'r1']], readDelta: true,
        })
    })
    function batchWriter() {
        const write = vi.fn(async (rows: any[]) => {
            for (const row of rows) copies.set(row.key, { ...row })
        })
        transferCache.putBatch = write
        return write
    }
    test('a cold 100-key preload writes bounded batches and flushes the last partial batch', async () => {
        const write = batchWriter()
        const rows = Array.from({ length: 100 }, (_, i) => [`key-${i}`, JSON.stringify(`value-${i}`), `h${i}`, `r${i}`])
        const fetcher = vi.fn().mockResolvedValue(ndjson([...rows, { done: true }]))
        const onEntry = vi.fn()
        await storage(fetcher).getPluginStorageAll(onEntry)
        expect(onEntry).toHaveBeenCalledTimes(100)
        expect(write.mock.calls.map(([rows]) => rows.length)).toEqual([32, 32, 32, 4])
        expect(transferCache.put).not.toHaveBeenCalled()
        expect(copies.get('plugin:key-99')).toMatchObject({ etag: 'h99', revision: 'r99' })
        expect(new TextDecoder().decode(copies.get('plugin:key-99').data)).toBe('"value-99"')
        expect(fetcher).toHaveBeenCalledTimes(1)
    })
    test('preload write staging is byte-bounded and oversized values are written alone', async () => {
        const write = batchWriter()
        const a = 'a'.repeat(700 * 1024), b = 'b'.repeat(700 * 1024), big = 'c'.repeat(2 * 1024 * 1024)
        const fetcher = vi.fn().mockResolvedValue(ndjson([
            ['a', a, 'a'], ['b', b, 'b'], ['big', big, 'big'], ['small', '1', 'small'], { done: true },
        ]))
        await storage(fetcher).getPluginStorageAll(() => {})
        expect(write.mock.calls.map(([rows]) => rows.length)).toEqual([1, 1, 1])
        for (const [rows] of write.mock.calls) {
            expect(rows.reduce((total, row) => total + row.data.byteLength, 0)).toBeLessThanOrEqual(1024 * 1024)
        }
        expect(transferCache.put).toHaveBeenCalledTimes(1)
        expect(vi.mocked(transferCache.put).mock.calls[0][0]).toBe('plugin:big')
        expect(copies.get('plugin:big').data.byteLength).toBe(big.length)
    })
    test('an incomplete stream keeps existing copies and caches only its validated rows', async () => {
        const write = batchWriter()
        copies.set('plugin:existing', { key: 'plugin:existing', etag: 'old', data: bytes('old') })
        const s = storage(vi.fn().mockResolvedValue(ndjson([['a', '1', 'h1', 'r1']])))
        await expect(s.getPluginStorageAll(() => {})).rejects.toThrow('Incomplete plugin sync')
        expect(write).toHaveBeenCalledTimes(1)
        expect(copies.get('plugin:existing').etag).toBe('old')
        expect(copies.get('plugin:a').revision).toBe('r1')
    })
    test('a repeated conditional stream key can reuse a preceding queued row', async () => {
        const write = batchWriter()
        const fetcher = vi.fn().mockResolvedValue(ndjson([['a', '1', 'h1', 'r1'], ['a', null, null, 'r1'], { done: true }]))
        const onEntry = vi.fn()
        await storage(fetcher).getPluginStorageAll(onEntry)
        expect(onEntry.mock.calls).toEqual([['a', '1'], ['a', '1']])
        expect(write).toHaveBeenCalledTimes(1)
        expect(fetcher).toHaveBeenCalledTimes(1)
    })
    test('revision-only rows reuse plugin values without requiring content hashes from the server', async () => {
        copies.set('plugin:a', { key: 'plugin:a', etag: 'sha', revision: 'r1', data: bytes('"cached"') })
        const fetcher = vi.fn().mockResolvedValue(ndjson([['a', null, null, 'r1'], { done: true }]))
        const onEntry = vi.fn()
        await storage(fetcher).getPluginStorageAll(onEntry)
        expect(onEntry).toHaveBeenCalledWith('a', '"cached"')
        expect(JSON.parse(fetcher.mock.calls[0][1].body).revisions).toEqual([['a', 'r1']])
        expect(fetcher).toHaveBeenCalledTimes(1)
    })
    test('a new page reuses unchanged keys, replaces changed ones, and omits deleted ones', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(ndjson([['a', '"one"', 'h1'], ['b', '"old"', 'h2'], ['deleted', '1', 'h3'], { done: true }]))
            .mockResolvedValueOnce(ndjson([['a', null, 'h1'], ['b', '"new"', 'h4'], { done: true }]))
        await storage(fetcher).getPluginStorageAll(() => {})
        const seen = new Map()
        await storage(fetcher).getPluginStorageAll((k, v) => seen.set(k, JSON.parse(v)))
        expect(Object.fromEntries(seen)).toEqual({ a: 'one', b: 'new' })
        expect(JSON.parse(fetcher.mock.calls[1][1].body).versions).toContainEqual(['a', 'h1'])
        expect(copies.get('plugin:b').etag).toBe('h4')
    })
    test('a copy evicted after the manifest is recovered from the server', async () => {
        vi.mocked(transferCache.versions).mockResolvedValue([['a', 'h1']])
        const fetcher = vi.fn().mockResolvedValueOnce(ndjson([['a', null, 'h1'], { done: true }]))
            .mockResolvedValueOnce(new Response('"current"'))
        const onEntry = vi.fn()
        await storage(fetcher).getPluginStorageAll(onEntry)
        expect(onEntry).toHaveBeenCalledWith('a', '"current"')
        expect(fetcher.mock.calls[1][0]).toBe('/api/read')
    })
    test('a truncated stream is rejected, preserving only validated complete rows', async () => {
        const s = storage(vi.fn().mockResolvedValue(ndjson([['a', '1', 'h1']])))
        await expect(s.getPluginStorageAll(() => {})).rejects.toThrow('Incomplete plugin sync')
    })
    test('older servers use the existing full stream', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
            .mockResolvedValueOnce(ndjson([['a', '1']]))
        const onEntry = vi.fn()
        await storage(fetcher).getPluginStorageAll(onEntry)
        expect(onEntry).toHaveBeenCalledWith('a', '1')
        expect(fetcher.mock.calls[1][0]).toBe('/api/plugin-storage/all')
    })
    test('cached rows do not corrupt split UTF-8 network characters', async () => {
        copies.set('plugin:a', { key: 'plugin:a', etag: 'h1', data: bytes('"사본"') })
        const data = bytes(JSON.stringify(['a', null, 'h1']) + '\n' + JSON.stringify(['b', '"한글"', 'h2']) + '\n{"done":true}\n')
        const split = data.indexOf(0xed) + 1 // split inside 한
        const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(data.slice(0, split)); c.enqueue(data.slice(split)); c.close() } })))
        const seen = new Map()
        await storage(fetcher).getPluginStorageAll((k, v) => seen.set(k, v))
        expect(seen.get('b')).toBe('"한글"')
    })
})

describe('changed large values', () => {
    const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
    function prepare(size = 512 * 1024) {
        const old = randomBytes(size)
        const next = Buffer.concat([old.subarray(0, 12345), Buffer.from('edit'), old.subarray(12345)])
        copies.set('db:database/database.bin', { key: 'db:database/database.bin', etag: 'old', data: old })
        return { old, next, packet: makeDelta(next, makeManifest(old, hash)!, hash) }
    }
    test('reconstructs a changed DB and uses its latest validator; gzips the manifest', async () => {
        // Even maximum-sized chunks must produce a manifest large enough
        // to exercise request compression, independently of random cuts.
        const { old, next, packet } = prepare(2 * 1024 * 1024)
        const fetcher = vi.fn().mockResolvedValue(new Response(packet, { headers: { 'x-read-delta': '1', 'x-db-etag': 'new' } }))
        const s = storage(fetcher)
        expect(hash(await s.getItem('database/database.bin'))).toBe(hash(next))
        expect(s._lastDbEtag).toBe('new')
        expect(fetcher.mock.calls[0][0]).toBe('/api/read-delta')
        const init = fetcher.mock.calls[0][1]
        expect(init.headers.get('content-encoding')).toBe('gzip')
        expect(JSON.parse(new TextDecoder().decode(gunzipSync(init.body)))).toEqual(makeManifest(old, hash))
        expect(hash(copies.get('db:database/database.bin').data)).toBe(hash(next))
    })
    test('corrupt or truncated deltas trigger one full authenticated read without a validator', async () => {
        const { next, packet } = prepare()
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(packet.subarray(0, 10), { headers: { 'x-read-delta': '1', 'x-db-etag': 'bad' } }))
            .mockResolvedValueOnce(new Response(next, { headers: { 'x-db-etag': 'full' } }))
        const s = storage(fetcher)
        expect(await s.getItem('database/database.bin')).toEqual(next)
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(fetcher.mock.calls[1][0]).toBe('/api/read')
        expect(fetcher.mock.calls[1][1].headers.has('if-none-match')).toBe(false)
        expect(s._lastDbEtag).toBe('full')
    })
    test('old servers fall back to the existing conditional GET', async () => {
        const { old } = prepare()
        const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
            .mockResolvedValueOnce(new Response(null, { status: 304 }))
        expect(await storage(fetcher).getItem('database/database.bin')).toEqual(old)
        expect(fetcher.mock.calls[1][0]).toBe('/api/read')
    })
    test('a connection interrupted during the delta body also fetches one full value', async () => {
        const { next } = prepare()
        const interrupted = new Response(new ReadableStream({ start(c) { c.error(new TypeError('connection lost')) } }), { headers: { 'x-read-delta': '1' } })
        const fetcher = vi.fn().mockResolvedValueOnce(interrupted)
            .mockResolvedValueOnce(new Response(next, { headers: { 'x-db-etag': 'recovered' } }))
        expect(await storage(fetcher).getItem('database/database.bin')).toEqual(next)
        expect(fetcher).toHaveBeenCalledTimes(2)
    })
    test('V2 bulk markers fetch the changed value through the same byte-delta path', async () => {
        const old = Buffer.from(JSON.stringify(randomBytes(300000).toString('base64')))
        const next = Buffer.from(old); next[12345] = next[12345] === 65 ? 66 : 65
        copies.set('plugin:memory', { key: 'plugin:memory', etag: hash(old), data: old })
        const packet = makeDelta(next, makeManifest(old, hash)!, hash)
        const fetcher = vi.fn().mockResolvedValueOnce(ndjson([['memory', { read: true }, hash(next)], { done: true }]))
            .mockResolvedValueOnce(new Response(packet, { headers: { 'x-read-delta': '1', 'x-storage-etag': hash(next) } }))
        const onEntry = vi.fn()
        await storage(fetcher).getPluginStorageAll(onEntry)
        expect(onEntry).toHaveBeenCalledWith('memory', next.toString())
        expect(fetcher.mock.calls[1][0]).toBe('/api/read-delta')
    })
})

describe('post-save boot-copy refresh', () => {
    test('coalesces accepted saves and updates only the copy, preserving the live editor validator', async () => {
        vi.useFakeTimers()
        try {
            copies.set('db:database/database.bin', { etag: 'old', revision: 'r0', data: bytes('old') })
            const fetcher = vi.fn(async (_url, init) => new Response(null, { status: 304, headers: { 'x-read-version-check': '1', 'x-read-revision': 'r1' } }))
            const s = storage(fetcher)
            s._lastDbEtag = 'editor-baseline'
            const before = performance.getEntriesByName('pocketrisu:startup:database-cache-write').length
            s.scheduleDbCacheRefresh()
            await vi.advanceTimersByTimeAsync(1000)
            s.scheduleDbCacheRefresh()
            await vi.advanceTimersByTimeAsync(1499)
            expect(fetcher).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(1)
            await vi.runAllTimersAsync()
            expect(fetcher).toHaveBeenCalledOnce()
            expect(new Headers(fetcher.mock.calls[0][1].headers).get('x-read-cache-refresh')).toBe('1')
            expect(copies.get('db:database/database.bin').revision).toBe('r1')
            expect(s._lastDbEtag).toBe('editor-baseline')
            expect(performance.getEntriesByName('pocketrisu:startup:database-cache-write')).toHaveLength(before)
        } finally { vi.useRealTimers() }
    })

    test('background data is validated and persisted without adopting a foreign write ETag', async () => {
        copies.set('db:database/database.bin', { etag: 'old', data: bytes('old') })
        const s = storage(vi.fn(async () => new Response('latest', { headers: { 'x-db-etag': 'foreign', 'x-read-revision': 'r2' } })))
        s._lastDbEtag = 'live-baseline'
        await s.getItem('database/database.bin', { purpose: 'cache-refresh' })
        expect(copies.get('db:database/database.bin').etag).toBe('foreign')
        expect(s._lastDbEtag).toBe('live-baseline')
    })

    test('an older background response cannot replace a later read copy', async () => {
        let release!: (response: Response) => void
        const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
            .mockResolvedValueOnce(new Response('new', { headers: { 'x-db-etag': 'new' } }))
        const s = storage(fetcher)
        const background = s.getItem('database/database.bin', { purpose: 'cache-refresh' })
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
        await s.getItem('database/database.bin')
        release(new Response('older', { headers: { 'x-db-etag': 'older' } }))
        await background
        expect(copies.get('db:database/database.bin').etag).toBe('new')
        expect(s._lastDbEtag).toBe('new')
    })

    test('cache failures are recorded and retried once without failing a valid read', async () => {
        vi.useFakeTimers()
        try {
            vi.mocked(transferCache.put).mockRejectedValue(Object.assign(new Error('synthetic quota'), { name: 'QuotaExceededError' }))
            const s = storage(vi.fn(async () => new Response('valid', { headers: { 'x-db-etag': 'valid' } })))
            const result = s.getItem('database/database.bin', { purpose: 'cache-refresh' })
            await vi.runAllTimersAsync()
            expect((await result).toString()).toBe('valid')
            expect(transferCache.put).toHaveBeenCalledTimes(2)
            expect(globalThis.__pocketrisuSyncDiagnostics!().filter(row => row.type === 'cache-write-failed').slice(-2).map(row => row.error)).toEqual(['QuotaExceededError', 'QuotaExceededError'])
        } finally { vi.useRealTimers() }
    })
})

test('a save during an in-flight copy refresh schedules a follow-up without stranding it', async () => {
    vi.useFakeTimers()
    try {
        let release!: (response: Response) => void
        const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
            .mockResolvedValueOnce(new Response('latest', { headers: { 'x-db-etag': 'latest' } }))
        const s = storage(fetcher)
        const first = (s as any).refreshDbCache() as Promise<void>
        await vi.advanceTimersByTimeAsync(0)
        s.scheduleDbCacheRefresh()
        await vi.advanceTimersByTimeAsync(1500)
        release(new Response('first', { headers: { 'x-db-etag': 'first' } }))
        await first
        await vi.advanceTimersByTimeAsync(1500)
        await vi.runAllTimersAsync()
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(copies.get('db:database/database.bin').etag).toBe('latest')
    } finally { vi.useRealTimers() }
})

test('patch diagnostics name root fields without recording the changed content', async () => {
    const s = storage(vi.fn(async () => Response.json({ success: true, etag: 'accepted' })))
    await s.patchItem('database/database.bin', { patch: [{ op: 'replace', path: '/globalNote', value: 'private-content-sentinel' }], expectedHash: 'baseline' })
    const trace = globalThis.__pocketrisuSyncDiagnostics!()
    expect(trace.at(-1)?.roots).toEqual(['globalNote'])
    expect(JSON.stringify(trace)).not.toContain('private-content-sentinel')
})
