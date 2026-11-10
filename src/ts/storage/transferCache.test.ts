// @vitest-environment node
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'

beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function openCacheDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('pocketrisu-transfer-cache-v1', 1)
        req.onupgradeneeded = () => {
            req.result.createObjectStore('copies', { keyPath: 'key' })
            req.result.createObjectStore('versions', { keyPath: 'key' })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

test('copies and their versions survive a page/module reload on the same origin', async () => {
    const { transferCache: first } = await import('./transferCache')
    const data = new TextEncoder().encode('기억 데이터')
    await first.put('plugin:memory', 'sha', data)
    await first.put('db:database', 'etag', new Uint8Array([1, 2, 3]))
    vi.resetModules()
    const { transferCache: next } = await import('./transferCache')
    expect(await next.versions('plugin:')).toEqual([['memory', 'sha']])
    expect((await next.get('plugin:memory'))?.data).toEqual(data)
    expect(await next.get('missing')).toBeNull()
    await next.put('plugin:memory', 'updated', new Uint8Array([9]))
    expect(await next.versions('plugin:')).toEqual([['memory', 'updated']])
})

test('unavailable IndexedDB does not prevent network-only operation', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const { transferCache: copies } = await import('./transferCache')
    expect(await copies.get('plugin:a')).toBeNull()
    expect(await copies.versions('plugin:')).toEqual([])
    await expect(copies.put('plugin:a', 'sha', new Uint8Array([1]))).resolves.toBeUndefined()
})

test('revision metadata updates preserve the body and reject a mismatched validator', async () => {
    const { transferCache: copies } = await import('./transferCache')
    await copies.put('plugin:a', 'hash', new Uint8Array([1, 2, 3]), 'r1')
    expect(await copies.revisions('plugin:')).toEqual([['a', 'r1']])
    await copies.updateRevision('plugin:a', 'wrong', 'bad')
    expect((await copies.get('plugin:a'))?.revision).toBe('r1')
    await copies.updateRevision('plugin:a', 'hash', 'r2')
    expect((await copies.get('plugin:a'))?.data).toEqual(new Uint8Array([1, 2, 3]))
    expect((await copies.get('plugin:a'))?.revision).toBe('r2')
    expect(await copies.versions('plugin:')).toEqual([['a', 'hash']])
})

test('a quota failure is optional and does not advertise an uncommitted copy', async () => {
    const { transferCache: copies } = await import('./transferCache')
    await copies.put('plugin:old', 'old', new Uint8Array([1]))
    const db = await new Promise<IDBDatabase>(resolve => {
        const req = indexedDB.open('pocketrisu-transfer-cache-v1', 1)
        req.onsuccess = () => resolve(req.result)
    })
    const proto = Object.getPrototypeOf(db.transaction('copies', 'readwrite').objectStore('copies'))
    const put = vi.spyOn(proto, 'put').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    await expect(copies.put('plugin:new', 'new', new Uint8Array([2]))).resolves.toBeUndefined()
    put.mockRestore()
    expect(await copies.versions('plugin:')).toEqual([['old', 'old']])
    expect(await copies.get('plugin:new')).toBeNull()
    db.close()
})

test('100 small copies use four bounded write transactions and metadata scans', async () => {
    const db = await openCacheDb()
    const storeProto = Object.getPrototypeOf(db.transaction('versions').objectStore('versions'))
    const dbProto = Object.getPrototypeOf(db)
    const originalCursor = storeProto.openCursor
    const originalTransaction = dbProto.transaction
    let scans = 0, rowsRead = 0, writeTransactions = 0
    vi.spyOn(storeProto, 'openCursor').mockImplementation(function(this: IDBObjectStore, ...args: any[]) {
        const request = originalCursor.apply(this, args)
        if (this.name === 'versions' && this.transaction.mode === 'readwrite') {
            scans++
            request.addEventListener('success', () => { if (request.result) rowsRead++ })
        }
        return request
    })
    vi.spyOn(dbProto, 'transaction').mockImplementation(function(this: IDBDatabase, ...args: any[]) {
        if (args[1] === 'readwrite') writeTransactions++
        return originalTransaction.apply(this, args)
    })
    const { transferCache: copies } = await import('./transferCache')
    const batch = Array.from({ length: 100 }, (_, i) => ({
        key: `plugin:${String(i).padStart(3, '0')}`, etag: `hash-${i}`, revision: `revision-${i}`, data: new Uint8Array([i]),
    }))
    await copies.putBatch!(batch)
    expect(writeTransactions).toBe(4)
    expect(scans).toBe(4)
    expect(rowsRead).toBe(32 + 64 + 96 + 100)
    expect(await copies.versions('plugin:')).toHaveLength(100)
    expect((await copies.get('plugin:099'))?.data).toEqual(new Uint8Array([99]))
    expect((await copies.get('plugin:099'))?.revision).toBe('revision-99')
    db.close()
})

