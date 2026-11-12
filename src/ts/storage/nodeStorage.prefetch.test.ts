import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { Buffer } from 'buffer'
vi.mock('../alert', () => ({ alertInput: vi.fn(async () => 'password'), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('src/lang', () => ({ language: { inputNodePassword: 'Password', setNodePassword: 'Set password' } }))
vi.mock('./transferCache', () => ({ transferCache: { get: vi.fn(), put: vi.fn(), updateRevision: vi.fn() } }))
const { NodeStorage } = await import('./nodeStorage')
const { transferCache } = await import('./transferCache')
const { alertInput } = await import('../alert')
const idle = { state: 'idle', blocking: false }
beforeEach(() => {
    vi.clearAllMocks()
    ;(NodeStorage as any).sessionInitialized = false
    ;(NodeStorage as any).sessionPending = null
    vi.mocked(transferCache.get).mockResolvedValue(null)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren() })
function fixture(authStatus = 'success') {
    let value = 'first', revision = 'r1', authState = authStatus, importStatus = idle
    const auth = vi.fn(async (url: string) => {
        if (url === '/api/test_auth') return Response.json({ status: authState, token: 'fixture', bootstrap: {
            v: 1, sessionInitialized: true, importStatus, backupReminderEnabled: false,
        } })
        if (url === '/api/crypto') return new Response('hashed')
        if (url === '/api/login') { authState = 'success'; return Response.json({ token: 'fixture' }) }
        if (url === '/api/session') return Response.json({ ok: true })
        throw Error('Unexpected authentication request')
    })
    vi.stubGlobal('fetch', auth)
    const read = vi.fn(async (url: string, init: RequestInit) => {
        if (url === '/api/risu-account/status') return Response.json(importStatus)
        const headers = new Headers(init.headers)
        if (headers.get('x-read-check-only') === '1') {
            return new Response(null, { status: headers.get('if-none-match') === value ? 304 : 200,
                headers: { 'x-read-version-check': '1', 'x-read-revision': revision } })
        }
        return new Response(value, { headers: { 'x-db-etag': value, 'x-read-revision': revision } })
    })
    return { auth, read, storage: new NodeStorage(read),
        change(next: string) { value = next; revision = 'r2' }, revise() { revision = 'r2' },
        block() { importStatus = { state: 'applying', blocking: true } } }
}
test('preloads without UI/database writes, then revalidates the exact in-memory copy', async () => {
    const f = fixture()
    await f.storage.prefetchStartupDatabase()
    expect(f.read).toHaveBeenCalledOnce()
    expect(transferCache.put).not.toHaveBeenCalled()
    expect(alertInput).not.toHaveBeenCalled()
    expect(await f.storage.getBootstrapInfo()).toMatchObject({ importStatus: idle })
    expect((await f.storage.getItem('database/database.bin', { deferCacheWrite: true })).toString()).toBe('first')
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(new Headers(f.read.mock.calls[1][1].headers).get('x-read-check-only')).toBe('1')
    expect(transferCache.get).toHaveBeenCalledOnce()
    await f.storage.flushDeferredCacheWrites()
    expect(transferCache.put).toHaveBeenCalledOnce()
    expect(f.auth).toHaveBeenCalledOnce()
})
test('another device changing data during app download cannot make the prefetched copy authoritative', async () => {
    const f = fixture()
    await f.storage.prefetchStartupDatabase()
    f.change('latest')
    expect((await f.storage.getItem('database/database.bin', { deferCacheWrite: true })).toString()).toBe('latest')
    expect(f.storage._lastDbEtag).toBe('latest')
    await f.storage.flushDeferredCacheWrites()
    expect(transferCache.put).toHaveBeenCalledOnce()
    expect(vi.mocked(transferCache.put).mock.calls[0][1]).toBe('latest')
})
test('unchanged cached data is reused without a duplicate IDB read or body rewrite', async () => {
    const f = fixture()
    vi.mocked(transferCache.get).mockResolvedValue({ key: 'db:database/database.bin', etag: 'first', revision: 'r1', usedAt: 1, data: Buffer.from('first') })
    await f.storage.prefetchStartupDatabase()
    expect((await f.storage.getItem('database/database.bin', { deferCacheWrite: true })).toString()).toBe('first')
    await f.storage.flushDeferredCacheWrites()
    expect(transferCache.get).toHaveBeenCalledOnce()
    expect(transferCache.put).not.toHaveBeenCalled()
    expect(f.read.mock.calls.every(([, init]) => new Headers(init.headers).has('x-read-check-only'))).toBe(true)
})
test('revalidation updates persisted revision metadata before mutating the in-memory copy', async () => {
    const f = fixture()
    vi.mocked(transferCache.get).mockResolvedValue({ key: 'db:database/database.bin', etag: 'first', revision: 'r1', usedAt: 1, data: Buffer.from('first') })
    await f.storage.prefetchStartupDatabase()
    f.revise()
    expect((await f.storage.getItem('database/database.bin', { deferCacheWrite: true })).toString()).toBe('first')
    expect(transferCache.updateRevision).toHaveBeenCalledWith('db:database/database.bin', 'first', 'r2')
})
test.each(['incorrect', 'unset'])('unauthenticated prefetch never opens a dialog: %s', async state => {
    const f = fixture(state)
    await f.storage.prefetchStartupDatabase()
    expect(alertInput).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
    expect(f.storage.authChecked).toBe(false)
})
test('first login retains the existing interactive prompt after noninteractive preflight', async () => {
    const f = fixture('incorrect')
    await f.storage.prefetchStartupDatabase()
    expect(await f.storage.getBootstrapInfo()).toMatchObject({ importStatus: idle })
    expect(alertInput).toHaveBeenCalledOnce()
})
test('import guard is refreshed when app code takes time to download', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.storage.prefetchStartupDatabase()
    f.block(); vi.setSystemTime(Date.now() + 2000)
    expect((await f.storage.getBootstrapInfo()).importStatus.blocking).toBe(true)
})
test('a failed optional transfer is retried by the normal read', async () => {
    const f = fixture()
    f.read.mockRejectedValueOnce(new TypeError('offline'))
    await f.storage.prefetchStartupDatabase()
    expect((await f.storage.getItem('database/database.bin', { deferCacheWrite: true })).toString()).toBe('first')
})
test('touches on the initial loading shell cannot authorize a writer takeover', async () => {
    document.body.innerHTML = '<div id="preloading">Preparing</div>'
    window.dispatchEvent(new Event('pointerdown'))
    document.body.replaceChildren()
    const f = fixture()
    await f.storage.prefetchStartupDatabase()
    expect(new Headers(f.read.mock.calls[0][1].headers).has('x-user-active')).toBe(false)
})
