/** Save a small, device-local appearance copy without touching the server DB. */
export function cacheStartupPresentation(preferences: { betaMobileGUI?: boolean; sideBarSize?: number; roundIcons?: boolean; nodeOnlyHideRecentChats?: boolean }) {
    try {
        const root = document.documentElement.style
        const colors = Object.fromEntries(['bgcolor', 'darkbg', 'borderc', 'selected', 'textcolor', 'textcolor2', 'darkborderc', 'darkbutton', 'primary']
            .map(key => [key, root.getPropertyValue(`--risu-theme-${key}`).trim()]))
        const value = JSON.stringify({ v: 1, mobileUI: preferences.betaMobileGUI === true || import.meta.env.VITE_RISU_LITE === 'TRUE',
            sidebarSize: preferences.sideBarSize ?? 0, roundIcons: preferences.roundIcons === true,
            hideRecentHome: preferences.nodeOnlyHideRecentChats === true,
            colors, font: root.getPropertyValue('--risu-font-family').trim() })
        const key = 'pocketrisu-startup-presentation-v1'
        if (localStorage.getItem(key) !== value) localStorage.setItem(key, value)
    } catch { /* storage restrictions must never block startup/settings */ }
}

/** Keep only this layout preference in sync; no character or conversation data. */
export function cacheRecentHomeVisibility(hidden: boolean) {
    try {
        const key = 'pocketrisu-startup-presentation-v1'
        const raw = localStorage.getItem(key)
        const parsed = raw && raw.length <= 4096 ? JSON.parse(raw) : null
        const profile = parsed?.v === 1 ? parsed : { v: 1 }
        if (profile.hideRecentHome === hidden) return
        profile.hideRecentHome = hidden
        localStorage.setItem(key, JSON.stringify(profile))
    } catch { /* optional layout hint */ }
}
