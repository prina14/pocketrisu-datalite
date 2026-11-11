/** Save a small, device-local appearance copy without touching the server DB. */
export function cacheStartupPresentation(preferences: { betaMobileGUI?: boolean; sideBarSize?: number; roundIcons?: boolean }) {
    try {
        const root = document.documentElement.style
        const colors = Object.fromEntries(['bgcolor', 'darkbg', 'borderc', 'selected', 'textcolor', 'textcolor2', 'darkborderc', 'darkbutton', 'primary']
            .map(key => [key, root.getPropertyValue(`--risu-theme-${key}`).trim()]))
        const value = JSON.stringify({ v: 1, mobileUI: preferences.betaMobileGUI === true || import.meta.env.VITE_RISU_LITE === 'TRUE',
            sidebarSize: preferences.sideBarSize ?? 0, roundIcons: preferences.roundIcons === true,
            colors, font: root.getPropertyValue('--risu-font-family').trim() })
        const key = 'pocketrisu-startup-presentation-v1'
        if (localStorage.getItem(key) !== value) localStorage.setItem(key, value)
    } catch { /* storage restrictions must never block startup/settings */ }
}
