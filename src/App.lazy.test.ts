// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'

const imports = vi.hoisted(() => {
    const hold = () => {
        let release!: () => void
        return { called: vi.fn(), ready: new Promise<void>(r => { release = r }), release: () => release() }
    }
    return { prompt: hold(), model: hold(), persona: hold(), memory: hold() }
})
vi.mock('./ts/stores.svelte', async () => await import('../test/helpers/AppLazyState.svelte'))
vi.mock('./ts/characterCards', async () => ({
    showRealmInfoStore: (await import('../test/helpers/AppLazyState.svelte')).showRealmInfoStore,
    importCharacterProcess: vi.fn(),
}))
vi.mock('./ts/storage/database.svelte', () => ({ importPreset: vi.fn(), getDatabase: vi.fn(), setDatabase: vi.fn() }))
vi.mock('./ts/process/modules', () => ({ readModule: vi.fn() }))
vi.mock('./ts/alert', () => ({ notifySuccess: vi.fn() }))
vi.mock('./ts/globalApi.svelte', () => ({ checkCharOrder: vi.fn() }))
vi.mock('./ts/assetViewer.svelte', async () => ({
    assetViewerStore: (await import('../test/helpers/AppLazyState.svelte')).assetViewerStore,
    closeAssetViewer: vi.fn(),
}))
vi.mock('./lang', () => ({ language: { loading: 'Loading', close: 'Close', errors: { networkFetch: 'Failed', chatLoadRetry: 'Retry' } } }))
vi.mock('./ts/keepAliveAudio', () => ({ createKeepAliveAudio: vi.fn() }))
vi.mock('./ts/update', async () => {
    const state = await import('../test/helpers/AppLazyState.svelte')
    return { updatePopupStore: state.updatePopupStore, selfUpdateProgressStore: state.selfUpdateProgressStore }
})
vi.mock('./ts/support', async () => ({ supportDialogOpen: (await import('../test/helpers/AppLazyState.svelte')).supportDialogOpen }))
vi.mock('./ts/proton/protonImport', async () => ({ protonImportDialogOpen: (await import('../test/helpers/AppLazyState.svelte')).protonImportDialogOpen }))

vi.mock('./lib/Setting/botpreset.svelte', async () => {
    imports.prompt.called(); await imports.prompt.ready
    return { default: (await import('../test/helpers/EmptyComponent.svelte')).default }
})
vi.mock('./lib/Setting/modelpreset.svelte', async () => {
    imports.model.called(); await imports.model.ready
    return { default: (await import('../test/helpers/EmptyComponent.svelte')).default }
})
vi.mock('./lib/Setting/listedPersona.svelte', async () => {
    imports.persona.called(); await imports.persona.ready
    return { default: (await import('../test/helpers/EmptyComponent.svelte')).default }
})
vi.mock('./lib/Setting/listedMemoryPreset.svelte', async () => {
    imports.memory.called(); await imports.memory.ready
    return { default: (await import('../test/helpers/EmptyComponent.svelte')).default }
})
vi.mock('./lib/SideBars/Sidebar.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/ChatScreens/ChatScreen.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Others/AlertComp.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/CharacterManager/CharacterManager.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/CharacterManager/FolderSettingsDialog.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Setting/RisuAccountImportScreen.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Others/SavePopupIcon.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Mobile/MobileHeader.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Mobile/MobileBody.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Mobile/MobileFooter.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Others/HypaV3Progress.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Others/PluginAlertModal.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Others/UpdatePopup.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Others/SupportDialog.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Others/ProtonImportDialog.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Others/BootBackupPrompt.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/UI/PopupList.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Others/LoadingOverlay.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/UI/GUI/Toaster.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/UI/GUI/RequestStatusToaster.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))
vi.mock('./lib/Others/ServerActivityNotice.svelte', async () => await import('../test/helpers/EmptyComponent.svelte'))

import App from './App.svelte'
import * as state from '../test/helpers/AppLazyState.svelte'

let app: ReturnType<typeof mount> | undefined
afterEach(async () => {
    if (app) await unmount(app)
    app = undefined
    document.body.replaceChildren()
    state.startupPreview.set(null)
    state.loadedStore.set(false)
    state.accountImportBlocking.set(false)
})

test('preview appears before loaded, import blocking wins, and the preview leaves when ready', async () => {
    state.loadedStore.set(false)
    state.startupPreview.set({ names: ['Early character'], total: 1 })
    const target = document.createElement('div')
    document.body.appendChild(target)
    app = mount(App, { target })
    await tick()
    expect(target.textContent).toContain('Early character')
    state.accountImportBlocking.set(true)
    await tick()
    expect(target.textContent).not.toContain('Early character')
    state.accountImportBlocking.set(false)
    state.loadedStore.set(true)
    await tick()
    expect(target.querySelector('.startup-preview')).toBeNull()
})

test('the public layout remains visible while authentication and DB loading are pending', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    app = mount(App, { target })
    await tick()
    expect(target.querySelector('.startup-shell')).not.toBeNull()
    expect(target.textContent).toContain('PocketRisu')
    expect(target.querySelector('.startup-shell img, .startup-shell button, .startup-shell input')).toBeNull()
    state.loadedStore.set(true)
    await tick()
    expect(target.querySelector('.startup-shell')).toBeNull()
})

test('pickers import only on demand and clear pending selections when closed before their modules mount', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    app = mount(App, { target })
    await tick()
    for (const pending of Object.values(imports)) expect(pending.called).not.toHaveBeenCalled()

    const pickers: Array<{ pending: typeof imports.prompt; open: import('svelte/store').Writable<boolean>; callback: import('svelte/store').Writable<any>; programmaticClose: boolean }> = [
        { pending: imports.prompt, open: state.openPresetList, callback: state.presetSelectCallback, programmaticClose: false },
        { pending: imports.model, open: state.openModelPresetList, callback: state.modelPresetSelectCallback, programmaticClose: false },
        { pending: imports.persona, open: state.openPersonaList, callback: state.personaSelectCallback, programmaticClose: true },
        { pending: imports.memory, open: state.openMemoryPresetList, callback: state.memoryPresetSelectCallback, programmaticClose: true },
    ]
    for (const { pending, open, callback, programmaticClose } of pickers) {
        const stale = vi.fn()
        callback.set(stale)
        open.set(true)
        await vi.waitFor(() => expect(pending.called).toHaveBeenCalledOnce())
        expect(target.textContent).toContain('Loading')
        if (programmaticClose) open.set(false)
        else Array.from(target.querySelectorAll('button')).find(button => button.textContent === 'Close')!.click()
        await tick()
        expect(get(open)).toBe(false)
        expect(get(callback)).toBeNull()
        pending.release()
        await vi.dynamicImportSettled()
        await tick()
        expect(target.querySelector('[data-testid="loaded-picker"]')).toBeNull()
        expect(stale).not.toHaveBeenCalled()


    }
})
