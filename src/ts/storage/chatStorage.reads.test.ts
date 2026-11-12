import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const fixtures = vi.hoisted(() => ({
    copies: new Map<string, any>(),
    delta: vi.fn(), full: vi.fn(), save: vi.fn(),
}))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: {
    fetchChatContentDelta: fixtures.delta,
    fetchChatContent: fixtures.full,
    saveChatContentDelta: fixtures.save,
} } }))
vi.mock('./database.svelte', () => ({ isChatStub: (c: any) => c?._stub === true }))
vi.mock('./chatCopyStore', () => ({ indexedDbChatCopies: {
    get: async (key: string) => structuredClone(fixtures.copies.get(key) ?? null),
    put: async (key: string, value: any) => { fixtures.copies.set(key, structuredClone(value)) },
} }))

const chat = () => ({ id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'fixture', chatId: 'm' }], note: '', localLore: [{ content: 'fixture lore' }] })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    fixtures.copies.clear()
    fixtures.delta.mockImplementation(async (_cha, _index, _chat, base) => base
        ? { chat: { ...chat(), localLore: [], message: [] }, deltaBase: base.count, reuseLore: true }
        : { chat: chat(), deltaBase: null })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(performance.now())); return 0 })
})
afterEach(() => { vi.unstubAllGlobals() })

test.each(['ui-first', 'plugin-first'])('%s shares one verified request and returns an isolated plugin snapshot', async order => {
    const api = await import('./chatStorage')
    const chats = [api.stubToPlaceholder({ _stub: true, id: 'chat', name: 'Chat' })]
    let resolve!: (value: any) => void
    fixtures.delta.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    let ui: Promise<any>, plugin: Promise<any>
    if (order === 'ui-first') {
        ui = api.ensureChatHydrated(chats, 0, 'char')
        plugin = api.fetchChatForPlugin('char', 0, 'chat')
    } else {
        plugin = api.fetchChatForPlugin('char', 0, 'chat')
        ui = api.ensureChatHydrated(chats, 0, 'char')
    }
    await vi.waitFor(() => expect(fixtures.delta).toHaveBeenCalledOnce())
    resolve({ chat: chat(), deltaBase: null })
    const [live, copy] = await Promise.all([ui, plugin])
    expect(fixtures.full).not.toHaveBeenCalled()
    expect(fixtures.save).not.toHaveBeenCalled()
    expect(copy.message).toEqual(live.message)
    copy.message[0].data = 'plugin edit'
    copy.localLore[0].content = 'plugin edit'
    expect(live.message[0].data).toBe('fixture')
    expect(live.localLore[0].content).toBe('fixture lore')
})

test('a plugin-only read leaves the app placeholder untouched and reuses the stored body after refresh', async () => {
    let api = await import('./chatStorage')
    const chats = [api.stubToPlaceholder({ _stub: true, id: 'chat', name: 'Chat' })]
    await api.fetchChatForPlugin('char', 0, 'chat')
    await settle()
    expect(chats[0]._placeholder).toBe(true)
    vi.resetModules()
    api = await import('./chatStorage')
    const copy = await api.fetchChatForPlugin('char', 0, 'chat')
    const base = fixtures.delta.mock.calls.at(-1)![3]
    expect(base.count).toBe(1)
    expect(base.loreFp).toMatch(/^[0-9a-f]{16}$/)
    expect(copy).toEqual(chat())
    expect(fixtures.full).not.toHaveBeenCalled()
    expect(fixtures.save).not.toHaveBeenCalled()
})

test('concurrent plugin reads share a request but not mutable objects', async () => {
    const api = await import('./chatStorage')
    const [a, b] = await Promise.all([api.fetchChatForPlugin('char', 0, 'chat'), api.fetchChatForPlugin('char', 0, 'chat')])
    expect(fixtures.delta).toHaveBeenCalledOnce()
    a!.message[0].data = 'edit'
    expect(b!.message[0].data).toBe('fixture')
})

test('a failed plugin read propagates without falling back to an unvalidated full download', async () => {
    const api = await import('./chatStorage')
    fixtures.delta.mockRejectedValueOnce(new Error('offline'))
    await expect(api.fetchChatForPlugin('char', 0, 'chat')).rejects.toThrow('offline')
    expect(fixtures.full).not.toHaveBeenCalled()
    expect(await api.fetchChatForPlugin('char', 0, 'chat')).toEqual(chat())
})

test('the real V3 bridge shares four character reads across four simulated page reloads', async () => {
    const source = readFileSync('src/ts/plugins/apiV3/v3.svelte.ts', 'utf8')
    const start = source.indexOf('        getChatFromIndex: async')
    const end = source.indexOf('        parseRisuChat:', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    // Execute the actual method body, stripping only its two parameter types.
    const method = source.slice(start, end).replace('characterIndex:number, chatIndex:number', 'characterIndex, chatIndex')
    const bridge = new Function('DBState', 'fetchChatForPlugin', '$state', `return ({${method}}).getChatFromIndex`)
    for (let round = 0; round < 4; round++) {
        vi.resetModules()
        const api = await import('./chatStorage')
        const characters = Array.from({ length: 4 }, (_, i) => ({
            chaId: `char-${i}`, chats: [api.stubToPlaceholder({ _stub: true, id: 'chat', name: 'Chat' })],
        }))
        const getChat = bridge({ db: { characters } }, api.fetchChatForPlugin, { snapshot: structuredClone })
        for (let i = 0; i < characters.length; i++) {
            const count = fixtures.delta.mock.calls.length
            const [live, snapshot] = await Promise.all([
                api.ensureChatHydrated(characters[i].chats, 0, characters[i].chaId),
                getChat(i, 0),
            ])
            expect(fixtures.delta.mock.calls.length - count).toBe(1)
            expect(snapshot.message).toEqual(live!.message)
            if (round > 0) expect(fixtures.delta.mock.calls.at(-1)![3]?.count).toBe(1)
            await settle()
        }
    }
    expect(fixtures.full).not.toHaveBeenCalled()
    expect(fixtures.save).not.toHaveBeenCalled()
})
