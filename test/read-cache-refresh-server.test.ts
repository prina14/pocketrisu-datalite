// @vitest-environment node
import { afterAll, expect, test } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient } from './compat/helpers/client.js'
const utils = require('../server/node/utils.cjs')
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

test('optional copy reads reuse patch bytes without flushing; normal reads still persist and revalidate', async () => {
    const name = 'database/database.bin', key = Buffer.from(name).toString('hex')
    const seed = { characters: [], botPresets: [], personas: [], pluginCustomStorage: {}, username: 'before' }
    const server = await spawnServer({ seedSave: dir => writeFile(path.join(dir, key), utils.encodeRisuSaveLegacy(seed)) })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const read = await client.fetch('/api/read', { headers: { 'file-path': key } })
    const decoded = await utils.decodeRisuSave(new Uint8Array(await read.arrayBuffer()))
    const disk = new Database(path.join(server.cwd, 'save/risuai.db'), { readonly: true })
    const diskToken = () => disk.prepare('SELECT hex(token) AS token FROM datalite_read_revisions WHERE key = ?').get(name).token
    try {
        const before = diskToken()
        const patch = await client.fetch('/api/patch', { method: 'POST', headers: { 'file-path': key, 'content-type': 'application/json' }, body: JSON.stringify({ patch: [{ op: 'replace', path: '/username', value: 'after' }], expectedHash: utils.calculateHash(utils.normalizeJSON(decoded)).toString(16) }) })
        expect(patch.ok).toBe(true); const accepted = await patch.json()
        const memory = await client.fetch('/api/read', { headers: { 'file-path': key, 'x-read-cache-refresh': '1' } })
        expect(memory.headers.get('x-read-persist-policy')).toBe('memory-view')
        expect(memory.headers.get('x-read-snapshot')).toBe('hit')
        expect(memory.headers.get('x-db-etag')).toBe(accepted.etag)
        const revision = memory.headers.get('x-read-revision')!
        expect(revision).toContain('.pending.')
        expect((await utils.decodeRisuSave(new Uint8Array(await memory.arrayBuffer()))).username).toBe('after')
        expect(diskToken()).toBe(before)
        const normal = await client.fetch('/api/read', { headers: { 'file-path': key } }); await normal.arrayBuffer()
        expect(diskToken()).not.toBe(before)
        const check = await client.fetch('/api/read', { headers: { 'file-path': key, 'x-read-check-only': '1', 'if-read-revision': revision, 'if-none-match': accepted.etag } })
        expect(check.status).toBe(304)
        expect(check.headers.get('x-read-index-validator')).toBe('1')
        expect(check.headers.get('x-read-revision')).not.toContain('.pending.')
    } finally { disk.close() }
})
