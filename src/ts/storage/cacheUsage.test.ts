// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { IDBCursor, IDBDatabase, IDBFactory, IDBTransaction } from 'fake-indexeddb'

beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('navigator', {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function seed(name: string, storeName: string, rows: any[]) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, 1)
        req.onupgradeneeded = () => req.result.createObjectStore(storeName, { keyPath: 'key' })
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error)
        for (const row of rows) tx.objectStore(storeName).put(row)
    })
    db.close()
}

test('uses browser usage and quota without opening or scanning cache data', async () => {
    const estimate = vi.fn(async () => ({ usage: 128 * 1024 ** 2, quota: 1024 ** 3 }))
    vi.stubGlobal('navigator', { storage: { estimate } })
    const open = vi.spyOn(indexedDB, 'open')
    const { readCacheUsage } = await import('./cacheUsage')
    expect(await readCacheUsage()).toEqual({ usageBytes: 128 * 1024 ** 2, quotaBytes: 1024 ** 3, source: 'browser' })
    estimate.mockResolvedValueOnce({ usage: 256 * 1024 ** 2, quota: 1024 ** 3 })
    expect((await readCacheUsage()).usageBytes).toBe(256 * 1024 ** 2)
    expect(open).not.toHaveBeenCalled()
})

test('an unknown browser quota stays unknown, including a zero quota', async () => {
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 0, quota: 0 }) } })
    const { readCacheUsage } = await import('./cacheUsage')
    expect(await readCacheUsage()).toEqual({ usageBytes: 0, quotaBytes: null, source: 'browser' })
})

test('HTTP fallback counts transfer metadata and existing chat bodies without changing schemas or records', async () => {
    const chat = { message: [{ data: '안녕하세요' }], note: 'cached note' }
    await seed('pocketrisu-transfer-cache-v1', 'versions', [{ key: 'db:x', bytes: 2048 }, { key: 'plugin:y', bytes: 4096 }])
    await seed('pocketrisu-chat-copies', 'chats', [{ key: 'char|chat', chat, usedAt: 123 }])
    const { readCacheUsage } = await import('./cacheUsage')
    expect(await readCacheUsage()).toEqual({
        usageBytes: 6144 + new TextEncoder().encode(JSON.stringify(chat)).byteLength,
        quotaBytes: null, source: 'cache',
    })
    const request = indexedDB.open('pocketrisu-chat-copies')
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result) })
    expect(db.version).toBe(1)
    const row = await new Promise<any>(resolve => {
        const get = db.transaction('chats').objectStore('chats').get('char|chat')
        get.onsuccess = () => resolve(get.result)
    })
    expect(row).toEqual({ key: 'char|chat', chat, usedAt: 123 })
    db.close()
})

test('a rejected or invalid estimate falls back; viewing empty caches does not create databases', async () => {
    vi.stubGlobal('navigator', { storage: { estimate: async () => { throw new Error('policy') } } })
    const { readCacheUsage } = await import('./cacheUsage')
    expect(await readCacheUsage()).toEqual({ usageBytes: 0, quotaBytes: null, source: 'cache' })
    expect(await indexedDB.databases()).toEqual([])
})

test('missing IndexedDB is unavailable rather than a misleading zero', async () => {
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: NaN, quota: -1 }) } })
    const { readCacheUsage } = await import('./cacheUsage')
    expect(await readCacheUsage()).toEqual({ usageBytes: null, quotaBytes: null, source: 'unavailable' })
    vi.stubGlobal('indexedDB', new IDBFactory())
    await seed('pocketrisu-transfer-cache-v1', 'versions', [{ key: 'db:x', bytes: 100 }])
    expect((await readCacheUsage()).usageBytes).toBe(100)
})

