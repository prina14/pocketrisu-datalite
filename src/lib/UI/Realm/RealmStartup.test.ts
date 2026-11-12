// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { get } from 'svelte/store';

const fixtures = vi.hoisted(() => ({
    db: { hideRealm: undefined as boolean | undefined, language: 'en', realmDirectOpen: true, nodeOnlyTransferSizeWarning: false, characters: [] },
    getHub: vi.fn(),
}));
vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store');
    return {
        DBState: { db: fixtures.db }, OpenRealmStore: writable(false), RealmInitialOpenChar: writable(null), openCharacterManager: writable(false),
    };
});
vi.mock('src/ts/alert', async () => {
    const { writable } = await import('svelte/store');
    return { risuTosAccepted: writable(true), alertTOS: vi.fn() };
});
vi.mock('src/ts/characterCards', () => ({ getRisuHub: fixtures.getHub, hubAdditionalHTML: '', hubURL: 'https://realm.example' }));
vi.mock('src/ts/globalApi.svelte', () => ({ getVersionString: () => 'test', openURL: vi.fn() }));
vi.mock('src/ts/characters', () => ({ changeChar: vi.fn(), getCharImage: vi.fn() }));
vi.mock('src/ts/characterActivity', async () => ({ characterActivity: (await import('svelte/store')).writable({}) }));
vi.mock('src/ts/update', async () => {
    const { writable } = await import('svelte/store');
    return { updateInfoStore: writable(null), updatePopupStore: writable(null) };
});
vi.mock('src/ts/publicStats', async () => ({ publicStatsStore: (await import('svelte/store')).writable(null) }));
vi.mock('src/ts/transferSize', async () => {
    const { writable } = await import('svelte/store');
    return { dbTransferSizeStore: writable({ overLimit: false }), transferSizeWarningDismissed: writable(false) };
});
vi.mock('src/ts/secureContext', () => ({ isSecureContext: true }));
vi.mock('src/ts/routing', () => ({ openSettings: vi.fn(), SettingsRoute: { RemoteAccess: 'remote' } }));
vi.mock('src/lang', () => ({ language: new Proxy({
    loading: 'Loading', close: 'Close', errors: { networkFetch: 'Network unavailable', chatLoadRetry: 'Retry' },
}, { get(target, key) { return Reflect.get(target, key) ?? String(key); } }) }));
vi.mock('./RealmHubIcon.svelte', async () => ({ default: (await import('../../../../test/helpers/RealmCard.svelte')).default }));
vi.mock('./RealmMain.svelte', async () => ({ default: (await import('../../../../test/helpers/RealmBrowserProbe.svelte')).default }));

import MainMenu from '../MainMenu.svelte';
import { OpenRealmStore, RealmInitialOpenChar } from 'src/ts/stores.svelte';
import { risuTosAccepted } from 'src/ts/alert';

let app: ReturnType<typeof mount> | undefined;
beforeEach(() => {
    vi.clearAllMocks();
    fixtures.db.hideRealm = undefined;
    fixtures.db.realmDirectOpen = true;
    fixtures.getHub.mockResolvedValue([{ name: 'Example character' }]);
    OpenRealmStore.set(false);
    RealmInitialOpenChar.set(null);
    risuTosAccepted.set(true);
});
afterEach(async () => {
    if (app) await unmount(app);
    app = undefined;
    vi.useRealTimers();
    document.body.replaceChildren();
});
async function home() {
    const target = document.createElement('div');
    document.body.appendChild(target);
    app = mount(MainMenu, { target });
    await tick();
    return target;
}
const toggle = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('[aria-controls="main-realm-section"]')!;

test.each([undefined, true])('collapsed preference %s does not request Realm after waiting on home', async (preference) => {
    vi.useFakeTimers();
    fixtures.db.hideRealm = preference;
    const target = await home();
    await vi.advanceTimersByTimeAsync(5000);
    expect(toggle(target).getAttribute('aria-expanded')).toBe('false');
    expect(fixtures.getHub).not.toHaveBeenCalled();
    expect(target.querySelector('[data-realm-card]')).toBeNull();
});

test('explicit expansion requests cards immediately and card selection preserves direct-open state', async () => {
    const target = await home();
    toggle(target).click();
    await vi.waitFor(() => expect(target.querySelector('[data-realm-card]')).not.toBeNull());
    expect(fixtures.getHub).toHaveBeenCalledOnce();
    target.querySelector<HTMLButtonElement>('[data-realm-card]')!.click();
    await vi.waitFor(() => expect(target.querySelector('[data-realm-browser]')).not.toBeNull());
    expect(get(OpenRealmStore)).toBe(true);
    expect(get(RealmInitialOpenChar)).toEqual({ name: 'Example character' });
});

test('an explicit stored expanded preference keeps the automatic-home delay', async () => {
    fixtures.db.hideRealm = false;
    const target = await home();
    expect(toggle(target).getAttribute('aria-expanded')).toBe('true');
    expect(fixtures.getHub).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(target.querySelector('[data-realm-card]')).not.toBeNull(), { timeout: 2500 });
    expect(fixtures.getHub).toHaveBeenCalledOnce();
});

test('expanded recommendations respect the terms gate before making any request', async () => {
    risuTosAccepted.set(false);
    const target = await home();
    toggle(target).click();
    await vi.waitFor(() => expect(target.textContent).toContain('risuTosGate'));
    expect(fixtures.getHub).not.toHaveBeenCalled();
    risuTosAccepted.set(true);
    await vi.waitFor(() => expect(target.querySelector('[data-realm-card]')).not.toBeNull());
    expect(fixtures.getHub).toHaveBeenCalledOnce();
});

test('failed recommendation reads can be retried and the section can be collapsed', async () => {
    fixtures.getHub.mockRejectedValueOnce(new Error('offline'));
    const target = await home();
    toggle(target).click();
    await vi.waitFor(() => expect(target.textContent).toContain('Network unavailable'));
    Array.from(target.querySelectorAll('button')).find(button => button.textContent === 'Retry')!.click();
    await vi.waitFor(() => expect(target.querySelector('[data-realm-card]')).not.toBeNull());
    expect(fixtures.getHub).toHaveBeenCalledTimes(2);
    toggle(target).click();
    await tick();
    expect(target.querySelector('[data-realm-card]')).toBeNull();
});

test('Get More loads the full browser only after an explicit request and back restores home', async () => {
    const target = await home();
    expect(fixtures.getHub).not.toHaveBeenCalled();
    Array.from(target.querySelectorAll('button')).find(button => button.textContent === 'Get More')!.click();
    await vi.waitFor(() => expect(target.querySelector('[data-realm-browser]')).not.toBeNull());
    expect(fixtures.getHub).toHaveBeenCalledOnce();
    target.querySelector<HTMLButtonElement>('button')!.click();
    await tick();
    expect(target.querySelector('[data-realm-browser]')).toBeNull();
    expect(toggle(target).getAttribute('aria-expanded')).toBe('false');
});
