// @vitest-environment node
import { afterAll, expect, test } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient } from './compat/helpers/client.js'
import { makeManifest, applyDelta } from '../server/node/readDelta.mjs'
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(s => s.cleanup())) })
const hex = (key: string) => Buffer.from(key).toString('hex')
async function boot() {
    const srv = await spawnServer(); servers.push(srv)
    return { srv, client: await createClient(srv.port, srv.password) }
}

test('a changed large plugin key uses byte deltas, including the V2 bulk preload path', async () => {
    const { client } = await boot()
    const key = 'plugin-storage/' + Buffer.from('memory').toString('base64url')
    const oldText = randomBytes(2 * 1024 * 1024).toString('base64')
    async function write(text: string) {
        const res = await client.fetch('/api/write', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/octet-stream' }, body: text })
        expect(res.status).toBe(200); await res.text()
    }
    const old = Buffer.from(JSON.stringify(oldText))
    await write(old.toString())
    const read = await client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
    const etag = read.headers.get('x-storage-etag')!
    expect(read.headers.get('x-read-resource')).toBe('plugin-storage')
    await read.arrayBuffer()
    const next = Buffer.from(JSON.stringify(oldText.slice(0, 123456) + 'new memory' + oldText.slice(123456)))
    await write(next.toString())
    const manifest = makeManifest(old, hash)!
    const res = await client.fetch('/api/read-delta', { method: 'POST', headers: {
        'file-path': hex(key), 'content-type': 'application/json', 'content-encoding': 'gzip', 'if-none-match': etag,
    }, body: new Uint8Array(gzipSync(JSON.stringify(manifest))) })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-read-transfer')).toBe('delta')
    const packet = Buffer.from(await res.arrayBuffer())
    expect(packet.length).toBeLessThan(next.length * 0.05)
    // Comparing millions of individual bytes with the assertion formatter
    // blocks the test event loop long enough to expire HTTP keepalive sockets.
    expect(hash(applyDelta(old, packet, hash))).toBe(hash(next))
    const sync = await client.fetch('/api/plugin-storage/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versions: [['memory', etag]], readDelta: true }) })
    const lines = (await sync.text()).trim().split('\n').map(l => JSON.parse(l))
    expect(lines[0][1]).toEqual({ read: true })
    const unchanged = await client.fetch('/api/read-delta', { method: 'POST', headers: {
        'file-path': hex(key), 'content-type': 'application/json', 'if-none-match': hash(next),
    }, body: JSON.stringify(manifest) })
    expect(unchanged.status).toBe(304)
    expect((await unchanged.arrayBuffer()).byteLength).toBe(0)
})

test('main DB changes reconstruct exactly, with the current writer-lock validator', async () => {
    const { client } = await boot()
    const key = 'database/database.bin'
    const extra = randomBytes(3 * 1024 * 1024).toString('base64')
    const packr = new Packr({ useRecords: false })
    const header = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
    async function write(username: string) {
        const body = Buffer.concat([header, packr.encode({ characters: [], botPresets: [], personas: [], pluginCustomStorage: {}, username, extra })])
        const res = await client.fetch('/api/write', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/octet-stream' }, body })
        expect(res.status).toBe(200); await res.text()
    }
    await write('before')
    const first = await client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
    const etag = first.headers.get('x-db-etag')!
    const base = Buffer.from(await first.arrayBuffer())
    await write('after the edit')
    const res = await client.fetch('/api/read-delta', { method: 'POST', headers: {
        'file-path': hex(key), 'content-type': 'application/json', 'if-none-match': etag,
    }, body: JSON.stringify(makeManifest(base, hash)) })
    expect(res.headers.get('x-read-resource')).toBe('database')
    expect(res.headers.get('x-read-transfer')).toBe('delta')
    expect(res.headers.get('x-db-etag')).not.toBe(etag)
    const packet = Buffer.from(await res.arrayBuffer())
    const full = await client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
    expect(hash(applyDelta(base, packet, hash))).toBe(hash(Buffer.from(await full.arrayBuffer())))
    expect(packet.length).toBeLessThan(base.length * 0.05)
})

test('authentication and manifest validation precede reading; unrelated values use full responses', async () => {
    const { srv, client } = await boot()
    const anonymous = await fetch(`http://127.0.0.1:${srv.port}/api/read-delta`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(anonymous.status).not.toBe(200)
    const invalid = await client.fetch('/api/read-delta', { method: 'POST', headers: { 'file-path': hex('database/database.bin'), 'content-type': 'application/json' }, body: '{}' })
    expect(invalid.status).toBe(400)
    await invalid.text()
    const key = 'plugin-storage/' + Buffer.from('changed').toString('base64url')
    const value = randomBytes(150000)
    const write = await client.fetch('/api/write', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/octet-stream' }, body: value })
    expect(write.status).toBe(200); await write.text()
    const res = await client.fetch('/api/read-delta', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/json' }, body: JSON.stringify(makeManifest(randomBytes(150000), hash)) })
    expect(res.headers.get('x-read-transfer')).toBe('full')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(value)
})
