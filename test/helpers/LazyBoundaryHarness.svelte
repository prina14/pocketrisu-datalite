<script lang="ts">
    import type { Component } from 'svelte';
    import LazyBoundary from '../../src/lib/UI/LazyBoundary.svelte';

    let { load, retained = false }: { load: () => Promise<{ default: Component<any> }>; retained?: boolean } = $props();
    let open = $state(false);
</script>
<button onclick={() => { open = true; }}>Open panel</button>
{#if open || retained}
    <LazyBoundary {load} activate={open} close={() => { open = false; }} overlay>
        {#snippet children(Panel)}
            <Panel label="Requested settings panel" close={() => { open = false; }} />
        {/snippet}
    </LazyBoundary>
{/if}
