<script lang="ts">
    let { label, close }: { label: string, close: () => void } = $props();
</script>
<section data-testid="loaded-panel">
    <p>{label}</p>
    <button onclick={close}>Close loaded panel</button>
</section>
