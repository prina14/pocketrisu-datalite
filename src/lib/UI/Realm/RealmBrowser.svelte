<script lang="ts">
    import { risuTosAccepted } from 'src/ts/alert';
    import RealmMain from './RealmMain.svelte';
    import RealmTosGate from './RealmTosGate.svelte';
</script>

{#if $risuTosAccepted}
    <RealmMain />
{:else}
    <RealmTosGate />
{/if}
