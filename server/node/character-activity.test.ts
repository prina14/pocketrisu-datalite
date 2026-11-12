import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createCharacterActivity } = require('./character-activity.cjs')

function fixture() {
    const rows = new Map<string, Buffer>()
    const db = {
        prepare: (sql: string) => ({ all: () => sql.includes('OFFSET') ? [] : [...rows].map(([key, value]) => ({ key, value })) }),
        transaction: (fn: () => void) => fn,
    }
    const activity = createCharacterActivity(db, { kvSet: (k: string, v: Buffer) => rows.set(k, v), kvDel: (k: string) => rows.delete(k) })
    const routes = new Map<string, Function>()
    activity.register({ get: (p: string, fn: Function) => routes.set('GET', fn), post: (p: string, fn: Function) => routes.set('POST', fn) }, async () => true)
    async function call(method: string, headers = {}, ids?: string[]) {
        const result = { status: 200, headers: {} as Record<string, string>, body: undefined as any }
        const response = {
            setHeader: (k: string, v: string) => { result.headers[k.toLowerCase()] = v },
            status: (status: number) => { result.status = status; return response },
            type: () => response,
            json: (body: any) => { result.body = body; return response },
            send: (body: string) => { result.body = JSON.parse(body); return response },
            end: () => response,
        }
        await routes.get(method)!({ headers, body: { ids } }, response, (error: Error) => { throw error })
        return result
    }
    return { activity, call }
}

test('negotiated POST returns exactly the subsequent GET snapshot and validator', async () => {
    const { activity, call } = fixture()
    activity.record(['other-device'])
    const posted = await call('POST', { 'x-activity-snapshot': '1' }, ['opened', 'opened'])
    const read = await call('GET')
    expect(posted.headers['x-activity-snapshot']).toBe('1')
    expect(posted.headers.etag).toBe(read.headers.etag)
    expect(posted.body).toEqual(read.body)
    expect(posted.body.entries.map((e: any) => e.chaId).sort()).toEqual(['opened', 'other-device'])
    expect((await call('GET', { 'if-none-match': posted.headers.etag })).status).toBe(304)
})

test('old clients keep the small acknowledgement and invalid input is not recorded', async () => {
    const { activity, call } = fixture()
    activity.record(['other-device'])
    const posted = await call('POST', {}, ['opened'])
    expect(posted.body.entries).toHaveLength(1)
    expect(posted.headers['x-activity-snapshot']).toBeUndefined()
    expect((await call('POST', { 'x-activity-snapshot': '1' }, [])).status).toBe(400)
    expect((await call('GET')).body.entries).toHaveLength(2)
})
