// Keep this entry independent of the application, polyfills and full CSS.
// The inline HTML shell can paint while these larger modules are still loading.
import { startAppAfterShellPaint, showStartupFailure } from './ts/startupShell';
import { prefetchStartupPreview, renderStartupPreview } from './ts/earlyStartupPreview';

window.addEventListener('vite:preloadError', (event) => {
    console.error('Chunk load error detected:', event);
    showStartupFailure();
});

void startAppAfterShellPaint(() => {
    void prefetchStartupPreview().then(renderStartupPreview).catch(() => {});
    if (globalThis.__NODE__) {
        void import('./ts/storage/startupStorage').then(module => module.startStartupStoragePrefetch()).catch(() => {});
    }
    return import('./appEntry');
}).catch(error => {
    console.error('Application startup failed:', error);
    showStartupFailure();
});
