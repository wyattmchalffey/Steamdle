const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { decoratePuzzleReviewers } = require('../reviewer-profiles');

const author = '76561198049206668';
const otherAuthor = '76561199100261339';
const avatar = 'https://avatars.akamai.steamstatic.com/' + 'a'.repeat(40) + '_medium.jpg';
const source = id => `https://steamcommunity.com/profiles/${id}/recommended/1145350/`;
const profile = { reviewerName: 'Actual Steam reviewer 🌙', reviewerAvatarUrl: avatar };
const profiles = { version: 1, profiles: { [author]: profile } };
const clue = changes => ({ originalUrl: source(author), reviewerName: 'A Steam User', reviewerAvatarUrl: null,
    recommendation: 'Recommended', reviewText: 'Exact saved clue.', recommendationId: '177021280',
    playtime: '80.3 hrs at review time', datePosted: 'Oct 14, 2024', isExcerpt: true, ...changes });
const puzzle = reviews => ({ title: 'Fixture game', appId: '1145350', puzzleDate: '2026-11-13',
    curationVersion: 'frozen-v1', reviews });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

test('decorates explicit and legacy URL authors without changing a frozen snapshot or clue identity', () => {
    const saved = freeze(puzzle([
        clue({ authorSteamId: author }),
        clue({ reviewText: 'Second clue, in its original order.' }),
        clue({ originalUrl: undefined, sourceUrl: source(author), reviewText: 'Source URL variant.' }),
        clue({ originalUrl: undefined, authorSteamId: author, reviewText: 'Explicit author only.' })
    ]));
    const before = JSON.stringify(saved);
    const beforeHash = digest(saved);
    const response = decoratePuzzleReviewers(saved, freeze(structuredClone(profiles)));
    assert.notEqual(response, saved);
    assert.notEqual(response.reviews, saved.reviews);
    for (const [index, review] of response.reviews.entries()) {
        assert.deepEqual(review, { ...saved.reviews[index], ...profile });
        assert.notEqual(review, saved.reviews[index]);
    }
    assert.equal(JSON.stringify(saved), before);
    assert.equal(digest(saved), beforeHash);
    assert.equal(saved.reviews[0].reviewerName, 'A Steam User');
});

test('rejects wrong app, conflicting authors and noncanonical or spoofed source URLs', () => {
    const mismatches = [
        { originalUrl: source(otherAuthor), authorSteamId: author },
        { originalUrl: source(author).replace('/1145350/', '/999/') },
        { originalUrl: source(author), sourceUrl: source(otherAuthor) },
        { originalUrl: source(author).replace('steamcommunity.com', 'steamcommunity.com.evil.test') },
        { originalUrl: source(author).replace('https:', 'http:') },
        { originalUrl: source(author) + '?author=' + author },
        { originalUrl: source(author) + '#review' },
        { originalUrl: source(author).replace('/profiles/', '/id/') },
        { authorSteamId: Number(author) },
        { authorSteamId: '99999999999999999' },
        { authorSteamId: 'not-a-steam-id' },
        { originalUrl: undefined, authorSteamId: undefined }
    ];
    for (const change of mismatches) {
        const saved = freeze(puzzle([clue(change)]));
        assert.equal(decoratePuzzleReviewers(saved, profiles), saved, JSON.stringify(change));
    }
    const wrongMap = { [otherAuthor]: profile };
    const saved = freeze(puzzle([clue()]));
    assert.equal(decoratePuzzleReviewers(saved, wrongMap), saved);
});

test('preserves real legacy metadata and only fills missing fields with valid profile data', () => {
    const legacyAvatar = avatar.replace('_medium.jpg', '_full.jpg');
    const saved = freeze(puzzle([
        clue({ reviewerName: 'Previously saved name', reviewerAvatarUrl: legacyAvatar }),
        clue({ reviewerName: 'Previously saved name' }),
        clue({ reviewerAvatarUrl: legacyAvatar }),
        clue({ reviewerName: '  ', reviewerAvatarUrl: '' })
    ]));
    const response = decoratePuzzleReviewers(saved, profiles);
    assert.equal(response.reviews[0], saved.reviews[0]);
    assert.equal(response.reviews[1].reviewerName, 'Previously saved name');
    assert.equal(response.reviews[1].reviewerAvatarUrl, avatar);
    assert.equal(response.reviews[2].reviewerName, profile.reviewerName);
    assert.equal(response.reviews[2].reviewerAvatarUrl, legacyAvatar);
    assert.equal(response.reviews[3].reviewerName, profile.reviewerName);
    assert.equal(response.reviews[3].reviewerAvatarUrl, avatar);
    assert.equal(decoratePuzzleReviewers(saved, { [author]: { reviewerName: 'A Steam User', reviewerAvatarUrl: null } }), saved);
});

