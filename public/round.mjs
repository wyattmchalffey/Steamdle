export const MAX_GUESS_LENGTH = 512;

export function normalizeTitle(title) {
    return typeof title === 'string'
        ? title.normalize('NFD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
        : '';
}

export function canonicalGuess(guess, aliases) {
    const key = normalizeTitle(guess);
    return aliases && Object.hasOwn(aliases, key) ? aliases[key] : guess;
}

// Only new turns use aliases. Saved turns keep the outcome they had when played.
export function guessError(guess, attempts, { aliases, answer } = {}) {
    if (guess === null) return '';
    if (typeof guess !== 'string' || guess.length > MAX_GUESS_LENGTH) return 'Enter a shorter game title.';
    const title = normalizeTitle(canonicalGuess(guess, aliases));
    if (!title) return 'Enter a game title to guess.';
    const wins = title === normalizeTitle(answer);
    // A previously rejected shorthand must not prevent a correct guess under the new rules.
    const duplicate = attempts.some(prior => normalizeTitle(wins ? prior : canonicalGuess(prior, aliases)) === title);
    if (duplicate) return 'You already guessed that game.';
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
