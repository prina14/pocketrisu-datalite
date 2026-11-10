// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const name = 'pocketrisu-chat-copies'
const chat = (messageCount = 1, note = '') => ({
    id: 'chat', name: 'Chat', message: Array.from({ length: messageCount }, () => ({ role: 'user', data: 'hello' })),
    note, localLore: [],
}) as any

beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', new IDBFactory())
    let tick = 0
    vi.spyOn(Date, 'now').mockImplementation(() => ++tick)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function connect(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onupgradeneeded = () => request.result.createObjectStore('chats', { keyPath: 'key' }).createIndex('usedAt', 'usedAt')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}
function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
}

test('retains more than 24 small and empty chats across a module reload', async () => {
    const { indexedDbChatCopies: first } = await import('./chatCopyStore')
    for (let i = 0; i < 40; i++) await first.put(`chat-${i}`, chat(i % 2))
    vi.resetModules()
    const { indexedDbChatCopies: reloaded } = await import('./chatCopyStore')
    for (let i = 0; i < 40; i++) expect(await reloaded.get(`chat-${i}`)).toEqual(chat(i % 2))
    expect(await reloaded.get('missing')).toBeNull()
})

test('reads records written by the existing version-1 schema', async () => {
    const db = await connect()
    const tx = db.transaction('chats', 'readwrite')
    const completed = done(tx)
    tx.objectStore('chats').put({ key: 'legacy', chat: chat(2, 'old copy'), usedAt: 0 })
    await completed
    db.close()
    const { indexedDbChatCopies: copies } = await import('./chatCopyStore')
    expect(await copies.get('legacy')).toEqual(chat(2, 'old copy'))
})

test('reading a 20,000-message chat writes only small recency metadata, even when that write fails', async () => {
    const { indexedDbChatCopies: copies } = await import('./chatCopyStore')
    const large = chat(20_000)
    for (const message of large.message) message.data = 'x'.repeat(250)
    await copies.put('large', large)
    const db = await connect()
    const proto = Object.getPrototypeOf(db.transaction('chats').objectStore('chats'))
    const original = proto.put
    let bodyWrites = 0, metadataWrites = 0
    const spy = vi.spyOn(proto, 'put').mockImplementation(function(this: IDBObjectStore, value: any, ...args: any[]) {
        if (this.name === 'chats') bodyWrites++
        else { metadataWrites++; expect(value.chat).toBeUndefined() }
        return original.apply(this, [value, ...args])
    })
    expect(await copies.get('large')).toEqual(large)
    expect(bodyWrites).toBe(0)
    expect(metadataWrites).toBe(1)
    spy.mockImplementation(function(this: IDBObjectStore) {
        if (this.name === 'chats') throw new Error('must not rewrite the body')
        throw new DOMException('metadata quota', 'QuotaExceededError')
    })
    expect(await copies.get('large')).toEqual(large)
    spy.mockRestore()
    db.close()
})

test('an aborted recency write at commit still returns the valid cached body', async () => {
    const { indexedDbChatCopies: copies } = await import('./chatCopyStore')
    await copies.put('keep', chat(2))
    const db = await connect()
    const raw = (db.transaction('recency').objectStore('recency') as any)._rawObjectStore
    vi.spyOn(raw, 'storeRecord').mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError') })
    expect(await copies.get('keep')).toEqual(chat(2))
    db.close()
})

