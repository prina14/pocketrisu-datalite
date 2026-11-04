import { afterEach, expect, test, vi } from 'vitest'
import { createActivityMonitor } from './serverActivity'
afterEach(() => vi.useRealTimers())
const tick = async () => { await vi.advanceTimersByTimeAsync(0) }

test('working status clears when generation completes or is aborted on the server', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValueOnce({ generating: 1, saving: false }).mockResolvedValue({ generating: 0, saving: false })
    const publish = vi.fn()
    const monitor = createActivityMonitor(read, publish)
    monitor.setVisible(true); await tick()
    expect(publish).toHaveBeenLastCalledWith('working')
    await vi.advanceTimersByTimeAsync(5000)
    expect(publish).toHaveBeenLastCalledWith('idle')
    monitor.stop()
})

test('an active save is advisory working status too', async () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const monitor = createActivityMonitor(async () => ({ generating: 0, saving: true }), publish)
    monitor.setVisible(true); await tick()
    expect(publish).toHaveBeenLastCalledWith('working')
    monitor.stop()
})

test('connection errors replace working status with unavailable and allow later recovery', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValueOnce({ generating: 1, saving: false }).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ generating: 0, saving: false })
    const publish = vi.fn()
    const monitor = createActivityMonitor(read, publish)
    monitor.setVisible(true); await tick()
    await vi.advanceTimersByTimeAsync(5000)
    expect(publish).toHaveBeenLastCalledWith('unavailable')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(publish).toHaveBeenLastCalledWith('idle')
    monitor.stop()
})

test('a hung status request expires without leaving a permanent busy indicator', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockImplementation(() => new Promise(() => {}))
    const publish = vi.fn()
    const monitor = createActivityMonitor(read, publish)
    monitor.setVisible(true)
    await vi.advanceTimersByTimeAsync(8000)
    expect(read.mock.calls[0][0].aborted).toBe(true)
    expect(publish).toHaveBeenLastCalledWith('unavailable')
    expect(read).toHaveBeenCalledTimes(1)
    monitor.stop()
})

test('hidden pages do not poll, and a late previous response cannot replace fresh status', async () => {
    vi.useFakeTimers()
    let resolveOld: (v: any) => void
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
        .mockResolvedValue({ generating: 0, saving: false })
    const publish = vi.fn()
    const monitor = createActivityMonitor(read, publish)
    monitor.setVisible(true)
    monitor.setVisible(false)
    expect(read.mock.calls[0][0].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(1)
    monitor.setVisible(true); await tick()
    expect(publish).toHaveBeenLastCalledWith('idle')
    resolveOld!({ generating: 99, saving: true }); await tick()
    expect(publish).toHaveBeenLastCalledWith('idle')
    monitor.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(2)
})
