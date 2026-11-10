// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { get } from 'svelte/store';

const fixtures = vi.hoisted(() => {
    let charReady!: () => void, devReady!: () => void;
    return { getHub: vi.fn(), charImport: vi.fn(), devImport: vi.fn(),
        charPending: new Promise<void>(r => { charReady = r }), devPending: new Promise<void>(r => { devReady = r }),
        resolveChar: () => charReady(), resolveDev: () => devReady(),
    };
});
vi.mock('src/ts/process/modules', () => ({ moduleUpdate: vi.fn() }));
vi.mock('src/ts/process/scripts', () => ({ resetScriptCache: vi.fn() }));
vi.mock('src/ts/process/memory/memoryPresets', () => ({
    MEMORY_PRESET_DEFAULT: 'default', MEMORY_PRESET_OFF: 'off', getMemoryPreset: () => undefined,
    resolveMemoryPresetId: () => 'off', setChatMemoryPreset: vi.fn(),
}));
vi.mock('src/ts/lite', async () => ({ isLite: (await import('svelte/store')).writable(false) }));
vi.mock('src/ts/characterCards', () => ({ getRisuHub: fixtures.getHub }));
vi.mock('src/ts/alert', async () => ({ risuTosAccepted: (await import('svelte/store')).writable(true), alertTOS: vi.fn() }));
vi.mock('src/lang', () => ({ language: {
    loading: 'Loading', close: 'Close', risuTosGate: 'Terms are required', risuTosGateButton: 'Accept terms',
    errors: { networkFetch: 'Network unavailable', chatLoadRetry: 'Retry' },
} }));
vi.mock('../CharacterManager/CharacterManager.svelte', async () => ({ default: (await import('../../../test/helpers/MobileCharacterPanel.svelte')).default }));
vi.mock('../ChatScreens/ChatScreen.svelte', async () => ({ default: (await import('../../../test/helpers/MobileCharacterPanel.svelte')).default }));
vi.mock('../SideBars/CharConfig.svelte', async () => { fixtures.charImport(); await fixtures.charPending; return { default: (await import('../../../test/helpers/MobileCharacterPanel.svelte')).default }; });
vi.mock('../SideBars/SideChatList.svelte', async () => ({ default: (await import('../../../test/helpers/MobileCharacterPanel.svelte')).default }));
vi.mock('../SideBars/DevTool.svelte', async () => { fixtures.devImport(); await fixtures.devPending; return { default: (await import('../../../test/helpers/MobileCharacterPanel.svelte')).default }; });
vi.mock('../UI/Realm/RealmMain.svelte', async () => ({ default: (await import('../../../test/helpers/RealmBrowserProbe.svelte')).default }));

import MobileBody from './MobileBody.svelte';
import { DBState, MobileGUIStack, MobileSideBar, selectedCharID } from 'src/ts/stores.svelte';
import { risuTosAccepted } from 'src/ts/alert';

let app: ReturnType<typeof mount> | undefined;
beforeEach(() => {
    fixtures.getHub.mockReset().mockResolvedValue([]);
    MobileSideBar.set(0);
    selectedCharID.set(-1);
    risuTosAccepted.set(true);
});
afterEach(async () => {
    if (app) await unmount(app);
    app = undefined;
    MobileGUIStack.set(1);
    document.body.replaceChildren();
});
async function body() {
    const target = document.createElement('div');
    document.body.appendChild(target);
    app = mount(MobileBody, { target });
    await tick();
    return target;
}

test('chat opening does not load editors; closing pending tools and deleting their character remain safe', async () => {
    DBState.db.characters = [{ chaId: 'test', chats: [] }] as never;
    selectedCharID.set(0);
    MobileSideBar.set(0);
    const target = await body();
    expect(fixtures.charImport).not.toHaveBeenCalled();
    expect(fixtures.devImport).not.toHaveBeenCalled();
    MobileSideBar.set(2);
    await vi.waitFor(() => expect(fixtures.charImport).toHaveBeenCalledOnce());
    expect(target.textContent).toContain('Loading');
    Array.from(target.querySelectorAll('button')).find(e => e.textContent === 'Close')!.click();
    await tick();
    expect(get(MobileSideBar)).toBe(1);
    fixtures.resolveChar();
    await vi.dynamicImportSettled();
    await tick();
    expect(target.textContent).not.toContain('Loading');
    expect(fixtures.devImport).not.toHaveBeenCalled();
    MobileSideBar.set(3);
    await vi.waitFor(() => expect(fixtures.devImport).toHaveBeenCalledOnce());
    selectedCharID.set(-1);
    await tick();
    fixtures.resolveDev();
    await vi.dynamicImportSettled();
    await tick();
    expect(target.textContent).not.toContain('Loading');
    expect(target.querySelector('[data-local-characters]')).not.toBeNull();
});
