import { expect, test } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

// Execute the real replacement phases against disposable files. Include the
// empty backup folder that older portable smoke tests accidentally shipped.
test.each(['scripts/updater.cjs', 'server/node/server.cjs'])('%s preserves protected paths even when the archive contains them', async sourcePath => {
    const root = await fsp.mkdtemp(path.join(tmpdir(), 'risu-preserve-'))
    const appDir = path.join(root, 'app'), sourceDir = path.join(root, 'archive')
    const updateTmp = path.join(appDir, '.update-tmp')
    try {
        for (const dir of [appDir, sourceDir]) {
            for (const child of ['save', 'backups', 'data', 'scripts', 'dist', 'server']) {
                await fsp.mkdir(path.join(dir, child), { recursive: true })
            }
            await fsp.writeFile(path.join(dir, 'package.json'), '{}')
            await fsp.writeFile(path.join(dir, 'dist/index.html'), dir === sourceDir ? 'new app' : 'old app')
        }
        await fsp.mkdir(updateTmp)
        await fsp.writeFile(path.join(appDir, 'backups/risu-backup-123.bin'), 'existing backup')
        await fsp.writeFile(path.join(appDir, 'data/custom-backup.bin'), 'custom backup')
        await fsp.writeFile(path.join(appDir, 'save/database'), 'existing database')
        await fsp.writeFile(path.join(appDir, '.env'), 'existing configuration')
        await fsp.writeFile(path.join(sourceDir, '.env'), 'package configuration')
        const source = await fsp.readFile(sourcePath, 'utf8')
        const start = source.indexOf("const keep = new Set(['save', 'backups'")
        const end = source.indexOf('// Phase 3: update scripts/', start)
        expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
        const web = sourcePath.startsWith('server/')
        const context = {
            fs: web ? fsp : fs, path, ROOT: appDir, appDir, sourceDir, extractedRoot: sourceDir,
            tmpDir: updateTmp, updateTmp, isWin: false, skipBinReplacement: false,
            MANIFEST_NAME: '.installed-manifest', inProgressMarker: path.join(updateTmp, 'in-progress'),
            targetVersion: 'fixture', latest: 'fixture',
            REQUIRED_ENTRIES: ['dist', 'server', 'package.json'], REQUIRED_DIST_FILES: ['index.html'],
            existsSync: fs.existsSync, getCustomBackupKeepEntry: () => 'data', customBackupKeepEntry: () => 'data',
            readInstalledManifest: () => ({ exists: false, entries: [] }),
            moveAcrossVolumes: (from: string, to: string) => fsp.rename(from, to),
            log: () => {}, console: { log: () => {} }, logger: { error: () => {} },
            restoreBackup: () => { throw Error('unexpected rollback') },
            restoreBackupIntoRoot: () => { throw Error('unexpected rollback') },
            error: (message: string) => { throw Error(message) },
        }
        await vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, context)
        expect(await fsp.readFile(path.join(appDir, 'backups/risu-backup-123.bin'), 'utf8')).toBe('existing backup')
        expect(await fsp.readFile(path.join(appDir, 'data/custom-backup.bin'), 'utf8')).toBe('custom backup')
        expect(await fsp.readFile(path.join(appDir, 'save/database'), 'utf8')).toBe('existing database')
        expect(await fsp.readFile(path.join(appDir, '.env'), 'utf8')).toBe('existing configuration')
        expect(await fsp.readFile(path.join(appDir, 'dist/index.html'), 'utf8')).toBe('new app')
    } finally {
        if (!root.startsWith(path.join(tmpdir(), 'risu-preserve-'))) throw Error('Unexpected fixture path')
        await fsp.rm(root, { recursive: true, force: true })
    }
})
