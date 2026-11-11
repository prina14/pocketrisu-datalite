// @vitest-environment node
import { afterAll, expect, test } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
    expect(res.headers.get('server-timing')).toMatch(/read-compress-compare;dur=/)
    expect(res.headers.get('x-read-compare-bytes')).not.toBeNull()
    expect(Number(res.headers.get('x-read-compare-bytes'))).toBeLessThan(next.length)
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
    expect(res.headers.get('server-timing')).toMatch(/read-encode;dur=/)
    expect(res.headers.get('x-read-compare-bytes')).not.toBeNull()
    expect(Number(res.headers.get('x-read-compare-bytes'))).toBeLessThan(base.length)
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

test('wire-size selection keeps the full response when its gzip beats a raw-smaller delta; identity still uses delta', async () => {
    const { client } = await boot()
    const key = 'plugin-storage/' + Buffer.from('compressible').toString('base64url')
    const next = Buffer.concat(Array.from({ length: 8 }, (_, i) => Buffer.alloc(32768, 65 + i)))
    const base = Buffer.concat([Buffer.alloc(5 * 32768, 90), next.subarray(5 * 32768)])
    const write = await client.fetch('/api/write', { method: 'POST', headers: {
        'file-path': hex(key), 'content-type': 'application/octet-stream',
    }, body: next })
    expect(write.status).toBe(200); await write.text()
    const manifest = JSON.stringify(makeManifest(base, hash))
    for (const encoding of ['gzip', 'br', 'identity']) {
        const res = await client.fetch('/api/read-delta', { method: 'POST', headers: {
            'file-path': hex(key), 'content-type': 'application/json', 'accept-encoding': encoding,
        }, body: manifest })
        expect(res.status).toBe(200)
        const body = Buffer.from(await res.arrayBuffer())
        if (encoding !== 'identity') {
            expect(res.headers.get('x-read-transfer')).toBe('full')
            expect(Number(res.headers.get('x-read-compare-bytes'))).toBe(next.length)
            expect(hash(body)).toBe(hash(next))
        } else {
            expect(res.headers.get('x-read-transfer')).toBe('delta')
            expect(res.headers.get('x-read-compare-bytes')).toBeNull()
            expect(body.length).toBeLessThan(next.length * 0.8)
            expect(hash(applyDelta(base, body, hash))).toBe(hash(next))
        }
    }
})

test('a Brotli delta does not wait for the pending whole-DB compression', async () => {
    const preload = fileURLToPath(new URL('./compat/helpers/slow-brotli-preload.cjs', import.meta.url))
    const srv = await spawnServer({ env: { NODE_OPTIONS: `--require=${preload}` } }); servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    const key = 'database/database.bin'
    const extra = randomBytes(6 * 1024 * 1024).toString('base64')
    const packr = new Packr({ useRecords: false })
    const header = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
    async function write(username: string) {
        const body = Buffer.concat([header, packr.encode({ characters: [], botPresets: [], personas: [], pluginCustomStorage: {}, username, extra })])
        const res = await client.fetch('/api/write', { method: 'POST', headers: {
            'file-path': hex(key), 'content-type': 'application/octet-stream',
        }, body })
        expect(res.ok).toBe(true); await res.text()
    }
    async function read() {
        const res = await client.fetch('/api/read', { headers: { 'file-path': hex(key), 'accept-encoding': 'identity' } })
        expect(res.ok).toBe(true)
        return { bytes: Buffer.from(await res.arrayBuffer()), etag: res.headers.get('x-db-etag')! }
    }
    await write('before')
    const base = await read()
    // Larger than the former 16 KiB compressed shortcut limit; it still must
    // not wait for a pending full-DB Brotli artifact.
    await write(randomBytes(24000).toString('base64'))
    const current = await read()
    const marker = path.join(srv.cwd, 'pending-brotli-' + hash(current.bytes))
    await expect.poll(() => readFile(marker, 'utf8').catch(() => 'missing'), { timeout: 8000 }).toBe('pending')
    const res = await client.fetch('/api/read-delta', { method: 'POST', headers: {
        'file-path': hex(key), 'content-type': 'application/json', 'accept-encoding': 'br', 'if-none-match': base.etag,
    }, body: JSON.stringify(makeManifest(base.bytes, hash)), signal: AbortSignal.timeout(5000) })
    expect(res.ok).toBe(true)
    expect(res.headers.get('x-read-snapshot')).toBe('hit')
    expect(res.headers.get('x-read-transfer')).toBe('delta')
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('x-db-etag')).toBe(current.etag)
    expect(res.headers.get('x-read-compare-policy')).toBe('small-cold-delta')
    expect(res.headers.get('x-read-compare-bytes')).toBe('0')
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(16 * 1024)
    expect(Number(res.headers.get('content-length'))).toBeLessThanOrEqual(64 * 1024)
    // Brotli may buffer the whole input for some data. Independence from the
    // shared full-snapshot promise is required even when early exit is absent.
    expect(Number(res.headers.get('x-read-compare-bytes'))).toBeLessThanOrEqual(current.bytes.length)
    const packet = Buffer.from(await res.arrayBuffer())
    expect(hash(applyDelta(base.bytes, packet, hash))).toBe(hash(current.bytes))
    expect(await readFile(marker, 'utf8')).toBe('pending')
}, 15_000)
