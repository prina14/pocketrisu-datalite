// Optional, origin-local copies. Never serve one without authenticating and
// validating its version with the server first. IndexedDB also works on HTTP
// IP addresses, where CacheStorage/crypto.subtle may be unavailable.
export interface TransferCopy { key: string; etag: string; data: Uint8Array; usedAt: number }
export interface TransferCache {
    get(key: string): Promise<TransferCopy | null>
    put(key: string, etag: string, data: Uint8Array): Promise<void>
    versions(prefix: string): Promise<[string, string][]>
}

const STORE = 'copies'
const META = 'versions'
const MAX_BYTES = 512 * 1024 * 1024
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

export const transferCache: TransferCache = {
    async get(key) {
        try {
            const db = await open()
            const tx = db.transaction(STORE, 'readonly')
            return await new Promise<TransferCopy | null>((resolve, reject) => {
                const req = tx.objectStore(STORE).get(key)
                req.onsuccess = () => {
                    const row = req.result
                    resolve(row && typeof row.etag === 'string' && row.data instanceof Uint8Array ? row : null)
                }
                req.onerror = () => reject(req.error)
            })
        } catch { return null }
    },
    async versions(prefix) {
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
                    if (typeof row.etag === 'string') result.push([row.key.slice(prefix.length), row.etag])
                    cursor.continue()
                }
                req.onerror = () => reject(req.error)
            })
            return result
        } catch { return [] }
    },
    async put(key, etag, data) {
        if (data.byteLength > MAX_BYTES) return
        try {
            const db = await open()
            const tx = db.transaction([STORE, META], 'readwrite')
            const finished = complete(tx)
            const store = tx.objectStore(STORE)
            const meta = tx.objectStore(META)
            store.put({ key, etag, data, usedAt: Date.now() })
            meta.put({ key, etag, bytes: data.byteLength, usedAt: Date.now() })
            // Only metadata is scanned; never clone every large cached value.
            const rows: { key: string; bytes: number; usedAt: number }[] = []
            const req = meta.openCursor()
            req.onsuccess = () => {
                const cursor = req.result
                if (cursor) {
                    const row = cursor.value
                    rows.push(row)
                    cursor.continue()
                    return
                }
                let size = rows.reduce((sum, r) => sum + r.bytes, 0)
                for (const row of rows.sort((a, b) => a.usedAt - b.usedAt)) {
                    if (size <= MAX_BYTES) break
                    if (row.key === key) continue
                    store.delete(row.key)
                    meta.delete(row.key)
                    size -= row.bytes
                }
            }
            await finished
        } catch { /* quota/private mode: use the network normally */ }
    },
}
