<script lang="ts">
    export let heading = 'Characters';
    export let status = 'Connecting…';
</script>

<section class="startup-shell" aria-busy="true" aria-label="PocketRisu">
    <header><strong>PocketRisu</strong><span class="shell-status" role="status">{status}</span></header>
    <div class="shell-content">
        <h1>{heading}</h1>
        <div class="shell-grid" aria-hidden="true">
            {#each [0, 1, 2, 3] as placeholder}
                <div class="shell-card"><span class="shell-avatar"></span><span class="shell-line"></span></div>
            {/each}
        </div>
    </div>
</section>
