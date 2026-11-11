'use strict';

const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

// Context for a request, not a portion of its duration. A stall before Node
// dispatches the HTTP request cannot appear in request-to-handler timing.
function createStartupLoopProbe({ histogram = monitorEventLoopDelay({ resolution: 20 }), now = () => performance.now() } = {}) {
    const recent = [];
    let nextSample = now() + 1000;
    histogram.enable();
    const sample = () => {
        const time = now();
        recent.push({ time, ms: Math.max(histogram.max / 1e6, time - nextSample, 0) });
        while (recent.length && recent[0].time < time - 5000) recent.shift();
        histogram.reset();
        nextSample = time + 1000;
    };
    const timer = setInterval(sample, 1000);
    timer.unref?.();
    return {
        maxMs() {
            const time = now();
            return Math.max(0, histogram.max / 1e6, time - nextSample,
                ...recent.filter(row => row.time >= time - 5000).map(row => row.ms));
        },
        close() { clearInterval(timer); histogram.disable(); },
    };
}

module.exports = { createStartupLoopProbe };
