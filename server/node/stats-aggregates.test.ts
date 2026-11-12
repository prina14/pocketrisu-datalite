import { expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const dbSource = readFileSync('server/node/db.cjs', 'utf8')
const serverSource = readFileSync('server/node/server.cjs', 'utf8')

test('numeric prefix aggregates equal the existing list read for literal and Unicode prefixes', () => {
    const db = new Database(':memory:')
    try {
        db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL)')
        const insert = db.prepare('INSERT INTO kv VALUES (?,?)')
        for (const [i, key] of ['assets/a', 'assets/A', 'assets/a%', 'assets/a_', 'assets/文', 'assets0', 'literal%한/item', 'literal_한/item', 'literal한/item', '문서/a', '문서/b'].entries()) {
            insert.run(key, Buffer.alloc(i))
        }
        const statements = ['stmtKvRangeSizes', 'stmtKvPrefixSizes', 'stmtKvRangeStats', 'stmtKvPrefixStats']
            .map(name => dbSource.split('\n').find(line => line.startsWith(`const ${name} =`))).join('\n')
        const helpers = dbSource.slice(dbSource.indexOf('function prefixRange('), dbSource.indexOf('function kvDelPrefix('))
        const methods = dbSource.slice(dbSource.indexOf('function kvListWithSizes('), dbSource.indexOf('function checkpointWal('))
        const context: any = { db }
        vm.runInNewContext(statements + '\n' + helpers + '\n' + methods, context)
        for (const prefix of ['assets/', 'assets/a', 'missing/', '', '문서', 'literal%한', 'literal_한']) {
            const list = context.kvListWithSizes(prefix)
            expect(context.kvPrefixStats(prefix)).toEqual({ count: list.length, totalSize: list.reduce((sum: number, row: any) => sum + row.size, 0) })
        }
    } finally { db.close() }
})

test('backup estimate can reuse exact per-request totals without rereading them, including zero', async () => {
    const start = serverSource.indexOf('async function estimateServerBackupSize(')
    const end = serverSource.indexOf("app.get('/api/db/stats'", start)
    const size = vi.fn((key: string) => key === 'database/database.bin' ? 100 : key === 'archive/a' ? 13 : 17)
    const sums = vi.fn((prefix: string) => ({ totalSize: prefix === 'assets/' ? 30 : 2 }))
    const files = vi.fn(async () => 19)
    const plugins = vi.fn(() => [{ size: 7 }]), cold = vi.fn(() => [{ size: 11 }])
    const context: any = { kvSize: size, kvPrefixStats: sums, pluginStorage: { list: plugins },
        listColdStorageBackupEntries: cold, kvList: () => ['archive/a', 'archive/b'],
        sumInlayFsBytes: files, DB_BLOB_KEY: 'database/database.bin', ARCHIVE_PREFIX: 'archive/' }
    vm.runInNewContext(serverSource.slice(start, end), context)
    expect(await context.estimateServerBackupSize()).toBe(199)
    expect(size).toHaveBeenCalledTimes(3)
    expect(sums).toHaveBeenCalledTimes(2)
    expect(files).toHaveBeenCalledOnce()
    size.mockClear(); sums.mockClear(); files.mockClear()
    expect(await context.estimateServerBackupSize({ dbBlobSize: 100, assetsBytes: 30, inlayMetaBytes: 2, archiveBytes: 30, inlayFsBytes: 19 })).toBe(199)
    expect(size).not.toHaveBeenCalled(); expect(sums).not.toHaveBeenCalled(); expect(files).not.toHaveBeenCalled()
    expect(await context.estimateServerBackupSize({ dbBlobSize: 0, assetsBytes: 0, inlayMetaBytes: 0, archiveBytes: 0, inlayFsBytes: 0 })).toBe(18)
    expect(size).not.toHaveBeenCalled(); expect(sums).not.toHaveBeenCalled(); expect(files).not.toHaveBeenCalled()
    expect(plugins).toHaveBeenCalledTimes(3); expect(cold).toHaveBeenCalledTimes(3)
})
