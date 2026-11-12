import { get } from 'svelte/store'
import { characterActivity } from './characterActivity'
import { DBState, selectedCharID } from './stores.svelte'
import { recentCharacters } from './recentCharacters'
import { loadSettings } from './settingsLoader'
import { measureStartupPhase } from './startup'

/** Start after the UI frame; foreground input always takes priority. */
export function warmNavigation() {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return
    const controller = new AbortController()
    const stop = () => controller.abort()
    const hidden = () => { if (document.hidden) stop() }
    window.addEventListener('pointerdown', stop, { once: true, capture: true })
    window.addEventListener('keydown', stop, { once: true, capture: true })
    document.addEventListener('visibilitychange', hidden)
    const timer = window.setTimeout(async () => {
        try {
            if (controller.signal.aborted || document.hidden) return
            await measureStartupPhase('settings-prefetch', loadSettings)
            if (!globalThis.__NODE__ || controller.signal.aborted || get(selectedCharID) !== -1) return
            const { prefetchChatCopy } = await import('./storage/chatStorage')
            for (const { character } of recentCharacters(DBState.db.characters, get(characterActivity))) {
                if (controller.signal.aborted || document.hidden || get(selectedCharID) !== -1) break
                const index = character.chatPage ?? 0
                const chat = character.chats?.[index]
                if (chat?._placeholder && chat.id) {
                    await measureStartupPhase('recent-chat-prefetch', () => prefetchChatCopy(character.chaId, index, chat.id, controller.signal))
                }
            }
        } catch { /* Speculation must never interrupt normal navigation. */ }
        finally {
            clearTimeout(deadline)
            window.removeEventListener('pointerdown', stop, true)
            window.removeEventListener('keydown', stop, true)
            document.removeEventListener('visibilitychange', hidden)
        }
    }, 2500)
    const deadline = window.setTimeout(() => { clearTimeout(timer); stop() }, 20_000)
}
