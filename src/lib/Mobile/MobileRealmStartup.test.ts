// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { get } from 'svelte/store';

const fixtures = vi.hoisted(() => ({ getHub: vi.fn() }));
vi.mock('src/ts/characters', () => ({ changeChar: vi.fn(), getCharImage: vi.fn() }));
vi.mock('src/ts/characterActivity', async () => ({ characterActivity: (await import('svelte/store')).writable({}) }));
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
vi.mock('../SideBars/CharConfig.svelte', async () => ({ default: (await import('../../../test/helpers/MobileCharacterPanel.svelte')).default }));
vi.mock('../SideBars/SideChatList.svelte', async () => ({ default: (await import('../../../test/helpers/MobileCharacterPanel.svelte')).default }));
vi.mock('../SideBars/DevTool.svelte', async () => ({ default: (await import('../../../test/helpers/MobileCharacterPanel.svelte')).default }));
vi.mock('../UI/Realm/RealmMain.svelte', async () => ({ default: (await import('../../../test/helpers/RealmBrowserProbe.svelte')).default }));

import MobileBody from './MobileBody.svelte';
import { MobileGUIStack, MobileSideBar, selectedCharID } from 'src/ts/stores.svelte';
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

test('the real initial mobile stack shows local characters without a Realm request', async () => {
    expect(get(MobileGUIStack)).toBe(1);
    const target = await body();
    expect(target.querySelector('[data-local-characters]')).not.toBeNull();
    expect(fixtures.getHub).not.toHaveBeenCalled();
    MobileGUIStack.set(0);
    await vi.waitFor(() => expect(target.querySelector('[data-realm-browser]')).not.toBeNull());
    expect(fixtures.getHub).toHaveBeenCalledOnce();
    MobileGUIStack.set(1);
    await tick();
    expect(target.querySelector('[data-realm-browser]')).toBeNull();
    expect(target.querySelector('[data-local-characters]')).not.toBeNull();
});

test('manually opening the mobile Realm still respects the terms gate', async () => {
    risuTosAccepted.set(false);
    MobileGUIStack.set(0);
    const target = await body();
    await vi.waitFor(() => expect(target.textContent).toContain('Terms are required'));
    expect(fixtures.getHub).not.toHaveBeenCalled();
    risuTosAccepted.set(true);
    await vi.waitFor(() => expect(target.querySelector('[data-realm-browser]')).not.toBeNull());
    expect(fixtures.getHub).toHaveBeenCalledOnce();
});
