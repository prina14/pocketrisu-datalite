'use strict';

const REPOSITORY = 'prina14/pocketrisu-datalite';

function newerVersion(current, next) {
    const parse = value => /^(\d+)\.(\d+)\.(\d+)(?:-datalite\.(\d+))?$/.exec(value)?.slice(1).map(v => Number(v || 0));
    const before = parse(current), after = parse(next);
    if (!after) return false;
    if (!before) return true;
    for (let i = 0; i < after.length; i++) {
        if (after[i] !== before[i]) return after[i] > before[i];
    }
    return false;
}

// The fork uses its own Releases rather than upstream's update notification
// service, so updating a portable cannot replace the DataLite changes.
function releaseInfo(currentVersion, release) {
    const latestVersion = typeof release?.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : currentVersion;
    const valid = /^\d+\.\d+\.\d+-datalite\.\d+$/.test(latestVersion);
    const hasUpdate = valid && !release?.draft && !release?.prerelease && newerVersion(currentVersion, latestVersion);
    return {
        currentVersion,
        latestVersion: valid ? latestVersion : currentVersion,
        hasUpdate,
        severity: hasUpdate ? 'optional' : 'none',
        releaseUrl: `https://github.com/${REPOSITORY}/releases`,
        releaseName: typeof release?.name === 'string' ? release.name : 'PocketRisu DataLite',
        publishedAt: typeof release?.published_at === 'string' ? release.published_at : '',
        manualOnly: !portableAsset(Array.isArray(release?.assets) ? release.assets : [], `${{ win32: 'win', linux: 'linux', darwin: 'macos' }[process.platform]}-${process.arch}`),
    };
}

function portableAsset(assets, suffix) {
    const ext = suffix.startsWith('win-') ? 'zip' : 'tar.gz';
    return assets.find(asset => typeof asset?.name === 'string' && asset.name.endsWith(`${suffix}.${ext}`));
}

module.exports = { REPOSITORY, releaseInfo, portableAsset, newerVersion };
