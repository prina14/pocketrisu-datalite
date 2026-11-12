import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: {} as any }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => state.db }))
vi.mock('../storage/persistentKv', () => ({
    listPersistentKeys: vi.fn(), makeEncodedStorageKey: vi.fn(), decodeStorageKeyComponent: vi.fn(),
    readPersistentJson: vi.fn(), writePersistentJson: vi.fn(), removePersistentKey: vi.fn(), clearPersistentPrefix: vi.fn(),
}))
import { recordOwner, removeOwner, clearOwners, getOwners } from './pluginStorageMeta'
import { getSyncDiagnostics } from '../storage/syncDiagnostics'

beforeEach(() => { state.db = {}; vi.restoreAllMocks() })

test('repeated startup writes by the same owner do not mutate the main DB', () => {
    const record = { plugin: 'fixture', updatedAt: 123 }
    const set = vi.fn(() => true)
    state.db.pluginStorageMeta = new Proxy({ key: record }, { set })
    const clock = vi.spyOn(Date, 'now')
    recordOwner('save', 'key', 'fixture')
    recordOwner('save', 'key', 'fixture')
    expect(set).not.toHaveBeenCalled()
    expect(clock).not.toHaveBeenCalled()
    expect(state.db.pluginStorageMeta.key).toBe(record)
    expect(getSyncDiagnostics().at(-1)).toMatchObject({ type: 'plugin-storage-owner', plugin: 'fixture', changed: false })
    expect(JSON.stringify(getSyncDiagnostics())).not.toContain('"key"')
})

test('new ownership and a different plugin still update attribution', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200)
    recordOwner('save', 'key', 'first')
    expect(state.db.pluginStorageMeta.key).toEqual({ plugin: 'first', updatedAt: 100 })
    recordOwner('save', 'key', 'second')
    expect(state.db.pluginStorageMeta.key).toEqual({ plugin: 'second', updatedAt: 200 })
    expect(await getOwners('save')).toEqual({ key: 'second' })
})

test('removal and clear allow ownership to be recorded again', () => {
    recordOwner('save', 'key', 'fixture')
    removeOwner('save', 'key')
    expect(state.db.pluginStorageMeta.key).toBeUndefined()
    recordOwner('save', 'key', 'fixture')
    expect(state.db.pluginStorageMeta.key.plugin).toBe('fixture')
    clearOwners('save')
    expect(state.db.pluginStorageMeta).toEqual({})
    recordOwner('save', 'key', 'fixture')
    expect(state.db.pluginStorageMeta.key.plugin).toBe('fixture')
})

test('missing plugin names do not create metadata', () => {
    recordOwner('save', 'key', '')
    expect(state.db.pluginStorageMeta).toBeUndefined()
})

