// @vitest-environment node
import { expect, test } from 'vitest'
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient } from './compat/helpers/client.js'

test.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('web self-update stages on the install filesystem even when OS temp is unusable, and cleans up failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'risu-update-test-'))
    const blockedTemp = path.join(root, 'not-a-directory')
    await writeFile(blockedTemp, 'OS temp unavailable')
    let srv: ServerHandle | undefined
    try {
        srv = await spawnServer({
            env: {
                TMPDIR: blockedTemp,
                NODE_OPTIONS: `--require=${path.resolve(import.meta.dirname, 'compat/helpers/mock-update-download-preload.cjs')}`,
            },
            seedSave: async save => { await writeFile(path.join(save, '..', '.portable'), '') },
        })
        const client = await createClient(srv.port, srv.password)
        const response = await client.fetch('/api/self-update', { method: 'POST' })
        expect(response.status).toBe(200)
        const events = (await response.text()).trim().split('\n').map(s => JSON.parse(s))
        expect(events.map(e => e.step)).toContain('downloading')
        expect(events.map(e => e.step)).toContain('extracting')
        expect(events.at(-1).step).toBe('error')
        expect(events.at(-1).message).toContain(path.join(srv.cwd, '.risu-update-'))
        expect(events.at(-1).message).not.toContain(blockedTemp)
        // Failure cleanup is asynchronous; it must leave no archive/staging
        // directory or rollback tree, and the old server must still run.
        await expect.poll(async () => (await readdir(srv!.cwd)).filter(s => s.startsWith('.risu-update-'))).toEqual([])
        expect(await readdir(srv.cwd)).not.toContain('.update-tmp')
        const live = await client.fetch('/api/update-check')
        expect(live.ok).toBe(true)
        await live.text()
    } finally {
        await srv?.cleanup()
        await rm(root, { recursive: true, force: true })
    }
})
