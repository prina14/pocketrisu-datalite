<script lang="ts">
    let { element = $bindable(), children, onReorder }: any = $props();
</script>
<div bind:this={element} data-risu-sortable-list>
    {@render children?.()}
    <button data-drop-probe onclick={() => onReorder?.()}>Drop</button>
</div>
