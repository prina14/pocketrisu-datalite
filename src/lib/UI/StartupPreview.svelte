<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { recordStartupListFrame } from '../../ts/earlyStartupPreview';
    export let names: string[] = [];
    export let total = 0;
    export let heading = '캐릭터';
    export let loadingLabel = '준비 중…';
    export let early = false;
    let mounted = false;
    onMount(() => { mounted = true });
    // An index can update an existing loading component after it mounts.
    $: if (mounted && early) void tick().then(recordStartupListFrame);
</script>

<section class="startup-preview bg-bgcolor text-textcolor" aria-busy="true" aria-label={loadingLabel}>
    <header><strong>PocketRisu</strong><span role="status">{loadingLabel}</span></header>
    <div class="preview-content">
        <h1>{heading} <small>{total}</small></h1>
        <div class="preview-grid">
            {#each names as name}
                <div class="preview-card"><span class="preview-avatar" aria-hidden="true">{name.slice(0, 1)}</span><span>{name}</span></div>
            {/each}
        </div>
    </div>
</section>

<style>
    .startup-preview { min-height:100%; width:100%; }
    header { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1.1rem 1.5rem; border-bottom:1px solid #8883; }
    header span { font-size:.85rem; opacity:.7; }
    .preview-content { max-width:68rem; margin:auto; padding:1.5rem; }
    h1 { font-size:1.15rem; margin-bottom:1rem; } small { opacity:.6; font-weight:normal; }
    .preview-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:.75rem; }
    .preview-card { display:flex; align-items:center; gap:.65rem; padding:.8rem; border:1px solid #8883; border-radius:.75rem; overflow:hidden; }
    .preview-card>span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .preview-avatar { flex-shrink:0; width:2.5rem; height:2.5rem; display:grid; place-items:center; border-radius:.6rem; background:#8882; }
    @media(max-width:480px) { header,.preview-content { padding:1rem; } header span { font-size:.75rem; } }
</style>
