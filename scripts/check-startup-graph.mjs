import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';

const root = path.resolve(process.argv[2] || 'dist', 'assets');
const entries = (await readdir(root)).filter(name => /^startupStorage-.*\.js$/.test(name));
if (!entries.length) throw new Error('Missing early storage entry');
for (const entry of entries) {
    const visited = new Set();
    async function visit(file) {
        if (visited.has(file)) return;
        visited.add(file);
        if (!file.startsWith(root + path.sep)) throw new Error('Unexpected external startup dependency');
        const ast = parse(await readFile(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
        for (const statement of ast.body) {
            if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(statement.type) && statement.source?.value?.startsWith('.')) {
                await visit(path.resolve(path.dirname(file), statement.source.value));
            }
        }
    }
    await visit(path.join(root, entry));
    let bytes = 0;
    for (const file of visited) {
        if (/^(?:appEntry|database\.svelte|plugins|parser|lang)-/.test(path.basename(file))) throw new Error('Application pulled into early storage: ' + path.basename(file));
        bytes += (await stat(file)).size;
    }
    if (bytes > 256 * 1024) throw new Error(`Early storage grew beyond 256 KiB: ${bytes}`);
    console.log(JSON.stringify({ earlyStorage: entry, files: visited.size, rawBytes: bytes, lightweight: true }));
}
