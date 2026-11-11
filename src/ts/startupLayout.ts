import { applyStartupPresentation } from './startupPresentation.js'
// Shared lightweight updates. Private names always use textContent.
export interface StartupLabels {
    recentChatsTitle: string; search: string; characterManager: string; character: string;
    grid: string; trash: string; characterManagerHint: string; sortSidebarOrder: string;
    filterAll: string; select: string; settings: string;
    relatedGithub: string; relatedGithubDesc: string; relatedFeedbackForm: string; relatedFeedbackFormDesc: string;
    relatedContactEmail: string; relatedContactEmailDesc: string; relatedArcaLive: string; relatedArcaLiveDesc: string;
}

export function updateStartupLayout(host: HTMLElement, options: {
    names?: string[]; total?: number; status?: string; language?: string; labels?: Partial<StartupLabels>;
}) {
    applyStartupPresentation(host, options.language)
    const labels = options.labels ?? {}
    host.querySelectorAll<HTMLElement>('[data-startup-label]').forEach(node => {
        const label = labels[node.dataset.startupLabel as keyof StartupLabels]
        if (label) node.textContent = label
    })
    if (options.status) host.querySelectorAll('[data-startup-status]').forEach(node => { node.textContent = options.status })
    if (options.total !== undefined) host.dataset.startupTotal = String(options.total)
    for (const [selector, rail] of [['[data-startup-list]', false], ['[data-startup-rail]', true]] as const) {
        const list = host.querySelector(selector)
        if (!list) continue
        const fragment = document.createDocumentFragment()
        for (const name of options.names ?? ['', '', '', '']) {
            const card = document.createElement('div'); card.className = rail ? 'shell-rail-card' : 'shell-card'
            const avatar = document.createElement('span'); avatar.className = 'shell-avatar'; avatar.setAttribute('aria-hidden', 'true')
            avatar.textContent = name.slice(0, 1)
            const label = document.createElement('span'); label.className = name ? 'shell-name' : 'shell-line'; label.textContent = name
            if (rail) card.append(avatar, label)
            else {
                const text = document.createElement('span'); text.className = 'shell-card-text'
                const meta = document.createElement('span'); meta.className = 'shell-meta-line'; meta.setAttribute('aria-hidden', 'true')
                text.append(label, meta); card.append(avatar, text)
            }
            fragment.append(card)
        }
        list.replaceChildren(fragment)
        list.setAttribute('aria-hidden', options.names ? 'false' : 'true')
    }
}
