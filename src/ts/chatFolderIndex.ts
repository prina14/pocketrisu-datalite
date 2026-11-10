import type { Chat } from './storage/database.svelte'

export interface IndexedChat { chat: Chat; index: number }

/** Index metadata only. Never inspect message bodies just to build a list. */
export function indexChatsByFolder(chats: readonly Chat[]): Map<string, IndexedChat[]> {
    const groups = new Map<string, IndexedChat[]>()
    for (let index = 0; index < chats.length; index++) {
        const chat = chats[index]
        const folderId = chat?.folderId
        if (folderId == null) continue
        const key = String(folderId)
        let group = groups.get(key)
        if (!group) groups.set(key, group = [])
        group.push({ chat, index })
    }
    return groups
}
