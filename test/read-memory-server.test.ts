// @vitest-environment node
import { afterAll, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient } from './compat/helpers/client.js'
import { createSeedBackup } from './compat/helpers/seed.js'
import { makeManifest } from '../server/node/readDelta.mjs'

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(s => s.cleanup())) })
const preload = path.resolve(import.meta.dirname, 'compat/helpers/count-db-reads-preload.cjs')
const dbKey = Buffer.from('database/database.bin').toString('hex')
const utils = require('../server/node/utils.cjs')

test('cold DB reads load once; warm, conditional and delta reads never fetch the full DB again', async () => {
    const srv = await spawnServer({ env: {
        NODE_OPTIONS: `--require=${preload}`,
        POCKETRISU_MEMORY_PROFILE: 'low',
    } })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    const countReads = async () => Number(await readFile(path.join(srv.cwd, 'db-read-count'), 'utf8').catch(() => '0'))
    const read = (headers = {}) => client.fetch('/api/read', { headers: { 'file-path': dbKey, ...headers } })

    // Fresh installations retain the empty response, with no invented version.
    const missing = await read()
    expect(missing.status).toBe(200)
    expect((await missing.arrayBuffer()).byteLength).toBe(0)
    expect(missing.headers.get('x-db-etag')).toBeNull()

    expect((await client.importBackup(createSeedBackup({ characterCount: 2 }))).ok).toBe(true)
    const beforeCold = await countReads()
    const first = await read()
    expect(first.status).toBe(200)
    const body = Buffer.from(await first.arrayBuffer())
    const etag = first.headers.get('x-db-etag')!
    const revision = first.headers.get('x-read-revision')!
    const afterCold = await countReads()
    expect(afterCold - beforeCold).toBe(1)
    const database = await utils.decodeRisuSave(body)
    expect(database.characters[0].chats[0]._stub).toBe(true)

    for (let i = 0; i < 3; i++) {
        const warm = await read()
        expect(warm.status).toBe(200)
        expect(Buffer.from(await warm.arrayBuffer())).toEqual(body)
        expect(warm.headers.get('x-db-etag')).toBe(etag)
        expect(warm.headers.get('x-read-revision')).toBe(revision)
    }
    const conditional = await read({ 'if-none-match': etag })
    expect(conditional.status).toBe(304)
    await conditional.arrayBuffer()
    const probe = await read({ 'x-read-check-only': '1', 'if-read-revision': revision })
    expect(probe.status).toBe(304)
    await probe.arrayBuffer()
    const manifest = makeManifest(body, (data: Uint8Array) => createHash('sha256').update(data).digest('hex'))
    const delta = await client.fetch('/api/read-delta', { method: 'POST', headers: {
        'file-path': dbKey, 'content-type': 'application/json', 'if-none-match': etag,
    }, body: JSON.stringify(manifest) })
    expect(delta.status).toBe(304)
    await delta.arrayBuffer()
    expect(await countReads()).toBe(afterCold)
})
