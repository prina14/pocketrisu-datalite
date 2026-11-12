<script lang="ts">
    import { MobileGUIStack, MobileSearch, MobileSideBar, selectedCharID } from "src/ts/stores.svelte";
    import CharacterManager from "../CharacterManager/CharacterManager.svelte";
    import ChatScreen from "../ChatScreens/ChatScreen.svelte";
    import { WrenchIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import SideChatList from "../SideBars/SideChatList.svelte";
    import { isLite } from "src/ts/lite";
    
    import { DBState } from 'src/ts/stores.svelte';
    import LazyBoundary from '../UI/LazyBoundary.svelte';

    import { loadSettings } from 'src/ts/settingsLoader';
    import RecentCharacters from '../UI/RecentCharacters.svelte';
    const loadRealmBrowser = () => import('../UI/Realm/RealmBrowser.svelte');
    const loadCharConfig = () => import('../SideBars/CharConfig.svelte');
    const loadDevTool = () => import('../SideBars/DevTool.svelte');
</script>

{#if $MobileSideBar > 0 && $selectedCharID !== -1 && !$isLite}
<div class="w-full px-2 py-1 text-textcolor2 border-b border-b-darkborderc bg-darkbg flex justify-start items-center gap-2">
    <button class="flex-1 border-r border-r-darkborderc" class:text-textcolor={$MobileSideBar === 1} onclick={() => {
        $MobileSideBar = 1
    }}>
        {language.Chat}
    </button>
    <button class="flex-1 border-r border-r-darkborderc" class:text-textcolor={$MobileSideBar === 2} onclick={() => {
        $MobileSideBar = 2
    }}>
        {language.character}
    </button>
    <button class:text-textcolor={$MobileSideBar === 3} onclick={() => {
        $MobileSideBar = 3
    }}>
        <WrenchIcon size={18} />
    </button>
</div>
{/if}
<div class="w-full flex-1 overflow-y-auto bg-bgcolor relative">
    <!-- Guard on selectedCharID: deleting the character from inside these panels
         leaves $MobileSideBar set, which used to keep CharConfig/SideChatList
         mounted against characters[-1]. Fall through to the home screen instead. -->
    {#if $MobileSideBar > 0 && $selectedCharID !== -1}
        <div class="w-full flex flex-col p-2 mt-2 h-full">
            {#if $MobileSideBar === 1}
                <SideChatList bind:chara={DBState.db.characters[$selectedCharID]} />
            {:else if $MobileSideBar === 2}
                <LazyBoundary load={loadCharConfig} close={() => { $MobileSideBar = 1; }}>
                    {#snippet children(CharConfig)}<CharConfig />{/snippet}
                </LazyBoundary>
            {:else if $MobileSideBar === 3}
                <LazyBoundary load={loadDevTool} close={() => { $MobileSideBar = 1; }}>
                    {#snippet children(DevTool)}<DevTool />{/snippet}
                </LazyBoundary>
            {/if}
        </div>
    {:else if $selectedCharID !== -1}
        <ChatScreen />
    {:else if $MobileGUIStack === 0}
        <LazyBoundary load={loadRealmBrowser} close={() => { $MobileGUIStack = 1; }}>
            {#snippet children(RealmBrowser)}<RealmBrowser />{/snippet}
        </LazyBoundary>
    {:else if $MobileGUIStack === 1}
        <div class="px-3"><RecentCharacters /></div>
        <CharacterManager inline externalSearch={$MobileSearch} />
    {:else if $MobileGUIStack === 2}
        <LazyBoundary load={loadSettings} close={() => { $MobileGUIStack = 1; }}>
            {#snippet children(Settings)}<Settings />{/snippet}
        </LazyBoundary>
    {/if}
</div>
