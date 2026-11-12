const test = require('node:test');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');
const { createDailyPuzzles } = require('../daily-puzzles');

async function fixture(t) {
    const db = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(':memory:', error => error ? reject(error) : resolve(connection));
    });
    t.after(() => promisify(db.close.bind(db))());
    await promisify(db.exec.bind(db))(`
        CREATE TABLE games (id INTEGER PRIMARY KEY, title TEXT UNIQUE, steam_app_id TEXT,
            last_played_on TEXT, is_active INTEGER DEFAULT 1);
        CREATE TABLE game_reviews (id INTEGER PRIMARY KEY, game_id INTEGER, review_page_url TEXT UNIQUE,
            clue_order INTEGER, review_data TEXT);
        CREATE TABLE daily_puzzles (puzzle_date TEXT PRIMARY KEY, game_id INTEGER, puzzle_json TEXT);
    `);
    const run = promisify(db.run.bind(db));
    const get = promisify(db.get.bind(db));
    async function game(id, appId, { stored = true, lastPlayed = null } = {}) {
        await run('INSERT INTO games (id, title, steam_app_id, last_played_on) VALUES (?, ?, ?, ?)',
            [id, 'Game ' + appId, String(appId), lastPlayed]);
        for (let i = 1; i <= 6; i++) {
            const url = `game-${appId}-clue-${i}`;
            await run('INSERT INTO game_reviews (game_id, review_page_url, clue_order, review_data) VALUES (?, ?, ?, ?)',
                [id, url, i, stored ? JSON.stringify({ reviewText: url }) : null]);
        }
    }
    async function history(date, gameId, appId) {
        const snapshot = { title: 'Historical title', appId: String(appId), puzzleDate: date,
            reviews: [{ reviewText: 'Original frozen review' }] };
        await run('INSERT INTO daily_puzzles VALUES (?, ?, ?)', [date, gameId, JSON.stringify(snapshot)]);
        return snapshot;
    }
    return { db, run, get, game, history };
}

test('an unused URL-only game beats a cached repeat, without marking the fetched game played early', async t => {
    const f = await fixture(t);
    await f.game(1, 10, { lastPlayed: '2026-06-01' });
    await f.game(2, 20, { stored: false });
    const fetched = [];
    const service = createDailyPuzzles(f.db, async url => {
        fetched.push(url);
        return { reviewText: url };
    });
    const puzzle = await service.forDay('2026-11-12', { preparing: true });
    assert.equal(puzzle.appId, '20');
    assert.equal(fetched.length, 6);
    assert.equal((await f.get('SELECT last_played_on FROM games WHERE id = 2')).last_played_on, null);
});

test('stored-only preparation waits for unused clues, then the same day can recover without a repeat', async t => {
    const f = await fixture(t);
    await f.game(1, 10, { lastPlayed: '2026-06-01' });
    await f.game(2, 20, { stored: false });
    let fetched = 0;
    const service = createDailyPuzzles(f.db, async url => {
        fetched++;
        return { reviewText: url };
    });
    assert.equal(await service.forDay('2026-11-12', { preparing: true, storedOnly: true }), null);
    assert.equal(fetched, 0);
    assert.equal((await f.get('SELECT COUNT(*) AS n FROM daily_puzzles')).n, 0);
    assert.equal((await service.forDay('2026-11-12', { preparing: true })).appId, '20');
});

test('a transient failure never exhausts unused games or silently promotes a cached repeat', async t => {
    const f = await fixture(t);
    await f.game(1, 10, { lastPlayed: '2026-06-01' });
    await f.game(2, 20, { stored: false });
    let offline = true;
    const service = createDailyPuzzles(f.db, () => {
        if (offline) throw new Error('Temporary upstream outage');
        return { reviewText: 'Recovered original review' };
    });
    assert.equal(await service.forDay('2026-11-12'), null);
    assert.equal(await service.forDay('2026-11-12'), null);
    assert.equal((await f.get('SELECT COUNT(*) AS n FROM daily_puzzles')).n, 0);
    assert.equal((await f.get('SELECT last_played_on FROM games WHERE id = 2')).last_played_on, null);
    offline = false;
    assert.equal((await service.forDay('2026-11-12')).appId, '20');
});

