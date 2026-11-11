<script lang="ts">
    import StartupFrame from './StartupFrame.svelte';
    import type { StartupLabels } from '../../ts/startupLayout';
    export let heading = 'Characters';
    export let status = 'Connecting…';
    export let labels: Partial<StartupLabels> = {};
</script>

<StartupFrame {status} labels={{ character: heading, ...labels }} />
