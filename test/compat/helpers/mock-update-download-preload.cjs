// Keep the integration test offline and stop at extraction, before replacing
// any files. A broken archive still exercises the real download/staging path.
const original = globalThis.fetch;
const version = '99.0.0-datalite.1';
const name = `PocketRisu-v${version}-linux-x64.tar.gz`;
globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/prina14/pocketrisu-datalite/releases/latest') {
        return Response.json({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name }] });
    }
    if (url === `https://github.com/prina14/pocketrisu-datalite/releases/download/v${version}/${name}`) {
        return new Response('intentionally invalid archive');
    }
    return original(input, init);
};
