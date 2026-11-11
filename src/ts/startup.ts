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

export function createStartupPreview(characters: Array<{ name?: string; trashTime?: number }>) {
    const names: string[] = []
    let total = 0
    for (const character of characters) {
        if (!character || character.trashTime) continue
        total++
        if (names.length < 40) names.push(typeof character.name === 'string' ? character.name : '')
    }
    return { names, total }
}

/** Yield a frame for the read-only preview; hidden/throttled pages must not
 * be held by requestAnimationFrame indefinitely. No user data changes here.
 */
export function waitForStartupPreviewFrame(): Promise<void> {
    if (typeof requestAnimationFrame !== 'function' ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return Promise.resolve()
    return new Promise(resolve => {
        let done = false
        const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve() } }
        const timer = setTimeout(finish, 100)
        try { requestAnimationFrame(() => { if (!done) requestAnimationFrame(finish) }) }
        catch { finish() }
    })
}

/** Rendering opportunity for the main UI, not proof of physical display or
 * an all-network-idle event. Include navigation/JS startup in this metric.
 */
export function recordStartupUiFrame(name = 'navigation-to-ui-frame'): void {
    try {
        performance.measure(`pocketrisu:startup:${name}`, { start: 0, end: performance.now() })
    } catch { /* Optional diagnostics. */ }
}

/** Start an optional read only after the database read/initial write has finished.
 * The plugin index depends on server-side legacy storage migration at that boundary.
 * loadPlugins still awaits the store's shared init promise (or retries a failure).
 */
export async function readDatabaseWithIndexPrefetch<T>(
    readDatabase: () => Promise<T>, initializeIndex: () => Promise<unknown>,
): Promise<T> {
    const data = await readDatabase()
    try { void initializeIndex().catch(() => {}) } catch { /* optional prefetch */ }
    return data
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
