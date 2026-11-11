import { expect, test } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import StartupPreview from './StartupPreview.svelte'

test('shows real names as escaped read-only content, with no media requests or editing controls', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(StartupPreview, { target, props: {
        names: ['Alice', '<img src=x onerror=alert(1)>'], total: 2,
        heading: 'Characters', loadingLabel: 'Preparing chats',
    } })
    try {
        await tick()
        expect(target.textContent).toContain('Alice')
        expect(target.textContent).toContain('<img src=x onerror=alert(1)>')
        expect(target.querySelector('[aria-busy="true"]')).not.toBeNull()
        expect(target.querySelector('[role="status"]')?.textContent).toBe('Preparing chats')
        expect(target.querySelector('img,video,audio,iframe,button,input,textarea,a')).toBeNull()
    } finally { await unmount(app); target.remove() }
})
