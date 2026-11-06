import { afterEach, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { getMemoryProfile, applySqliteMemoryProfile } = require('./memory-profile.cjs')
const MiB = 1024 * 1024
const GiB = 1024 * MiB

function profile(totalMemory: number, constrainedMemory = 0, requested?: string) {
    return getMemoryProfile({
        totalMemory,
        constrainedMemory,
        env: requested === undefined ? {} : { POCKETRISU_MEMORY_PROFILE: requested },
    })
}

describe('server memory profile', () => {
    test('automatically uses the low profile through 2 GiB of usable capacity', () => {
        expect(profile(951 * MiB).name).toBe('low')
        expect(profile(2 * GiB).name).toBe('low')
        expect(profile(2 * GiB + 1).name).toBe('standard')
        expect(profile(16 * GiB, GiB).name).toBe('low')
        expect(profile(GiB, 16 * GiB).name).toBe('low')
    })

    test('ignores unknown or invalid capacity limits', () => {
        for (const constraint of [0, -1, Infinity, NaN]) {
            expect(profile(8 * GiB, constraint).name).toBe('standard')
        }
        expect(profile(0, GiB).name).toBe('low')
        expect(profile(0, 0).name).toBe('standard')
    })

    test('honors explicit profiles and rejects an invalid override', () => {
        expect(profile(8 * GiB, 0, 'low').name).toBe('low')
        expect(profile(GiB, 0, 'standard').name).toBe('standard')
        expect(profile(GiB, 0, 'auto').name).toBe('low')
        expect(() => profile(GiB, 0, 'minimum')).toThrow('POCKETRISU_MEMORY_PROFILE must be auto, low, or standard')
    })

    const directories: string[] = []
    afterEach(() => {
        for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
    })

    test.each([
        { name: 'low', totalMemory: GiB, cacheKiB: 8192, mmapBytes: 0, tempStore: 1, assetBytes: 8 * MiB },
        { name: 'standard', totalMemory: 8 * GiB, cacheKiB: 64000, mmapBytes: 256 * MiB, tempStore: 2, assetBytes: 64 * MiB },
    ])('$name configures the actual SQLite connection and preserves stored data', ({ totalMemory, cacheKiB, mmapBytes, tempStore, assetBytes }) => {
        const directory = mkdtempSync(join(tmpdir(), 'pocketrisu-memory-'))
        directories.push(directory)
        const db = new Database(join(directory, 'data.db'))
        try {
            db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY, value BLOB NOT NULL)')
            const expected = Buffer.from('existing database payload')
            db.prepare('INSERT INTO kv VALUES (?, ?)').run('database/database.bin', expected)
            const selected = profile(totalMemory)
            applySqliteMemoryProfile(db, selected)
            expect(db.pragma('cache_size', { simple: true })).toBe(-cacheKiB)
            expect(db.pragma('mmap_size', { simple: true })).toBe(mmapBytes)
            expect(db.pragma('temp_store', { simple: true })).toBe(tempStore)
            expect(selected.assetManifestCacheBytes).toBe(assetBytes)
            expect((db.prepare('SELECT value FROM kv').get() as { value: Buffer }).value).toEqual(expected)
            db.exec('VACUUM')
            expect(db.pragma('temp_store', { simple: true })).toBe(tempStore)
        } finally {
            db.close()
        }
    })
})
