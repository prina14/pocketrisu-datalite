import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (chat: any) => chat }))
const { NodeStorage } = await import('./nodeStorage')
const status = { state: 'idle', blocking: false }
const bundle = (extra = {}) => ({ v: 1, sessionInitialized: true, importStatus: status, backupReminderEnabled: false, ...extra })

beforeEach(() => {
    ;(NodeStorage as any).sessionInitialized = false
    ;(NodeStorage as any).sessionPending = null
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function setup(bootstrap: unknown, authStatus = 'success') {
    const auth = vi.fn(async (url: string) => {
        if (url === '/api/test_auth') return Response.json({ status: authStatus, token: 'token', bootstrap })
        if (url === '/api/session') return Response.json({ ok: true })
        if (url === '/api/crypto') return new Response('digest')
        if (url === '/api/login') return Response.json({ token: 'login-token' })
        throw Error('Unexpected auth URL: ' + url)
    })
    vi.stubGlobal('fetch', auth)
    const request = vi.fn(async () => Response.json({ state: 'downloading', blocking: true }))
    return { auth, request, storage: new NodeStorage(request) }
}

test('authenticated boot uses one bundled request; later status polling stays fresh', async () => {
    const { auth, request, storage } = setup(bundle())
    expect(await storage.getBootstrapInfo()).toEqual({ importStatus: status, backupReminderEnabled: false })
    expect(auth).toHaveBeenCalledOnce()
    expect(auth.mock.calls[0][0]).toBe('/api/test_auth')
    const headers = (auth.mock.calls[0] as any[])[1].headers
    expect(headers['x-risu-bootstrap']).toBe('1')
    expect(headers['x-session-id']).toBeTruthy()
    expect(request).not.toHaveBeenCalled()
    expect(await storage.getRisuAccountImportStatus()).toMatchObject({ state: 'downloading', blocking: true })
    expect(await storage.getBootstrapInfo()).toEqual({
        importStatus: { state: 'downloading', blocking: true }, backupReminderEnabled: undefined,
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(auth).toHaveBeenCalledOnce()
})

test.each([undefined, { v: 2, sessionInitialized: true }, { v: 1, sessionInitialized: false }])(
    'unsupported or absent bundles preserve the legacy session and status path: %j', async bootstrap => {
        const { auth, request, storage } = setup(bootstrap)
        expect(await storage.getBootstrapInfo()).toEqual({
            importStatus: { state: 'downloading', blocking: true }, backupReminderEnabled: undefined,
        })
        expect(auth.mock.calls.map(([url]) => url)).toEqual(['/api/test_auth', '/api/session'])
        expect(request).toHaveBeenCalledOnce()
    },
)

test('a confirmed session with missing or malformed import status fetches the guard before returning', async () => {
    const { auth, request, storage } = setup(bundle({ importStatus: { state: 'idle', blocking: 'false' }, backupReminderEnabled: true }))
    let reply!: (value: Response) => void
    request.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
    let ready = false
    const boot = storage.getBootstrapInfo().then(value => { ready = true; return value })
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(ready).toBe(false)
    reply(Response.json({ state: 'downloading', blocking: true }))
    expect(await boot).toEqual({ importStatus: { state: 'downloading', blocking: true }, backupReminderEnabled: true })
    expect(auth).toHaveBeenCalledOnce()
})

test('failed authentication ignores even a purported successful bundle and keeps the password flow', async () => {
    const { alertInput } = await import('../alert')
    vi.mocked(alertInput).mockResolvedValueOnce('password')
    const { auth, request, storage } = setup(bundle(), 'incorrect')
    expect((await storage.getBootstrapInfo()).importStatus.blocking).toBe(true)
    expect(alertInput).toHaveBeenCalledOnce()
    expect(auth.mock.calls.map(([url]) => url)).toEqual(['/api/test_auth', '/api/crypto', '/api/login', '/api/session'])
    expect(request).toHaveBeenCalledOnce()
})

test('blocking import status from the boot bundle is preserved', async () => {
    const { storage, request } = setup(bundle({ importStatus: { state: 'downloaded', blocking: true } }))
    expect((await storage.getBootstrapInfo()).importStatus).toEqual({ state: 'downloaded', blocking: true })
    expect(request).not.toHaveBeenCalled()
})

test('controlled latency removes the session and status round trips, rather than bypassing authentication', async () => {
    vi.useFakeTimers()
    const elapsed: number[] = []
    for (const bundled of [false, true]) {
        ;(NodeStorage as any).sessionInitialized = false
        const pause = () => new Promise(resolve => setTimeout(resolve, 100))
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            await pause()
            return Response.json(url === '/api/test_auth'
                ? { status: 'success', token: 'token', ...(bundled ? { bootstrap: bundle() } : {}) }
                : { ok: true })
        }))
        const storage = new NodeStorage(async () => { await pause(); return Response.json(status) })
        const start = Date.now()
        let readyAt = -1
        const boot = storage.getBootstrapInfo().then(result => { readyAt = Date.now() - start; return result })
        await vi.runAllTimersAsync()
        expect((await boot).importStatus.blocking).toBe(false)
        elapsed.push(readyAt)
    }
    expect(elapsed).toEqual([300, 100])
})
