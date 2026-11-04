const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { selectClues, fetchGameClues } = require('../clues');

const title = 'Clockwork Isles';
const description = 'Sail to Beacon Harbor and grow your crops.';
const texts = [
    'I came here for five minutes and completely lost my evening.',
    'My family may never see me again after this weekend.',
    'Somehow I convinced everyone at home to give it a try.',
    'It was the best birthday present I bought myself this year.',
    'I can harvest every crop before breakfast if I remember to water them.',
    'I sailed to Beacon Harbor and found the ghost watching the lighthouse.'
];
function reviewsFrom(lines) {
    return lines.map((review, index) => ({
        review, _source: index === 0 ? 'funny' : 'helpful',
        author: { steamid: String(100 + index), playtime_at_review: 90 },
        voted_up: true, timestamp_created: 1704067200
    }));
}

test('reserve different concrete details for clues five and six, after the humorous opener', () => {
    const pool = reviewsFrom([...texts,
        'Clockwork Isles has one of the most unique mechanics I have ever seen.',
        '✔ Guns ✔ Turrets ✔ Dragons ✔ Farms ✔ Ghost ✔ I rate everything excellent.',
        texts[0].toUpperCase()
    ]);
    const selected = selectClues(pool, title, description);
    assert.equal(selected[0].review, texts[0]);
    assert.deepEqual(selected.slice(4).map(review => review.review), texts.slice(4));
    assert.deepEqual(new Set(selected.map(review => review.review)), new Set(texts));
    assert.equal(new Set(selected.map(review => review.author.steamid)).size, 6);
});

test('declines an all-opinion set and a set whose two ending reviews repeat one mechanic', () => {
    const generic = Array.from({ length: 8 }, (_, i) => `I loved spending another evening with this game, number ${i}.`);
    assert.deepEqual(selectClues(reviewsFrom(generic), title), []);
    generic[6] += ' I enjoyed the fishing.';
    generic[7] += ' Oh, did I mention the fishing?';
    assert.deepEqual(selectClues(reviewsFrom(generic), title), []);
});

test('stores readable Steam data and attribution even if optional profile lookups fail', async t => {
    const pool = reviewsFrom(texts);
    const previousKey = process.env.STEAM_API_KEY;
    process.env.STEAM_API_KEY = 'test-only';
    t.after(() => {
        if (previousKey === undefined) delete process.env.STEAM_API_KEY;
        else process.env.STEAM_API_KEY = previousKey;
    });
    let profileRequested = false;
    t.mock.method(axios, 'get', async (url, options) => {
        if (url.includes('appdetails')) return { data: { 7: { data: { short_description: description } } } };
        if (url.includes('GetPlayerSummaries')) {
            profileRequested = true;
            throw new Error('temporary failure');
        }
        const input = JSON.parse(options.params.input_json);
        assert.equal(input.appid, 7);
        return { data: { response: { reviews: input.filter === 3 ? pool.slice(0, 1) : pool } } };
    });
    const clues = await fetchGameClues('7', title);
    assert.equal(profileRequested, true);
    assert.equal(clues.length, 6);
    assert.equal(clues[5].data.reviewText, texts[5]);
    assert.equal(clues[5].data.recommendation, 'Recommended');
    assert.equal(clues[5].data.playtime, '1.5 hrs');
    assert.equal(clues[5].data.datePosted, 'Jan 1, 2024');
    assert.equal(clues[5].data.originalUrl, 'https://steamcommunity.com/profiles/105/recommended/7/');
});
