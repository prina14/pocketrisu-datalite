'use strict';

function startupPreview(view, revision) {
    const names = [];
    let total = 0;
    for (const character of Array.isArray(view?.characters) ? view.characters : []) {
        if (!character || character.trashTime) continue;
        total++;
        if (names.length < 40) names.push(typeof character.name === 'string' ? character.name.slice(0, 128) : '');
    }
    return { v: 1, ready: true, names, total, revision,
        language: typeof view?.language === 'string' ? view.language.slice(0, 16) : undefined };
}

module.exports = { startupPreview };
