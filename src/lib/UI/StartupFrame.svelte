<script lang="ts">
    import { updateStartupLayout, type StartupLabels } from '../../ts/startupLayout';
    import STARTUP_LAYOUT_HTML from '../../etc/startup-layout.html?raw';
    export let names: string[] | undefined = undefined;
    export let total: number | undefined = undefined;
    export let status = 'Connecting…';
    export let labels: Partial<StartupLabels> = {};
    export let preview = false;
    let host: HTMLElement;
    $: if (host) updateStartupLayout(host, { names, total, status, labels });
</script>

<!-- Fixed local template. Private names are inserted using textContent. -->
<section bind:this={host} class="startup-shell" class:startup-preview={preview} aria-busy="true" aria-label={status}>
    {@html STARTUP_LAYOUT_HTML}
</section>
