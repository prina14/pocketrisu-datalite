/** Rank metadata only; never hydrate chats or record an interaction. */
export function recentCharacters<T extends { chaId: string; lastInteraction?: number; trashTime?: number }>(characters: T[] | undefined, activity: Record<string, number>, limit = 3) {
    return (characters ?? []).flatMap((character, index) => character && !character.trashTime
        ? [{ character, index, time: Math.max(character.lastInteraction ?? 0, activity[character.chaId] ?? 0) }] : [])
        .filter(entry => entry.time > 0)
        .sort((a, b) => b.time - a.time || a.index - b.index)
        .slice(0, limit)
}
