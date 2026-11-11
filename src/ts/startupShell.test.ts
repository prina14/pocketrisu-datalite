import { afterEach, expect, test, vi } from 'vitest'
import { startAppAfterShellPaint, showStartupFailure } from './startupShell'

afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
    document.body.replaceChildren()
})

test('app import waits until the task after the shell frame and runs only once', async () => {
    vi.useFakeTimers()
    let frame!: FrameRequestCallback
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    const load = vi.fn(async () => {})
    const pending = startAppAfterShellPaint(load)
    expect(load).not.toHaveBeenCalled()
    frame(0)
    expect(load).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    await pending
    await vi.advanceTimersByTimeAsync(200)
    expect(load).toHaveBeenCalledOnce()
})

test('throttled animation cannot prevent startup or start a second app later', async () => {
    vi.useFakeTimers()
    let frame!: FrameRequestCallback
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    const load = vi.fn(async () => {})
    const pending = startAppAfterShellPaint(load)
    await vi.advanceTimersByTimeAsync(100)
    await pending
    frame(1000)
    await vi.runAllTimersAsync()
    expect(load).toHaveBeenCalledOnce()
})

test('hidden tabs start without waiting for animation', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const frame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', frame)
    const load = vi.fn(async () => {})
    await startAppAfterShellPaint(load)
    expect(load).toHaveBeenCalledOnce()
    expect(frame).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
})

test('failed chunk loads surface the error and a working reload action', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    const error = new Error('CSS chunk unavailable')
    await expect(startAppAfterShellPaint(() => Promise.reject(error))).rejects.toBe(error)
    document.body.innerHTML = '<section id="preloading" aria-busy="true"><span id="startup-status">Connecting</span><button id="startup-retry" hidden>Reload</button></section>'
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    showStartupFailure()
    expect(document.getElementById('preloading')!.getAttribute('aria-busy')).toBe('false')
    expect(document.getElementById('startup-status')!.textContent).toContain('reload')
    const button = document.getElementById('startup-retry') as HTMLButtonElement
    expect(button.hidden).toBe(false)
    button.click()
    expect(reload).toHaveBeenCalledOnce()
})
