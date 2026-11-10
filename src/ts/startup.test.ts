// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import { beginStartupPhase, measureStartupPhase, readBootBackupReminderEnabled, readDatabaseWithIndexPrefetch, scheduleAfterFirstPaint } from './startup'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

test('plugin index prefetch waits for the DB read and fresh-save acknowledgment but does not block DB processing', async () => {
    let read!: () => void, saved!: () => void
    const readReady = new Promise<void>(resolve => { read = resolve })
    const savedReady = new Promise<void>(resolve => { saved = resolve })
    const index = vi.fn(() => new Promise(() => {}))
    const result = readDatabaseWithIndexPrefetch(async () => {
        await readReady
        await savedReady // fresh DB must be initialized server-side first
        return 'database'
    }, index)
    expect(index).not.toHaveBeenCalled()
    read(); await Promise.resolve(); await Promise.resolve()
    expect(index).not.toHaveBeenCalled()
    saved()
    expect(await result).toBe('database')
    expect(index).toHaveBeenCalledOnce()
})

test('failed DB reads never start plugin index work; failed prefetches leave normal recovery possible', async () => {
    const index = vi.fn(async () => {})
    const failure = new Error('DB unavailable')
    await expect(readDatabaseWithIndexPrefetch(async () => { throw failure }, index)).rejects.toBe(failure)
    expect(index).not.toHaveBeenCalled()
    expect(await readDatabaseWithIndexPrefetch(async () => 'data', async () => { throw new Error('index unavailable') })).toBe('data')
    expect(await readDatabaseWithIndexPrefetch(async () => 'data', () => { throw new Error('sync failure') })).toBe('data')
})

test('independent 500ms backup setting and 300ms DB read complete together at 500ms', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    let dbReady = -1, settingReady = -1
    const setting = readBootBackupReminderEnabled(async () => 'auth', async () => {
        await new Promise(resolve => setTimeout(resolve, 500))
        return Response.json({ enabled: true })
    }).then(enabled => { settingReady = Date.now() - start; return enabled })
    const database = readDatabaseWithIndexPrefetch(async () => {
        await new Promise(resolve => setTimeout(resolve, 300))
        return 'database'
    }, async () => {}).then(data => { dbReady = Date.now() - start; return data })
    await vi.runAllTimersAsync()
    expect(await database).toBe('database')
    expect(await setting).toBe(true)
    expect([dbReady, settingReady]).toEqual([300, 500])
})

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
