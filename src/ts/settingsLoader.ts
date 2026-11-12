let pending: Promise<typeof import('../lib/Setting/Settings.svelte')> | undefined

/** Share a speculative import with the next real navigation. Retry failures. */
export function loadSettings() {
    if (!pending) {
        pending = import('../lib/Setting/Settings.svelte').catch(error => {
            pending = undefined
            throw error
        })
    }
    return pending
}
