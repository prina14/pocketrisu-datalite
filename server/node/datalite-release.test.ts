import { expect, test } from 'vitest'
const { REPOSITORY, releaseInfo, portableAsset, newerVersion } = require('./datalite-release.cjs')

test('DataLite checks its own repository and published custom release', () => {
    expect(REPOSITORY).toBe('prina14/pocketrisu-datalite')
    const release = { tag_name: 'v1.17.0-datalite.2', name: 'DataLite 2', draft: false, prerelease: false }
    expect(releaseInfo('1.17.0-datalite.1', release)).toMatchObject({ latestVersion: '1.17.0-datalite.2', hasUpdate: true, severity: 'optional' })
    expect(releaseInfo('1.17.0-datalite.2', release).hasUpdate).toBe(false)
    for (const bad of [{}, { tag_name: 'v1.18.0' }, { ...release, draft: true }, { ...release, prerelease: true }]) {
        expect(releaseInfo('1.17.0-datalite.1', bad).hasUpdate).toBe(false)
    }
})

test('custom updates never downgrade a newer installed build', () => {
    expect(newerVersion('1.17.0-datalite.2', '1.17.0-datalite.1')).toBe(false)
    expect(newerVersion('1.17.0-datalite.2', '1.17.0-datalite.3')).toBe(true)
    expect(newerVersion('1.17.0', '1.17.0-datalite.1')).toBe(true)
    expect(newerVersion('1.18.0-datalite.1', '1.17.0-datalite.9')).toBe(false)
})

test('a checksum file is never selected as the portable archive', () => {
    const archive = { name: 'PocketRisu-v1.17.0-datalite.1-linux-x64.tar.gz' }
    expect(portableAsset([{ name: archive.name + '.sha256' }, archive], 'linux-x64')).toBe(archive)
    expect(portableAsset([archive], 'linux-arm64')).toBeUndefined()
    expect(portableAsset([{ name: 'PocketRisu-v1.17.0-datalite.1-win-x64.zip' }], 'win-x64')).toBeTruthy()
})
