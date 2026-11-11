// @vitest-environment node
import { afterAll, expect, test } from 'vitest'
import { writeFile, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient } from './compat/helpers/client.js'
const utils = require('../server/node/utils.cjs')
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(s => s.cleanup())) })
const key = Buffer.from('database/database.bin').toString('hex')
const db = () => ({ characters: [], botPresets: [], personas: [], pluginCustomStorage: {}, username: 'same' })
async function boot() {
    const server = await spawnServer({ seedSave: dir => writeFile(path.join(dir, key), utils.encodeRisuSaveLegacy(db())) })
    servers.push(server)
    return { server, client: await createClient(server.port, server.password) }
}
const headers = { 'file-path': key, 'x-read-check-only': '1' }

test('cold load, metadata reads and warm encodings do not change the content revision', async () => {
    const { client } = await boot()
    const initial = await client.fetch('/api/read', { headers })
    const revision = initial.headers.get('x-read-revision')!
    await initial.text()
    const preview = await client.fetch('/api/startup-preview'); await preview.text()
    const full = await client.fetch('/api/read', { headers: { 'file-path': key } }); await full.arrayBuffer()
    const same = await client.fetch('/api/read', { headers: { ...headers, 'if-read-revision': revision } })
    expect(same.status).toBe(304)
    expect(same.headers.get('x-read-revision')).toBe(revision)
})

test('opening metadata is authenticated, conditional and leaves DB content and writer lock untouched', async () => {
    const { server, client } = await boot()
    const before = await client.fetch('/api/read', { headers }); const revision = before.headers.get('x-read-revision')!; await before.text()
    const anonymous = await fetch(`http://127.0.0.1:${server.port}/api/character-activity`)
    expect(anonymous.ok).toBe(false); await anonymous.text()
    const session = await client.fetch('/api/session', { method: 'POST', headers: { 'x-session-id': 'pc' } }); await session.text()
    const state = async () => (await (await client.fetch('/api/session/lock-status', { headers: { 'x-session-id': 'pc' } })).json()).state
    const oldState = await state()
    const save = await client.fetch('/api/character-activity', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': 'phone', 'x-user-active': '1' }, body: JSON.stringify({ ids: ['alice', 'bob'] }) })
    expect(save.ok).toBe(true); expect((await save.json()).entries).toHaveLength(2)
    expect(await state()).toBe(oldState)
    const meta = await client.fetch('/api/character-activity'); const etag = meta.headers.get('etag')!
    expect((await meta.json()).entries).toHaveLength(2)
    expect((await client.fetch('/api/character-activity', { headers: { 'if-none-match': etag } })).status).toBe(304)
    expect((await client.fetch('/api/read', { headers: { ...headers, 'if-read-revision': revision } })).status).toBe(304)
    const full = await client.fetch('/api/read', { headers: { 'file-path': key } })
    const value = await utils.decodeRisuSave(new Uint8Array(await full.arrayBuffer()))
    expect(value.characters).toEqual([])
    expect(value.username).toBe('same')
})

test('same-value patches preserve validators while a real pending edit immediately invalidates them', async () => {
    const { client } = await boot()
    const full = await client.fetch('/api/read', { headers: { 'file-path': key } })
    const value = utils.normalizeJSON(await utils.decodeRisuSave(new Uint8Array(await full.arrayBuffer())))
    const revision = full.headers.get('x-read-revision')!
    const etag = full.headers.get('x-db-etag')!
    const patch = (name: string) => client.fetch('/api/patch', { method: 'POST', headers: { 'file-path': key, 'content-type': 'application/json' }, body: JSON.stringify({
        patch: [{ op: 'replace', path: '/username', value: name }], expectedHash: utils.calculateHash(value).toString(16),
    }) })
    const noop = await patch('same'); expect(noop.ok).toBe(true); expect((await noop.json()).unchanged).toBe(true)
    expect((await client.fetch('/api/read', { headers: { ...headers, 'if-read-revision': revision } })).status).toBe(304)
    const changed = await patch('actually changed'); expect(changed.ok).toBe(true); await changed.text()
    const probe = await client.fetch('/api/read', { headers: { ...headers, 'if-read-revision': revision, 'if-none-match': etag } })
    expect(probe.status).toBe(200); await probe.text()
})

test('a validated persisted startup index serves names and unchanged bytes after a process restart', async () => {
    const { server, client } = await boot()
    const first = await client.fetch('/api/read', { headers: { 'file-path': key } })
    const revision = first.headers.get('x-read-revision')!, etag = first.headers.get('x-db-etag')!
    await first.arrayBuffer()
    const temp = await mkdtemp(path.join(tmpdir(), 'risu-startup-index-'))
    const snapshot = path.join(temp, 'snapshot.db')
    const connection = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    try { await connection.backup(snapshot) } finally { connection.close() }
    try {
        const restored = await spawnServer({ seedSave: save => copyFile(snapshot, path.join(save, 'risuai.db')) }); servers.push(restored)
        const fresh = await createClient(restored.port, restored.password)
        const preview = await fresh.fetch('/api/startup-preview')
        expect(preview.headers.get('x-startup-preview-cache')).toBe('hit')
        expect(await preview.json()).toMatchObject({ ready: true, total: 0 })
        const check = await fresh.fetch('/api/read', { headers: { ...headers, 'if-read-revision': revision, 'if-none-match': etag } })
        expect(check.status).toBe(304)
        expect(check.headers.get('x-read-index-validator')).toBe('1')
        expect(check.headers.get('x-read-revision')).not.toBe(revision)
        expect(check.headers.get('server-timing')).not.toContain('read-encode')
    } finally { await rm(temp, { recursive: true, force: true }) }
})
