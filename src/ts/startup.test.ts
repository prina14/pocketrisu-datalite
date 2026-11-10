// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import { beginStartupPhase, measureStartupPhase, readBootBackupReminderEnabled, scheduleAfterFirstPaint } from './startup'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

test('backup reminder configuration keeps the authenticated enabled flag and fails open on unavailable settings', async () => {
    const getAuth = vi.fn(async () => 'boot-test')
    const request = vi.fn(async () => Response.json({ enabled: true }))
    expect(await readBootBackupReminderEnabled(getAuth, request)).toBe(true)
    expect(request).toHaveBeenCalledWith('/api/backup/boot-reminder', { headers: { 'risu-auth': 'boot-test' } })
    expect(await readBootBackupReminderEnabled(getAuth, async () => new Response('', { status: 503 }))).toBe(false)
    expect(await readBootBackupReminderEnabled(getAuth, async () => { throw new Error('timeout') })).toBe(false)
    expect(await readBootBackupReminderEnabled(async () => { throw new Error('auth unavailable') }, request)).toBe(false)
})

test('optional tasks start after a rendering opportunity and do not wait on persistence or each other', async () => {
    vi.useFakeTimers()
    let frame!: FrameRequestCallback
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    const stalled = vi.fn(() => new Promise(() => {}))
    const update = vi.fn()
    const failure = vi.fn(() => { throw new Error('optional task failed') })
    const stats = vi.fn()
    scheduleAfterFirstPaint([stalled, update, failure, stats])
    expect(stalled).not.toHaveBeenCalled()
    frame(0)
    expect(stalled).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(stalled).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledOnce()
    expect(stats).toHaveBeenCalledOnce()
})

test('without animation frame support optional requests still run asynchronously and ignore rejections', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', undefined)
    const request = vi.fn(async () => { throw new Error('permission denied') })
    scheduleAfterFirstPaint([request])
    expect(request).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(request).toHaveBeenCalledOnce()
})

test('startup timings preserve successful results and original errors when diagnostics are unsupported', async () => {
    vi.stubGlobal('performance', { now: () => 100, measure: () => { throw new Error('unsupported') } })
    expect(await measureStartupPhase('test', async () => 'ready')).toBe('ready')
    const error = new Error('storage failed')
    await expect(measureStartupPhase('test', () => { throw error })).rejects.toBe(error)
    vi.stubGlobal('performance', undefined)
    expect(await measureStartupPhase('test', () => 'ready')).toBe('ready')
})

test('startup measurements contain phase names and record a phase only once', async () => {
    const measure = vi.fn()
    vi.stubGlobal('performance', { now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(20), measure })
    const finish = beginStartupPhase('database-read')
    finish()
    finish()
    expect(measure).toHaveBeenCalledOnce()
    expect(measure).toHaveBeenCalledWith('pocketrisu:startup:database-read', { start: 10, end: 20 })
})
