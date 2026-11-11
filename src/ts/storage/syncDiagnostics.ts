export interface SyncDiagnostic {
    type: string
    atMs: number
    [key: string]: string | number | boolean | string[] | null
}
const events: SyncDiagnostic[] = []
/** Bounded metadata only: never record request bodies, keys, messages or IDs. */
export function recordSyncDiagnostic(type: string, details: Omit<SyncDiagnostic, 'type' | 'atMs'> = {}) {
    if (events.length >= 40) events.shift()
    events.push({ ...details, type, atMs: Math.round(performance.now()) })
}
export function getSyncDiagnostics(): SyncDiagnostic[] {
    return events.map(event => Object.fromEntries(Object.entries(event).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])) as SyncDiagnostic)
}
declare global { var __pocketrisuSyncDiagnostics: (() => SyncDiagnostic[]) | undefined }
if (typeof window !== 'undefined') globalThis.__pocketrisuSyncDiagnostics = getSyncDiagnostics
