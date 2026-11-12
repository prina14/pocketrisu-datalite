import { recordSyncDiagnostic } from '../storage/syncDiagnostics'

interface PluginInitialization {
    name: string; api: string; startedMs: number; durationMs: number | null; state: 'pending' | 'complete' | 'failed'
}
const initializations: PluginInitialization[] = []
export function beginPluginInitialization(name: string, api: string) {
    const entry: PluginInitialization = { name: name.slice(0, 100), api, startedMs: Math.round(performance.now()), durationMs: null, state: 'pending' }
    if (initializations.length >= 40) initializations.shift()
    initializations.push(entry)
    return (success: boolean) => {
        if (entry.state !== 'pending') return
        entry.durationMs = Math.round(performance.now() - entry.startedMs)
        entry.state = success ? 'complete' : 'failed'
    }
}
/** Names/methods/root fields only. A write request is not proof of a DB change. */
export function recordPluginWrite(name: string, method: string, roots: string[]) {
    recordSyncDiagnostic('plugin-write-request', { plugin: name.slice(0, 100), method, roots: roots.slice(0, 30) })
}
declare global { var __pocketrisuPluginDiagnostics: (() => PluginInitialization[]) | undefined }
if (typeof window !== 'undefined') globalThis.__pocketrisuPluginDiagnostics = () => initializations.map(entry => ({ ...entry }))
