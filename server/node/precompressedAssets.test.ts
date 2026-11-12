import { test, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { request } from 'node:http'
import { brotliCompressSync, gzipSync, brotliDecompressSync, gunzipSync } from 'node:zlib'
const express = require('express')
const compression = require('compression')
const { createPrecompressedAssets } = require('./precompressed-assets.cjs')

test('build compression consumes final files, including late preload analysis and source maps', async () => {
    const { precompressedAssets, verifyPrecompressedAssets } = await import('../../scripts/precompress-assets.mjs')
    const root = await mkdtemp(path.join(tmpdir(), 'risu-final-compression-'))
    await mkdir(path.join(root, 'assets'))
    try {
        const file = path.join(root, 'assets', 'app-final.js')
        await writeFile(file, 'const placeholder = "__VITE_PRELOAD__";'.repeat(100))
        await writeFile(file, 'const preload = ["final-dependency.js"];'.repeat(100) + '\n//# sourceMappingURL=app-final.js.map')
        await precompressedAssets().writeBundle({ dir: root })
        expect(await verifyPrecompressedAssets(root)).toBe(2)
        await writeFile(file, 'incorrect later overwrite')
        await expect(verifyPrecompressedAssets(root)).rejects.toThrow('Precompressed bytes differ')
    } finally { await rm(root, { recursive: true, force: true }) }
})

test('prebuilt assets negotiate exact bytes, MIME, private encoding validators, HEAD and legacy fallback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'risu-precompressed-'))
    const source = Buffer.from('const app = "Hello Korean 안녕";\n'.repeat(1000))
    await Promise.all([
        writeFile(path.join(root, 'app-hash.js'), source),
        writeFile(path.join(root, 'app-hash.js.br'), brotliCompressSync(source)),
        writeFile(path.join(root, 'app-hash.js.gz'), gzipSync(source)),
        writeFile(path.join(root, 'legacy.js'), source),
        writeFile(path.join(root, '_precompressed.json'), JSON.stringify({ 'app-hash.js': { br: true, gzip: true }, 'missing.js': { br: true } })),
    ])
    const app = express()
    app.use(compression())
    app.use('/assets', createPrecompressedAssets(root))
    app.use('/assets', express.static(root))
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
    const port = server.address().port
    const get = (pathname: string, encoding: string, extra = {}, method = 'GET') => new Promise<any>((resolve, reject) => {
        request({ hostname: '127.0.0.1', port, path: pathname, method, headers: { 'accept-encoding': encoding, ...extra } }, res => {
            const body: Buffer[] = []; res.on('data', chunk => body.push(chunk))
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(body) }))
        }).on('error', reject).end()
    })
    try {
        const br = await get('/assets/app-hash.js?version=1', 'gzip, br')
        expect(br.headers['x-static-precompressed']).toBe('br')
        expect(br.headers['content-type']).toMatch(/javascript/)
        expect(br.headers.vary).toContain('Accept-Encoding')
        expect(br.headers['cache-control']).toContain('immutable')
        expect(brotliDecompressSync(br.body)).toEqual(source)
        const gz = await get('/assets/app-hash.js', 'br;q=0,gzip')
        expect(gz.headers['x-static-precompressed']).toBe('gzip')
        expect(gunzipSync(gz.body)).toEqual(source)
        expect(gz.headers.etag).not.toBe(br.headers.etag)
        const plain = await get('/assets/app-hash.js', 'identity')
        expect(plain.headers['content-encoding']).toBeUndefined()
        expect(plain.body).toEqual(source)
        const cached = await get('/assets/app-hash.js', 'br', { 'if-none-match': br.headers.etag })
        expect(cached.status).toBe(304)
        expect(cached.headers.vary).toContain('Accept-Encoding')
        expect((await get('/assets/app-hash.js', 'br', {}, 'HEAD')).body.length).toBe(0)
        const legacy = await get('/assets/legacy.js', 'gzip')
        expect(legacy.headers['x-static-precompressed']).toBeUndefined()
        expect(gunzipSync(legacy.body)).toEqual(source)
        expect((await get('/assets/missing.js', 'br')).headers['content-encoding']).toBeUndefined()
        expect((await get('/assets/%2e%2e%2fsecret.js', 'br')).status).not.toBe(200)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})
