import { describe, expect, test, vi } from 'vitest'
import { createChatDeltaSync, type ChatCopyStore, type ChatDeltaTransport } from './chatDeltaSync'
import { messageFingerprints, prefixFingerprint } from './chatFingerprint'

const msg = (i: number, data = `message ${i}`) => ({ role: (i % 2 ? 'char' : 'user') as 'char' | 'user', data, chatId: `m${i}`, time: i })
const chatOf = (n: number, extra: Record<string, unknown> = {}) => ({ id: 'chat', name: 'Chat', note: '', localLore: [], fmIndex: -1, message: Array.from({ length: n }, (_, i) => msg(i)), ...extra }) as any

// A fake server holding one chat that verifies prefixes exactly like server.cjs.
function fakeServer(initial: any) {
    let stored = structuredClone(initial)
    const matches = (base: { count: number, fp: string }) =>
        base.count <= stored.message.length && prefixFingerprint(messageFingerprints(stored.message.slice(0, base.count)), base.count) === base.fp
    const transport: ChatDeltaTransport = {
        fetchChatContentDelta: vi.fn(async (_a, _i, _c, base) => {
            if (base && matches(base)) return { chat: structuredClone({ ...stored, message: stored.message.slice(base.count) }), deltaBase: base.count }
            return { chat: structuredClone(stored), deltaBase: null }
        }),
        saveChatContentDelta: vi.fn(async (_a, _i, _c, chat, base) => {
            const body = structuredClone(chat)
            if (base) {
                if (!matches(base)) return 'base-mismatch' as const
                body.message = stored.message.slice(0, base.count).concat(body.message)
            }
            stored = body
            return 'ok' as const
        }),
    }
    return { transport, get stored() { return stored }, set stored(v) { stored = v } }
}

function memoryCopies(): ChatCopyStore & { map: Map<string, any> } {
    const map = new Map<string, any>()
    return { map, get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : null), put: async (k, c) => { map.set(k, structuredClone(c)) } }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('background chat preparation', () => {
    test('warms the persistent copy so the next foreground opening uses a verified delta', async () => {
        const server = fakeServer(chatOf(50))
        const copies = memoryCopies()
        const transport = { ...server.transport, fetchChatContentDelta: vi.fn(server.transport.fetchChatContentDelta) }
        const sync = createChatDeltaSync(transport, copies)
        const signal = new AbortController().signal
        await sync.fetchChat('char', 0, 'chat', { signal, prefetch: true })
        const opened = await sync.fetchChat('char', 0, 'chat')
        expect(opened?.message).toHaveLength(50)
        expect(transport.fetchChatContentDelta.mock.calls[0][4]).toEqual({ signal, prefetch: true })
        expect(transport.fetchChatContentDelta.mock.calls[1][3]?.count).toBe(50)
    })

    test('a canceled speculative response cannot replace a cached conversation', async () => {
        const copies = memoryCopies()
        const controller = new AbortController()
        const server = fakeServer(chatOf(5))
        const transport = { ...server.transport, fetchChatContentDelta: vi.fn(async () => {
            controller.abort()
            return { chat: chatOf(5), deltaBase: null }
        }) }
        const result = await createChatDeltaSync(transport, copies).fetchChat('char', 0, 'chat', { signal: controller.signal, prefetch: true })
        await settle()
        expect(result).toBeNull()
        expect(copies.map.size).toBe(0)
    })
})

