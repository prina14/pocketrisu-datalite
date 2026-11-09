export interface CacheUsageSnapshot {
    usageBytes: number | null
    quotaBytes: number | null
    source: 'browser' | 'cache' | 'unavailable'
}

const unavailable: CacheUsageSnapshot = { usageBytes: null, quotaBytes: null, source: 'unavailable' }
// HTTP fallback may read large legacy chats. Reuse a completed estimate for
// this page's lifetime; only an explicit refresh should scan those bodies again.
let lastFallback: CacheUsageSnapshot | null = null
let fallbackGeneration = 0

function abortReason(signal?: AbortSignal): unknown {
    return signal?.reason ?? new DOMException('Cache usage measurement cancelled', 'AbortError')
}

function checkAbort(signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal)
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    return new Promise((resolve, reject) => {
        const cancel = () => { signal.removeEventListener('abort', cancel); reject(abortReason(signal)) }
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
        // The browser estimate itself cannot be stopped, but its late result
        // must not keep a departed card pending or produce an unhandled error.
        promise.then(value => {
            signal.removeEventListener('abort', cancel)
            if (!signal.aborted) resolve(value)
        }, error => {
            signal.removeEventListener('abort', cancel)
            if (!signal.aborted) reject(error)
        })
    })
}

function validBytes(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

// Opening a missing database normally creates it. Abort that upgrade instead:
// viewing usage must never initialize, migrate, or modify a cache database.
function openExisting(name: string, signal?: AbortSignal): Promise<IDBDatabase | null> {
    checkAbort(signal)
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name)
        let missing = false
        let settled = false
        const finish = (db: IDBDatabase | null, error?: unknown) => {
            if (settled) { db?.close(); return }
            settled = true
            signal?.removeEventListener('abort', cancel)
            if (error !== undefined) reject(error)
            else resolve(db)
        }
        const cancel = () => {
            try { request.transaction?.abort() } catch { /* already finished */ }
            finish(null, abortReason(signal))
        }
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) cancel()
        request.onupgradeneeded = () => { missing = true; request.transaction?.abort() }
        request.onerror = () => missing ? finish(null) : finish(null, request.error)
        request.onblocked = () => finish(null, new Error('Cache usage database blocked'))
        request.onsuccess = () => finish(request.result)
    })
}

async function sumStore(name: string, storeName: string, size: (row: any) => number, signal?: AbortSignal): Promise<number> {
    const db = await openExisting(name, signal)
    if (!db) return 0
    try {
        checkAbort(signal)
        if (!db.objectStoreNames.contains(storeName)) throw new Error('Cache usage store unavailable')
        return await new Promise<number>((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly')
            let total = 0
            let failure: unknown
            let settled = false
            const finish = (error?: unknown) => {
                if (settled) return
                settled = true
                signal?.removeEventListener('abort', cancel)
                if (error !== undefined) reject(error)
                else resolve(total)
            }
            const cancel = () => {
                failure = abortReason(signal)
                try { tx.abort() } catch { /* already finished */ }
                finish(failure)
            }
            signal?.addEventListener('abort', cancel, { once: true })
            if (signal?.aborted) { cancel(); return }
            tx.oncomplete = () => signal?.aborted ? finish(abortReason(signal)) : finish()
            tx.onerror = () => finish(failure ?? tx.error ?? new Error('Cache usage read failed'))
            tx.onabort = () => finish(failure ?? tx.error ?? new Error('Cache usage read aborted'))
            const cursor = tx.objectStore(storeName).openCursor()
            cursor.onsuccess = () => {
                if (settled) return
                const entry = cursor.result
                if (!entry) return
                try {
                    checkAbort(signal)
                    const bytes = size(entry.value)
                    checkAbort(signal)
                    if (!validBytes(bytes)) throw new Error('Invalid cache usage size')
                    total += bytes
                    entry.continue()
                } catch (error) {
                    failure = error
                    try { tx.abort() } catch { /* cancellation may have aborted it */ }
                    finish(error)
                }
            }
        })
    } finally { db.close() }
}

async function measureCopies(signal?: AbortSignal): Promise<CacheUsageSnapshot> {
    checkAbort(signal)
    if (typeof indexedDB === 'undefined') return unavailable
    try {
        // Transfer cache has size-only metadata, so its large bodies stay on disk.
        const transfer = await sumStore('pocketrisu-transfer-cache-v1', 'versions', row => row.bytes, signal)
        // Legacy chat copies have no size metadata. Count one record at a time,
        // only in this fallback; never load all cached chats into one collection.
        const chats = await sumStore('pocketrisu-chat-copies', 'chats', row => {
            const json = JSON.stringify(row.chat)
            if (json === undefined) throw new Error('Chat cache size unavailable')
            return new TextEncoder().encode(json).byteLength
        }, signal)
        checkAbort(signal)
        return { usageBytes: transfer + chats, quotaBytes: null, source: 'cache' }
    } catch {
        checkAbort(signal)
        return unavailable
    }
}

export async function readCacheUsage({ force = false, signal }: { force?: boolean, signal?: AbortSignal } = {}): Promise<CacheUsageSnapshot> {
    checkAbort(signal)
    try {
        // This quota is shared by this site's browser storage. It is neither
        // physical free disk space nor the transfer cache's separate 512 MiB cap.
        if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
            const estimate = await abortable(navigator.storage.estimate(), signal)
            checkAbort(signal)
            if (validBytes(estimate.usage)) return {
                usageBytes: estimate.usage,
                quotaBytes: validBytes(estimate.quota) && estimate.quota > 0 ? estimate.quota : null,
                source: 'browser',
            }
        }
    } catch { checkAbort(signal) /* HTTP origins / browser policy: count known copies instead. */ }
    if (!force && lastFallback) return lastFallback
    // A new caller never joins an old component's cancelled work. A generation
    // guard also keeps a slower old scan from replacing a newer manual estimate.
    const generation = ++fallbackGeneration
    const value = await measureCopies(signal)
    checkAbort(signal)
    if (value.source === 'cache' && generation === fallbackGeneration) lastFallback = value
    return value
}

export function formatCacheBytes(bytes: number): string {
    if (!validBytes(bytes)) return '—'
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    const index = bytes === 0 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
    const value = bytes / 1024 ** Math.max(0, index)
    return `${value.toLocaleString(undefined, { maximumFractionDigits: index > 0 ? 1 : 0 })} ${units[Math.max(0, index)]}`
}
