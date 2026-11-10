// Optional, origin-local copies. Never serve one without authenticating and
// validating its version with the server first. IndexedDB also works on HTTP
// IP addresses, where CacheStorage/crypto.subtle may be unavailable.
export interface TransferCopy { key: string; etag: string; data: Uint8Array; usedAt: number; revision?: string }
export type TransferCopyInput = Omit<TransferCopy, 'usedAt'>
export interface TransferCache {
    get(key: string): Promise<TransferCopy | null>
    put(key: string, etag: string, data: Uint8Array, revision?: string): Promise<void>
    putBatch?(copies: TransferCopyInput[]): Promise<void>
    updateRevision(key: string, etag: string, revision: string): Promise<void>
    versions(prefix: string, revisionsOnly?: boolean): Promise<[string, string][]>
    revisions(prefix: string): Promise<[string, string][]>
}

const STORE = 'copies'
const META = 'versions'
const MAX_BYTES = 512 * 1024 * 1024
const BATCH_MAX_ENTRIES = 32
const BATCH_MAX_BYTES = 1024 * 1024
let opening: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
    if (!opening) {
        opening = new Promise((resolve, reject) => {
            const request = indexedDB.open('pocketrisu-transfer-cache-v1', 1)
            request.onupgradeneeded = () => {
                request.result.createObjectStore(STORE, { keyPath: 'key' })
                request.result.createObjectStore(META, { keyPath: 'key' })
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
            request.onblocked = () => reject(new Error('Transfer cache blocked'))
        })
        opening.catch(() => { opening = undefined })
    }
    return opening
}
function complete(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = tx.onabort = () => reject(tx.error)
    })
}

async function writeBatch(copies: TransferCopyInput[]): Promise<void> {
    if (!copies.length) return
    const db = await open()
    const tx = db.transaction([STORE, META], 'readwrite')
    const finished = complete(tx)
    try {
        const store = tx.objectStore(STORE)
        const meta = tx.objectStore(META)
        const protectedKeys = new Set(copies.map(copy => copy.key))
        for (const copy of copies) {
            const usedAt = Date.now()
            store.put({ ...copy, usedAt })
            meta.put({ key: copy.key, etag: copy.etag, revision: copy.revision, bytes: copy.data.byteLength, usedAt })
        }
        // One size-only scan per bounded batch, not per plugin key. Values are
        // never read for eviction, and no sorting is needed below the cap.
        const rows: { key: string; bytes: number; usedAt: number }[] = []
        const req = meta.openCursor()
        let size = 0
        req.onsuccess = () => {
            const cursor = req.result
            if (cursor) {
                const row = cursor.value
                rows.push(row)
                size += row.bytes
                cursor.continue()
                return
            }
            if (size <= MAX_BYTES) return
            for (const row of rows.sort((a, b) => a.usedAt - b.usedAt)) {
                if (size <= MAX_BYTES) break
                if (protectedKeys.has(row.key)) continue
                store.delete(row.key)
                meta.delete(row.key)
                size -= row.bytes
            }
        }
        await finished
    } catch (error) {
        // A synchronous clone/quota error must not commit a partial batch or
        // leave the transaction completion promise rejected without a handler.
        try { tx.abort() } catch { /* already completed/aborted */ }
        await finished.catch(() => {})
        throw error
    }
}

async function putCopies(copies: TransferCopyInput[]): Promise<void> {
    let batch: TransferCopyInput[] = []
    let bytes = 0
    const flush = async () => {
        const pending = batch
        batch = []
        bytes = 0
        try { await writeBatch(pending) } catch { /* optional cache */ }
    }
    for (const copy of copies) {
        if (copy.data.byteLength > MAX_BYTES) continue
        if (batch.length && (batch.length >= BATCH_MAX_ENTRIES || bytes + copy.data.byteLength > BATCH_MAX_BYTES)) await flush()
        batch.push(copy)
        bytes += copy.data.byteLength
        // A single large value is written alone rather than queued beside
        // other values. The existing per-value 512 MiB ceiling still applies.
        if (batch.length >= BATCH_MAX_ENTRIES || bytes >= BATCH_MAX_BYTES) await flush()
    }
    if (batch.length) await flush()
}

export const transferCache: TransferCache = {
    async get(key) {
        try {
            const db = await open()
            const tx = db.transaction([STORE, META], 'readonly')
            const meta = tx.objectStore(META).get(key)
            return await new Promise<TransferCopy | null>((resolve, reject) => {
                const req = tx.objectStore(STORE).get(key)
                req.onsuccess = () => {
                    const row = req.result
                    if (!row || typeof row.etag !== 'string' || !(row.data instanceof Uint8Array)) { resolve(null); return }
                    // Requests in one transaction finish in creation order.
                    resolve({ ...row, revision: meta.result?.etag === row.etag ? meta.result.revision : undefined })
                }
                req.onerror = () => reject(req.error)
            })
        } catch { return null }
    },
    async revisions(prefix) { return this.versions(prefix, true) },
    async versions(prefix, revisionsOnly = false) {
        try {
            const db = await open()
            const tx = db.transaction(META, 'readonly')
            const result: [string, string][] = []
            await new Promise<void>((resolve, reject) => {
                const req = tx.objectStore(META).openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'))
                req.onsuccess = () => {
                    const cursor = req.result
                    if (!cursor) { resolve(); return }
                    const row = cursor.value
                    const version = revisionsOnly ? row.revision : row.etag
                    if (typeof version === 'string') result.push([row.key.slice(prefix.length), version])
                    cursor.continue()
                }
                req.onerror = () => reject(req.error)
            })
            return result
        } catch { return [] }
    },
    async updateRevision(key, etag, revision) {
        try {
            const db = await open()
            const tx = db.transaction(META, 'readwrite')
            const finished = complete(tx)
            const store = tx.objectStore(META)
            const req = store.get(key)
            req.onsuccess = () => {
                if (req.result?.etag === etag) store.put({ ...req.result, revision })
            }
            await finished
        } catch { /* optional cache */ }
    },
    async put(key, etag, data, revision) {
        await putCopies([{ key, etag, data, revision }])
    },
    async putBatch(copies) { await putCopies(copies) },
}
