// Paste into the logged-in PocketRisu browser console after startup.
// Reads cache metadata and performs authenticated, body-free revision probes.
// It does not change the app DB, clear caches or print authentication tokens.
(async () => {
    const key = 'db:database/database.bin';
    const cacheName = 'pocketrisu-transfer-cache-v1';
    async function cacheMetadata() {
        try {
            if (indexedDB.databases && !(await indexedDB.databases()).some(db => db.name === cacheName)) {
                return { exists: false, reason: 'no-cache-database' };
            }
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(cacheName, 1);
                request.onupgradeneeded = () => { request.transaction.abort(); };
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);
            });
            try {
                return await new Promise((resolve, reject) => {
                    const tx = db.transaction(['versions', 'copies'], 'readonly');
                    const version = tx.objectStore('versions').get(key);
                    const copyKey = tx.objectStore('copies').getKey(key);
                    tx.oncomplete = () => resolve({
                        exists: copyKey.result !== undefined,
                        etag: version.result?.etag ?? null,
                        revision: version.result?.revision ?? null,
                        bytes: version.result?.bytes ?? null,
                    });
                    tx.onerror = tx.onabort = () => reject(tx.error);
                });
            } finally { db.close(); }
        } catch (error) {
            return { exists: false, error: error?.name ?? 'CacheReadError' };
        }
    }
    async function request(url, headers = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            return await fetch(url, { cache: 'no-store', credentials: 'same-origin', headers, signal: controller.signal });
        } finally { clearTimeout(timeout); }
    }
    const samples = [];
    try {
        const authResponse = await request('/api/test_auth');
        const auth = await authResponse.json();
        if (!authResponse.ok || auth.status !== 'success' || typeof auth.token !== 'string') {
            throw new Error('로그인된 리수 페이지에서 실행해 주세요.');
        }
        for (let i = 0; i < 3; i++) {
            if (i) await new Promise(resolve => setTimeout(resolve, 2000));
            const cache = await cacheMetadata();
            const headers = {
                'risu-auth': auth.token,
                'file-path': '64617461626173652f64617461626173652e62696e',
                'x-read-check-only': '1',
                ...(cache.etag ? { 'if-none-match': cache.etag } : {}),
                ...(cache.revision ? { 'if-read-revision': cache.revision } : {}),
            };
            const started = performance.now();
            const response = await request('/api/read', headers);
            const isProbe = response.headers.get('x-read-version-check') === '1';
            // Older servers may ignore the probe header. Do not read or decode
            // their potentially large body; this diagnostic requires DataLite.
            await response.body?.cancel();
            samples.push({
                '측정': i + 1,
                '접속후초': +(started / 1000).toFixed(2),
                '캐시': cache,
                '응답상태': response.status,
                '확인전용응답': isProbe,
                '사본최신': isProbe && cache.exists && response.status === 304,
                '서버revision': response.headers.get('x-read-revision'),
                '인덱스로확인': response.headers.get('x-read-index-validator') === '1',
            });
            if (!isProbe || !response.ok && response.status !== 304) break;
        }
        const phases = performance.getEntriesByType('measure')
            .filter(entry => entry.name.startsWith('pocketrisu:startup:'))
            .map(entry => ({ '단계': entry.name.replace('pocketrisu:startup:', ''), '시작초': +(entry.startTime / 1000).toFixed(3), '소요초': +(entry.duration / 1000).toFixed(3) }));
        const writes = performance.getEntriesByType('resource').reduce((counts, entry) => {
            const path = new URL(entry.name).pathname;
            if (['/api/patch', '/api/write', '/api/remove'].includes(path)) counts[path] = (counts[path] ?? 0) + 1;
            return counts;
        }, {});
        const report = {
            '종류': 'pocketrisu-db-sync-check-v2',
            '서버revision관측중변경': new Set(samples.map(row => row['서버revision']).filter(Boolean)).size > 1,
            '확인결과': samples,
            '현재페이지저장요청수': writes,
            '저장요청타임라인': performance.getEntriesByType('resource')
                .filter(entry => ['/api/patch', '/api/write', '/api/remove'].includes(new URL(entry.name).pathname))
                .map(entry => ({ '요청': new URL(entry.name).pathname, '시작초': +(entry.startTime / 1000).toFixed(3), '완료초': +(entry.responseEnd / 1000).toFixed(3) })),
            '동기화추적': typeof globalThis.__pocketrisuSyncDiagnostics === 'function' ? globalThis.__pocketrisuSyncDiagnostics() : [],
            '초기화단계': phases,
        };
        console.log(JSON.stringify(report, null, 2));
        return report;
    } catch (error) {
        const report = { '종류': 'pocketrisu-db-sync-check-v2', '오류': error?.message ?? String(error), '확인결과': samples };
        console.log(JSON.stringify(report, null, 2));
        return report;
    }
})()