test('missing or malformed lookup data cannot remove original attribution or stop serving a puzzle', () => {
    const saved = freeze(puzzle([clue(), null]));
    for (const data of [null, {}, [], 'bad', { profiles: [] }, { [author]: null }, { [author]: [] },
        Object.create({ [author]: profile })]) assert.equal(decoratePuzzleReviewers(saved, data), saved);
    assert.equal(decoratePuzzleReviewers(null, profiles), null);
    const missingReviews = freeze({ appId: '1145350' });
    assert.equal(decoratePuzzleReviewers(missingReviews, profiles), missingReviews);
});

test('accepts bounded Unicode names and genuine HTTPS avatar paths, rejecting untrusted values independently', () => {
    const saved = freeze(puzzle([clue()]));
    for (const name of ['x'.repeat(129), 'new\nline', 'control\u0000name', 'control\u0085name', '', 42]) {
        const response = decoratePuzzleReviewers(saved, { [author]: { ...profile, reviewerName: name } });
        assert.equal(response.reviews[0].reviewerName, 'A Steam User');
        assert.equal(response.reviews[0].reviewerAvatarUrl, avatar);
    }
    const validName = '🌙'.repeat(128);
    assert.equal(decoratePuzzleReviewers(saved, { [author]: { reviewerName: validName } }).reviews[0].reviewerName, validName);
    for (const url of [avatar.replace('https:', 'http:'), avatar.replace('.com/', '.com.evil.test/'),
        avatar + '?redirect=evil', avatar.replace('/' + 'a'.repeat(40), '/anything'),
        'https://evil.test/avatar.jpg', 'data:image/svg+xml,<svg/>', 'javascript:alert(1)', 42]) {
        const response = decoratePuzzleReviewers(saved, { [author]: { ...profile, reviewerAvatarUrl: url } });
        assert.equal(response.reviews[0].reviewerName, profile.reviewerName);
        assert.equal(response.reviews[0].reviewerAvatarUrl, null);
    }
    for (const host of ['avatars.steamstatic.com', 'avatars.cloudflare.steamstatic.com', 'avatars.fastly.steamstatic.com']) {
        const url = avatar.replace('avatars.akamai.steamstatic.com', host);
        assert.equal(decoratePuzzleReviewers(saved, { [author]: { reviewerAvatarUrl: url } }).reviews[0].reviewerAvatarUrl, url);
    }
});

test('optional review counts use verified nonnegative integers and preserve existing values', () => {
    const saved = freeze(puzzle([clue(), clue({ reviewerReviewCount: 8 })]));
    const response = decoratePuzzleReviewers(saved, { [author]: { reviewerReviewCount: 21 } });
    assert.equal(response.reviews[0].reviewerReviewCount, 21);
    assert.equal(response.reviews[1].reviewerReviewCount, 8);
    assert.equal(saved.reviews[0].reviewerReviewCount, undefined);
    for (const count of [-1, 1.5, '21', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])
        assert.equal(decoratePuzzleReviewers(saved, { [author]: { reviewerReviewCount: count } }), saved);
    assert.equal(decoratePuzzleReviewers(saved, { [author]: { reviewerReviewCount: 0 } }).reviews[0].reviewerReviewCount, 0);
});

test('every active curated clue receives verified presentation while the pack fingerprint and clue contents stay unchanged', () => {
    const pack = require('../active-curation');
    const { prepareCuratedTrial } = require('../curated-trial');
    const beforeHash = digest(pack);
    const games = prepareCuratedTrial(pack);
    let clueCount = 0;
    for (const game of games.values()) {
        const saved = freeze({ appId: game.steam_app_id, title: game.title, curationVersion: pack.version,
            reviews: game.clues.map(item => item.data) });
        const before = JSON.stringify(saved);
        const decorated = decoratePuzzleReviewers(saved);
        for (const [index, review] of decorated.reviews.entries()) {
            assert.ok(review.reviewerName && review.reviewerName !== 'A Steam User',
                `${game.title} clue ${index + 1} lacks a verified name`);
            assert.match(review.reviewerAvatarUrl, /^https:\/\//,
                `${game.title} clue ${index + 1} lacks a verified avatar`);
            assert.ok(Number.isSafeInteger(review.reviewerReviewCount) && review.reviewerReviewCount >= 0,
                `${game.title} clue ${index + 1} lacks a verified review count`);
            const presentationKeys = new Set(['reviewerName', 'reviewerAvatarUrl', 'reviewerReviewCount']);
            const content = value => Object.fromEntries(Object.entries(value).filter(([key]) => !presentationKeys.has(key)));
            assert.deepEqual(content(review), content(saved.reviews[index]));
            clueCount++;
        }
        assert.equal(JSON.stringify(saved), before);
    }
    assert.equal(clueCount, pack.games.length * 6);
    assert.equal(clueCount, 180);
    assert.equal(digest(pack), beforeHash);
});
