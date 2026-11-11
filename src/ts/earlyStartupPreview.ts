import { updateStartupLayout } from './startupLayout';
// Shared by the tiny entry and the application. No Svelte, DB, plugin or CSS
// imports here: this module must not pull the application into the first paint.
export type EarlyStartupPreview = {
    v: 1; ready: true; names: string[]; total: number; revision: string; language?: string;
}
let early: EarlyStartupPreview | null = null
let earlyRequest: Promise<EarlyStartupPreview | null> | null = null
let listFrameScheduled = false

export function validateStartupPreview(value: unknown): EarlyStartupPreview | null {
    const data = value as EarlyStartupPreview
    if (!data || data.v !== 1 || data.ready !== true || !Array.isArray(data.names) || data.names.length > 40 ||
        !data.names.every(name => typeof name === 'string' && name.length <= 128) ||
        !Number.isSafeInteger(data.total) || data.total < data.names.length || data.total > 10_000_000 ||
        typeof data.revision !== 'string' || data.revision.length > 512) return null
    return { v: 1, ready: true, names: data.names.slice(), total: data.total, revision: data.revision,
        language: typeof data.language === 'string' ? data.language.slice(0, 16) : undefined }
}

export async function fetchStartupPreview(request: (url: string, init: RequestInit) => Promise<Response>, timeoutMs = 2000): Promise<EarlyStartupPreview | null> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<null>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null) }, timeoutMs)
    })
    try {
        return await Promise.race([deadline, (async () => {
            const response = await request('/api/startup-preview', { cache: 'no-store', signal: controller.signal })
            if (!response.ok) return null
            const text = await response.text()
            if (text.length > 32 * 1024) return null
            return validateStartupPreview(JSON.parse(text))
        })()])
    } catch { return null }
    finally { clearTimeout(timer!) }
}

export function peekStartupPreview(): EarlyStartupPreview | null { return early }

// Observe the lightweight entry's request without starting another request.
// Used by the mounted app while its authentication preflight is still waiting.
export function getPrefetchedStartupPreview(): Promise<EarlyStartupPreview | null> {
    return earlyRequest ?? Promise.resolve(early)
}

export async function getStartupPreviewAfterAuth(request: (url: string, init: RequestInit) => Promise<Response>): Promise<EarlyStartupPreview | null> {
    const prefetched = await getPrefetchedStartupPreview()
    return prefetched ?? fetchStartupPreview(request)
}

export function recordStartupListFrame(): void {
    if (listFrameScheduled) return
    listFrameScheduled = true
    const record = () => {
        try { performance.measure('pocketrisu:startup:navigation-to-list-frame', { start: 0, end: performance.now() }) } catch { /* optional */ }
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(record, 0))
    else setTimeout(record, 0)
}

export function renderStartupPreview(preview: EarlyStartupPreview | null): void {
    const shell = document.getElementById('preloading')
    if (!preview || !shell) return
    updateStartupLayout(shell, { names: preview.names, total: preview.total, language: preview.language,
        status: preview.language === 'ko' ? '준비 중…' : 'Preparing…' })
    shell.setAttribute('data-startup-list', 'true')
    recordStartupListFrame()
}

export function prefetchStartupPreview(): Promise<EarlyStartupPreview | null> {
    earlyRequest ??= fetchStartupPreview((url, init) => fetch(url, init)).then(value => { early = value; return value })
    return earlyRequest
}
