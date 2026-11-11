'use strict';

const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { prepareDelta } = require('./readDelta.mjs');

if (!isMainThread) {
    parentPort.on('message', bytes => {
        const { sha256, blocks } = prepareDelta(bytes,
            data => createHash('sha256').update(data).digest('hex'));
        // Keep the original bytes owned by the main thread. Return only the
        // index, not another copy of the full database.
        parentPort.postMessage({ sha256, blocks });
    });
}

// One lazy worker, one input at a time. Queued jobs retain existing immutable
// snapshot references, but do not copy more DBs into the worker in advance.
function createDeltaPreparer() {
    let worker = null, active = null, serial = Promise.resolve();
    const ensureWorker = () => {
        if (worker) return worker;
        const instance = new Worker(__filename);
        worker = instance;
        instance.on('message', result => {
            const job = active; active = null;
            instance.unref();
            job?.resolve(result);
        });
        const fail = error => {
            if (worker !== instance) return;
            worker = null;
            const job = active; active = null;
            job?.reject(error);
        };
        instance.on('error', fail);
        instance.on('exit', code => fail(new Error(`Read index worker exited (${code})`)));
        instance.unref();
        return instance;
    };
    return {
        prepare(bytes) {
            const run = serial.then(() => new Promise((resolve, reject) => {
                const instance = ensureWorker();
                active = { resolve, reject };
                instance.ref();
                try {
                    // Transfer one exact-size copy, never the shared snapshot
                    // or an oversized msgpack backing allocation.
                    const copy = new Uint8Array(bytes);
                    instance.postMessage(copy, [copy.buffer]);
                }
                catch (error) { active = null; instance.unref(); reject(error); }
            }));
            serial = run.catch(() => {});
            return run;
        },
        async close() {
            await serial;
            const instance = worker;
            worker = null;
            if (instance) await instance.terminate();
        },
    };
}

module.exports = { createDeltaPreparer };
