import { afterEach, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'
import { buildManagerEntries } from './characterManager'
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear() })

test('recent display uses viewing metadata without changing the character record', () => {
    const character = { chaId: 'alice', name: 'Alice', lastInteraction: 10, chats: [] }
    const db = { characters: [character] } as any
    expect(buildManagerEntries(db, { alice: 100 }).get('alice')!.lastInteraction).toBe(100)
    expect(character.lastInteraction).toBe(10)
})

test('a new open during an older save stays pending and is sent separately', async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(10000); localStorage.clear()
    const activity = await import('./characterActivity')
    let finishFirst!: (response: Response) => void
    let posts = 0
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            posts++
            if (posts === 1) return new Promise<Response>(resolve => { finishFirst = resolve })
            return Response.json({ entries: [{ chaId: 'alice', lastInteraction: 20000 }] })
        }
        return Response.json({ entries: [] }, { headers: { etag: '"meta"' } })
    })
    vi.stubGlobal('fetch', request)
    activity.initCharacterActivity(async () => 'token')
    await activity.syncCharacterActivity()
    activity.recordCharacterOpen('alice')
    await vi.advanceTimersByTimeAsync(250)
    const first = activity.syncCharacterActivity()
    activity.recordCharacterOpen('alice')
    await vi.advanceTimersByTimeAsync(250)
    finishFirst(Response.json({ entries: [{ chaId: 'alice', lastInteraction: 10001 }] }))
    await first
    expect(get(activity.characterActivity).alice).toBeGreaterThan(10001)
    await vi.advanceTimersByTimeAsync(250)
    await activity.syncCharacterActivity()
    expect(posts).toBe(2)
    expect(get(activity.characterActivity).alice).toBe(20000)
    expect(request.mock.calls.every(([url]) => url === '/api/character-activity')).toBe(true)
})

test('offline metadata stays local without starting an endless retry poll', async () => {
    vi.resetModules(); vi.useFakeTimers(); localStorage.clear()
    const activity = await import('./characterActivity')
    const request = vi.fn(async () => { throw Error('offline') })
    vi.stubGlobal('fetch', request)
    activity.initCharacterActivity(async () => 'token')
    await activity.syncCharacterActivity()
    activity.recordCharacterOpen('alice')
    await vi.advanceTimersByTimeAsync(250)
    await activity.syncCharacterActivity()
    const calls = request.mock.calls.length
    await vi.advanceTimersByTimeAsync(30000)
    expect(request).toHaveBeenCalledTimes(calls)
    expect(JSON.parse(localStorage.getItem('pocketrisu-character-activity-v1')!).pending[0][0]).toBe('alice')
})

test('a negotiated POST snapshot replaces the follow-up GET and keeps other-device activity', async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(10000); localStorage.clear()
    const activity = await import('./characterActivity')
    const request = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
        ? Response.json({ entries: [{ chaId: 'alice', lastInteraction: 10001 }, { chaId: 'other', lastInteraction: 9000 }] },
            { headers: { 'x-activity-snapshot': '1', etag: '"snapshot"' } })
        : Response.json({ entries: [] }))
    vi.stubGlobal('fetch', request)
    activity.initCharacterActivity(async () => 'token'); await activity.syncCharacterActivity()
    request.mockClear(); activity.recordCharacterOpen('alice'); await vi.advanceTimersByTimeAsync(250)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ 'x-activity-snapshot': '1' })
    expect(get(activity.characterActivity)).toMatchObject({ alice: 10001, other: 9000 })
    await activity.syncCharacterActivity()
    expect(request.mock.calls[1][1]?.headers).toMatchObject({ 'if-none-match': '"snapshot"' })
})

test('snapshot acknowledgement cannot erase an open recorded while the POST was in flight', async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(10000); localStorage.clear()
    const activity = await import('./characterActivity')
    let release!: (response: Response) => void
    let posts = 0
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== 'POST') return Response.json({ entries: [] })
        if (++posts === 1) return new Promise<Response>(resolve => { release = resolve })
        return Response.json({ entries: [{ chaId: 'alice', lastInteraction: 20001 }] }, { headers: { 'x-activity-snapshot': '1' } })
    })
    vi.stubGlobal('fetch', request)
    activity.initCharacterActivity(async () => 'token'); await activity.syncCharacterActivity()
    activity.recordCharacterOpen('alice'); await vi.advanceTimersByTimeAsync(250)
    const first = activity.syncCharacterActivity()
    vi.setSystemTime(20000); activity.recordCharacterOpen('alice'); await vi.advanceTimersByTimeAsync(250)
    release(Response.json({ entries: [{ chaId: 'alice', lastInteraction: 10001 }] }, { headers: { 'x-activity-snapshot': '1' } }))
    await first
    expect(get(activity.characterActivity).alice).toBe(20000)
    await vi.advanceTimersByTimeAsync(250); await activity.syncCharacterActivity()
    expect(posts).toBe(2)
    expect(get(activity.characterActivity).alice).toBe(20001)
})
