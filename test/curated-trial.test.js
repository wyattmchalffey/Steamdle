const test = require('node:test');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const { mkdtemp, rm } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { prepareCuratedTrial, registerCatalogAndCuratedReviews } = require('../curated-trial');

function trialGame(appId, title = 'Game ' + appId) {
    return {
        title, steam_app_id: String(appId),
        clues: Array.from({ length: 6 }, (_, i) => ({
            recommendationid: String(appId * 100 + i), authorSteamId: String(7000 + i),
            sourceUrl: `https://steamcommunity.com/profiles/${7000 + i}/recommended/${appId}/`,
            displayText: `Evidence ${i} for the fixture puzzle.`, isExcerpt: i % 2 === 0,
            reviewMetadata: { recommendation: 'Recommended', playtime: '12 hrs', datePosted: 'Nov 10, 2026' }
        }))
    };
}

async function fixture(t) {
    const db = new sqlite3.Database(':memory:');
    t.after(() => promisify(db.close.bind(db))());
    const run = promisify(db.run.bind(db));
    const get = promisify(db.get.bind(db));
    const all = promisify(db.all.bind(db));
    await promisify(db.exec.bind(db))(`
        CREATE TABLE games (id INTEGER PRIMARY KEY, title TEXT UNIQUE, steam_app_id TEXT,
            last_played_on TEXT, is_active INTEGER DEFAULT 1);
        CREATE TABLE game_reviews (id INTEGER PRIMARY KEY, game_id INTEGER,
            review_page_url TEXT UNIQUE, clue_order INTEGER, review_data TEXT);
        CREATE TABLE daily_puzzles (puzzle_date TEXT PRIMARY KEY, game_id INTEGER, puzzle_json TEXT);
    `);
    return { db, run, get, all };
}

test('actual curated pack has six source-linked reviews per game and rejects conflicting attribution', () => {
    const pack = require('../data/clue-trial-2026-11-12');
    const prepared = prepareCuratedTrial(pack);
    assert.equal(prepared.size, 6);
    for (const game of prepared.values()) {
        assert.equal(game.clues.length, 6);
        for (const clue of game.clues) {
            assert.equal(clue.data.originalUrl, clue.url);
            assert.equal(clue.data.curationVersion, pack.version);
            assert.equal(typeof clue.data.isExcerpt, 'boolean');
        }
    }
    const bad = { version: 'v1', games: [trialGame(101)] };
    bad.games[0].clues[1].authorSteamId = bad.games[0].clues[0].authorSteamId;
    assert.throws(() => prepareCuratedTrial(bad), /Invalid or duplicate/);
    bad.games[0] = trialGame(101);
    bad.games[0].clues[0].sourceUrl = 'https://steamcommunity.com/profiles/7000/recommended/999/';
    assert.throws(() => prepareCuratedTrial(bad), /Invalid or duplicate/);
});

test('startup registers unready games, retains old app identity, and deactivates without deleting history', async t => {
    const { db, run, get } = await fixture(t);
    await run(`INSERT INTO games VALUES (1, 'Corrected title', '99', '2026-05-10', 0)`);
    await run(`INSERT INTO games VALUES (2, 'Removed title', '55', '2026-04-01', 1)`);
    await run(`INSERT INTO game_reviews VALUES (1, 1, 'legacy-source', 1, '{"reviewText":"Original clue"}')`);
    const game = trialGame(101);
    const catalog = [game, { title: 'Corrected title', steam_app_id: '100' }, { title: 'Not ready', steam_app_id: '202' }];
    await registerCatalogAndCuratedReviews(db, catalog, prepareCuratedTrial({ version: 'v1', games: [game] }));
    assert.deepEqual(await get('SELECT steam_app_id, last_played_on, is_active FROM games WHERE id = 1'),
        { steam_app_id: '99', last_played_on: '2026-05-10', is_active: 1 });
    assert.deepEqual(await get('SELECT last_played_on, is_active FROM games WHERE id = 2'),
        { last_played_on: '2026-04-01', is_active: 0 });
    assert.equal((await get(`SELECT COUNT(*) AS count FROM games WHERE title = 'Not ready'`)).count, 1);
    assert.equal((await get('SELECT review_data FROM game_reviews WHERE id = 1')).review_data, '{"reviewText":"Original clue"}');
    assert.equal((await get('SELECT COUNT(*) AS count FROM game_reviews WHERE game_id = (SELECT id FROM games WHERE title = ?)', game.title)).count, 6);
});

