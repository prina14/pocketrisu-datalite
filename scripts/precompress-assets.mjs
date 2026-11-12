import { promisify } from 'node:util';
import { gzip, brotliCompress, gunzipSync, brotliDecompressSync, constants } from 'node:zlib';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const gz = promisify(gzip), br = promisify(brotliCompress);

export async function writePrecompressedAssets(directory) {
    const assets = path.join(directory, 'assets');
    const manifest = {};
    for (const name of await readdir(assets)) {
        if (!/^[\w.-]+\.(js|css)$/.test(name)) continue;
        // Vite's preload analysis can still rewrite code in generateBundle.
        // Read final written bytes, including source map URLs, instead.
        const bytes = await readFile(path.join(assets, name));
        if (bytes.length < 1024) continue;
        const variants = {};
        for (const [encoding, compress] of [['gzip', () => gz(bytes, { level: 9 })],
            ['br', () => br(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })]]) {
            const output = await compress();
            if (output.length >= bytes.length) continue;
            const suffix = encoding === 'gzip' ? 'gz' : 'br';
            await writeFile(path.join(assets, `${name}.${suffix}`), output);
            variants[encoding] = true;
        }
        manifest[name] = variants;
    }
    await writeFile(path.join(assets, '_precompressed.json'), JSON.stringify(manifest));
}

export async function verifyPrecompressedAssets(directory) {
    const assets = path.join(directory, 'assets');
    const manifest = JSON.parse(await readFile(path.join(assets, '_precompressed.json'), 'utf8'));
    let count = 0;
    for (const [name, variants] of Object.entries(manifest)) {
        if (!/^[\w.-]+\.(js|css)$/.test(name)) throw new Error('Invalid precompressed asset name');
        const original = await readFile(path.join(assets, name));
        for (const encoding of Object.keys(variants)) {
            if (!['br', 'gzip'].includes(encoding)) throw new Error('Invalid asset encoding');
            const encoded = await readFile(path.join(assets, `${name}.${encoding === 'br' ? 'br' : 'gz'}`));
            const decoded = encoding === 'br' ? brotliDecompressSync(encoded) : gunzipSync(encoded);
            if (!decoded.equals(original)) throw new Error(`Precompressed bytes differ: ${name} (${encoding})`);
            count++;
        }
    }
    if (!count) throw new Error('Missing precompressed app assets');
    return count;
}

// Run once on the build machine, never on the small user's server.
export function precompressedAssets() {
    let outputDirectory = 'dist';
    return {
        name: 'precompressed-app-assets',
        apply: /** @type {const} */ ('build'),
        configResolved(config) { outputDirectory = path.resolve(config.root, config.build.outDir); },
        async writeBundle(options) { await writePrecompressedAssets(options.dir || outputDirectory); },
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv[2] !== '--verify') throw new Error('Usage: node scripts/precompress-assets.mjs --verify dist');
    const count = await verifyPrecompressedAssets(process.argv[3] || 'dist');
    console.log(`Verified ${count} exact precompressed representations.`);
}
