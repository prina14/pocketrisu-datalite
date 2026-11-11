const sources = new Set<() => boolean>()
/** Providers read existing state only. Optional cache work must not register. */
export function registerUnsavedWork(source: () => boolean): () => void {
    sources.add(source)
    return () => { sources.delete(source) }
}
export function hasUnsavedWork(): boolean {
    for (const source of sources) {
        try { if (source()) return true } catch { return true }
    }
    return false
}
