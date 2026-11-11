import { get, writable } from 'svelte/store'

const KEY = 'pocketrisu-character-activity-v1'
const MAX = 10000
export const characterActivity = writable<Record<string, number>>({})
const pending = new Map<string, number>()
let loaded = false, initialized = false, auth: (() => Promise<string>) | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let syncing: Promise<void> | null = null
let etag: string | undefined
let openSequence = 0
const valid = (id: unknown): id is string => typeof id === 'string' && !!id && id.length <= 128 && !id.startsWith('§') && !id.includes('\0')
function persist() {
    const values = Object.fromEntries(Object.entries(get(characterActivity)).sort((a, b) => b[1] - a[1]).slice(0, MAX))
    for (const id of pending.keys()) if (!(id in values)) pending.delete(id)
    characterActivity.set(values)
    try { localStorage.setItem(KEY, JSON.stringify({ values, pending: [...pending] })) } catch { /* optional copy */ }
}
function loadLocal() {
    if (loaded) return
    loaded = true
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
        const values: Record<string, number> = {}
        for (const [id, at] of Object.entries(saved.values ?? {}).slice(0, MAX)) {
            if (valid(id) && Number.isSafeInteger(at) && Number(at) > 0) values[id] = Number(at)
        }
        for (const row of Array.isArray(saved.pending) ? saved.pending.slice(0, MAX) : []) {
            if (Array.isArray(row) && valid(row[0]) && Number.isSafeInteger(row[1]) && row[1] > 0) pending.set(row[0], row[1])
        }
        characterActivity.set(values)
    } catch { /* optional copy */ }
}
export function recordCharacterOpen(id: string) {
    if (!valid(id)) return
    loadLocal()
    openSequence++
    const at = Date.now()
    pending.delete(id); pending.set(id, at)
    characterActivity.update(values => ({ ...values, [id]: at }))
    persist()
    clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void syncCharacterActivity() }, 250)
}

export function syncCharacterActivity(): Promise<void> {
    if (!auth) return Promise.resolve()
    if (syncing) return syncing
    const sequence = openSequence
    let acknowledged = false
    syncing = (async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        try {
            const token = await auth!()
            const headers = { 'risu-auth': token }
            const batch = [...pending].slice(0, 50)
            if (batch.length) {
                const response = await fetch('/api/character-activity', { method: 'POST', cache: 'no-store', signal: controller.signal,
                    headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ids: batch.map(([id]) => id) }) })
                if (!response.ok) return
                const data = await response.json()
                const values = { ...get(characterActivity) }
                for (const [id, at] of batch) {
                    if (pending.get(id) !== at) continue
                    const entry = data.entries?.find(entry => entry.chaId === id && Number.isSafeInteger(entry.lastInteraction) && entry.lastInteraction > 0)
                    if (!entry) continue
                    values[id] = entry.lastInteraction
                    pending.delete(id)
                    acknowledged = true
                }
                characterActivity.set(values); persist()
            }
            const response = await fetch('/api/character-activity', { cache: 'no-store', signal: controller.signal,
                headers: { ...headers, ...(etag ? { 'if-none-match': etag } : {}) } })
            if (response.status === 304 || !response.ok) return
            const data = await response.json()
            if (!Array.isArray(data.entries) || data.entries.length > MAX) return
            const values = { ...get(characterActivity) }
            for (const entry of data.entries) {
                if (valid(entry.chaId) && Number.isSafeInteger(entry.lastInteraction) && entry.lastInteraction > 0 && !pending.has(entry.chaId)) values[entry.chaId] = entry.lastInteraction
            }
            characterActivity.set(values); etag = response.headers.get('etag') ?? undefined; persist()
        } catch { /* viewing metadata must never interrupt chats or boot */ }
        finally { clearTimeout(timeout) }
    })().finally(() => {
        syncing = null
        // An open recorded while an older batch was in flight must not be
        // stranded when its debounce timer encountered that shared request.
        if (pending.size && !timer && (acknowledged || openSequence !== sequence)) timer = setTimeout(() => { timer = undefined; void syncCharacterActivity() }, 250)
    })
    return syncing
}

export function initCharacterActivity(authProvider?: () => Promise<string>) {
    loadLocal()
    if (!authProvider) return
    auth = authProvider
    if (!initialized) {
        initialized = true
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncCharacterActivity() })
        window.addEventListener('online', () => { void syncCharacterActivity() })
    }
    void syncCharacterActivity()
}
