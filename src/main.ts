// Keep this entry independent of the application, polyfills and full CSS.
// The inline HTML shell can paint while these larger modules are still loading.
import { startAppAfterShellPaint, showStartupFailure } from './ts/startupShell';

window.addEventListener('vite:preloadError', (event) => {
    console.error('Chunk load error detected:', event);
    showStartupFailure();
});

void startAppAfterShellPaint(() => import('./appEntry')).catch(error => {
    console.error('Application startup failed:', error);
    showStartupFailure();
});
