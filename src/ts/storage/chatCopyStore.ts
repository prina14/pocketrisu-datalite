import type { Chat } from './database.svelte'

export interface ChatCopyStore {
    get(key: string): Promise<Chat | null>
    put(key: string, chat: Chat): Promise<void>
}

// Keep existing bodies; version 2 separates the small LRU timestamp from them.
const DB_NAME = 'pocketrisu-chat-copies'
const STORE = 'chats'
const META = 'recency'
const EVICTION_BATCH = 8
let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
    if (opening) return opening
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
        const request = indexedDB.open(DB_NAME, 2)
        let blocked = false
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('usedAt', 'usedAt')
            }
            const meta = db.createObjectStore(META, { keyPath: 'key' })
            meta.createIndex('usedAt', 'usedAt')
            // Upgrade old caches without deserializing any conversation body.
            const cursor = request.transaction!.objectStore(STORE).index('usedAt').openKeyCursor()
            cursor.onsuccess = () => {
                const row = cursor.result
                if (!row) return
                meta.put({ key: row.primaryKey, usedAt: row.key })
                row.continue()
            }
        }
        request.onsuccess = () => {
            const db = request.result
            if (blocked) { db.close(); return }
            db.onversionchange = () => { db.close(); opening = null }
            resolve(db)
        }
        request.onerror = () => reject(request.error)
        request.onblocked = () => { blocked = true; reject(new Error('Chat cache upgrade blocked')) }
    })
    opening = pending
    void pending.catch(() => { if (opening === pending) opening = null })
    return pending
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = event => reject(tx.error ?? (event.target as IDBRequest)?.error ?? new Error('Chat cache transaction failed'))
        tx.onabort = () => reject(tx.error ?? new Error('Chat cache transaction aborted'))
    })
}

async function write(db: IDBDatabase, key: string, chat: Chat) {
    const tx = db.transaction([STORE, META], 'readwrite')
    const completed = done(tx)
    try {
        const usedAt = Date.now()
        tx.objectStore(STORE).put({ key, chat, usedAt })
        tx.objectStore(META).put({ key, usedAt })
    } catch (error) {
        tx.abort()
        await completed.catch(() => {})
        throw error
    }
    await completed
}

async function evictOldest(db: IDBDatabase, protectedKey: string): Promise<number> {
    const tx = db.transaction([STORE, META], 'readwrite')
    const completed = done(tx)
    const store = tx.objectStore(STORE)
    let removed = 0
    // Read keys/timestamps only: eviction must not deserialize every large chat.
    const meta = tx.objectStore(META)
    const request = meta.index('usedAt').openKeyCursor()
    request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || removed >= EVICTION_BATCH) return
        if (cursor.primaryKey !== protectedKey) {
            store.delete(cursor.primaryKey)
            meta.delete(cursor.primaryKey)
            removed++
        }
        cursor.continue()
    }
    await completed
    return removed
}

export const indexedDbChatCopies: ChatCopyStore = {
    async get(key) {
        const db = await open()
        const tx = db.transaction(STORE, 'readonly')
        // Subscribe before awaiting the request: a transaction may finish before
        // a later listener is installed, leaving the cache read pending forever.
        const completed = done(tx)
        const record = new Promise<any>((resolve, reject) => {
            const store = tx.objectStore(STORE)
            const request = store.get(key)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve(request.result)
        })
        const [value] = await Promise.all([record, completed])
        if (value) {
            // A failed recency update must never turn a usable large copy
            // into a cache miss (and another full network download).
            try {
                const touch = db.transaction(META, 'readwrite')
                const completed = done(touch)
                try { touch.objectStore(META).put({ key, usedAt: Date.now() }) }
                catch (error) {
                    touch.abort()
                    await completed.catch(() => {})
                    throw error
                }
                await completed
            } catch { /* cache body is still valid */ }
        }
        return value?.chat ?? null
    },
    async put(key, chat) {
        const db = await open()
        // Every opened/saved chat is eligible. Reclaim old copies only when the
        // browser actually reports quota pressure; server data is never deleted.
        for (;;) {
            try { await write(db, key, chat); return }
            catch (error) {
                if ((error as DOMException)?.name !== 'QuotaExceededError') throw error
                if (!(await evictOldest(db, key))) throw error
            }
        }
    },
}
