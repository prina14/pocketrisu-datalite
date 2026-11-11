import { expect, test, vi } from 'vitest'

test('idle reloads are allowed; pending work and open editors stay protected', async () => {
    vi.resetModules()
    const { registerUnsavedWork } = await import('./unsavedWork')
    const { preLoadCheck } = await import('../../preload')
    const add = vi.spyOn(window, 'addEventListener')
    preLoadCheck(); preLoadCheck()
    const handlers = add.mock.calls.filter(([name]) => name === 'beforeunload')
    expect(handlers).toHaveLength(1)
    const handler = handlers[0][1] as EventListener
    const blocked = () => { const event = new Event('beforeunload', { cancelable: true }); handler(event); return event.defaultPrevented }
    expect(blocked()).toBe(false)
    let pending = true
    const unregister = registerUnsavedWork(() => pending)
    expect(blocked()).toBe(true)
    pending = false
    expect(blocked()).toBe(false)
    const editor = document.createElement('div'); editor.setAttribute('role', 'dialog'); document.body.appendChild(editor)
    vi.spyOn(editor, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    expect(blocked()).toBe(true)
    editor.setAttribute('aria-hidden', 'true')
    expect(blocked()).toBe(false)
    editor.remove(); unregister()
    expect(blocked()).toBe(false)
    window.removeEventListener('beforeunload', handler)
    add.mockRestore()
})

test('broken save-state providers remain conservative and can be removed', async () => {
    vi.resetModules()
    const { registerUnsavedWork, hasUnsavedWork } = await import('./unsavedWork')
    const unregister = registerUnsavedWork(() => { throw Error('broken provider') })
    expect(hasUnsavedWork()).toBe(true)
    unregister()
    expect(hasUnsavedWork()).toBe(false)
})
