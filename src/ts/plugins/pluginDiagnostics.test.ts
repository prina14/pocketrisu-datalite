import { test, expect } from 'vitest'
import { beginPluginInitialization, recordPluginWrite } from './pluginDiagnostics'
import { getSyncDiagnostics } from '../storage/syncDiagnostics'
test('plugin completion is independent of UI startup and cannot be finished twice', () => {
    const finish = beginPluginInitialization('fixture', '3.0')
    expect(globalThis.__pocketrisuPluginDiagnostics!().at(-1)?.state).toBe('pending')
    finish(true); finish(false)
    const row = globalThis.__pocketrisuPluginDiagnostics!().at(-1)!
    expect(row.state).toBe('complete')
    expect(row.durationMs).toBeGreaterThanOrEqual(0)
    row.name = 'changed copy'
    expect(globalThis.__pocketrisuPluginDiagnostics!().at(-1)?.name).toBe('fixture')
})
test('diagnostics remain bounded and record only requested root fields', () => {
    for (let i = 0; i < 50; i++) beginPluginInitialization('fixture-' + i, '3.0')(false)
    expect(globalThis.__pocketrisuPluginDiagnostics!()).toHaveLength(40)
    recordPluginWrite('fixture', 'setArgument', ['plugins'])
    expect(getSyncDiagnostics().at(-1)).toMatchObject({ type: 'plugin-write-request', roots: ['plugins'], plugin: 'fixture' })
})
