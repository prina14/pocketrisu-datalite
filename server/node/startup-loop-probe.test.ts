import { afterEach, expect, test, vi } from 'vitest'
const { createStartupLoopProbe } = require('./startup-loop-probe.cjs')
afterEach(() => vi.useRealTimers())

test('recent event-loop lag is bounded in time and also observes a late sampling timer', async () => {
    vi.useFakeTimers()
    let time = 0
    const histogram = { max: 120_000_000, enable: vi.fn(), disable: vi.fn(), reset: vi.fn(() => { histogram.max = 0 }) }
    const probe = createStartupLoopProbe({ histogram, now: () => time })
    try {
        expect(probe.maxMs()).toBe(120)
        time = 1400
        expect(probe.maxMs()).toBe(400)
        await vi.advanceTimersByTimeAsync(1000)
        expect(probe.maxMs()).toBe(400)
        time = 8000
        await vi.advanceTimersByTimeAsync(1000)
        // After the late timer has been sampled, a later healthy window ages it out.
        for (let i = 0; i < 7; i++) { time += 1000; await vi.advanceTimersByTimeAsync(1000) }
        expect(probe.maxMs()).toBe(0)
    } finally { probe.close() }
    expect(histogram.disable).toHaveBeenCalledOnce()
})
