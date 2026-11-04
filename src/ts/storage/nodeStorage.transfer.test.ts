import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (c: any) => c }))
vi.mock('./transferCache', () => ({ transferCache: { get: vi.fn(), put: vi.fn(), versions: vi.fn() } }))
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
    copies.clear()
    vi.mocked(transferCache.get).mockImplementation(async k => copies.get(k) ?? null)
    vi.mocked(transferCache.put).mockImplementation(async (key, etag, data) => { copies.set(key, { key, etag, data }) })
    vi.mocked(transferCache.versions).mockImplementation(async prefix => [...copies.values()].filter(v => v.key.startsWith(prefix)).map(v => [v.key.slice(prefix.length), v.etag]))
})

describe('validated boot copies', () => {
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
