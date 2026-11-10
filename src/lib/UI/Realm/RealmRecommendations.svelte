<script lang="ts">
    import { untrack } from 'svelte';
    import { language } from 'src/lang';
    import { risuTosAccepted } from 'src/ts/alert';
    import { getRisuHub, hubAdditionalHTML, type hubType } from 'src/ts/characterCards';
    import { DBState, OpenRealmStore, RealmInitialOpenChar } from 'src/ts/stores.svelte';
    import RealmHubIcon from './RealmHubIcon.svelte';
    import RealmTosGate from './RealmTosGate.svelte';

    let cards = $state<Promise<hubType[]> | null>(null);
    let attempt = $state(0);
    $effect(() => {
        if (!$risuTosAccepted) return;
        attempt;
        // One request per opening/retry, independent of unrelated DB changes.
        cards = untrack(() => getRisuHub({ search: '', page: 0, nsfw: false, sort: 'recommended' }));
    });
</script>

{#if !$risuTosAccepted}
    <RealmTosGate />
{:else if cards}
    {#await cards}
        <p class="p-4 text-textcolor2" role="status">{language.loading}…</p>
    {:then charas}
        {#if charas.length > 0}
            {@html hubAdditionalHTML}
            <div class="flex w-full flex-wrap justify-center gap-4 p-2">
                {#each charas as chara}
                    <RealmHubIcon {chara} onClick={() => {
                        $OpenRealmStore = true;
                        if (DBState.db.realmDirectOpen) $RealmInitialOpenChar = chara;
                    }} />
                {/each}
            </div>
        {:else}
            {@render retry()}
        {/if}
    {:catch}
        {@render retry()}
    {/await}
{/if}

{#snippet retry()}
    <div class="flex items-center gap-3 p-4 text-textcolor2" role="status">
        <span>{language.errors.networkFetch}</span>
        <button class="rounded-md border border-darkborderc px-3 py-2 hover:bg-selected" onclick={() => { attempt += 1; }}>
            {language.errors.chatLoadRetry}
        </button>
    </div>
{/snippet}