test('new curated versions update unused caches but preserve used games and frozen future snapshots', async t => {
    const { db, run, get, all } = await fixture(t);
    const pack = { version: 'v1', games: [trialGame(101), trialGame(102), trialGame(103), trialGame(104)] };
    await registerCatalogAndCuratedReviews(db, pack.games, prepareCuratedTrial(pack));
    const used = await get('SELECT id FROM games WHERE steam_app_id = ?', '102');
    const frozen = await get('SELECT id FROM games WHERE steam_app_id = ?', '103');
    await run('UPDATE games SET last_played_on = ? WHERE id = ?', ['2026-11-12', used.id]);
    await run(`INSERT INTO games (title, steam_app_id, last_played_on, is_active)
        VALUES ('Old name for game 104', '104', '2025-12-01', 0)`);
    const snapshot = JSON.stringify({ appId: '103', reviews: [{ reviewText: 'Exact frozen text' }] });
    await run('INSERT INTO daily_puzzles VALUES (?, ?, ?)', ['2026-11-13', frozen.id, snapshot]);
    const idsBefore = await all('SELECT id FROM game_reviews ORDER BY id');
    await registerCatalogAndCuratedReviews(db, pack.games, prepareCuratedTrial(pack));
    assert.deepEqual(await all('SELECT id FROM game_reviews ORDER BY id'), idsBefore, 'same-version import is idempotent');
    pack.version = 'v2';
    for (const game of pack.games) game.clues[0].displayText = 'Revised editorial clue';
    const report = await registerCatalogAndCuratedReviews(db, pack.games, prepareCuratedTrial(pack));
    assert.deepEqual(report.imported, ['101']);
    assert.deepEqual(report.protectedGames, ['102', '103', '104']);
    const saved = await all(`SELECT g.steam_app_id, r.review_data FROM games g
        JOIN game_reviews r ON r.game_id = g.id WHERE clue_order = 1 ORDER BY g.steam_app_id`);
    assert.equal(JSON.parse(saved[0].review_data).curationVersion, 'v2');
    assert.equal(JSON.parse(saved[1].review_data).curationVersion, 'v1');
    assert.equal(JSON.parse(saved[2].review_data).curationVersion, 'v1');
    assert.equal(JSON.parse(saved[3].review_data).curationVersion, 'v1',
        'a renamed game retains the inactive previous row\'s play history');
    assert.equal((await get('SELECT puzzle_json FROM daily_puzzles')).puzzle_json, snapshot);
    assert.equal((await get('SELECT last_played_on FROM games WHERE id = ?', used.id)).last_played_on, '2026-11-12');
});

test('an import failure rolls back placeholder registration and clue replacement together', async t => {
    const { db, run, get } = await fixture(t);
    await run(`CREATE TRIGGER fail_clue BEFORE INSERT ON game_reviews
        BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`);
    const game = trialGame(101);
    await assert.rejects(registerCatalogAndCuratedReviews(db, [game],
        prepareCuratedTrial({ version: 'v1', games: [game] })), /fixture write failure/);
    assert.equal((await get('SELECT COUNT(*) AS count FROM games')).count, 0);
    assert.equal((await get('SELECT COUNT(*) AS count FROM game_reviews')).count, 0);
});

test('db.ready imports the trial before scheduling and FORCE_RESEED cannot replace curated sets', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'steamdle-curated-startup-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const script = `
        const assert = require('node:assert/strict');
        const { promisify } = require('node:util');
        const pack = require('./data/clue-trial-2026-11-12');
        const activePath = require.resolve('./active-curation');
        require(activePath);
        require.cache[activePath].exports = pack;
        const catalogPath = require.resolve('./catalog');
        require(catalogPath);
        require.cache[catalogPath].exports = [...pack.games, { title: 'Unready fixture', steam_app_id: '99999' }];
        const cluesPath = require.resolve('./clues');
        require(cluesPath);
        const fetched = [];
        require.cache[cluesPath].exports = { fetchGameClues: async appId => { fetched.push(appId); return []; } };
        const db = require('./db');
        (async () => {
            await db.ready;
            const get = promisify(db.get.bind(db));
            assert.equal((await get('SELECT COUNT(*) AS n FROM games')).n, 7);
            assert.equal((await get('SELECT COUNT(*) AS n FROM game_reviews')).n, 36);
            await db.seeded;
            assert.deepEqual(fetched, ['99999']);
            assert.equal((await get('SELECT COUNT(*) AS n FROM game_reviews')).n, 36);
            await promisify(db.close.bind(db))();
            console.log('CURATED_STARTUP_OK');
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, NODE_ENV: 'production', DISABLE_DB_SEED: 'false', FORCE_RESEED: 'true',
            RENDER_DISK_MOUNT_PATH: directory }, timeout: 15000
    });
    assert.match(stdout, /CURATED_STARTUP_OK/);
});
