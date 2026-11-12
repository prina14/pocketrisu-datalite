import { expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

const source = readFileSync('server/node/server.cjs', 'utf8')

test('dashboard overview leaves unscanned cleanup results unavailable', async () => {
    const start = source.indexOf("app.get('/api/db/stats',")
    const end = source.indexOf("app.get('/api/db/stats/characters'", start)
    let handler: any
    const json = vi.fn(), next = vi.fn()
    const scan = vi.fn(() => { throw Error('unexpected reference scan') })
    vm.runInNewContext(source.slice(start, end), {
        app: { get: (_: string, callback: any) => { handler = callback } },
        checkAuth: async () => true, path, process, statSafe: () => ({ size: 10 }),
        diskFreeStat: async () => ({ free: 123, total: 456 }), backupsDir: '/backups', DEFAULT_BACKUPS_DIR: '/backups',
        estimateServerBackupSize: async () => 99, sumInlayFsBytes: async () => 0,
        sqliteDb: { pragma: () => 0, prepare: () => ({ get: () => ({ c: 0, b: 0, s: 0 }) }) },
        DB_BLOB_KEY: 'database/database.bin', DB_BACKUP_PREFIX: 'database/dbbackup-', ASSET_PREFIXES: [],
        DB_HEX_KEY: 'db', dbCache: { db: { characters: [] } }, dbEtag: 'fixture',
        kvSize: () => 0, kvList: () => [], snapshotPluginSizer: () => () => ({ bytes: 0 }),
        isDbBlobChunked: () => true, archivedStubsOf: () => [], fs: { readdir: async () => [] },
        reclaimableChunkBytes: scan, listOrphanArchiveRows: scan, buildUncleanableSet: scan,
        logger: { warn: scan },
    })
    await handler({ query: { scope: 'overview' } }, { json }, next)
    expect(next).not.toHaveBeenCalled()
    expect(scan).not.toHaveBeenCalled()
    expect(json.mock.calls[0][0]).toMatchObject({
        detailed: false, chunks: { orphanBytes: null },
        orphan: { available: false }, archiveOrphan: { available: false },
    })
})

test('backup capacity request returns before the database/reference scans', async () => {
    const start = source.indexOf("app.get('/api/db/stats',")
    const end = source.indexOf("app.get('/api/db/stats/characters'", start)
    let handler: any
    const json = vi.fn()
    const next = vi.fn()
    const disk = { free: 123, total: 456 }
    const estimate = vi.fn(async () => 99)
    vm.runInNewContext(source.slice(start, end), {
        app: { get: (_: string, callback: any) => { handler = callback } },
        checkAuth: async () => true, path, process, statSafe: () => ({ size: 10 }),
        diskFreeStat: async () => disk, backupsDir: '/backups', DEFAULT_BACKUPS_DIR: '/backups',
        estimateServerBackupSize: estimate,
        sqliteDb: { pragma: () => { throw Error('unexpected database scan') } },
    })
    await handler({ query: { scope: 'backup' } }, { json }, next)
    expect(next).not.toHaveBeenCalled()
    expect(estimate).toHaveBeenCalledOnce()
    expect(json.mock.calls[0][0]).toMatchObject({ disk, estimatedBackupSize: 99 })
})

test('large chat preparation is skipped, while foreground and small deltas still work', () => {
    const start = source.indexOf('function sendChatContent(')
    const end = source.indexOf("app.get('/api/chat-content", start)
    const context: any = {
        Buffer, readChatDeltaBase: (req: any) => req.base,
        chatPrefixMatches: () => true,
        encodeRisuSaveLegacy: (chat: any) => Buffer.alloc(chat.message.length * 1024 * 1024),
    }
    vm.runInNewContext(source.slice(start, end), context)
    const response = () => {
        const res: any = { setHeader: vi.fn(), send: vi.fn(), end: vi.fn() }
        res.status = vi.fn(() => res)
        return res
    }
    const chat = { message: [1, 2, 3] }
    const background = response()
    context.sendChatContent({ headers: { 'x-chat-prefetch': '1' } }, background, chat)
    expect(background.status).toHaveBeenCalledWith(204)
    expect(background.send).not.toHaveBeenCalled()
    const foreground = response()
    context.sendChatContent({ headers: {} }, foreground, chat)
    expect(foreground.send.mock.calls[0][0].length).toBe(3 * 1024 * 1024)
    const delta = response()
    context.sendChatContent({ headers: { 'x-chat-prefetch': '1' }, base: { count: 2 } }, delta, chat)
    expect(delta.send.mock.calls[0][0].length).toBe(1024 * 1024)
    expect(delta.setHeader).toHaveBeenCalledWith('x-chat-delta-base', '2')
})
