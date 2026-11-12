'use strict';
const path = require('node:path');
const { readFileSync } = require('node:fs');
const express = require('express');
const { preferredReadEncoding } = require('./read-snapshot-cache.cjs');

function createPrecompressedAssets(root) {
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(path.join(root, '_precompressed.json'), 'utf8')); }
    catch { /* Old builds use the normal static/compression middleware. */ }
    const serve = express.static(root, { maxAge: '1y', immutable: true });
    return (req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method) || req.headers.range) return next();
        let name;
        try { name = decodeURIComponent(req.path).slice(1); } catch { return next(); }
        if (!/^[\w.-]+\.(js|css)$/.test(name) || !Object.hasOwn(manifest, name)) return next();
        res.vary('Accept-Encoding');
        const encoding = preferredReadEncoding(req);
        if (!['br', 'gzip'].includes(encoding) || manifest[name]?.[encoding] !== true) return next();
        const original = req.url;
        req.url = `/${name}.${encoding === 'br' ? 'br' : 'gz'}`;
        res.type(name.endsWith('.js') ? 'application/javascript' : 'text/css');
        res.setHeader('Content-Encoding', encoding);
        res.setHeader('x-static-precompressed', encoding);
        return serve(req, res, error => {
            req.url = original;
            if (!res.headersSent) {
                res.removeHeader('Content-Encoding');
                res.removeHeader('Content-Type');
                res.removeHeader('x-static-precompressed');
            }
            next(error);
        });
    };
}
module.exports = { createPrecompressedAssets };
