<script lang="ts">
    import { DynamicGUI, settingsOpen, sideBarStore, openPresetList, presetSelectCallback, openCharacterManager, openModelPresetList, modelPresetSelectCallback, openModelProfileBrowser, openPersonaList, personaSelectCallback, openMemoryPresetList, memoryPresetSelectCallback, openThemePresetList, MobileGUI, loadedStore, accountImportBlocking, alertStore, LoadingStatusState, bookmarkListOpen, popupStore, popUpEditorStore } from './ts/stores.svelte';
    import Sidebar from './lib/SideBars/Sidebar.svelte';
    import { DBState } from './ts/stores.svelte';
    import ChatScreen from './lib/ChatScreens/ChatScreen.svelte';
    import AlertComp from './lib/Others/AlertComp.svelte';
    import CharacterManager from './lib/CharacterManager/CharacterManager.svelte';
    import FolderSettingsDialog from './lib/CharacterManager/FolderSettingsDialog.svelte';
    import RisuAccountImportScreen from './lib/Setting/RisuAccountImportScreen.svelte';
    import { showRealmInfoStore, importCharacterProcess } from './ts/characterCards';
    import { importPreset, getDatabase, setDatabase } from './ts/storage/database.svelte';
    import { readModule } from './ts/process/modules';
    import { notifySuccess } from './ts/alert';
    import { language } from './lang';
    import SavePopupIconComp from './lib/Others/SavePopupIcon.svelte';
    import MobileHeader from './lib/Mobile/MobileHeader.svelte';
    import MobileBody from './lib/Mobile/MobileBody.svelte';
    import MobileFooter from './lib/Mobile/MobileFooter.svelte';
    import { checkCharOrder } from './ts/globalApi.svelte';
    import { ArrowUpIcon, GlobeIcon, PlusIcon } from '@lucide/svelte';
    import { hypaV3ModalOpen, hypaV3ProgressStore } from "./ts/stores.svelte";
    import { assetViewerStore, closeAssetViewer } from './ts/assetViewer.svelte';
    import HypaV3Progress from './lib/Others/HypaV3Progress.svelte';
    import PluginAlertModal from './lib/Others/PluginAlertModal.svelte';
    import UpdatePopup from './lib/Others/UpdatePopup.svelte';
    import SupportDialog from './lib/Others/SupportDialog.svelte';
    import ProtonImportDialog from './lib/Others/ProtonImportDialog.svelte';
    import BootBackupPrompt from './lib/Others/BootBackupPrompt.svelte';
    import PopupList from './lib/UI/PopupList.svelte';
    import LoadingOverlay from './lib/Others/LoadingOverlay.svelte';
    import Toaster from './lib/UI/GUI/Toaster.svelte';
    import RequestStatusToaster from './lib/UI/GUI/RequestStatusToaster.svelte';
    import { createKeepAliveAudio } from './ts/keepAliveAudio';
    import { RISU_APP_INTERNAL_DRAG_TYPE, RISU_SIDEBAR_DRAG_TYPE } from './ts/dragTypes';
    import ServerActivityNotice from './lib/Others/ServerActivityNotice.svelte';
    import LazyBoundary from './lib/UI/LazyBoundary.svelte';

    const loadSettings = () => import('./lib/Setting/Settings.svelte');
    const loadModelProfileBrowser = () => import('./lib/Setting/modelProfileBrowser.svelte');
    const loadHypaV3Modal = () => import('./lib/Others/HypaV3Modal.svelte');
    const loadRealmPopUp = () => import('./lib/UI/Realm/RealmPopUp.svelte');
    const loadBotpreset = () => import('./lib/Setting/botpreset.svelte');
    const loadModelpreset = () => import('./lib/Setting/modelpreset.svelte');
    const loadThemepreset = () => import('./lib/Setting/themepreset.svelte');
    const loadListedPersona = () => import('./lib/Setting/listedPersona.svelte');
    const loadListedMemoryPreset = () => import('./lib/Setting/listedMemoryPreset.svelte');
    const loadBookmarkList = () => import('./lib/Others/BookmarkList.svelte');
    const loadAssetViewer = () => import('./lib/Others/AssetViewer.svelte');
    const loadPopupEditor = () => import('./lib/Others/PopupEditor.svelte');

    const closePresetList = () => { $openPresetList = false; $presetSelectCallback = null; };
    const closeModelPresetList = () => { $openModelPresetList = false; $modelPresetSelectCallback = null; };
    const closePersonaList = () => { $openPersonaList = false; $personaSelectCallback = null; };
    const closeMemoryPresetList = () => { $openMemoryPresetList = false; $memoryPresetSelectCallback = null; };

    // The picker may be closed by a hotkey before its module has mounted.
    // Keep callback cleanup in the owner as well as in each loaded picker.
    $effect(() => {
        if ($openPresetList) return () => { presetSelectCallback.set(null); };
    });
    $effect(() => {
        if ($openModelPresetList) return () => { modelPresetSelectCallback.set(null); };
    });
    $effect(() => {
        if ($openPersonaList) return () => { personaSelectCallback.set(null); };
    });
    $effect(() => {
        if ($openMemoryPresetList) return () => { memoryPresetSelectCallback.set(null); };
    });

    let aprilFools = $state(new Date().getMonth() === 3 && new Date().getDate() === 1)
    let aprilFoolsPage = $state(0)
    let keepingSessionAlive = $state(false)
    let keepAliveAudio: HTMLAudioElement | null = null

    const getMainDropEffect = (e:DragEvent): DataTransfer['dropEffect'] => {
        const types = Array.from(e.dataTransfer?.types ?? [])
        if(types.includes(RISU_SIDEBAR_DRAG_TYPE)){
            return 'none'
        }
        if(types.includes(RISU_APP_INTERNAL_DRAG_TYPE)){
            return 'none'
        }
        return types.includes('Files') ? 'copy' : 'none'
    }

    const markAppInternalDrag = (e:DragEvent) => {
        e.dataTransfer?.setData(RISU_APP_INTERNAL_DRAG_TYPE, 'true')
    }

