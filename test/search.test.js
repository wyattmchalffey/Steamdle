const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../catalog');
const titleAliases = require('../title-aliases');
const { buildSearchIndex, buildGuessAliases, searchGames } = require('../game-search');

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

test('each accepted alias belongs to one catalog game and ranks first with or without Steam', async () => {
    const { normalizeTitle } = await import('../public/round.mjs');
    const ids = new Map(catalog.map(game => [game.steam_app_id, game.title]));
    const claimed = new Map(catalog.map(game => [normalizeTitle(game.title), game.title]));
    for (const index of [buildSearchIndex(), buildSearchIndex(steamApps)]) {
        const aliases = buildGuessAliases(index);
        for (const [appId, spellings] of Object.entries(titleAliases)) {
            const title = ids.get(appId);
            assert.ok(title, `Missing catalog app ${appId}`);
            for (const alias of spellings) {
                const key = normalizeTitle(alias);
                assert.ok(!claimed.has(key) || claimed.get(key) === title, `Ambiguous alias: ${alias}`);
                claimed.set(key, title);
                assert.equal(aliases[key], title, alias);
                assert.deepEqual(searchGames(index, alias, 1), [title], alias);
            }
        }
    }
});

test('search and scoring share curated spellings and catalog Steam renames, while keeping different games distinct', () => {
    const gta = 'Grand Theft Auto V';
    const index = buildSearchIndex([
        ...steamApps,
        { appid: 10, name: 'The Bogtavern' },
        { appid: 20, name: 'CS2D' },
        { appid: 30, name: 'Alternate Portal Store Title' }, // A conflicting extra catalog entry must not shadow the playable ID.
        { appid: 40, name: 'A Different Game' },
        { appid: 271590, name: 'Grand Theft Auto V: Other Store Spelling' }
    ].reverse());
    const aliases = buildGuessAliases(index);
    for (const alias of ['GTA V', 'gta-5', 'Grand Theft Auto 5']) {
        assert.deepEqual(searchGames(index, alias, 1), [gta]);
    }
    assert.deepEqual(searchGames(index, 'cs2', 1), ['Counter-Strike 2']);
    assert.deepEqual(searchGames(index, 'CS2D', 1), ['CS2D']);
    assert.deepEqual(searchGames(index, 'Portal', 1), ['Portal']);
    assert.deepEqual(searchGames(index, 'Portal 2', 1), ['Portal 2']);
    assert.equal(aliases.alternateportalstoretitle, 'Portal 2');
    assert.equal(aliases.grandtheftautovotherstorespelling, gta);
    for (const name of ['portal', 'portal2', 'gta', 'cs', 'cs2d', 'adifferentgame', 'tf2']) {
        assert.equal(Object.hasOwn(aliases, name), false, name);
    }
});

test('a shared store spelling suggests both playable titles but cannot score as either one', () => {
    const names = [
        { appid: 400, name: 'Shared store name' },
        { appid: 620, name: 'Shared Store-Name' },
        { appid: 620, name: 'Shared Store Name' },
        // A fetched spelling must never claim the canonical name of another catalog game.
        { appid: 400, name: 'Portal 2' }
    ];
    for (const apps of [names, [...names].reverse()]) {
        const index = buildSearchIndex(apps);
        assert.deepEqual(searchGames(index, 'shared store name', 5), ['Portal', 'Portal 2']);
        assert.equal(Object.hasOwn(buildGuessAliases(index), 'sharedstorename'), false);
        assert.deepEqual(searchGames(index, 'Portal 2', 1), ['Portal 2']);
    }
});