test('fallback is reused for the page lifetime, including after 30 seconds, until manual refresh', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const { readCacheUsage } = await import('./cacheUsage')
    expect((await readCacheUsage()).usageBytes).toBe(0)
    await seed('pocketrisu-transfer-cache-v1', 'versions', [{ key: 'db:x', bytes: 1000 }])
    const open = vi.spyOn(indexedDB, 'open')
    now.mockReturnValue(60 * 60 * 1000)
    expect((await readCacheUsage()).usageBytes).toBe(0)
    expect(open).not.toHaveBeenCalled()
    expect((await readCacheUsage({ force: true })).usageBytes).toBe(1000)
})

test('aborting a body scan aborts its transaction, closes the database, and never caches a partial result', async () => {
    const chat = { message: [{ data: 'cached message' }] }
    await seed('pocketrisu-transfer-cache-v1', 'versions', [{ key: 'db:x', bytes: 1000 }])
    await seed('pocketrisu-chat-copies', 'chats', Array.from({ length: 20 }, (_, key) => ({ key: String(key), chat })))
    const controller = new AbortController()
    const originalContinue = IDBCursor.prototype.continue
    let stopped = false
    vi.spyOn(IDBCursor.prototype, 'continue').mockImplementation(function (...args) {
        if (this.source.name === 'chats' && !stopped) {
            stopped = true
            controller.abort()
            return
        }
        return originalContinue.apply(this, args)
    })
    const abort = vi.spyOn(IDBTransaction.prototype, 'abort')
    const close = vi.spyOn(IDBDatabase.prototype, 'close')
    const { readCacheUsage } = await import('./cacheUsage')
    await expect(readCacheUsage({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(stopped).toBe(true)
    expect(abort).toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(2)
    // A new mount must start cleanly instead of joining the aborted work.
    expect(await readCacheUsage()).toEqual({
        usageBytes: 1000 + 20 * new TextEncoder().encode(JSON.stringify(chat)).byteLength,
        quotaBytes: null, source: 'cache',
    })
})

test('cancels pending database opening and closes a late connection without poisoning the next read', async () => {
    const request: any = {}
    vi.stubGlobal('indexedDB', { open: () => request })
    const controller = new AbortController()
    const { readCacheUsage } = await import('./cacheUsage')
    const pending = readCacheUsage({ signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const close = vi.fn()
    request.result = { close }
    request.onsuccess()
    expect(close).toHaveBeenCalledOnce()
    vi.stubGlobal('indexedDB', new IDBFactory())
    expect(await readCacheUsage()).toEqual({ usageBytes: 0, quotaBytes: null, source: 'cache' })
})

test('an unmounted caller can cancel a slow browser estimate without starting fallback work', async () => {
    let complete!: (value: StorageEstimate) => void
    const estimate = vi.fn(() => new Promise<StorageEstimate>(resolve => { complete = resolve }))
    vi.stubGlobal('navigator', { storage: { estimate } })
    const open = vi.spyOn(indexedDB, 'open')
    const controller = new AbortController()
    const { readCacheUsage } = await import('./cacheUsage')
    const pending = readCacheUsage({ signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    complete({ usage: 100, quota: 1000 })
    estimate.mockResolvedValueOnce({ usage: 200, quota: 1000 })
    expect((await readCacheUsage()).usageBytes).toBe(200)
    expect(open).not.toHaveBeenCalled()
})

test('an invalid metadata size reports unavailable rather than incomplete usage', async () => {
    await seed('pocketrisu-transfer-cache-v1', 'versions', [{ key: 'broken', bytes: NaN }])
    const { readCacheUsage } = await import('./cacheUsage')
    expect((await readCacheUsage()).source).toBe('unavailable')
})

test('formats readable binary units and rejects invalid sizes', async () => {
    const { formatCacheBytes } = await import('./cacheUsage')
    expect(formatCacheBytes(0)).toBe('0 B')
    expect(formatCacheBytes(1024)).toBe('1 KiB')
    expect(formatCacheBytes(1024 ** 3)).toBe('1 GiB')
    expect(formatCacheBytes(NaN)).toBe('—')
    expect(formatCacheBytes(-1)).toBe('—')
})