</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main class="flex bg-bg w-full h-full max-w-100vw text-textcolor" ondragover={(e) => {
    const dropEffect = getMainDropEffect(e)
    e.preventDefault()
    e.dataTransfer.dropEffect = dropEffect
}} ondragstart={markAppInternalDrag} ondrop={async (e) => {
    const types = Array.from(e.dataTransfer.types ?? [])
    if (types.includes(RISU_APP_INTERNAL_DRAG_TYPE) || types.includes(RISU_SIDEBAR_DRAG_TYPE)) {
        e.preventDefault()
        return
    }
    const file = e.dataTransfer.files[0]
    if (!file) {
        e.preventDefault()
        return
    }
    e.preventDefault()
    const name = file.name.toLowerCase()

    if (name.endsWith('.risup')) {
        const data = new Uint8Array(await file.arrayBuffer())
        await importPreset({ name: file.name, data })
        notifySuccess(language.successImport)
    } else if (name.endsWith('.risum')) {
        const data = new Uint8Array(await file.arrayBuffer())
        const module = await readModule(Buffer.from(data))
        const db = getDatabase()
        db.modules.push(module)
        notifySuccess(language.successImport)
    } else {
        await importCharacterProcess({
            name: file.name,
            data: file
        })
        checkCharOrder()
    }
}} onclick={() => {
    if(keepingSessionAlive){
        return
    }

    const aliveMode = DBState?.db?.keepSessionAlive
    switch(aliveMode){
        case 'pip':{

            break
        }
        case 'sound':{
            console.log("Starting inaudible audio to keep session alive")
            if(!keepAliveAudio){
                keepAliveAudio = createKeepAliveAudio()
                // Paused by the OS or by another app taking audio focus; restart on the next click
                keepAliveAudio.addEventListener('pause', () => {
                    keepingSessionAlive = false
                })
            }
            keepingSessionAlive = true
            keepAliveAudio.play().catch(() => {
                keepingSessionAlive = false
            })
            if('mediaSession' in navigator){
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: 'PocketRisu'
                })
            }
            break
        }
    }

}}>
    {#if aprilFools}

        <div class="bg-[#212121] w-full h-screen min-h-screen text-black flex relative">
            <div class="w-full max-w-3xl mx-auto py-8 px-4 flex justify-center items-center">
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="flex flex-col w-full items-center text-[#bbbbbb]">
                    {#if aprilFoolsPage === 0}
                        <h1 class="text-3xl text-white font-bold mb-6">What can I help you?</h1>
                        <div class="resize-none relative w-full bg-[#303030] rounded-3xl h-[110px] mb-6 text-[#bbbbbb]" placeholder="Ask me" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                aprilFoolsPage = 1
                            }
                        }}>
                            <textarea class="absolute top-0 left-0 w-full placeholder-[#bbbbbb] rounded-3xl h-full p-4 bg-transparent resize-none" placeholder="Ask me"></textarea>
                            <div class="absolute bottom-2 left-4 flex gap-1.5">
                                <button class="p-2 rounded-full border border-[#bbbbbb30]">
                                    <PlusIcon size={18} color="#bbbbbb" />
                                </button>
                                <button class="p-2 rounded-full border border-[#bbbbbb30]">
                                    <GlobeIcon size={18} color="#bbbbbb" />
                                </button>
                                
                            </div>
                            <div class="absolute bottom-2 right-4 flex">
                                <button class="p-2 rounded-full bg-[#bbbbbb]">
                                    <ArrowUpIcon size={18} color="#00000080" />
                                </button>
                            </div>
                        </div>
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <div class="flex gap-1.5" onclick={() => {
                            aprilFoolsPage = 1
                        }}>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                <span class="text-[#bbbbbb]">🔍</span>
                                Search
                            </button>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                <span class="text-[#bbbbbb]">🎮</span>
                                Games
                            </button>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                <span class="text-[#bbbbbb]">🎨</span>
                                Roleplay
                            </button>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                More
                            </button>
                        </div>
                    {:else}
                    <h1 class="text-3xl text-white font-bold mb-6">
                        We do not have search results.
                    </h1>
                    <p class="text-[#bbbbbb] mb-6">
                        <!-- svelte-ignore a11y_missing_attribute -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        Go to <a class="text-blue-500 cursor-pointer" onclick={() => {
                            aprilFoolsPage = 0
                            aprilFools = false
                        }}>
                            PocketRisu  
                        </a>
                    </p>

                    {/if}
                </div>
            </div>
            <span class="absolute top-4 left-4 font-bold text-[#bbbbbb] text-md md:text-lg">RisyGTP-9</span>
        </div>
    {:else if $accountImportBlocking}
        <RisuAccountImportScreen />
    {:else if !$loadedStore}
        <div class="w-full h-full flex justify-center items-center text-textcolor text-xl bg-gray-900 flex-col">
            <div class="flex flex-row items-center">
                <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-textcolor" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                <span>Loading...</span>
            </div>

            <span class="text-sm mt-2 text-textcolor2">{LoadingStatusState.text}</span>
        </div>
    {:else if $settingsOpen}
        <LazyBoundary load={loadSettings} close={() => { $settingsOpen = false; }}>
            {#snippet children(Settings)}<Settings />{/snippet}
        </LazyBoundary>
    {:else if $MobileGUI}
        <div class="w-full h-full flex flex-col">
            <MobileHeader />
            <MobileBody />
            <MobileFooter />
        </div>
    {:else}
        {#if (!$DynamicGUI)}
            <Sidebar hidden={!$sideBarStore} />
        {:else}
            <div class="top-0 w-full h-full left-0 z-30 flex flex-row items-center" class:fixed={$sideBarStore} class:hidden={!$sideBarStore} >
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <Sidebar hidden={false} />
            </div>
        {/if}
        <ChatScreen />
        {#if $openCharacterManager}
            <CharacterManager />
        {/if}
    {/if}
    <AlertComp />
    {#if $showRealmInfoStore}
        <LazyBoundary load={loadRealmPopUp} overlay close={() => { $showRealmInfoStore = null; }}>
            {#snippet children(RealmPopUp)}<RealmPopUp bind:openedData={$showRealmInfoStore} />{/snippet}
        </LazyBoundary>
    {/if}
    <FolderSettingsDialog />
    {#if $openPresetList}
        <LazyBoundary load={loadBotpreset} overlay close={closePresetList}>
            {#snippet children(Botpreset)}<Botpreset close={closePresetList} />{/snippet}
        </LazyBoundary>
    {/if}
    {#if $openModelPresetList}
        <LazyBoundary load={loadModelpreset} overlay close={closeModelPresetList}>
            {#snippet children(Modelpreset)}<Modelpreset close={closeModelPresetList} />{/snippet}
        </LazyBoundary>
    {/if}
    {#if $openModelProfileBrowser}
        <LazyBoundary load={loadModelProfileBrowser} overlay close={() => { $openModelProfileBrowser = false; }}>
            {#snippet children(ModelProfileBrowser)}
                <ModelProfileBrowser close={() => {$openModelProfileBrowser = false}} />
            {/snippet}
        </LazyBoundary>
    {/if}
    {#if $openThemePresetList}
        <LazyBoundary load={loadThemepreset} overlay close={() => { $openThemePresetList = false; }}>
            {#snippet children(Themepreset)}<Themepreset close={() => { $openThemePresetList = false; }} />{/snippet}
        </LazyBoundary>
    {/if}
    {#if $openPersonaList}
        <LazyBoundary load={loadListedPersona} overlay close={closePersonaList}>
            {#snippet children(ListedPersona)}
                <ListedPersona close={closePersonaList} onSelect={$personaSelectCallback} />
            {/snippet}
        </LazyBoundary>
    {/if}
    {#if $openMemoryPresetList}
        <LazyBoundary load={loadListedMemoryPreset} overlay close={closeMemoryPresetList}>
            {#snippet children(ListedMemoryPreset)}
                <ListedMemoryPreset close={closeMemoryPresetList} onSelect={$memoryPresetSelectCallback} />
            {/snippet}
        </LazyBoundary>
    {/if}
    {#if $bookmarkListOpen}
        <LazyBoundary load={loadBookmarkList} overlay close={() => { $bookmarkListOpen = false; }}>
            {#snippet children(BookmarkList)}<BookmarkList />{/snippet}
        </LazyBoundary>
    {/if}
    {#if $hypaV3ModalOpen}
        <LazyBoundary load={loadHypaV3Modal} overlay close={() => { $hypaV3ModalOpen = false; }}>
            {#snippet children(HypaV3Modal)}<HypaV3Modal />{/snippet}
        </LazyBoundary>
    {/if}
    <SavePopupIconComp />
    {#if $hypaV3ProgressStore.open}
        <HypaV3Progress />
    {/if}
    <PluginAlertModal />
    <LoadingOverlay />
    <UpdatePopup />
    <SupportDialog />
    <ProtonImportDialog />
    <BootBackupPrompt />
    {#if popupStore.children}
        <PopupList />
    {/if}
    {#if popUpEditorStore.open}
        <LazyBoundary load={loadPopupEditor} overlay close={() => { popUpEditorStore.open = false; }}>
            {#snippet children(PopupEditor)}<PopupEditor />{/snippet}
        </LazyBoundary>
    {/if}
    {#if assetViewerStore.open}
        <LazyBoundary load={loadAssetViewer} overlay close={closeAssetViewer}>
            {#snippet children(AssetViewer)}<AssetViewer />{/snippet}
        </LazyBoundary>
    {/if}
    <Toaster />
    <RequestStatusToaster />
    {#if $loadedStore && !$accountImportBlocking}
        <ServerActivityNotice />
    {/if}
</main>
