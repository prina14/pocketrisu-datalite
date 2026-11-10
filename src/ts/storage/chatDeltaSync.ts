import type { Chat } from './database.svelte'
import { messageFingerprints, prefixFingerprint } from './chatFingerprint'
import rfdc from 'rfdc'
import isEqual from 'lodash/isEqual'
import type { ChatCopyStore } from './chatCopyStore'
export type { ChatCopyStore } from './chatCopyStore'
export { indexedDbChatCopies } from './chatCopyStore'

// Chat delta sync — transfer only what changed for cached chats.
//
// Loading: the browser keeps a copy of opened or successfully saved chats in
// IndexedDB. Opening one sends the copy's message count and prefix
// fingerprint; the server returns only the messages after it when its own
// first messages fingerprint the same, otherwise the whole chat as before.
//
// Saving: the messages the server held after the last sync are remembered as
// fingerprints (memory only). A save sends only the messages after the
// longest unchanged prefix. The server splices them onto its stored chat
// ONLY after verifying that prefix against its own data; on mismatch it
// answers 409 and the full chat is sent. The remembered base only picks how
// much to send — the stored result always equals the client's chat, exactly
// like a full save.
//
// Nothing here puts a partial chat into memory: a chat is either assembled
// complete (verified prefix + fetched rest) or fetched whole.

export interface ChatDeltaTransport {
    fetchChatContentDelta(chaId: string, chatIndex: number, chatId: string, base: { count: number, fp: string } | null): Promise<{ chat: any, deltaBase: number | null } | null>
    saveChatContentDelta(chaId: string, chatIndex: number, chatId: string, chat: any, base: { count: number, fp: string } | null): Promise<'ok' | 'base-mismatch'>
}

// Native cloning handles plain fetch results; rfdc also handles Svelte proxies.
const cloneReactive = rfdc({ circles: true })
function snapshotChat(chat: Chat): Chat | null {
    try { return structuredClone(chat) } catch {
        try { return cloneReactive(chat) } catch { return null }
    }
}

function chatCopyKey(chaId: string, chatId: string) {
    return `${chaId}|${chatId}`
}

function isUsableCopy(chat: any): chat is Chat {
    return !!chat && typeof chat === 'object' && Array.isArray(chat.message) && !chat._placeholder && !chat._stub
}

export function createChatDeltaSync(transport: ChatDeltaTransport, copies: ChatCopyStore) {
    const serverFingerprints = new Map<string, string[]>()
    // Serialize local writes too: a slow older fetch must not overwrite the
    // snapshot of a later acknowledged save. Cache failures remain optional.
    const copyWrites = new Map<string, Promise<void>>()
    function persistCopy(key: string, snapshot: Chat): Promise<void> {
        const run = (copyWrites.get(key) ?? Promise.resolve())
            .then(() => copies.put(key, snapshot)).catch(() => {})
        copyWrites.set(key, run)
        void run.then(() => { if (copyWrites.get(key) === run) copyWrites.delete(key) })
        return run
    }

    async function fetchChat(chaId: string, chatIndex: number, chatId: string): Promise<Chat | null> {
        const key = chatCopyKey(chaId, chatId)
        let copy: Chat | null = null
        try {
            await copyWrites.get(key)
            const stored = await copies.get(key)
            if (isUsableCopy(stored)) copy = stored
        } catch {
            copy = null
        }
        const copyFingerprints = copy ? messageFingerprints(copy.message) : null
        const base = copy && copy.message.length > 0 && copyFingerprints
            ? { count: copy.message.length, fp: prefixFingerprint(copyFingerprints, copy.message.length) }
            : null

        const result = await transport.fetchChatContentDelta(chaId, chatIndex, chatId, base)
        if (!result) return null

        let full: Chat = result.chat
        let fingerprints: string[]
        if (result.deltaBase !== null && copy && copyFingerprints && result.deltaBase === copy.message.length) {
            const hasNewMessages = result.chat.message.length > 0
            full = { ...result.chat, message: hasNewMessages ? copy.message.concat(result.chat.message) : copy.message }
            fingerprints = hasNewMessages ? copyFingerprints.concat(messageFingerprints(result.chat.message)) : copyFingerprints
        } else {
            fingerprints = messageFingerprints(full.message ?? [])
        }
        serverFingerprints.set(key, fingerprints)

        // The server verified the prefix. Compare metadata only: a warm open
        // must not clone/rewrite the entire unchanged transcript to cache it.
        const unchanged = result.deltaBase !== null && copy &&
            result.deltaBase === copy.message.length && result.chat.message.length === 0 &&
            isEqual({ ...copy, message: undefined }, { ...full, message: undefined })
        if (!unchanged && isUsableCopy(full)) {
            const snapshot = snapshotChat(full)
            if (snapshot) void persistCopy(key, snapshot)
        }
        return full
    }

    // Saves of one chat run one at a time, in call order: autosave, job
    // recovery and plugin writes all save through here, and a slower earlier
    // request finishing last would replace the newer chat on the server.
    // With nothing in flight a save starts at once, so its content is taken
    // at the call as before.
    const saveQueues = new Map<string, Promise<void>>()

    function saveChat(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
        const key = chatCopyKey(chaId, chatId)
        const previous = saveQueues.get(key)
        const run = previous
            ? previous.then(() => saveChatNow(chaId, chatIndex, chatId, chat))
            : saveChatNow(chaId, chatIndex, chatId, chat)
        const settled = run.then(() => {}, () => {})
        saveQueues.set(key, settled)
        void settled.then(() => {
            if (saveQueues.get(key) === settled) saveQueues.delete(key)
        })
        return run
    }

    async function saveChatNow(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
        const key = chatCopyKey(chaId, chatId)
        // Freeze exactly what this request sends before any await. Streaming
        // may keep mutating the UI while gzip/network/fallback is in flight.
        const snapshot = snapshotChat(chat)
        const outgoing = snapshot ?? chat
        const messages = outgoing.message ?? []
        // Fingerprints, delta body and encoding are all taken synchronously
        // below, so they describe the same chat content even if it keeps
        // changing (streaming) while the request is in flight.
        const fingerprints = messageFingerprints(messages)
        const known = serverFingerprints.get(key)
        let shared = 0
        if (known) {
            const max = Math.min(known.length, fingerprints.length)
            while (shared < max && known[shared] === fingerprints[shared]) shared++
        }
        if (shared > 0) {
            const delta = { ...outgoing, message: messages.slice(shared) }
            const outcome = await transport.saveChatContentDelta(chaId, chatIndex, chatId, delta, {
                count: shared,
                fp: prefixFingerprint(fingerprints, shared),
            })
            if (outcome === 'ok') {
                serverFingerprints.set(key, fingerprints)
                if (snapshot && isUsableCopy(snapshot)) await persistCopy(key, snapshot)
                return
            }
            // The server holds something else (another device, a server-side
            // write): fall through to a full save, as before delta sync.
        }
        const outcome = await transport.saveChatContentDelta(chaId, chatIndex, chatId, outgoing, null)
        if (outcome !== 'ok') throw new Error('Server did not accept the full chat save')
        serverFingerprints.set(key, fingerprints)
        if (snapshot && isUsableCopy(snapshot)) await persistCopy(key, snapshot)
    }

    return { fetchChat, saveChat }
}