test('snapshot app identity survives a recreated game row and recovered pre-snapshot usage supplements it', async t => {
    const f = await fixture(t);
    await f.game(1, 10);
    await f.game(2, 20);
    await f.game(3, 30, { stored: false });
    await f.history('2026-06-01', 99, 10); // Former row is gone; app identity is retained.
    const service = createDailyPuzzles(f.db, async url => ({ reviewText: url }), { playedAppIds: [20] });
    assert.equal((await service.forDay('2026-11-12')).appId, '30');
});

test('a corrected app ID retains row history, while an existing daily snapshot stays unchanged', async t => {
    const f = await fixture(t);
    await f.game(1, 387290);
    await f.game(2, 20, { stored: false });
    const historical = await f.history('2026-06-01', 1, 261570);
    const service = createDailyPuzzles(f.db, async url => ({ reviewText: url }));
    assert.deepEqual(await service.forDay('2026-06-01'), historical);
    assert.equal((await service.forDay('2026-11-12')).appId, '20');
});

test('after unused games are exhausted, choose the oldest eligible repeat and exclude yesterday by app identity', async t => {
    const f = await fixture(t);
    await f.game(1, 10, { stored: false, lastPlayed: '2026-06-01' });
    await f.game(2, 20, { lastPlayed: '2026-07-01' });
    await f.game(3, 30); // Recreated yesterday's game would otherwise look unused.
    await f.history('2026-11-11', 99, 30);
    const service = createDailyPuzzles(f.db, async url => ({ reviewText: url }));
    assert.equal((await service.forDay('2026-11-12')).appId, '10');
});

test('a single game cannot immediately repeat after a restart, even through forDay rather than prebuilding', async t => {
    const f = await fixture(t);
    await f.game(1, 10, { lastPlayed: '2026-11-11' });
    const service = createDailyPuzzles(f.db, () => { throw new Error('Should not fetch'); });
    assert.equal(await service.forDay('2026-11-12'), null);
});

test('migration cannot replace a legacy answer already published today when its review rows are unavailable', async t => {
    const f = await fixture(t);
    await f.game(1, 10, { lastPlayed: '2026-11-12' });
    await f.game(2, 20);
    await f.run('DELETE FROM game_reviews WHERE game_id = 1');
    const service = createDailyPuzzles(f.db, () => { throw new Error('Should not fetch'); });
    assert.equal(await service.forDay('2026-11-12'), null);
    assert.equal((await f.get('SELECT COUNT(*) AS n FROM daily_puzzles')).n, 0);
});

test('an unused game awaiting clue import prevents repeats and recovers when all six clues arrive', async t => {
    const f = await fixture(t);
    await f.game(1, 10, { lastPlayed: '2026-06-01' });
    await f.game(2, 20);
    await f.run('DELETE FROM game_reviews WHERE game_id = 2');
    const service = createDailyPuzzles(f.db, () => { throw new Error('Should not fetch'); });
    assert.equal(await service.forDay('2026-11-12'), null);
    for (let i = 1; i <= 5; i++) {
        await f.run('INSERT INTO game_reviews (game_id, clue_order, review_data) VALUES (2, ?, ?)',
            [i, JSON.stringify({ reviewText: 'Imported original review ' + i })]);
    }
    assert.equal(await service.forDay('2026-11-12'), null);
    assert.equal((await f.get('SELECT COUNT(*) AS n FROM daily_puzzles')).n, 0);
    assert.equal((await f.get('SELECT last_played_on FROM games WHERE id = 2')).last_played_on, null);
    await f.run('INSERT INTO game_reviews (game_id, clue_order, review_data) VALUES (2, 6, ?)',
        [JSON.stringify({ reviewText: 'Imported original review 6' })]);
    assert.equal((await service.forDay('2026-11-12')).appId, '20');
});