test('body and recency update roll back together if metadata cannot be stored', async () => {
    const { indexedDbChatCopies: copies } = await import('./chatCopyStore')
    await copies.put('keep', chat(2, 'previous'))
    const db = await connect()
    const proto = Object.getPrototypeOf(db.transaction('chats').objectStore('chats'))
    const original = proto.put
    const spy = vi.spyOn(proto, 'put').mockImplementation(function(this: IDBObjectStore, value: any, ...args: any[]) {
        if (this.name === 'recency') throw new DOMException('quota', 'QuotaExceededError')
        return original.apply(this, [value, ...args])
    })
    await expect(copies.put('keep', chat(3, 'new'))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    spy.mockRestore()
    expect(await copies.get('keep')).toEqual(chat(2, 'previous'))
    db.close()
})

test('quota retries evict least-recently-used keys in batches, preserve the updated key, and avoid reading chat bodies', async () => {
    const { indexedDbChatCopies: copies } = await import('./chatCopyStore')
    for (let i = 0; i < 26; i++) await copies.put(`old-${String(i).padStart(2, '0')}`, chat())
    await copies.get('old-01') // recently used, so it must survive the eviction
    const db = await connect()
    const store = db.transaction('chats').objectStore('chats')
    const proto = Object.getPrototypeOf(store)
    const indexProto = Object.getPrototypeOf(store.index('usedAt'))
    const originalPut = proto.put
    const originalDelete = proto.delete
    const deleted: IDBValidKey[] = []
    const put = vi.spyOn(proto, 'put').mockImplementation(function (value: any, ...args: any[]) {
        if (value.key === 'old-00' && deleted.length < 16) throw new DOMException('quota', 'QuotaExceededError')
        return originalPut.apply(this, [value, ...args])
    })
    vi.spyOn(proto, 'delete').mockImplementation(function (key: IDBValidKey) {
        if (this.name === "chats") deleted.push(key)
        return originalDelete.call(this, key)
    })
    const cursor = vi.spyOn(indexProto, 'openKeyCursor')
    vi.spyOn(indexProto, 'openCursor').mockImplementation(() => { throw new Error('eviction must read keys only') })
    await copies.put('old-00', chat(2, 'new content'))
    expect(deleted).toEqual(Array.from({ length: 16 }, (_, i) => `old-${String(i + 2).padStart(2, '0')}`))
    expect(cursor).toHaveBeenCalledTimes(2)
    put.mockRestore()
    expect(await copies.get('old-00')).toEqual(chat(2, 'new content'))
    expect(await copies.get('old-01')).toEqual(chat())
    expect(await copies.get('old-02')).toBeNull()
    db.close()
})

test('an oversized update that cannot fit keeps its previous copy and fails without an infinite retry', async () => {
    const { indexedDbChatCopies: copies } = await import('./chatCopyStore')
    await copies.put('keep', chat(1, 'previous'))
    const db = await connect()
    const proto = Object.getPrototypeOf(db.transaction('chats').objectStore('chats'))
    const put = vi.spyOn(proto, 'put').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    await expect(copies.put('keep', chat(2, 'cannot fit'))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(put).toHaveBeenCalledTimes(1)
    put.mockRestore()
    expect(await copies.get('keep')).toEqual(chat(1, 'previous'))
    db.close()
})

test('non-quota failures do not evict other cached chats', async () => {
    const { indexedDbChatCopies: copies } = await import('./chatCopyStore')
    await copies.put('keep', chat())
    const db = await connect()
    const proto = Object.getPrototypeOf(db.transaction('chats').objectStore('chats'))
    const put = vi.spyOn(proto, 'put').mockImplementation(() => { throw new DOMException('unsupported value', 'DataCloneError') })
    await expect(copies.put('bad', chat())).rejects.toMatchObject({ name: 'DataCloneError' })
    put.mockRestore()
    expect(await copies.get('keep')).toEqual(chat())
    db.close()
})

test('an unavailable IndexedDB may become usable on a later call', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const { indexedDbChatCopies: copies } = await import('./chatCopyStore')
    await expect(copies.get('chat')).rejects.toThrow('IndexedDB unavailable')
    vi.stubGlobal('indexedDB', new IDBFactory())
    await copies.put('chat', chat())
    expect(await copies.get('chat')).toEqual(chat())
})

test('asynchronous quota failure aborts the write, evicts old copies, and retries', async () => {
    const { indexedDbChatCopies: copies } = await import('./chatCopyStore')
    await copies.put('old', chat())
    const db = await connect()
    // fake-indexeddb executes this storage operation asynchronously, after put
    // returned its request, matching browser quota errors during commit.
    const raw = (db.transaction('chats').objectStore('chats') as any)._rawObjectStore
    vi.spyOn(raw, 'storeRecord').mockImplementationOnce(() => { throw new DOMException('quota at commit', 'QuotaExceededError') })
    await copies.put('new', chat(2))
    expect(await copies.get('old')).toBeNull()
    expect(await copies.get('new')).toEqual(chat(2))
    db.close()
})

test('blocked opening rejects promptly, closes a late connection, and can retry', async () => {
    const request: any = {}
    vi.stubGlobal('indexedDB', { open: () => request })
    const { indexedDbChatCopies: copies } = await import('./chatCopyStore')
    const blocked = copies.get('chat')
    request.onblocked()
    await expect(blocked).rejects.toThrow('Chat cache upgrade blocked')
    const close = vi.fn()
    request.result = { close }
    request.onsuccess()
    expect(close).toHaveBeenCalledOnce()
    vi.stubGlobal('indexedDB', new IDBFactory())
    await copies.put('chat', chat())
    expect(await copies.get('chat')).toEqual(chat())
})
