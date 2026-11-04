<script lang="ts">
    import { onMount } from 'svelte'
    import { language } from 'src/lang'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { createActivityMonitor, type ActivityState } from 'src/ts/serverActivity'

    let state = $state<ActivityState>('idle')
    onMount(() => {
        const monitor = createActivityMonitor(signal => forageStorage.getServerActivity(signal), next => { state = next })
        const visibility = () => monitor.setVisible(document.visibilityState === 'visible')
        visibility()
        document.addEventListener('visibilitychange', visibility)
        return () => {
            document.removeEventListener('visibilitychange', visibility)
            monitor.stop()
        }
    })
</script>

{#if state !== 'idle'}
    <div role="status" aria-live="polite" class="pointer-events-none fixed top-2 left-1/2 -translate-x-1/2 z-50 rounded-full border border-textcolor2/30 bg-bg px-3 py-1 text-xs text-textcolor shadow-sm max-w-[90vw] text-center">
        {state === 'working' ? language.serverActivityWorking : language.serverActivityUnavailable}
    </div>
{/if}