test('a future snapshot counts as used by app identity even when the game row is recreated', async t => {
    const f = await fixture(t);
    await f.game(1, 10);
    await f.game(2, 20, { stored: false });
    const future = await f.history('2026-11-14', 99, 10);
    const service = createDailyPuzzles(f.db, async url => ({ reviewText: url }));
    assert.equal((await service.forDay('2026-11-12')).appId, '20');
    assert.deepEqual(await service.forDay('2026-11-14'), future);
});

test('a prebuilt tomorrow cannot immediately repeat today even when no unused games remain', async t => {
    const f = await fixture(t);
    await f.game(1, 10);
    const tomorrow = await f.history('2026-11-13', 99, 10);
    const service = createDailyPuzzles(f.db, () => { throw new Error('Should not fetch'); });
    assert.equal(await service.forDay('2026-11-12'), null);
    assert.deepEqual(await service.forDay('2026-11-13'), tomorrow);
});

test('unused trial priorities follow list order before cache preference and cannot change frozen days', async t => {
    const f = await fixture(t);
    await f.game(1, 10);
    await f.game(2, 20);
    await f.game(3, 30, { stored: false });
    const service = createDailyPuzzles(f.db, async url => ({ reviewText: url }), { priorityAppIds: [30, '20'] });
    const today = await service.forDay('2026-11-12');
    const tomorrow = await service.forDay('2026-11-13', { preparing: true });
    assert.equal(today.appId, '30');
    assert.equal(tomorrow.appId, '20');
    const restarted = createDailyPuzzles(f.db, () => { throw new Error('Should not fetch'); }, { priorityAppIds: [10] });
    assert.deepEqual(await restarted.forDay('2026-11-12'), today);
    assert.deepEqual(await restarted.forDay('2026-11-13', { preparing: true }), tomorrow);
});

test('a used trial priority cannot beat an unused game or change oldest-first repeats', async t => {
    const f = await fixture(t);
    await f.game(1, 10, { lastPlayed: '2026-11-01' });
    await f.game(2, 20);
    await f.game(3, 30, { lastPlayed: '2026-06-01' });
    const service = createDailyPuzzles(f.db, () => { throw new Error('Should not fetch'); }, { priorityAppIds: [10] });
    assert.equal((await service.forDay('2026-11-12')).appId, '20');
    assert.equal((await service.forDay('2026-11-13', { preparing: true })).appId, '30');
});

test('an inactive old alias keeps its pre-snapshot usage when a renamed game gets a fresh row', async t => {
    const f = await fixture(t);
    await f.game(1, 10);
    await f.game(2, 20, { stored: false });
    await f.run(`INSERT INTO games (id, title, steam_app_id, last_played_on, is_active)
        VALUES (99, 'Inactive old alias', '10', '2026-06-01', 0)`);
    const service = createDailyPuzzles(f.db, async url => ({ reviewText: url }), { priorityAppIds: [10] });
    assert.equal((await service.forDay('2026-11-12')).appId, '20');
});

test('yesterday usage on an inactive alias excludes the renamed game even after all games have been used', async t => {
    const f = await fixture(t);
    await f.game(1, 10);
    await f.run(`INSERT INTO games (id, title, steam_app_id, last_played_on, is_active)
        VALUES (99, 'Inactive old alias', '10', '2026-11-11', 0)`);
    const service = createDailyPuzzles(f.db, () => { throw new Error('Should not fetch'); });
    assert.equal(await service.forDay('2026-11-12'), null);
});

test('today usage on an inactive alias preserves the legacy answer after a rename', async t => {
    const f = await fixture(t);
    await f.game(1, 10);
    await f.game(2, 20);
    await f.run(`INSERT INTO games (id, title, steam_app_id, last_played_on, is_active)
        VALUES (99, 'Inactive old alias', '10', '2026-11-12', 0)`);
    const service = createDailyPuzzles(f.db, () => { throw new Error('Should not fetch'); }, { priorityAppIds: [20] });
    assert.equal((await service.forDay('2026-11-12')).appId, '10');
});
