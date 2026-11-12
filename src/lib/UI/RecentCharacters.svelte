<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import { characterActivity } from 'src/ts/characterActivity';
    import { recentCharacters } from 'src/ts/recentCharacters';
    import { changeChar, getCharImage } from 'src/ts/characters';
    import { language } from 'src/lang';
    import SidebarAvatar from '../SideBars/SidebarAvatar.svelte';

    let recent = $derived(recentCharacters(DBState.db.characters, $characterActivity));
</script>

{#if !DBState.db.nodeOnlyHideRecentChats && recent.length > 0}
    <section class="my-4 text-textcolor" aria-label={language.recentChatsTitle}>
        <h2 class="text-xl font-bold mb-3">{language.recentChatsTitle}</h2>
        <div class="grid grid-cols-3 gap-2">
            {#each recent as { character, index } (character.chaId)}
                <button type="button" class="min-w-0 flex flex-col items-center gap-2 rounded-lg border border-borderc/20 bg-darkbg p-3 hover:bg-selected focus-visible:ring-2 focus-visible:ring-borderc" onclick={() => changeChar(index)}>
                    <SidebarAvatar src={character.image ? getCharImage(character.image, 'plain') : '/none.webp'} size="56" rounded={true} name={character.name} chaId={character.chaId} />
                    <span class="w-full truncate text-center text-sm">{character.name}</span>
                </button>
            {/each}
        </div>
    </section>
{/if}
