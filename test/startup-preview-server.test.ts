// @vitest-environment node
import { afterAll, expect, test } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient } from './compat/helpers/client.js'
import { encodeBackup } from './compat/helpers/encode.js'
import { makeManifest, applyDelta } from '../server/node/readDelta.mjs'
const utils = require('../server/node/utils.cjs')
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })
const key = 'database/database.bin'
const hex = (value: string) => Buffer.from(value).toString('hex')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function boot() {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    const write = async (db: any) => {
        const res = await client.fetch('/api/write', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/octet-stream' }, body: utils.encodeRisuSaveLegacy(db) })
        expect(res.ok).toBe(true); await res.text()
    }
    return { server, client, write }
}

test('a bounded authenticated first-screen index excludes large fields, media, trashed entries and writer changes', async () => {
    const { server, client, write } = await boot()
    const db = { characters: Array.from({ length: 100 }, (_, i) => ({ chaId: 'c' + i, name: 'name-' + i + '\0'.repeat(200), trashTime: i === 0 ? 1 : 0, desc: 'secret description', chats: [] })),
        botPresets: [], personas: [], pluginCustomStorage: {}, extra: randomBytes(1_000_000).toString('base64') }
    await write(db)
    const url = `http://127.0.0.1:${server.port}/api/startup-preview`
    for (const headers of [{}, { 'risu-auth': 'invalid' }, { cookie: 'risu-session=invalid' }]) {
        const res = await fetch(url, { headers })
        expect(await res.json()).toEqual({ v: 1, ready: false })
        expect(res.headers.get('set-cookie')).toBeNull()
    }
    const session = await client.fetch('/api/session', { method: 'POST', headers: { 'x-session-id': 'pc' } })
    const cookie = session.headers.get('set-cookie')!.split(';')[0]
    await session.text()
    const lock = async () => (await (await client.fetch('/api/session/lock-status', { headers: { 'x-session-id': 'pc' } })).json()).state
    const before = await lock()
    for (const res of [await client.fetch('/api/startup-preview'), await fetch(url, { headers: { cookie, 'x-session-id': 'phone', 'x-user-active': '1' } })]) {
        const text = await res.text(), preview = JSON.parse(text)
        expect(Buffer.byteLength(text)).toBeLessThan(32 * 1024)
        expect(preview).toMatchObject({ v: 1, ready: true, total: 99 })
        expect(preview.names).toHaveLength(40)
        expect(preview.names[0]).toMatch(/^name-1/)
        expect(preview.names.every((n: string) => n.length <= 128)).toBe(true)
        expect(text).not.toContain('secret description')
        expect(text).not.toContain(db.extra.slice(0, 200))
        expect(res.headers.get('set-cookie')).toBeNull()
        expect(res.headers.get('cache-control')).toContain('no-store')
    }
    expect(await lock()).toBe(before)
})

test('index and prepared body follow edits, deletions and backup restore without stale names or validators', async () => {
    const { client, write } = await boot()
    const db = (name: string) => ({ characters: [{ chaId: 'a', name, chats: [] }], botPresets: [], personas: [], pluginCustomStorage: {}, username: name })
    await write(db('before'))
    const get = () => client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
    const first = await get(), old = Buffer.from(await first.arrayBuffer()), oldEtag = first.headers.get('x-db-etag')!
    const cached = await get()
    expect(cached.headers.get('x-read-snapshot')).toBe('hit')
    expect(hash(new Uint8Array(await cached.arrayBuffer()))).toBe(hash(old))
    const normalized = utils.normalizeJSON(await utils.decodeRisuSave(old))
    const patch = await client.fetch('/api/patch', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/json' }, body: JSON.stringify({
        patch: [{ op: 'replace', path: '/characters/0/name', value: 'after' }], expectedHash: utils.calculateHash(normalized).toString(16),
    }) })
    expect(patch.ok).toBe(true); await patch.text()
    expect((await (await client.fetch('/api/startup-preview')).json()).names).toEqual(['after'])
    const after = await get()
    expect(after.headers.get('x-db-etag')).not.toBe(oldEtag)
    expect((await utils.decodeRisuSave(new Uint8Array(await after.arrayBuffer()))).characters[0].name).toBe('after')
    const imported = await client.importBackup(encodeBackup([{ name: 'database.risudat', data: Buffer.from(utils.encodeRisuSaveLegacy(db('restored'))) }]))
    expect(imported.ok).toBe(true)
    expect((await (await client.fetch('/api/startup-preview')).json()).names).toEqual(['restored'])
    const restored = await get()
    expect((await utils.decodeRisuSave(new Uint8Array(await restored.arrayBuffer()))).characters[0].name).toBe('restored')
})

test('import-blocked bootstrap does not load or return the character index', async () => {
    const server = await spawnServer({ seedSave: async save => {
        const staging = path.join(save, 'account_import_staging')
        await mkdir(staging)
        await writeFile(path.join(staging, 'meta.json'), JSON.stringify({ accountId: 'fixture', startedAt: Date.now() }))
    } }); servers.push(server)
    const client = await createClient(server.port, server.password)
    expect((await (await client.fetch('/api/risu-account/status')).json()).blocking).toBe(true)
    const res = await client.fetch('/api/startup-preview')
    expect(await res.json()).toEqual({ v: 1, ready: false })
    expect(res.headers.get('server-timing')).not.toContain('preview-list')
})

test('cached gzip, identity and prepared deltas keep identical bytes and integrity; gzip q=0 stays unencoded', async () => {
    const { client, write } = await boot()
    const extra = randomBytes(300_000).toString('base64')
    const db = (username: string) => ({ characters: [], botPresets: [], personas: [], pluginCustomStorage: {}, username, extra })
    await write(db('old'))
    const read = (encoding: string) => client.fetch('/api/read', { headers: { 'file-path': hex(key), 'accept-encoding': encoding } })
    const first = await read('gzip'), base = Buffer.from(await first.arrayBuffer())
    const gzip = await read('gzip')
    expect(gzip.headers.get('content-encoding')).toBe('gzip')
    expect(gzip.headers.get('x-read-snapshot')).toBe('hit')
    expect(gzip.headers.get('server-timing')).toContain('read-compress')
    expect(hash(Buffer.from(await gzip.arrayBuffer()))).toBe(hash(base))
    const identity = await read('gzip;q=0, identity')
    expect(identity.headers.get('content-encoding')).toBeNull()
    expect(hash(Buffer.from(await identity.arrayBuffer()))).toBe(hash(base))
    await write(db('edited'))
    const current = await read('gzip'), expected = Buffer.from(await current.arrayBuffer())
    for (let i = 0; i < 2; i++) {
        const delta = await client.fetch('/api/read-delta', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/json', 'accept-encoding': 'gzip' }, body: JSON.stringify(makeManifest(base, hash)) })
        expect(delta.headers.get('x-read-delta')).toBe('1')
        expect(delta.headers.get('x-read-snapshot')).toBe('hit')
        expect(delta.headers.get('x-read-compare-bytes')).toBe('0')
        expect(hash(applyDelta(base, new Uint8Array(await delta.arrayBuffer()), hash))).toBe(hash(expected))
    }
})
