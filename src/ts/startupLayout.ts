// Shared lightweight updates. Private names always use textContent.
export interface StartupLabels {
    recentChatsTitle: string; search: string; characterManager: string; character: string;
    grid: string; trash: string; characterManagerHint: string; sortSidebarOrder: string;
    filterAll: string; select: string; settings: string;
}
const korean: StartupLabels = {
    recentChatsTitle: '최근 대화', search: '검색…', characterManager: '캐릭터 관리', character: '캐릭터',
    grid: '그리드', trash: '휴지통', characterManagerHint: '사용하지 않는 캐릭터는 비활성화하거나 휴지통으로 보내 두면 로딩과 저장이 가벼워집니다. 데이터는 서버에 보관되며 언제든 다시 활성화하거나 복원할 수 있습니다.',
    sortSidebarOrder: '사이드바 순서', filterAll: '전체 보기', select: '선택', settings: '설정',
}

export function updateStartupLayout(host: HTMLElement, options: {
    names?: string[]; total?: number; status?: string; language?: string; labels?: Partial<StartupLabels>;
}) {
    let locale = options.language
    if (!locale) { try { locale = localStorage.getItem('risu-lang') ?? '' } catch {} }
    const labels = { ...(locale === 'ko' ? korean : {}), ...options.labels }
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
