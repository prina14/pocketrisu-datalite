// @vitest-environment node
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'

beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
})
afterEach(() => vi.unstubAllGlobals())

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
