import { expect, test, vi } from 'vitest';
import { writable } from 'svelte/store';

// Test defaults against the real normalizer without the application-wide effects.
vi.mock('../stores.svelte', () => ({ DBState: { db: {} }, selectedCharID: writable(-1), selIdState: {} }));

import { setDatabase, themePresetTemplate, type Database } from './database.svelte';

test('missing Realm preference defaults to collapsed without overriding stored preferences', () => {
    const fresh = {} as Database;
    setDatabase(fresh);
    expect(fresh.hideRealm).toBe(true);
    expect(fresh.themePresets[0].hideRealm).toBe(true);
    expect(themePresetTemplate.hideRealm).toBe(true);
    for (const preference of [false, true]) {
        const existing = { hideRealm: preference } as Database;
        setDatabase(existing);
        expect(existing.hideRealm).toBe(preference);
    }
});
