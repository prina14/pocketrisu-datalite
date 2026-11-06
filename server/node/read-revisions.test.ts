import { expect, test } from 'vitest'
import Database from 'better-sqlite3'
const { createReadRevisions } = require('./read-revisions.cjs')
const { createChunkStore } = require('./chunkStore.cjs')
function setup() {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)')
    const put = db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?, 1)')
    return { db, put }
}
test('existing data is seeded; reads do not change versions; same timestamp writes do', () => {
    const { db, put } = setup()
    put.run('plugin-storage/a', Buffer.from('old'))
    const revision = createReadRevisions(db)
    const first = revision('plugin-storage/a')
    expect(first).toBeTruthy()
    expect(revision('plugin-storage/a')).toBe(first)
    put.run('plugin-storage/a', Buffer.from('new'))
    expect(revision('plugin-storage/a')).not.toBe(first)
    put.run('assets/unrelated', Buffer.from('x'))
    expect(revision('assets/unrelated')).toBeNull()
    db.close()
})
test('rollback, direct SQL restore, removal and recreation cannot falsely match', () => {
    const { db, put } = setup(), revision = createReadRevisions(db)
    put.run('database/database.bin', Buffer.from('before'))
    const first = revision('database/database.bin')
    expect(() => db.transaction(() => { put.run('database/database.bin', Buffer.from('aborted')); throw Error('rollback') })()).toThrow()
    expect(revision('database/database.bin')).toBe(first)
    db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(Buffer.from('restore'), 'database/database.bin')
    expect(revision('database/database.bin')).not.toBe(first)
    db.prepare('DELETE FROM kv').run()
    expect(revision('database/database.bin')).toBeNull()
    put.run('database/database.bin', Buffer.from('before'))
    expect(revision('database/database.bin')).not.toBe(first)
    expect(createReadRevisions(db)('database/database.bin')).not.toBe(revision('database/database.bin'))
    db.close()
})
test('chunked database marker rewrites still advance the version', () => {
    const { db } = setup(), revision = createReadRevisions(db)
    const chunks = createChunkStore(db, { threshold: 64 })
    chunks.putValue('database/database.bin', Buffer.alloc(1000, 1))
    const before = revision('database/database.bin')
    const marker = db.prepare('SELECT value FROM kv WHERE key = ?').get('database/database.bin') as any
    chunks.putValue('database/database.bin', Buffer.alloc(1000, 2))
    expect(revision('database/database.bin')).not.toBe(before)
    expect((db.prepare('SELECT value FROM kv WHERE key = ?').get('database/database.bin') as any).value).toEqual(marker.value)
    db.close()
})
