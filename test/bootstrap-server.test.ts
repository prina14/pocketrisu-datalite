// @vitest-environment node
import { afterAll, expect, test } from 'vitest'
import { writeFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient } from './compat/helpers/client.js'
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })
const bootHeaders = { 'x-risu-bootstrap': '1', 'x-session-id': 'desktop' }
async function start() {
    const server = await spawnServer(); servers.push(server)
    return { server, client: await createClient(server.port, server.password) }
}

test('the bundle requires authentication and does not issue cookies or status to anonymous callers', async () => {
    const { server } = await start()
    for (const headers of [bootHeaders, { ...bootHeaders, 'risu-auth': 'invalid' }, { ...bootHeaders, cookie: 'risu-session=invalid' }]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/test_auth`, { headers })
        expect(await response.json()).toEqual({ status: 'incorrect' })
        expect(response.headers.get('set-cookie')).toBeNull()
        expect(response.headers.get('cache-control')).toContain('no-store')
    }
})

test('authenticated bundle registers the same session and includes the backup flag and import guard', async () => {
    const { client, server } = await start()
    const saved = await client.fetch('/api/backup/boot-reminder', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' })
    expect(saved.ok).toBe(true); await saved.json()
    const response = await client.fetch('/api/test_auth', { headers: bootHeaders })
    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toMatch(/risu-session=.+; HttpOnly; SameSite=Strict/)
    expect(response.headers.get('server-timing')).toContain('boot-session;dur=')
    const body = await response.json()
    expect(body).toMatchObject({ status: 'success', bootstrap: { v: 1, sessionInitialized: true, backupReminderEnabled: true, importStatus: { state: 'idle', blocking: false } } })
    expect(body.token).toBeTruthy()
    const state = (id: string) => client.fetch('/api/session/lock-status', { headers: { 'x-session-id': id } }).then(r => r.json())
    expect(await state('desktop')).toEqual({ state: 'active' })

    // A page refresh sends the existing HttpOnly cookie, without a JWT.
    // A second device boot must not steal the desktop's write lock.
    const phone = await fetch(`http://127.0.0.1:${server.port}/api/test_auth`, { headers: {
        ...bootHeaders, 'x-session-id': 'phone', cookie: cookie.split(';')[0],
    } })
    expect(await phone.json()).toMatchObject({ status: 'success', bootstrap: { sessionInitialized: true } })
    expect(await state('desktop')).toEqual({ state: 'active' })
})

test('legacy clients and missing session IDs keep the old authentication response', async () => {
    const { client } = await start()
    for (const headers of [{}, { 'x-risu-bootstrap': '1' }]) {
        const response = await client.fetch('/api/test_auth', { headers })
        expect(response.headers.get('set-cookie')).toBeNull()
        const body = await response.json()
        expect(body.status).toBe('success')
        expect(body.bootstrap).toBeUndefined()
    }
})

test('password setup is never skipped by the boot extension', async () => {
    const server = await spawnServer({ seedSave: dir => writeFile(dir + '/__password', '') }); servers.push(server)
    const response = await fetch(`http://127.0.0.1:${server.port}/api/test_auth`, { headers: bootHeaders })
    expect(await response.json()).toEqual({ status: 'unset' })
    expect(response.headers.get('set-cookie')).toBeNull()
})

test('API authentication bypasses static-file probes even when those probes are stalled', async () => {
    const preload = fileURLToPath(new URL('./compat/helpers/slow-api-stat-preload.cjs', import.meta.url))
    const server = await spawnServer({ env: { NODE_OPTIONS: `--require=${preload}` } }); servers.push(server)
    const response = await fetch(`http://127.0.0.1:${server.port}/api/test_auth`, { signal: AbortSignal.timeout(2000) })
    expect(await response.json()).toEqual({ status: 'incorrect' })
    expect(response.headers.get('server-timing')).toMatch(/request-to-handler;dur=/)
    expect(await access(path.join(server.cwd, 'api-static-probed')).then(() => true, () => false)).toBe(false)
})
