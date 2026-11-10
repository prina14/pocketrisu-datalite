// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { rebuildOrder, type OrderEntry } from 'src/ts/characterOrder'
import type { ManagerEntry } from 'src/ts/characterManager'

vi.mock('src/lang', () => ({ language: { none: 'None', defaultLabel: 'Default' } }))
vi.mock('src/ts/storage/database.svelte', () => ({ folderDisplayMode: () => 'name' }))
vi.mock('src/lib/UI/GUI/ShSortableList.svelte', async () => await import('../../../test/helpers/SortableListProbe.svelte'))
vi.mock('./CharacterRow.svelte', async () => await import('../../../test/helpers/CharacterRowProbe.svelte'))
vi.mock('src/lib/UI/GUI/ShDropdownMenu.svelte', async () => await import('../../../test/helpers/EmptyComponent.svelte'))
vi.mock('src/lib/UI/GUI/ShDropdownMenuTrigger.svelte', async () => await import('../../../test/helpers/EmptyComponent.svelte'))
vi.mock('src/lib/UI/GUI/ShDropdownMenuContent.svelte', async () => await import('../../../test/helpers/EmptyComponent.svelte'))

import CharacterOrderList from './CharacterOrderList.svelte'
let app: ReturnType<typeof mount> | undefined
afterEach(async () => {
    if (app) await unmount(app)
    app = undefined
    document.body.replaceChildren()
    localStorage.clear()
})

test('1,000 characters in collapsed folders mount only the loose row, retain drag membership, and load on expansion', async () => {
    const first = { id: 'one', name: 'One', data: Array.from({ length: 500 }, (_, i) => `a-${i}`) }
    const second = { id: 'two', name: 'Two', data: Array.from({ length: 500 }, (_, i) => `b-${i}`) }
    const order = [first, second, 'loose'] as OrderEntry[]
    const ids = [...first.data, ...second.data, 'loose']
    const entries = new Map(ids.map(id => [id, { chaId: id, name: id }] as [string, ManagerEntry]))
    const changed = vi.fn()
    localStorage.setItem('risu-character-manager-collapsed', JSON.stringify(['one', 'two']))
    const target = document.createElement('div'); document.body.appendChild(target)
    app = mount(CharacterOrderList, { target, props: {
        order, entries, visible: () => true, onOpen: vi.fn(), onLayoutChange: changed,
    } })
    await tick()
    expect(target.querySelectorAll('[data-character-row]')).toHaveLength(1)
    const root = target.querySelector('[data-risu-sortable-list]')!
    root.insertBefore(target.querySelector('[data-folder-id="two"]')!, target.querySelector('[data-folder-id="one"]')!)
    root.querySelector<HTMLButtonElement>(':scope > [data-drop-probe]')!.click()
    expect(rebuildOrder(order, changed.mock.calls[0][0])).toEqual([second, first, 'loose'])
    target.querySelector<HTMLElement>('[data-folder-id="one"] > [role="button"]')!.click()
    await tick()
    expect(target.querySelectorAll('[data-character-row]')).toHaveLength(501)
    target.querySelector<HTMLElement>('[data-folder-id="one"] > [role="button"]')!.click()
    await tick()
    expect(target.querySelectorAll('[data-character-row]')).toHaveLength(1)
})
