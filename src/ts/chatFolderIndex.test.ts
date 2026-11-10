import { expect, test } from 'vitest'
import { indexChatsByFolder } from './chatFolderIndex'
import type { Chat } from './storage/database.svelte'

test('keeps chat order, original slot indices and references through folder moves and reorders', () => {
    const a = { id: 'a', folderId: 'f1' } as Chat
    const b = { id: 'b', folderId: 'f2' } as Chat
    const c = { id: 'c', folderId: 'f1' } as Chat
    const loose = { id: 'loose' } as Chat
    let index = indexChatsByFolder([a, loose, b, c])
    expect(index.get('f1')).toEqual([{ chat: a, index: 0 }, { chat: c, index: 3 }])
    expect(index.get('f1')![0].chat).toBe(a)
    expect(index.get('missing')).toBeUndefined()
    c.folderId = 'f2'
    index = indexChatsByFolder([c, a, b])
    expect(index.get('f1')).toEqual([{ chat: a, index: 1 }])
    expect(index.get('f2')).toEqual([{ chat: c, index: 0 }, { chat: b, index: 2 }])
})

test('100,000 chats in 1,000 folders are indexed once without reading any message history', () => {
    let folderReads = 0
    const chats = Array.from({ length: 100_000 }, (_, i) => ({
        id: `chat-${i}`,
        get folderId() { folderReads++; return `folder-${i % 1000}` },
        get message() { throw new Error('listing must not load message bodies') },
    })) as unknown as Chat[]
    const index = indexChatsByFolder(chats)
    expect(index.size).toBe(1000)
    for (let i = 0; i < 1000; i++) expect(index.get(`folder-${i}`)).toHaveLength(100)
    expect(folderReads).toBe(chats.length)
    expect(index.get('folder-999')!.at(-1)!.index).toBe(99_999)
})

test('missing, null and unknown folder assignments remain distinguishable for the loose/orphan fallback', () => {
    const unknown = { id: 'orphan', folderId: 'deleted' } as Chat
    const index = indexChatsByFolder([{ id: 'a' } as Chat, { id: 'b', folderId: null } as unknown as Chat, unknown])
    expect([...index.keys()]).toEqual(['deleted'])
    expect(index.get('deleted')![0]).toEqual({ chat: unknown, index: 2 })
})
