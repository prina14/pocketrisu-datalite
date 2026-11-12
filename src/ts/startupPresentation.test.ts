import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { applyStartupPresentation } from './startupPresentation.js'
import { cacheStartupPresentation, cacheRecentHomeVisibility } from './startupPresentationCache'
const KEY = 'pocketrisu-startup-presentation-v1'

test('recent home spacing is visible by default and honors the same hidden preference on refresh', () => {
    const host = document.createElement('section')
    applyStartupPresentation(host)
    expect(host.dataset.startupHideRecentHome).toBe('false')
    cacheStartupPresentation({ sideBarSize: 2, nodeOnlyHideRecentChats: false })
    cacheRecentHomeVisibility(true)
    applyStartupPresentation(host)
    expect(host.dataset.startupHideRecentHome).toBe('true')
    expect(host.style.getPropertyValue('--startup-sidebar-width')).toBe('496px')
    cacheRecentHomeVisibility(false)
    applyStartupPresentation(host)
    expect(host.dataset.startupHideRecentHome).toBe('false')
})
afterEach(() => { localStorage.clear(); document.documentElement.removeAttribute('style'); vi.unstubAllGlobals() })

test('stores appearance only and does not mutate the database or copy private content', () => {
    const db = { betaMobileGUI: true, sideBarSize: 2, roundIcons: true, characters: [{ name: 'private character' }], openAIKey: 'private secret' }
    const before = JSON.stringify(db)
    document.documentElement.style.setProperty('--risu-theme-darkborderc', '#123456')
    document.documentElement.style.setProperty('--risu-font-family', 'Times New Roman, serif')
    cacheStartupPresentation(db)
    const text = localStorage.getItem(KEY)!
    expect(text).not.toMatch(/private|characters|openAIKey/)
    expect(JSON.stringify(db)).toBe(before)
    const host = document.createElement('section')
    applyStartupPresentation(host)
    expect(host.style.getPropertyValue('--startup-sidebar-width')).toBe('496px')
    expect(host.style.getPropertyValue('--risu-theme-darkborderc')).toBe('#123456')
    expect(host.style.getPropertyValue('--risu-font-family')).toBe('Times New Roman, serif')
    expect(host.dataset.startupRoundIcons).toBe('true')
})

test('respects the saved mobile-mode preference rather than assuming every narrow screen uses it', () => {
    vi.stubGlobal('innerWidth', 390)
    const host = document.createElement('section')
    localStorage.setItem(KEY, JSON.stringify({ v: 1, mobileUI: false }))
    applyStartupPresentation(host)
    expect(host.dataset.startupMode).toBe('desktop')
    localStorage.setItem(KEY, JSON.stringify({ v: 1, mobileUI: true }))
    applyStartupPresentation(host)
    expect(host.dataset.startupMode).toBe('mobile')
    vi.stubGlobal('innerWidth', 1200)
    applyStartupPresentation(host)
    expect(host.dataset.startupMode).toBe('desktop')
})

test('corrupt or hostile appearance values cannot inject resources or alter the real app root', () => {
    const host = document.createElement('section')
    localStorage.setItem(KEY, JSON.stringify({ v: 1, sidebarSize: 900, colors: { bgcolor: 'url(https://example.invalid/private)', primary: 'var(--evil)', textcolor: '#ffffff' }, font: 'url(https://example.invalid/font)' }))
    applyStartupPresentation(host)
    expect(host.style.getPropertyValue('--startup-sidebar-width')).toBe('')
    expect(host.style.getPropertyValue('--risu-theme-bgcolor')).toBe('')
    expect(host.style.getPropertyValue('--risu-theme-primary')).toBe('')
    expect(host.style.getPropertyValue('--risu-font-family')).toBe('')
    expect(host.style.getPropertyValue('--risu-theme-textcolor')).toBe('#ffffff')
    expect(document.documentElement.style.cssText).toBe('')
    for (const invalid of ['{', JSON.stringify({ v: 9 }), 'x'.repeat(5000)]) {
        localStorage.setItem(KEY, invalid)
        expect(() => applyStartupPresentation(document.createElement('section'))).not.toThrow()
    }
})

test('the inline first-HTML path and mounted component apply the same appearance', () => {
    const source = readFileSync('src/ts/startupPresentation.js', 'utf8').replace(/^export /gm, '')
    const inline = new Function(`${source};return applyStartupPresentation`)() as typeof applyStartupPresentation
    cacheStartupPresentation({ betaMobileGUI: true, sideBarSize: 1, roundIcons: true })
    const first = document.createElement('section'), mounted = document.createElement('section')
    inline(first); applyStartupPresentation(mounted)
    expect(first.outerHTML).toBe(mounted.outerHTML)
})

test('public Korean labels are available before authentication or character-index loading', () => {
    localStorage.setItem('risu-lang', 'ko')
    const host = document.createElement('section')
    host.innerHTML = '<span data-startup-label="characterManager">Character Manager</span><span data-startup-label="relatedFeedbackForm">Feedback Form</span>'
    applyStartupPresentation(host)
    expect(host.textContent).toBe('캐릭터 관리의견 보내기')
    expect(host.querySelector('img,iframe,input,button')).toBeNull()
})
