// @vitest-environment node
import { afterAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient } from './compat/helpers/client.js'
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(s => s.cleanup())) })
async function boot() {
    const srv = await spawnServer(); servers.push(srv)
    return { srv, client: await createClient(srv.port, srv.password) }
}

test('activity is authenticated, small, uncached metadata', async () => {
    const { srv, client } = await boot()
    const anonymous = await fetch(`http://127.0.0.1:${srv.port}/api/server-activity`)
    expect(anonymous.status).not.toBe(200)
    const res = await client.fetch('/api/server-activity')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const text = await res.text()
    expect(text.length).toBeLessThan(100)
    expect(JSON.parse(text)).toEqual({ generating: 0, saving: false })
})

test('observing from the other device does not claim or revoke either session', async () => {
    const { client } = await boot()
    for (const id of ['pc', 'phone']) {
        const res = await client.fetch('/api/session', { method: 'POST', headers: { 'x-session-id': id } })
        expect(res.ok).toBe(true); await res.text()
    }
    const state = async (id: string) => (await (await client.fetch('/api/session/lock-status', { headers: { 'x-session-id': id } })).json()).state
    const pcBefore = await state('pc'), phoneBefore = await state('phone')
    expect(pcBefore).toBe('active')
    for (let i = 0; i < 3; i++) {
        const res = await client.fetch('/api/server-activity', { headers: { 'x-session-id': 'phone', 'x-user-active': '1' } })
        expect(res.ok).toBe(true); await res.text()
    }
    expect(await state('pc')).toBe(pcBefore)
    expect(await state('phone')).toBe(phoneBefore)
})

test('a server generation appears in the count and cancellation clears it', async () => {
    const { client } = await boot()
    const upstream = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: waiting\n\n')
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    try {
        const address = upstream.address() as { port: number }
        const created = await client.fetch('/api/model-jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            targetUrl: `http://127.0.0.1:${address.port}/`, method: 'POST', body: '{}', headers: {},
            chatId: 'status-chat', generationId: 'status-generation', streaming: true,
        }) })
        expect(created.ok).toBe(true)
        const { jobId } = await created.json()
        expect((await (await client.fetch('/api/server-activity')).json()).generating).toBe(1)
        const cancelled = await client.fetch(`/api/model-jobs/${jobId}`, { method: 'DELETE' })
        expect(cancelled.ok).toBe(true); await cancelled.text()
        expect((await (await client.fetch('/api/server-activity')).json()).generating).toBe(0)
    } finally {
        upstream.closeAllConnections()
        await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
})
