// Also inlined by Vite: keep this function self-contained and dependency-free.
// Only visual preferences are read; character names and DB data are never cached here.
/** @param {HTMLElement | null} host @param {string} [language] */
export function applyStartupPresentation(host, language) {
    if (!host) return;
    host.querySelectorAll('[data-startup-version]').forEach(node => {
        const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
        node.textContent = `v${version}`;
    });
    let profile = null;
    try {
        const raw = localStorage.getItem('pocketrisu-startup-presentation-v1');
        if (raw && raw.length <= 4096) {
            const value = JSON.parse(raw);
            if (value?.v === 1) profile = value;
        }
    } catch { /* optional appearance copy */ }
    host.dataset.startupMode = window.innerWidth <= 800 && profile?.mobileUI !== false ? 'mobile' : 'desktop';
    try {
        if ((language || localStorage.getItem('risu-lang')) === 'ko') {
            const korean = {
                recentChatsTitle: '최근 대화', search: '검색…', characterManager: '캐릭터 관리', character: '캐릭터',
                grid: '그리드', trash: '휴지통', characterManagerHint: '사용하지 않는 캐릭터는 비활성화하거나 휴지통으로 보내 두면 로딩과 저장이 가벼워집니다. 데이터는 서버에 보관되며 언제든 다시 활성화하거나 복원할 수 있습니다.',
                sortSidebarOrder: '사이드바 순서', filterAll: '전체 보기', select: '선택', settings: '설정',
                relatedGithub: 'GitHub', relatedGithubDesc: 'Star를 눌러 프로젝트를 응원해주세요.',
                relatedFeedbackForm: '의견 보내기', relatedFeedbackFormDesc: '이슈 제보 및 의견을 보내주세요.',
                relatedContactEmail: '개발자 이메일', relatedContactEmailDesc: '개발자에게 직접 메일을 보낼 수 있어요.',
                relatedArcaLive: '아카라이브 채널', relatedArcaLiveDesc: 'AI 채팅 채널에서 다른 사용자와 이야기를 나눠보세요.',
            }
            
            host.querySelectorAll('[data-startup-label]').forEach(node => {
                const key = node.getAttribute('data-startup-label');
                if (korean[key]) node.textContent = korean[key];
            });
        }
    } catch { /* public labels remain usable in the default language */ }
    if (!profile) return;
    if (Number.isInteger(profile.sidebarSize) && profile.sidebarSize >= 0 && profile.sidebarSize <= 3) {
        host.style.setProperty('--startup-sidebar-width', `${384 + 56 * profile.sidebarSize}px`);
    }
    host.dataset.startupRoundIcons = profile.roundIcons === true ? 'true' : 'false';
    for (const key of ['bgcolor', 'darkbg', 'borderc', 'selected', 'textcolor', 'textcolor2', 'darkborderc', 'darkbutton', 'primary']) {
        const value = profile.colors?.[key];
        // Reject URL/variable/expression values, including imported or corrupt cache data.
        if (typeof value === 'string' && value.length <= 96 && /^(#[\da-f]{3,8}|[a-z]{1,24}|(?:rgb|hsl)a?\([\d.,%\s]+\))$/i.test(value)) {
            host.style.setProperty(`--risu-theme-${key}`, value);
        }
    }
    if (typeof profile.font === 'string' && profile.font.length <= 200 && /^[\w\s,'"-]+$/.test(profile.font)) {
        host.style.setProperty('--risu-font-family', profile.font);
    }
}
