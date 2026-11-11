/** Give the HTML shell a render opportunity before loading the application.
 * Hidden/throttled tabs still start through the timer fallback. */
export function startAppAfterShellPaint(load: () => Promise<unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
        let started = false
        let fallback: ReturnType<typeof setTimeout>
        const start = () => {
            if (started) return
            started = true
            clearTimeout(fallback)
            try { Promise.resolve(load()).then(() => resolve(), reject) }
            catch (error) { reject(error) }
        }
        fallback = setTimeout(start, 100)
        if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') {
            try { requestAnimationFrame(() => setTimeout(start, 0)) }
            catch { start() }
        } else start()
    })
}

/** A failed app/CSS chunk must leave a usable recovery action. */
export function showStartupFailure(): void {
    const shell = document.getElementById('preloading')
    if (!shell) {
        // After mount the existing application owns the screen.
        window.alert('PocketRisu could not load an application file. Please refresh the page.')
        return
    }
    shell.setAttribute('aria-busy', 'false')
    const status = document.getElementById('startup-status')
    if (status) status.textContent = 'Unable to connect. Please reload.'
    const retry = document.getElementById('startup-retry') as HTMLButtonElement | null
    if (retry) {
        retry.hidden = false
        retry.onclick = () => window.location.reload()
    }
}
