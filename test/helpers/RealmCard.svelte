<script lang="ts">
    let { chara, onClick }: { chara: { name: string }; onClick: () => void } = $props();
</script>

<button data-realm-card onclick={onClick}>{chara.name}</button>
