import { hasUnsavedWork } from './ts/storage/unsavedWork'
let installed = false
export function preLoadCheck(){
    if (installed) return true
    installed = true
    window.addEventListener('beforeunload', (e) => {
        const editorOpen = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
            .some(node => !node.hasAttribute('hidden') && node.getAttribute('aria-hidden') !== 'true'
                && node.getAttribute('data-state') !== 'closed' && node.getClientRects().length > 0)
        if (!hasUnsavedWork() && !editorOpen) return
        e.preventDefault()
        //legacy browser
        e.returnValue = true
    })

    return true;
}
