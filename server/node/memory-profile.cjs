'use strict';

const os = require('node:os');

const MiB = 1024 * 1024;
const LOW_MEMORY_LIMIT = 2 * 1024 * MiB;

// constrainedMemory accounts for a container limit; zero means no known limit.
// Use total capacity, not currently free RAM, so the profile is stable on restart.
function getMemoryProfile({
    env = process.env,
    totalMemory = os.totalmem(),
    constrainedMemory = process.constrainedMemory?.() || 0,
} = {}) {
    const requested = env.POCKETRISU_MEMORY_PROFILE || 'auto';
    if (!['auto', 'low', 'standard'].includes(requested)) {
        throw new Error('POCKETRISU_MEMORY_PROFILE must be auto, low, or standard');
    }
    const capacities = [totalMemory, constrainedMemory].filter(n => Number.isFinite(n) && n > 0);
    const capacity = capacities.length ? Math.min(...capacities) : Infinity;
    const low = requested === 'low' || (requested === 'auto' && capacity <= LOW_MEMORY_LIMIT);
    return {
        name: low ? 'low' : 'standard',
        // Keep the original standard profile values, including SQLite's KiB units.
        sqliteCacheKiB: low ? 8192 : 64000,
        sqliteMmapBytes: low ? 0 : 256 * MiB,
        sqliteTempStore: low ? 'FILE' : 'MEMORY',
        assetManifestCacheBytes: (low ? 8 : 64) * MiB,
    };
}

function applySqliteMemoryProfile(db, profile) {
    db.pragma(`cache_size = -${profile.sqliteCacheKiB}`);
    db.pragma(`mmap_size = ${profile.sqliteMmapBytes}`);
    db.pragma(`temp_store = ${profile.sqliteTempStore}`);
}

module.exports = { getMemoryProfile, applySqliteMemoryProfile };
