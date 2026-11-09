// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

const { read } = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('src/ts/storage/cacheUsage', () => ({
    readCacheUsage: read,
    formatCacheBytes: (bytes: number) => `${bytes} B`,
}))
vi.mock('src/lang', () => ({ language: new Proxy({}, { get: (_target, key) => String(key) }) }))
import CacheUsageCard from './CacheUsageCard.svelte'

let component: ReturnType<typeof mount> | undefined
beforeEach(() => { read.mockReset() })
afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.replaceChildren()
    vi.restoreAllMocks()
})
async function show() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(CacheUsageCard, { target })
    await tick()
    await vi.waitFor(() => expect(document.querySelector('section')?.getAttribute('aria-busy')).toBe('false'))
    return target
}

test('shows real used/quota/remaining values and an accessible percentage', async () => {
    read.mockResolvedValue({ usageBytes: 25, quotaBytes: 100, source: 'browser' })
    const target = await show()
    const meter = target.querySelector('[role="progressbar"]')
    expect(meter?.getAttribute('aria-valuenow')).toBe('25')
    expect(meter?.getAttribute('aria-valuetext')).toBe('25 B / 100 B')
    expect(target.textContent).toContain('75 B')
    expect(target.textContent).toContain('cacheUsageEstimateNote')
    expect(target.textContent).not.toContain('cacheUsageFallbackNote')
})

test('fallback usage has no invented total capacity or percentage', async () => {
    read.mockResolvedValue({ usageBytes: 48, quotaBytes: null, source: 'cache' })
    const target = await show()
    expect(target.textContent).toContain('48 B')
    expect(target.textContent).toContain('cacheUsageQuotaUnknown')
    expect(target.textContent).toContain('cacheUsageFallbackNote')
    expect(target.querySelector('[role="progressbar"]')).toBeNull()
    expect(target.textContent).not.toContain('%')
})

test('unavailable storage does not masquerade as zero usage', async () => {
    read.mockResolvedValue({ usageBytes: null, quotaBytes: null, source: 'unavailable' })
    const target = await show()
    expect(target.textContent).toContain('cacheUsageUnavailable')
    expect(target.textContent).not.toContain('0 B')
    expect(target.querySelector('[role="progressbar"]')).toBeNull()
})

test('manual refresh forces a fresh measurement and preserves old data on failure', async () => {
    read.mockResolvedValueOnce({ usageBytes: 20, quotaBytes: 100, source: 'browser' })
    const target = await show()
    expect(read).toHaveBeenNthCalledWith(1, { force: false, signal: expect.anything() })
    read.mockRejectedValueOnce(new Error('storage unavailable'))
    target.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(read).toHaveBeenLastCalledWith({ force: true, signal: expect.anything() }))
    await vi.waitFor(() => expect(target.textContent).toContain('cacheUsageRefreshFailed'))
    expect(target.textContent).toContain('20 B')
})

test('refreshes on return to a visible page and removes its listener on unmount', async () => {
    read.mockResolvedValue({ usageBytes: 20, quotaBytes: 100, source: 'browser' })
    await show()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await unmount(component!)
    component = undefined
    document.dispatchEvent(new Event('visibilitychange'))
    expect(read).toHaveBeenCalledTimes(2)
})

test('unmount aborts a pending measurement rather than letting a scan continue after leaving home', async () => {
    let signal!: AbortSignal
    read.mockImplementationOnce(({ signal: supplied }: { signal: AbortSignal }) => {
        signal = supplied
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(CacheUsageCard, { target })
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(signal.aborted).toBe(false)
    await unmount(component)
    component = undefined
    expect(signal.aborted).toBe(true)
})

test('mounting in a hidden tab defers the first measurement until the page becomes visible', async () => {
    let hidden = true
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    read.mockResolvedValue({ usageBytes: 20, quotaBytes: 100, source: 'browser' })
    const target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(CacheUsageCard, { target })
    await tick()
    expect(read).not.toHaveBeenCalled()
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(target.querySelector('section')?.getAttribute('aria-busy')).toBe('false'))
    expect(target.textContent).toContain('20 B')
})

test('a quick hidden/visible return cancels the old scan and refreshes without losing the last valid snapshot', async () => {
    let hidden = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    read.mockResolvedValueOnce({ usageBytes: 20, quotaBytes: 100, source: 'browser' })
    const target = await show()
    let oldSignal!: AbortSignal
    read.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
        oldSignal = signal
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    read.mockResolvedValueOnce({ usageBytes: 25, quotaBytes: 100, source: 'browser' })
    target.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(oldSignal.aborted).toBe(true)
    expect(target.textContent).toContain('20 B')
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(target.textContent).toContain('25 B'))
    expect(target.textContent).not.toContain('cacheUsageRefreshFailed')
})
