export const MAX_GUESS_LENGTH = 512;

export function normalizeTitle(title) {
    return typeof title === 'string'
        ? title.normalize('NFD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
        : '';
}

// A skip is stored as null. All other turns must be distinct game titles.
export function guessError(guess, attempts) {
    if (guess === null) return '';
    if (typeof guess !== 'string' || guess.length > MAX_GUESS_LENGTH) return 'Enter a shorter game title.';
    const title = normalizeTitle(guess);
    if (!title) return 'Enter a game title to guess.';
    if (attempts.some(prior => normalizeTitle(prior) === title)) return 'You already guessed that game.';
    return '';
}

export function decodeAttempts(saved, answer, limit) {
    if (!Array.isArray(saved) || saved.length > limit) return [];
    const attempts = [];
    const correctTitle = normalizeTitle(answer);
    for (const guess of saved) {
        if (guessError(guess, attempts)) return [];
        attempts.push(guess);
        if (normalizeTitle(guess) === correctTitle && attempts.length !== saved.length) return [];
    }
    return attempts;
}
