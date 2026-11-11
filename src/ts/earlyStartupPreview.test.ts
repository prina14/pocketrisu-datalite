import { afterEach, expect, test, vi } from 'vitest'
import { fetchStartupPreview, validateStartupPreview, renderStartupPreview } from './earlyStartupPreview'
const data = { v: 1, ready: true, names: ['Alice', '<img src=x onerror=alert(1)>'], total: 2, revision: 'r1', language: 'ko' }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

test('only a bounded authenticated-ready index is accepted; partial/failed responses are optional', async () => {
    expect(validateStartupPreview(data)).toEqual(data)
    for (const invalid of [{ ...data, ready: false }, { ...data, names: Array(41).fill('a') }, { ...data, names: ['x'.repeat(129)] }, { ...data, total: 1 }, { ...data, revision: null }]) {
        expect(validateStartupPreview(invalid)).toBeNull()
    }
    expect(await fetchStartupPreview(async () => Response.json(data))).toEqual(data)
    expect(await fetchStartupPreview(async () => new Response('bad'))).toBeNull()
    expect(await fetchStartupPreview(async () => Response.json(data, { status: 401 }))).toBeNull()
    expect(await fetchStartupPreview(async () => { throw Error('offline') })).toBeNull()
})

test('a stalled fetch or response body cannot hold up bootstrap', async () => {
    vi.useFakeTimers()
    const pending = fetchStartupPreview(async () => new Promise(() => {}), 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toBeNull()
    const body = fetchStartupPreview(async () => ({ ok: true, text: () => new Promise(() => {}) } as any), 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(await body).toBeNull()
})

test('early names are escaped text in the public shell, with no requests or editing controls', () => {
    document.body.innerHTML = '<section id="preloading"><h1></h1><span id="startup-status"></span><div class="shell-content"><p>Preparing</p><div class="shell-grid" aria-hidden="true"></div></div></section>'
    renderStartupPreview(validateStartupPreview(data))
    expect(document.querySelector('.shell-grid')!.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img,button,input,a,iframe')).toBeNull()
    expect(document.querySelector('.shell-grid')!.hasAttribute('aria-hidden')).toBe(false)
    expect(document.querySelector('h1')!.textContent).toBe('캐릭터 2')
    document.body.replaceChildren()
    // An answer after app mount cannot recreate/overwrite the full application.
    renderStartupPreview(validateStartupPreview(data))
    expect(document.body.children.length).toBe(0)
})

test('a mounted consumer receives a late prefetched index without another authenticated request', async () => {
    vi.resetModules()
    const module = await import('./earlyStartupPreview')
    let respond!: (response: Response) => void
    const request = vi.fn(() => new Promise<Response>(resolve => { respond = resolve }))
    vi.stubGlobal('fetch', request)
    expect(await module.getPrefetchedStartupPreview()).toBeNull()
    const early = module.prefetchStartupPreview()
    const mounted = module.getPrefetchedStartupPreview()
    respond(Response.json(data))
    expect(await mounted).toEqual(data)
    expect(await early).toEqual(data)
    const fallback = vi.fn(async () => Response.json(data))
    expect(await module.getStartupPreviewAfterAuth(fallback)).toEqual(data)
    expect(fallback).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)
})
