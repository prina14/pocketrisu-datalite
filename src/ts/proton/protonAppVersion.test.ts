import { expect, test } from 'vitest'
import { protonAppVersion } from './protonAppVersion'

test.each(['1.17.0', '1.17.0-datalite.27', '1.17.0-datalite.28+build.1'])('uses a Proton-compatible release label for %s', version => {
    expect(protonAppVersion(version)).toBe('external-drive-pocketrisu@1.17.0-stable')
})

test('keeps a valid external version when package metadata is unavailable', () => {
    expect(protonAppVersion('unknown')).toBe('external-drive-pocketrisu@0.0.0-stable')
})
