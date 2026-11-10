// Small startup helpers: no network logging and no persisted diagnostics.
// Native performance entries can be inspected on the affected device later.
export function beginStartupPhase(name: string): () => void {
    let start: number
    try { start = performance.now() } catch { return () => {} }
    let finished = false
    return () => {
        if (finished) return
        finished = true
        try { performance.measure(`pocketrisu:startup:${name}`, { start, end: performance.now() }) }
        catch { /* Diagnostic support must never block startup. */ }
    }
}

export async function measureStartupPhase<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
    const finish = beginStartupPhase(name)
    try { return await operation() } finally { finish() }
}

export async function readBootBackupReminderEnabled(
    getAuth: () => Promise<string>,
    request: (input: string, init: RequestInit) => Promise<Response>,
): Promise<boolean> {
    try {
        const auth = await getAuth()
        const response = await request('/api/backup/boot-reminder', { headers: { 'risu-auth': auth } })
        return response.ok ? !!(await response.json()).enabled : false
    } catch { return false }
}

export function scheduleAfterFirstPaint(tasks: Array<() => unknown | Promise<unknown>>): void {
    const run = () => {
        for (const task of tasks) {
            try { void Promise.resolve(task()).catch(() => {}) } catch { /* optional startup task */ }
        }
    }
    // The timer runs after the animation frame's rendering opportunity, keeping
    // optional storage/update/stat requests off the first-screen critical path.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(run, 0))
    else setTimeout(run, 0)
}
