import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
    fetch: vi.fn(), db: { dynamicModelRegistry: true, google: { accessToken: 'google-test' }, claudeAPIKey: 'anthropic-test' } as any,
}))
vi.mock('../globalApi.svelte', () => ({ fetchNative: (...args: any[]) => fixture.fetch(...args) }))
vi.mock('../stores.svelte', () => ({ DBState: { db: fixture.db } }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => fixture.db }))
vi.mock('../plugins/plugins.svelte', async () => ({
    customProviderStore: (await import('svelte/store')).writable([]), pluginV2: {},
}))
vi.mock('../plugins/apiV3/v3.svelte', () => ({ customV3ProviderMetaStore: [] }))

import { LLMModels, registerModelDynamic, LLMProvider } from './modellist'
const baseLength = LLMModels.length
beforeEach(() => {
    fixture.fetch.mockReset()
    fixture.db.dynamicModelRegistry = true
    fixture.db.google = { accessToken: 'google-test' }
    fixture.db.claudeAPIKey = 'anthropic-test'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { LLMModels.splice(baseLength); vi.restoreAllMocks() })

test('starts both catalogs together but preserves Google-first collision precedence and duplicate checks', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    fixture.fetch.mockImplementation(async (url: string) => {
        if (url.includes('googleapis')) {
            await gate
            return Response.json({ models: [{ name: 'models/parallel-collision', supportedGenerationMethods: ['generateContent'] }] })
        }
        return Response.json({ data: [{ id: 'parallel-collision', display_name: 'Collision' }, { id: 'parallel-anthropic', display_name: 'Anthropic' }] })
    })
    const loading = registerModelDynamic()
    await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(2))
    expect(LLMModels.some(model => model.internalID === 'parallel-collision')).toBe(false)
    release(); await loading
    expect(LLMModels.filter(model => model.internalID === 'parallel-collision').map(model => model.provider)).toEqual([LLMProvider.GoogleCloud])
    expect(LLMModels.find(model => model.internalID === 'parallel-anthropic')?.provider).toBe(LLMProvider.Anthropic)
    await registerModelDynamic()
    expect(LLMModels.filter(model => model.internalID === 'parallel-collision')).toHaveLength(1)
})

test.each(['google', 'anthropic'])('a failed %s catalog does not discard the other result', async failed => {
    const failure = new Error('catalog unavailable')
    fixture.fetch.mockImplementation(async (url: string) => {
        const google = url.includes('googleapis')
        if (google === (failed === 'google')) throw failure
        return google
            ? Response.json({ models: [{ name: 'models/parallel-google', supportedGenerationMethods: ['generateContent'] }] })
            : Response.json({ data: [{ id: 'parallel-anthropic', display_name: 'Anthropic' }] })
    })
    await registerModelDynamic()
    expect(LLMModels.some(model => model.internalID === (failed === 'google' ? 'parallel-anthropic' : 'parallel-google'))).toBe(true)
    expect(console.error).toHaveBeenCalledWith(failed === 'google' ? 'Error fetching Google models' : 'Error fetching Anthropic models', failure)
})

test('disabled registry or absent credentials issue no catalog requests', async () => {
    fixture.db.dynamicModelRegistry = false
    await registerModelDynamic()
    expect(fixture.fetch).not.toHaveBeenCalled()
    fixture.db.dynamicModelRegistry = true
    fixture.db.google = undefined
    fixture.db.claudeAPIKey = ''
    await registerModelDynamic()
    expect(fixture.fetch).not.toHaveBeenCalled()
})
