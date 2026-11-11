// Simulate a saturated filesystem/native compression pool only for static
// API-path probes. Real API storage I/O remains available.
const fs = require('node:fs');
const original = fs.stat;
fs.stat = (file, ...args) => {
    if (String(file).replaceAll('\\', '/').includes('/dist/api/')) {
        fs.writeFileSync('api-static-probed', 'yes');
        return setTimeout(() => original(file, ...args), 5000);
    }
    return original(file, ...args);
};