describe('chat delta sync — loading', () => {
    test('an unchanged 20,000-message reopening reuses the validated body without another snapshot or cache write', async () => {
        const server = fakeServer(chatOf(20_000))
        const copies = memoryCopies()
        await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        await settle()
        const write = vi.spyOn(copies, 'put')
        const originalClone = structuredClone
        let fullClones = 0
        const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
            if ((value as any)?.message?.length === 20_000) fullClones++
            return originalClone(value, options)
        })
        try {
            const full = await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
            await settle()
            expect(full).toEqual(server.stored)
            expect(fullClones).toBe(1) // store.get owns one defensive copy
            expect(write).not.toHaveBeenCalled()
            full!.message[0].data = 'local unsaved edit'
            expect(copies.map.get('char|chat').message[0].data).not.toBe('local unsaved edit')
        } finally { clone.mockRestore(); write.mockRestore() }
    })

    test.each(['note', 'localLore', 'clearedField'])('metadata-only changes still update the cached body (%s)', async field => {
        const server = fakeServer(chatOf(50, { clearedField: 'old' }))
        const copies = memoryCopies()
        await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        await settle()
        if (field === 'note') server.stored.note = 'new note'
        if (field === 'localLore') server.stored.localLore = [{ key: 'changed', content: 'new' }]
        if (field === 'clearedField') server.stored.clearedField = null
        const write = vi.spyOn(copies, 'put')
        try {
            const full = await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
            await settle()
            expect(full).toEqual(server.stored)
            expect(write).toHaveBeenCalledOnce()
            expect(copies.map.get('char|chat')).toEqual(server.stored)
        } finally { write.mockRestore() }
    })
    test.each([0, 1, 12, 39, 40])('keeps a full copy with %i messages, including metadata', async n => {
        const server = fakeServer(chatOf(n, { note: 'keep metadata even when empty' }))
        const copies = memoryCopies()
        await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        await settle()
        expect(copies.map.get('char|chat')).toEqual(server.stored)
        await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        const sentBase = (server.transport.fetchChatContentDelta as any).mock.calls.at(-1)[3]
        // Empty copies are persisted too; the existing server prefix protocol
        // accepts only positive message counts, so these still use a full GET.
        expect(sentBase?.count ?? 0).toBe(n)
    })

    test('first open fetches the whole chat and keeps a copy', async () => {
        const server = fakeServer(chatOf(50))
        const copies = memoryCopies()
        const sync = createChatDeltaSync(server.transport, copies)
        const chat = await sync.fetchChat('char', 0, 'chat')
        expect(chat).toEqual(server.stored)
        expect((server.transport.fetchChatContentDelta as any).mock.calls[0][3]).toBeNull()
        await settle()
        expect(copies.map.get('char|chat')).toEqual(server.stored)
    })

    test('reopening with a copy receives only the new messages and assembles the full chat', async () => {
        const server = fakeServer(chatOf(60))
        const copies = memoryCopies()
        const sync = createChatDeltaSync(server.transport, copies)
        await sync.fetchChat('char', 0, 'chat'); await settle()
        server.stored = { ...server.stored, note: 'changed note', message: [...server.stored.message, msg(60), msg(61)] }
        const fetched = await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        const lastCall = (server.transport.fetchChatContentDelta as any).mock.results.at(-1).value
        expect((await lastCall).deltaBase).toBe(60)
        expect((await lastCall).chat.message).toHaveLength(2)
        expect(fetched).toEqual(server.stored)
    })

    test('a copy that no longer matches (older message edited elsewhere) falls back to the whole chat', async () => {
        const server = fakeServer(chatOf(60))
        const copies = memoryCopies()
        await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat'); await settle()
        server.stored.message[3] = msg(3, 'edited on another device')
        const fetched = await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        expect(fetched).toEqual(server.stored)
        expect(fetched!.message[3].data).toBe('edited on another device')
    })

    test('a broken local store never blocks loading', async () => {
        const server = fakeServer(chatOf(60))
        const broken: ChatCopyStore = { get: async () => { throw new Error('quota') }, put: async () => { throw new Error('quota') } }
        expect(await createChatDeltaSync(server.transport, broken).fetchChat('char', 0, 'chat')).toEqual(server.stored)
    })
})

