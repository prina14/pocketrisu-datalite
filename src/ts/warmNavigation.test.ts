import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { writable } from 'svelte/store'

const calls = vi.hoisted(() => ({ settings: vi.fn(async () => ({})), chat: vi.fn(async () => {}) }))
vi.mock('./settingsLoader', () => ({ loadSettings: calls.settings }))
vi.mock('./storage/chatStorage', () => ({ prefetchChatCopy: calls.chat }))
vi.mock('./characterActivity', () => ({ characterActivity: writable({}) }))
vi.mock('./stores.svelte', () => ({
    selectedCharID: writable(-1),
    DBState: { db: { characters: [1, 2, 3, 4].map(n => ({ chaId: `c${n}`, lastInteraction: n, chatPage: 0, chats: [{ id: `chat${n}`, _placeholder: true }] })) } },
}))
import { warmNavigation } from './warmNavigation'

beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.stubGlobal('__NODE__', true)
    Object.defineProperty(navigator, 'connection', { configurable: true, value: undefined })
})
afterEach(() => {
    window.dispatchEvent(new Event('pointerdown'))
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

test('waits for the home screen and prepares only three recent active chats', async () => {
    warmNavigation()
    await vi.advanceTimersByTimeAsync(2499)
    expect(calls.settings).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.settings).toHaveBeenCalledOnce()
    expect(calls.chat.mock.calls.map((args: any[]) => args[0])).toEqual(['c4', 'c3', 'c2'])
})

test('does not speculate when the user navigates first', async () => {
    warmNavigation()
    window.dispatchEvent(new Event('pointerdown'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls.settings).not.toHaveBeenCalled()
    expect(calls.chat).not.toHaveBeenCalled()
})

test('respects data saver', async () => {
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } })
    warmNavigation()
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls.settings).not.toHaveBeenCalled()
    expect(calls.chat).not.toHaveBeenCalled()
})
