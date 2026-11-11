<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { recordStartupListFrame } from '../../ts/earlyStartupPreview';
    import type { StartupLabels } from '../../ts/startupLayout';
    import StartupFrame from './StartupFrame.svelte';
    export let names: string[] = [];
    export let total = 0;
    export let heading = '캐릭터';
    export let loadingLabel = '준비 중…';
    export let labels: Partial<StartupLabels> = {};
    export let early = false;
    let mounted = false;
    onMount(() => { mounted = true; return () => { mounted = false } });
    $: if (mounted && early) void tick().then(() => { if (mounted) recordStartupListFrame() });
</script>

<StartupFrame {names} {total} status={loadingLabel} labels={{ character: heading, ...labels }} preview />
