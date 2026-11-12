const test = require('node:test');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');
const { prepareCuratedTrial, registerCatalogAndCuratedReviews } = require('../curated-trial');
const { installCuratedSchedule, curatedScheduleStatus, validateSchedule } = require('../curated-schedule');
const { createDailyPuzzles } = require('../daily-puzzles');

function pack() {
    const games = Array.from({ length: 30 }, (_, i) => ({
        title: 'Fixture game ' + i, steam_app_id: String(1000 + i),
        clues: Array.from({ length: 6 }, (_, j) => ({
            recommendationid: String(10000 + i * 6 + j), authorSteamId: String(7000 + j),
            sourceUrl: `https://steamcommunity.com/profiles/${7000 + j}/recommended/${1000 + i}/`,
            displayText: `Distinct review evidence ${j}.`, isExcerpt: true
        }))
    }));
    return { version: 'fixture-month-v1', games, schedule: { days: games.map((game, i) => ({
        date: new Date(Date.UTC(2026, 10, 13 + i)).toISOString().slice(0, 10), steam_app_id: game.steam_app_id
    })) } };
}
async function fixture(t) {
    const db = new sqlite3.Database(':memory:');
    t.after(() => promisify(db.close.bind(db))());
    const run = promisify(db.run.bind(db));
    const get = promisify(db.get.bind(db));
    const all = promisify(db.all.bind(db));
    await promisify(db.exec.bind(db))(`CREATE TABLE games(id INTEGER PRIMARY KEY,title TEXT UNIQUE,steam_app_id TEXT,last_played_on TEXT,is_active INTEGER DEFAULT 1);
        CREATE TABLE game_reviews(id INTEGER PRIMARY KEY,game_id INTEGER,review_page_url TEXT UNIQUE,clue_order INTEGER,review_data TEXT);
        CREATE TABLE daily_puzzles(puzzle_date TEXT PRIMARY KEY,game_id INTEGER,puzzle_json TEXT);`);
    const data = pack();
    await registerCatalogAndCuratedReviews(db, data.games, prepareCuratedTrial(data));
    const today = JSON.stringify({ title: 'Already live', appId: '500', reviews: [{ reviewText: 'Do not alter' }] });
    const tomorrow = JSON.stringify({ title: 'Old automatic choice', appId: '501', reviews: [{ reviewText: 'Backup me' }] });
    await run('INSERT INTO daily_puzzles VALUES (?, ?, ?)', ['2026-11-12', 500, today]);
    await run('INSERT INTO daily_puzzles VALUES (?, ?, ?)', ['2026-11-13', 501, tomorrow]);
    return { db, run, get, all, data, today, tomorrow };
}
const now = new Date('2026-11-12T18:00:00Z');

test('installs all 30 dates together, backs up unpublished choices, protects today and survives restarts', async t => {
    const { db, get, all, data, today, tomorrow } = await fixture(t);
    assert.equal((await installCuratedSchedule(db, data, now)).status, 'installed');
    assert.equal((await get(`SELECT puzzle_json FROM daily_puzzles WHERE puzzle_date='2026-11-12'`)).puzzle_json, today);
    assert.equal((await get('SELECT puzzle_json FROM curated_schedule_backups')).puzzle_json, tomorrow);
    const before = await all('SELECT * FROM daily_puzzles ORDER BY puzzle_date');
    assert.equal(before.length, 31);
    assert.equal((await installCuratedSchedule(db, data, new Date('2026-12-03T12:00:00Z'))).status, 'already-installed');
    assert.deepEqual(await all('SELECT * FROM daily_puzzles ORDER BY puzzle_date'), before);
    assert.equal((await get('SELECT COUNT(*) AS n FROM games WHERE last_played_on IS NOT NULL')).n, 0);
    const scheduler = createDailyPuzzles(db, () => { throw new Error('Steam must not be needed'); });
    for (const day of data.schedule.days) {
        const puzzle = await scheduler.forDay(day.date);
        assert.equal(puzzle.appId, day.steam_app_id);
        assert.equal(puzzle.reviews.length, 6);
    }
    assert.equal((await curatedScheduleStatus(db, data)).complete, true);
    const changed = structuredClone(data); changed.games[0].clues[0].displayText = 'Changed';
    await assert.rejects(installCuratedSchedule(db, changed, now), /cannot change/);
    assert.equal((await curatedScheduleStatus(db, changed)).complete, false);
    db.scheduleInstallationError = 'An installation failed';
    assert.equal((await curatedScheduleStatus(db, data)).complete, false);
    delete db.scheduleInstallationError;
    const corrupted = JSON.parse(before[1].puzzle_json);
    corrupted.reviews[0].reviewText = 'Unexpected changed clue with the same version';
    await promisify(db.run.bind(db))('UPDATE daily_puzzles SET puzzle_json = ? WHERE puzzle_date = ?',
        [JSON.stringify(corrupted), before[1].puzzle_date]);
    assert.equal((await curatedScheduleStatus(db, data)).complete, false);
});

test('legacy use on an inactive alias blocks the whole month without replacing tomorrow', async t => {
    const { db, run, get, data, tomorrow } = await fixture(t);
    await run(`INSERT INTO games(title, steam_app_id, last_played_on, is_active) VALUES('Old name','1005','2025-07-04',0)`);
    await assert.rejects(installCuratedSchedule(db, data, now), /already used or reserved/);
    assert.equal((await get('SELECT COUNT(*) AS n FROM daily_puzzles')).n, 2);
    assert.equal((await get(`SELECT puzzle_json FROM daily_puzzles WHERE puzzle_date='2026-11-13'`)).puzzle_json, tomorrow);
    assert.equal((await get('SELECT COUNT(*) AS n FROM curated_schedule_installations')).n, 0);
});

test('immutable history under a recreated row and a late database failure cannot cause partial installation', async t => {
    const { db, run, get, data } = await fixture(t);
    await run(`INSERT INTO daily_puzzles VALUES('2025-11-01',9999,'{"appId":"1017"}')`);
    await assert.rejects(installCuratedSchedule(db, data, now), /already used or reserved/);
    await run(`DELETE FROM daily_puzzles WHERE puzzle_date='2025-11-01'`);
    await run(`CREATE TRIGGER fail_late BEFORE INSERT ON daily_puzzles WHEN NEW.puzzle_date='2026-12-01'
        BEGIN SELECT RAISE(ABORT, 'fixture disk error'); END`);
    await assert.rejects(installCuratedSchedule(db, data, now), /fixture disk error/);
    assert.equal((await get('SELECT COUNT(*) AS n FROM daily_puzzles')).n, 2);
    assert.equal((await get('SELECT COUNT(*) AS n FROM curated_schedule_backups')).n, 0);
});

test('rejects duplicate games, missing days, invalid dates and first installation after the start date', async t => {
    const data = pack();
    const duplicate = structuredClone(data); duplicate.schedule.days[1].steam_app_id = duplicate.schedule.days[0].steam_app_id;
    assert.throws(() => validateSchedule(duplicate), /distinct/);
    const missing = structuredClone(data); missing.schedule.days.pop();
    assert.throws(() => validateSchedule(missing), /exactly 30/);
    const badDate = structuredClone(data); badDate.schedule.days[1].date = '2026-11-31';
    assert.throws(() => validateSchedule(badDate), /consecutive/);
    const { db } = await fixture(t);
    await assert.rejects(installCuratedSchedule(db, data, new Date('2026-11-13T00:00:00Z')), /today and past dates are protected/);
});
