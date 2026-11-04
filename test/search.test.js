const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../catalog');
const { buildSearchIndex, searchGames } = require('../game-search');

const steamApps = [
    { appid: 2215430, name: 'Ghost of Tsushima DIRECTOR’S CUT' },
    { appid: 620, name: 'Alternate Portal Store Title' },
    { appid: 1, name: 'Ghost of Tsushima Fan Adventure' },
    { appid: 2, name: 'Toastmaster' },
    { appid: 3, name: 'Lost and Found' },
    { appid: 4, name: 'Toastmaster OST' },
    { appid: 5, name: 'Lost and Found - Soundtrack Volume 1' }
];

test('every eligible title is the first exact match with or without Steam', () => {
    for (const index of [buildSearchIndex(), buildSearchIndex(steamApps)]) {
        for (const { title } of catalog) {
            assert.deepEqual(searchGames(index, title, 1), [title], title);
        }
    }
});

test('suggest canonical titles for common spellings, editions and Steam aliases', () => {
    const index = buildSearchIndex(steamApps);
    assert.equal(searchGames(index, 'Ghost of Tsushima', 1)[0], "Ghost of Tsushima DIRECTOR'S CUT");
    assert.deepEqual(searchGames(index, 'Alternate Portal Store Title', 1), ['Portal 2']);
    assert.equal(searchGames(index, 'Unpacking', 1)[0], 'Unpacking');
    assert.deepEqual(searchGames(index, ' ghost OF tsushima director’s cut ', 1), ["Ghost of Tsushima DIRECTOR'S CUT"]);
});

test('broad search keeps real games with embedded keywords and drops extras', () => {
    const index = buildSearchIndex(steamApps);
    assert.deepEqual(searchGames(index, 'toastmaster', 10), ['Toastmaster']);
    assert.deepEqual(searchGames(index, 'Lost and Found', 10), ['Lost and Found']);
    assert.deepEqual(searchGames(index, '???', 10), []);
});
