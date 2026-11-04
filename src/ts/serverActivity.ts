export type ActivityState = 'idle' | 'working' | 'unavailable'
type Activity = { generating: number; saving: boolean }

// Observe only. No session claims, writes, DB refreshes or reloads here.
// Slow idle polling and pausing hidden pages keep mobile traffic small.
export function createActivityMonitor(read: (signal: AbortSignal) => Promise<Activity>, publish: (state: ActivityState) => void) {
    let visible = false
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: AbortController | null = null

    async function poll() {
        if (!visible || stopped || current) return
        const controller = new AbortController()
        current = controller
        let timeout: ReturnType<typeof setTimeout>
        let delay = 15_000
        try {
            const activity = await Promise.race([
                read(controller.signal),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => { controller.abort(); reject(new Error('Activity timeout')) }, 8000)
                }),
            ])
            if (stopped || !visible || controller !== current) return
            const working = activity.generating > 0 || activity.saving
            publish(working ? 'working' : 'idle')
            if (working) delay = 5000
        } catch {
            if (!stopped && visible && controller === current) publish('unavailable')
            delay = 30_000
        } finally {
            clearTimeout(timeout)
            if (current === controller) {
                current = null
                if (!stopped && visible) timer = setTimeout(poll, delay)
            }
        }
    }

    return {
        setVisible(value: boolean) {
            if (stopped || visible === value) return
            visible = value
            clearTimeout(timer)
            if (!value) {
                const previous = current
                current = null
                previous?.abort()
                publish('idle') // never show a stale busy indicator on return
            } else void poll()
        },
        stop() {
            stopped = true
            clearTimeout(timer)
            current?.abort()
            current = null
        },
    }
}