test('batch writes are also bounded by bytes, with a large value written alone', async () => {
    const db = await openCacheDb()
    const proto = Object.getPrototypeOf(db)
    const originalTransaction = proto.transaction
    let writes = 0
    vi.spyOn(proto, 'transaction').mockImplementation(function(this: IDBDatabase, ...args: any[]) {
        if (args[1] === 'readwrite') writes++
        return originalTransaction.apply(this, args)
    })
    const { transferCache: copies } = await import('./transferCache')
    await copies.putBatch!([
        { key: 'plugin:a', etag: 'a', data: new Uint8Array(700 * 1024) },
        { key: 'plugin:b', etag: 'b', data: new Uint8Array(700 * 1024) },
        { key: 'plugin:large', etag: 'large', data: new Uint8Array(2 * 1024 * 1024) },
        { key: 'plugin:c', etag: 'c', data: new Uint8Array(16) },
    ])
    expect(writes).toBe(4)
    expect((await copies.get('plugin:large'))?.data.byteLength).toBe(2 * 1024 * 1024)
    db.close()
})

test('a synchronous batch write failure commits neither partial bytes nor new validators', async () => {
    const { transferCache: copies } = await import('./transferCache')
    await copies.put('plugin:old', 'old', new Uint8Array([1]), 'r-old')
    const db = await openCacheDb()
    const proto = Object.getPrototypeOf(db.transaction('copies').objectStore('copies'))
    const originalPut = proto.put
    const put = vi.spyOn(proto, 'put').mockImplementation(function(this: IDBObjectStore, value: any, ...args: any[]) {
        if (this.name === 'versions' && value.key === 'plugin:b') throw new DOMException('quota', 'QuotaExceededError')
        return originalPut.apply(this, [value, ...args])
    })
    await expect(copies.putBatch!([
        { key: 'plugin:a', etag: 'a', revision: 'r-a', data: new Uint8Array([2]) },
        { key: 'plugin:b', etag: 'b', revision: 'r-b', data: new Uint8Array([3]) },
    ])).resolves.toBeUndefined()
    put.mockRestore()
    expect(await copies.get('plugin:a')).toBeNull()
    expect(await copies.get('plugin:b')).toBeNull()
    expect(await copies.revisions('plugin:')).toEqual([['old', 'r-old']])
    db.close()
})

test('batch cap eviction removes old copies only and preserves all new batch validators', async () => {
    const db = await openCacheDb()
    // Size metadata can represent a full cache without allocating 512 MiB in a test.
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['copies', 'versions'], 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error)
        tx.objectStore('copies').put({ key: 'plugin:old', etag: 'old', data: new Uint8Array([1]), usedAt: 0 })
        tx.objectStore('versions').put({ key: 'plugin:old', etag: 'old', bytes: 512 * 1024 * 1024, usedAt: 0 })
    })
    const { transferCache: copies } = await import('./transferCache')
    await copies.putBatch!([
        { key: 'plugin:a', etag: 'a', revision: 'r-a', data: new Uint8Array([2]) },
        { key: 'plugin:b', etag: 'b', revision: 'r-b', data: new Uint8Array([3]) },
    ])
    expect(await copies.get('plugin:old')).toBeNull()
    expect(await copies.revisions('plugin:')).toEqual([['a', 'r-a'], ['b', 'r-b']])
    db.close()
})
