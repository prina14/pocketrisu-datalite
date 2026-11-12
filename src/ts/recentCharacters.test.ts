import { describe, expect, it } from 'vitest'
import { recentCharacters } from './recentCharacters'

describe('recent home characters', () => {
    it('uses activity metadata, excludes trash and limits without mutating the database', () => {
        const characters = [
            { chaId: 'a', lastInteraction: 10 },
            { chaId: 'b', lastInteraction: 20, trashTime: 1 },
            { chaId: 'c', lastInteraction: 5 },
            { chaId: 'd', lastInteraction: 30 },
            { chaId: 'e', lastInteraction: 40 },
            { chaId: 'unused' },
        ]
        const before = structuredClone(characters)
        expect(recentCharacters(characters, { c: 50 }).map(c => c.character.chaId)).toEqual(['c', 'e', 'd'])
        expect(characters).toEqual(before)
    })
})
