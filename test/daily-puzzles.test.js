const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');
const { createDailyPuzzles } = require('../daily-puzzles');

test('migrates old clue URLs and preserves both daily puzzles across a restart and Steam outage', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'steamdle-puzzles-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'database_files');
    await mkdir(directory);
    const filename = path.join(directory, 'steamdle.sqlite');
    const old = new sqlite3.Database(filename);
    await promisify(old.exec.bind(old))(`
        CREATE TABLE games (id INTEGER PRIMARY KEY, title TEXT UNIQUE, steam_app_id TEXT,
            last_played_on TEXT, is_active INTEGER DEFAULT 1);
        CREATE TABLE game_reviews (id INTEGER PRIMARY KEY, game_id INTEGER, review_page_url TEXT UNIQUE, clue_order INTEGER);
        INSERT INTO games VALUES (1, 'Existing daily', '10', '2026-11-04', 1);
        INSERT INTO games (id, title, steam_app_id) VALUES (2, 'Prepared daily', '20');
    `);
    await promisify(old.close.bind(old))();

    process.env.NODE_ENV = 'production';
    process.env.DISABLE_DB_SEED = 'true';
    process.env.RENDER_DISK_MOUNT_PATH = root;
    const db = require('../db');
    await db.ready;
    const run = promisify(db.run.bind(db));
    const get = promisify(db.get.bind(db));
    const service = createDailyPuzzles(db, async url => {
        assert.match(url, /^legacy-/);
        return { reviewText: 'Original clue ' + url };
    });
    assert.equal(await service.forDay('2026-11-04'), null, 'retry after empty start');
    for (let i = 1; i <= 6; i++) {
        await run('INSERT INTO game_reviews (game_id, review_page_url, clue_order) VALUES (1, ?, ?)', ['legacy-' + i, i]);
        await run('INSERT INTO game_reviews (game_id, review_page_url, clue_order, review_data) VALUES (2, ?, ?, ?)',
            ['new-' + i, i, JSON.stringify({ reviewText: 'Prepared clue ' + i })]);
    }

    const day = new Date('2026-11-04T23:59:00Z');
    const [today, ready] = await Promise.all([service.forDay('2026-11-04'), service.prepareThroughTomorrow(day)]);
    assert.equal(today.title, 'Existing daily');
    assert.equal(today.reviews.length, 6);
    assert.equal(ready, '2026-11-05');
    assert.equal((await get('SELECT last_played_on FROM games WHERE id = 2')).last_played_on, null);
    const prepared = await service.forDay('2026-11-05');
    assert.equal(prepared.title, 'Prepared daily');
    assert.equal(prepared.reviews[5].reviewText, 'Prepared clue 6');

    // Simulate reviews being edited/removed after preparation, plus a real DB reopen.
    await run('DELETE FROM game_reviews');
    await promisify(db.close.bind(db))();
    const reopened = new sqlite3.Database(filename);
    try {
        const offline = createDailyPuzzles(reopened, () => { throw new Error('Steam offline'); });
        assert.deepEqual(await offline.forDay('2026-11-04'), today);
        assert.deepEqual(await offline.forDay('2026-11-05'), prepared);
        assert.equal(await offline.prepareThroughTomorrow(new Date('2026-11-05T00:00:00Z')), null);
        const row = await promisify(reopened.get.bind(reopened))('SELECT last_played_on FROM games WHERE id = 2');
        assert.equal(row.last_played_on, '2026-11-05');

        // A deployment with seeding disabled can still prebuild the next day from an old, working URL set.
        const restore = promisify(reopened.run.bind(reopened));
        for (let i = 1; i <= 6; i++) {
            await restore('INSERT INTO game_reviews (game_id, review_page_url, clue_order) VALUES (1, ?, ?)', ['legacy-' + i, i]);
        }
        const recovery = createDailyPuzzles(reopened, async url => ({ reviewText: url }));
        assert.equal(await recovery.prepareThroughTomorrow(new Date('2026-11-05T20:00:00Z')), '2026-11-06');
        assert.equal((await offline.forDay('2026-11-06')).reviews[0].reviewText, 'legacy-1');
    } finally {
        await promisify(reopened.close.bind(reopened))();
    }
});