describe('chat delta sync — saving', () => {
    test('a saved short chat is available to the next page load with its latest prefix', async () => {
        const server = fakeServer(chatOf(2))
        const copies = memoryCopies()
        const sync = createChatDeltaSync(server.transport, copies)
        const chat = await sync.fetchChat('char', 0, 'chat')
        chat!.message.push(msg(2))
        await sync.saveChat('char', 0, 'chat', chat!)
        expect(copies.map.get('char|chat')).toEqual(server.stored)
        const reopened = await createChatDeltaSync(server.transport, copies).fetchChat('char', 0, 'chat')
        expect((server.transport.fetchChatContentDelta as any).mock.calls.at(-1)[3].count).toBe(3)
        expect(reopened).toEqual(server.stored)
    })

    test.each([false, true])('in-flight UI edits never enter the acknowledged cache (fallback=%s)', async fallback => {
        const server = fakeServer(chatOf(2))
        const copies = memoryCopies()
        const sync = createChatDeltaSync(server.transport, copies)
        const loaded = await sync.fetchChat('char', 0, 'chat')
        // Like Svelte state, this proxy cannot be passed to structuredClone.
        const chat = new Proxy(loaded!, {})
        chat.note = 'sent'
        chat.message.push(msg(2))
        const expected = structuredClone(loaded)
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const save = server.transport.saveChatContentDelta as any
        const real = save.getMockImplementation()
        save.mockImplementationOnce(async (...args: any[]) => {
            await gate
            return fallback ? 'base-mismatch' : real(...args)
        })
        const pending = sync.saveChat('char', 0, 'chat', chat)
        chat.note = 'not sent yet'
        chat.message[0].data = 'not sent either'
        release()
        await pending
        expect(server.stored).toEqual(expected)
        expect(copies.map.get('char|chat')).toEqual(expected)
        await sync.saveChat('char', 0, 'chat', chat)
        expect(server.stored).toEqual(loaded)
        expect(copies.map.get('char|chat')).toEqual(loaded)
    })

    test('failed network saves leave the previous cached copy intact', async () => {
        const server = fakeServer(chatOf(2))
        const copies = memoryCopies()
        const sync = createChatDeltaSync(server.transport, copies)
        const chat = await sync.fetchChat('char', 0, 'chat')
        await settle()
        const previous = structuredClone(copies.map.get('char|chat'))
        chat!.note = 'unsaved'
        ;(server.transport.saveChatContentDelta as any).mockRejectedValueOnce(new Error('network'))
        await expect(sync.saveChat('char', 0, 'chat', chat!)).rejects.toThrow('network')
        expect(copies.map.get('char|chat')).toEqual(previous)
    })

    test('a rejected full save never enters the cache', async () => {
        const server = fakeServer(chatOf(0))
        const copies = memoryCopies()
        ;(server.transport.saveChatContentDelta as any).mockResolvedValueOnce('base-mismatch')
        const sync = createChatDeltaSync(server.transport, copies)
        await expect(sync.saveChat('char', 0, 'chat', chatOf(1))).rejects.toThrow('did not accept')
        expect(copies.map.size).toBe(0)
    })

    test('a delayed fetch cache write cannot overwrite a later acknowledged save', async () => {
        const server = fakeServer(chatOf(2, { note: 'old' }))
        const copies = memoryCopies()
        const originalPut = copies.put
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        copies.put = async (key, chat) => {
            if (chat.note === 'old') await gate
            await originalPut(key, chat)
        }
        const sync = createChatDeltaSync(server.transport, copies)
        const chat = await sync.fetchChat('char', 0, 'chat')
        chat!.note = 'new'
        const saved = sync.saveChat('char', 0, 'chat', chat!)
        await settle()
        expect(server.stored.note).toBe('new')
        release()
        await saved
        expect(copies.map.get('char|chat').note).toBe('new')
    })

    test('a cache failure never turns a successful server save into an error', async () => {
        const server = fakeServer(chatOf(2))
        const broken: ChatCopyStore = { get: async () => null, put: async () => { throw new Error('quota') } }
        const sync = createChatDeltaSync(server.transport, broken)
        await expect(sync.saveChat('char', 0, 'chat', chatOf(3))).resolves.toBeUndefined()
        expect(server.stored.message).toHaveLength(3)
    })

    async function opened(n = 60) {
        const server = fakeServer(chatOf(n))
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const chat = await sync.fetchChat('char', 0, 'chat')
        return { server, sync, chat: structuredClone(chat)! }
    }
    const lastSave = (server: ReturnType<typeof fakeServer>) => (server.transport.saveChatContentDelta as any).mock.calls.at(-1)

    test('appended messages go out alone and the server ends up with the whole chat', async () => {
        const { server, sync, chat } = await opened()
        chat.message.push(msg(60), msg(61))
        await sync.saveChat('char', 0, 'chat', chat)
        const [, , , body, base] = lastSave(server)
        expect(base.count).toBe(60)
        expect(body.message).toHaveLength(2)
        expect(server.stored).toEqual(chat)
    })

    test('a reroll (last message replaced) sends only from the changed message', async () => {
        const { server, sync, chat } = await opened()
        chat.message[59] = msg(59, 'rerolled answer')
        await sync.saveChat('char', 0, 'chat', chat)
        const [, , , body, base] = lastSave(server)
        expect(base.count).toBe(59)
        expect(body.message.map((m: any) => m.data)).toEqual(['rerolled answer'])
        expect(server.stored).toEqual(chat)
    })

    test('deleting and editing older messages still leaves the server identical to the client', async () => {
        const { server, sync, chat } = await opened()
        chat.message.splice(10, 5)
        chat.message[2] = msg(2, 'edited early message')
        chat.scriptstate = { hp: 3 }
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4].count).toBe(2)
        expect(server.stored).toEqual(chat)
    })

    test('a server that changed underneath (another device) gets a full save instead', async () => {
        const { server, sync, chat } = await opened()
        server.stored = { ...server.stored, message: server.stored.message.map((m: any, i: number) => (i === 0 ? msg(0, 'other device') : m)) }
        chat.message.push(msg(60))
        await sync.saveChat('char', 0, 'chat', chat)
        const calls = (server.transport.saveChatContentDelta as any).mock.calls
        expect(calls.at(-2)[4].count).toBe(60)
        expect(calls.at(-1)[4]).toBeNull()
        expect(server.stored).toEqual(chat)
    })

    test('a chat never loaded from the server is saved in full, then as deltas', async () => {
        const server = fakeServer({ ...chatOf(0) })
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const chat = chatOf(3)
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4]).toBeNull()
        chat.message.push(msg(3))
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4].count).toBe(3)
        expect(server.stored).toEqual(chat)
    })

    test('clearing the chat saves in full', async () => {
        const { server, sync, chat } = await opened()
        chat.message = []
        await sync.saveChat('char', 0, 'chat', chat)
        expect(lastSave(server)[4]).toBeNull()
        expect(server.stored.message).toEqual([])
    })
})

