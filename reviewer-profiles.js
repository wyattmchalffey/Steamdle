// Reviewer presentation is separate from immutable puzzle snapshots and curated
// pack fingerprints. Updating this lookup never changes the selected clues.
let defaultProfiles = {};
try {
    defaultProfiles = require('./data/reviewer-profiles.json');
} catch (error) {
    // An installation without the optional profile lookup keeps its original
    // attribution. Other errors (including malformed JSON) must remain visible.
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function steamId(value) {
    if (typeof value !== 'string' || !/^\d{17}$/.test(value)) return null;
    const id = BigInt(value);
    return id >= 76561197960265728n && id <= 76561202255233023n ? value : null;
}

function reviewAuthor(review, appId) {
    let author = null;
    if (review.authorSteamId != null) {
        author = steamId(review.authorSteamId);
        if (!author) return null;
    }
    for (const source of [review.originalUrl, review.sourceUrl]) {
        if (source == null || source === '') continue;
        if (typeof source !== 'string') return null;
        const match = source.match(/^https:\/\/steamcommunity\.com\/profiles\/(\d{17})\/recommended\/([1-9]\d*)\/?$/);
        if (!match || !steamId(match[1]) || match[2] !== String(appId) ||
            (author && author !== match[1])) return null;
        author = match[1];
    }
    return author;
}

function profileName(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
    const name = value.trim();
    return name && [...name].length <= 128 && !/^a steam user$/i.test(name) ? name : null;
}

function profileAvatar(value) {
    if (typeof value !== 'string') return null;
    // Restrict static data to actual Steam avatar CDN paths, without redirects,
    // query strings, credentials or an arbitrary user-controlled image host.
    return /^https:\/\/avatars(?:\.(?:akamai|cloudflare|fastly))?\.steamstatic\.com\/[a-f0-9]{40}(?:_medium|_full)?\.jpg$/i.test(value) ||
        /^https:\/\/steamcdn-a\.akamaihd\.net\/steamcommunity\/public\/images\/avatars\/[a-f0-9]{2}\/[a-f0-9]{40}(?:_medium|_full)?\.jpg$/i.test(value)
        ? value : null;
}

function decoratePuzzleReviewers(puzzle, profileData = defaultProfiles) {
    if (!puzzle || !Array.isArray(puzzle.reviews)) return puzzle;
    const profiles = profileData?.profiles ?? profileData;
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return puzzle;
    let changed = false;
    const reviews = puzzle.reviews.map(review => {
        if (!review || typeof review !== 'object') return review;
        const author = reviewAuthor(review, puzzle.appId);
        if (!author || !Object.hasOwn(profiles, author)) return review;
        const profile = profiles[author];
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return review;
        const name = profileName(profile.reviewerName);
        const avatar = profileAvatar(profile.reviewerAvatarUrl);
        const additions = {};
        if (name && (typeof review.reviewerName !== 'string' || !review.reviewerName.trim() ||
            /^a steam user$/i.test(review.reviewerName.trim()))) additions.reviewerName = name;
        if (avatar && (review.reviewerAvatarUrl == null || review.reviewerAvatarUrl === ''))
            additions.reviewerAvatarUrl = avatar;
        if (review.reviewerReviewCount == null && Number.isSafeInteger(profile.reviewerReviewCount) &&
            profile.reviewerReviewCount >= 0) additions.reviewerReviewCount = profile.reviewerReviewCount;
        if (!Object.keys(additions).length) return review;
        changed = true;
        return { ...review, ...additions };
    });
    return changed ? { ...puzzle, reviews } : puzzle;
}

module.exports = { decoratePuzzleReviewers };
