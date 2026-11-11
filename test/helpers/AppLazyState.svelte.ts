import { writable } from 'svelte/store'
export const startupPreview = writable<{ names: string[]; total: number } | null>(null)

export const DynamicGUI = writable(false)
export const settingsOpen = writable(false)
export const sideBarStore = writable(false)
export const openPresetList = writable(false)
export const presetSelectCallback = writable<((index: number) => void) | null>(null)
export const openCharacterManager = writable(false)
export const openModelPresetList = writable(false)
export const modelPresetSelectCallback = writable<((id: string) => void) | null>(null)
export const openModelProfileBrowser = writable(false)
export const openPersonaList = writable(false)
export const personaSelectCallback = writable<((index: number) => void) | null>(null)
export const openMemoryPresetList = writable(false)
export const memoryPresetSelectCallback = writable<((value: string) => void) | null>(null)
export const openThemePresetList = writable(false)
export const MobileGUI = writable(false)
export const loadedStore = writable(false)
export const accountImportBlocking = writable(false)
export const alertStore = writable(null)
export const LoadingStatusState = { text: '' }
export const bookmarkListOpen = writable(false)
export const popupStore = { children: null }
export const popUpEditorStore = { open: false }
export const DBState = { db: {} }
export const hypaV3ModalOpen = writable(false)
export const hypaV3ProgressStore = writable({ open: false })
export const showRealmInfoStore = writable(null)
export const assetViewerStore = { open: false, title: '', items: [] }
