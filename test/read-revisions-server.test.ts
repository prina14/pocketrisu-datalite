// @vitest-environment node
import { afterAll, expect, test } from 'vitest'
import { Packr } from 'msgpackr'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient } from './compat/helpers/client.js'
import { encodeBackup } from './compat/helpers/encode.js'
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(s => s.cleanup())) })
const hex = (s: string) => Buffer.from(s).toString('hex')
const key = 'database/database.bin'
const packr = new Packr({ useRecords: false })
const utils = require('../server/node/utils.cjs')
function blob(username: string, plugins = {}) {
    return Buffer.concat([Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]), packr.encode({
        characters: [], botPresets: [], personas: [], pluginCustomStorage: plugins, username,
    })])
}
async function boot() {
    const srv = await spawnServer(); servers.push(srv)
    return { srv, client: await createClient(srv.port, srv.password) }
}

test('DB revision probe returns metadata only, detects writes and invalidates on backup import', async () => {
    const { client } = await boot()
    const write = async (name: string) => {
        const res = await client.fetch('/api/write', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/octet-stream' }, body: blob(name) })
        expect(res.status).toBe(200); await res.text()
    }
    const probe = (revision: string) => client.fetch('/api/read', { headers: { 'file-path': hex(key), 'x-read-check-only': '1', 'if-read-revision': revision } })
    await write('before')
    const read = await client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
    const revision = read.headers.get('x-read-revision')!
    expect(revision).toBeTruthy()
    const initial = Buffer.from(await read.arrayBuffer())
    const same = await probe(revision)
    expect(same.status).toBe(304)
    expect(same.headers.get('x-read-version-check')).toBe('1')
    expect(same.headers.get('x-db-etag')).toBeNull()
    expect(same.headers.get('x-read-full-bytes')).toBeNull()
    expect((await same.arrayBuffer()).byteLength).toBe(0)
    const baseline = utils.normalizeJSON(await utils.decodeRisuSave(initial))
    const patched = await client.fetch('/api/patch', { method: 'POST', headers: { 'file-path': hex(key), 'content-type': 'application/json' }, body: JSON.stringify({
        patch: [{ op: 'replace', path: '/username', value: 'pending-edit' }], expectedHash: utils.calculateHash(baseline).toString(16),
    }) })
    expect(patched.status).toBe(200); await patched.text()
    // The probe must account for acknowledged edits still awaiting debounce.
    const pending = await probe(revision)
    expect(pending.status).toBe(200)
    expect(pending.headers.get('x-read-revision')).not.toBe(revision)
    await pending.arrayBuffer()
    await write('after')
    const changed = await probe(revision)
    expect(changed.status).toBe(200)
    expect(changed.headers.get('x-read-revision')).not.toBe(revision)
    expect((await changed.arrayBuffer()).byteLength).toBe(0)
    const imported = await client.importBackup(encodeBackup([{ name: 'database.risudat', data: blob('before') }]))
    expect(imported.ok).toBe(true)
    const restored = await probe(revision)
    expect(restored.status).toBe(200)
    expect(restored.headers.get('x-read-revision')).not.toBe(revision)
    await restored.arrayBuffer()
})

test('plugin revision sync avoids value hashes for unchanged rows and detects deletion/recreation', async () => {
    const { client } = await boot()
    const storageKey = 'plugin-storage/' + Buffer.from('memory').toString('base64url')
    const write = async () => {
        const res = await client.fetch('/api/write', { method: 'POST', headers: { 'file-path': hex(storageKey), 'content-type': 'application/octet-stream' }, body: '"cached"' })
        expect(res.ok).toBe(true); await res.text()
    }
    const sync = async (revisions: any[] = [], versions: any[] = []) => {
        const res = await client.fetch('/api/plugin-storage/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versions, revisions, readDelta: true }) })
        expect(res.ok).toBe(true)
        return (await res.text()).trim().split('\n').map(line => JSON.parse(line)).filter(Array.isArray)
    }
    await write()
    const [cold] = await sync()
    expect(cold[1]).toBe('"cached"'); expect(cold[3]).toBeTruthy()
    const revisions = [['memory', cold[3]]], versions = [['memory', cold[2]]]
    expect(await sync(revisions, versions)).toEqual([['memory', null, null, cold[3]]])
    const res = await client.fetch('/api/remove', { headers: { 'file-path': hex(storageKey) } })
    expect(res.ok).toBe(true); await res.text()
    expect(await sync(revisions, versions)).toEqual([])
    await write()
    const [recreated] = await sync(revisions, versions)
    expect(recreated[3]).not.toBe(cold[3])
})

test('revision probes require authentication', async () => {
    const { srv } = await boot()
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/read`, { headers: { 'file-path': hex(key), 'x-read-check-only': '1', 'if-read-revision': 'fake' } })
    expect(res.status).not.toBe(200); expect(res.status).not.toBe(304)
    await res.text()
})

async function bootWithWriteCounter() {
    const srv = await spawnServer({ env: {
        NODE_OPTIONS: `--require=${path.resolve(import.meta.dirname, 'compat/helpers/count-db-writes-preload.cjs')}`,
    } })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    const writes = async () => Number(await readFile(path.join(srv.cwd, 'db-write-count'), 'utf8').catch(() => '0'))
    const read = () => client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
    const probe = (revision: string) => client.fetch('/api/read', { headers: {
        'file-path': hex(key), 'x-read-check-only': '1', 'if-read-revision': revision,
    } })
    return { srv, client, writes, read, probe }
}

test('pending patches invalidate metadata probes without forcing a database write; a body read still flushes', async () => {
    const { client, writes, read, probe } = await bootWithWriteCounter()
    const write = await client.fetch('/api/write', { method: 'POST', headers: {
        'file-path': hex(key), 'content-type': 'application/octet-stream',
    }, body: blob('before') })
    expect(write.ok).toBe(true); await write.text()
    const initial = await read()
    const oldRevision = initial.headers.get('x-read-revision')!
    const baseline = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await initial.arrayBuffer())))
    const before = await writes()
    const patch = await client.fetch('/api/patch', { method: 'POST', headers: {
        'file-path': hex(key), 'content-type': 'application/json',
    }, body: JSON.stringify({ patch: [{ op: 'replace', path: '/username', value: 'pending' }], expectedHash: utils.calculateHash(baseline).toString(16) }) })
    expect(patch.ok).toBe(true); await patch.text()
    const changed = await probe(oldRevision)
    expect(changed.status).toBe(200)
    expect((await changed.arrayBuffer()).byteLength).toBe(0)
    const pendingRevision = changed.headers.get('x-read-revision')!
    expect(pendingRevision).not.toBe(oldRevision)
    const samePending = await probe(pendingRevision)
    expect(samePending.status).toBe(304); await samePending.arrayBuffer()
    expect(await writes()).toBe(before)
    const body = await read()
    expect(body.ok).toBe(true)
    expect((await utils.decodeRisuSave(Buffer.from(await body.arrayBuffer()))).username).toBe('pending')
    expect(await writes()).toBeGreaterThan(before)
})

test('a pending chat body does not force DB metadata probes to persist; normal reads still save it to disk', async () => {
    const { srv, client, writes, read, probe } = await bootWithWriteCounter()
    const chat = { id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'before' }], note: '', localLore: [] }
    const database = { characters: [{ chaId: 'cha', name: 'Character', chats: [chat] }], botPresets: [], personas: [], pluginCustomStorage: {} }
    const write = await client.fetch('/api/write', { method: 'POST', headers: {
        'file-path': hex(key), 'content-type': 'application/octet-stream',
    }, body: Buffer.from(utils.encodeRisuSaveLegacy(database)) })
    expect(write.ok).toBe(true); await write.text()
    const initial = await read()
    const revision = initial.headers.get('x-read-revision')!
    await initial.arrayBuffer()
    const before = await writes()
    const nextChat = { ...chat, note: 'saved while DB debounce is pending', message: [...chat.message, { role: 'char', data: 'after' }] }
    const saved = await client.fetch('/api/chat-content/cha/0', { method: 'POST', headers: {
        'x-chat-id': 'chat', 'content-type': 'application/octet-stream',
    }, body: Buffer.from(utils.encodeRisuSaveLegacy(nextChat)) })
    expect(saved.ok).toBe(true); await saved.text()
    const metadata = await probe(revision)
    expect(metadata.status).toBe(304); await metadata.arrayBuffer()
    expect(await writes()).toBe(before)
    const body = await read()
    expect(body.ok).toBe(true); await body.arrayBuffer()
    expect(await writes()).toBeGreaterThan(before)
    const db = new Database(path.join(srv.cwd, 'save/risuai.db'), { readonly: true })
    try {
        const persisted = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: Buffer }
        const full = await utils.decodeRisuSave(persisted.value)
        expect(full.characters[0].chats[0].message).toHaveLength(2)
        expect(full.characters[0].chats[0].note).toBe(nextChat.note)
    } finally { db.close() }
})
