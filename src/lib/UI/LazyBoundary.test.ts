// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { Component } from 'svelte'

vi.mock('src/lang', () => ({ language: {
    loading: 'Loading', close: 'Close', errors: { networkFetch: 'Unable to load. Check the connection.', chatLoadRetry: 'Retry' },
} }))
import Harness from '../../../test/helpers/LazyBoundaryHarness.svelte'
import Panel from '../../../test/helpers/LazyBoundaryPanel.svelte'

let app: ReturnType<typeof mount> | undefined
afterEach(async () => {
    if (app) await unmount(app)
    app = undefined
    document.body.replaceChildren()
})

async function show(load: () => Promise<{ default: Component<any> }>) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    app = mount(Harness, { target, props: { load } })
    await tick()
    return target
}

test('waits for an explicit opening, then preserves child props and close callback', async () => {
    let resolve!: (value: { default: typeof Panel }) => void
    const load = vi.fn(() => new Promise<{ default: typeof Panel }>(r => { resolve = r }))
    const target = await show(load)
    expect(load).not.toHaveBeenCalled()
    target.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(target.textContent).toContain('Loading')
    expect(target.querySelector('[data-testid="loaded-panel"]')).toBeNull()
    resolve({ default: Panel })
    await vi.waitFor(() => expect(target.textContent).toContain('Requested settings panel'))
    target.querySelector<HTMLButtonElement>('[data-testid="loaded-panel"] button')!.click()
    await tick()
    expect(target.querySelector('[data-testid="loaded-panel"]')).toBeNull()
})

test('shows an actionable error and retries a failed module load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ default: Panel })
    const target = await show(load)
    target.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(target.textContent).toContain('Unable to load'))
    const retry = Array.from(target.querySelectorAll('button')).find(b => b.textContent === 'Retry')!
    retry.click()
    await vi.waitFor(() => expect(target.textContent).toContain('Requested settings panel'))
    expect(load).toHaveBeenCalledTimes(2)
})

test('closing during a slow import prevents a late dialog from appearing', async () => {
    let resolve!: (value: { default: typeof Panel }) => void
    const load = vi.fn(() => new Promise<{ default: typeof Panel }>(r => { resolve = r }))
    const target = await show(load)
    target.querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    Array.from(target.querySelectorAll('button')).find(b => b.textContent === 'Close')!.click()
    await tick()
    resolve({ default: Panel })
    await tick()
    expect(target.querySelector('[data-testid="loaded-panel"]')).toBeNull()
    expect(target.textContent).not.toContain('Loading')
})