describe('chat delta sync — save ordering', () => {
    // A slow earlier save (a plugin writing an unopened chat) must not land
    // after a newer one (the autosave after the user opened and edited it).
    test('saves of the same chat reach the server in call order', async () => {
        const server = fakeServer(chatOf(3))
        const order: string[] = []
        let releaseFirst!: () => void
        const firstGate = new Promise<void>((r) => { releaseFirst = r })
        const save = server.transport.saveChatContentDelta as any
        const real = save.getMockImplementation()
        save.mockImplementation(async (a: any, i: any, c: any, chat: any, base: any) => {
            if (chat.note === 'older') await firstGate
            const out = await real(a, i, c, chat, base)
            order.push(chat.note)
            return out
        })
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const older = sync.saveChat('char', 0, 'chat', chatOf(3, { note: 'older' }))
        const newer = sync.saveChat('char', 0, 'chat', chatOf(4, { note: 'newer' }))
        await settle()
        expect(save).toHaveBeenCalledTimes(1)
        releaseFirst()
        await Promise.all([older, newer])
        expect(order).toEqual(['older', 'newer'])
        expect(server.stored.note).toBe('newer')
        expect(server.stored.message).toHaveLength(4)
    })

    test('a failed save does not block the next one, and other chats are not queued behind it', async () => {
        const server = fakeServer(chatOf(3))
        const save = server.transport.saveChatContentDelta as any
        const real = save.getMockImplementation()
        save.mockImplementationOnce(async () => { throw new Error('network') })
        const sync = createChatDeltaSync(server.transport, memoryCopies())
        const failed = sync.saveChat('char', 0, 'chat', chatOf(3, { note: 'failed' }))
        const next = sync.saveChat('char', 0, 'chat', chatOf(3, { note: 'next' }))
        await expect(failed).rejects.toThrow('network')
        await next
        expect(server.stored.note).toBe('next')

        let release!: () => void
        const gate = new Promise<void>((r) => { release = r })
        save.mockImplementation(async (a: any, i: any, c: any, chat: any, base: any) => {
            if (c === 'slow') await gate
            return real(a, i, c, chat, base)
        })
        const slow = sync.saveChat('char', 0, 'slow', chatOf(1))
        await sync.saveChat('char', 0, 'chat', chatOf(3, { note: 'unblocked' }))
        expect(server.stored.note).toBe('unblocked')
        release()
        await slow
    })
})
