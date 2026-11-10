const test = require('node:test');
const assert = require('node:assert/strict');

function storage() {
    const values = new Map();
    return { values, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
        getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

const result = (date, won = true, turns = won ? 3 : 6) => ({ date, appId: '400', won, turns });
const today = '2026-11-10';

test('completed days include losses, retain an unfinished today, and gaps break the current streak', async () => {
    const { saveResult, readStats } = await import('../public/personal-stats.mjs');
    const local = storage();
    for (const record of [result('2026-11-06'), result('2026-11-07', false), result('2026-11-08')]) {
        assert.equal(saveResult(local, record, today), true);
    }
    assert.equal(readStats(local, '2026-11-09').currentStreak, 3, 'today is still available to play');
    assert.equal(readStats(local, today).currentStreak, 0, 'missing yesterday breaks the streak');
    saveResult(local, result(today, false), today);
    const stats = readStats(local, today);
    assert.equal(stats.currentStreak, 1);
    assert.equal(stats.bestStreak, 3);
    assert.equal(stats.played, 4);
    assert.equal(stats.solved, 2);
    assert.equal(stats.winRate, 50);
    assert.deepEqual(stats.history.map(row => row.date), [today, '2026-11-08', '2026-11-07', '2026-11-06']);
});

test('reopened results and other tabs cannot replace an existing daily result or lose other dates', async () => {
    const { saveResult, readStats } = await import('../public/personal-stats.mjs');
    const local = storage();
    const original = result(today, false);
    assert.equal(saveResult(local, original, today), true);
    assert.equal(saveResult(local, original, today), true);
    assert.equal(saveResult(local, result(today), today), false);
    assert.equal(saveResult(local, {...result(today), appId:'999'}, today), false);
    saveResult(local, result('2026-11-09'), today);
    const stats = readStats(local, today);
    assert.equal(stats.played, 2);
    assert.equal(stats.currentStreak, 2);
    assert.deepEqual(stats.history[0], original);
    assert.equal(local.length, 2);
});

test('malformed, future, incomplete and unrelated saved data never become personal results', async () => {
    const { saveResult, readStats } = await import('../public/personal-stats.mjs');
    const local = storage();
    for (const invalid of [
        result('2026-02-31'), result('2026-11-11'), result(today, false, 5), result(today, true, 7),
        result(today, true, 0), result(today, 'true', 3), {...result(today), appId:'raw-title'},
        {...result(today), appId:0}, {...result(today), turns:['wrong','solve']}, null
    ]) assert.equal(saveResult(local, invalid, today), false);
    local.setItem('steamdle.round.v1.' + today + '.400', JSON.stringify(['wrong','unknown title']));
    local.setItem('steamdle.result.v1.2026-11-09', '{broken');
    local.setItem('steamdle.result.v1.2026-11-08', JSON.stringify(result('2026-11-07')));
    local.setItem('steamdle.result.v1.2026-11-11', JSON.stringify(result('2026-11-11')));
    assert.equal(readStats(local, today).played, 0);
    assert.equal(saveResult(local, {...result('2026-11-09'), appId:400, title:'Never retained'}, today), true);
    const stats = readStats(local, today);
    assert.deepEqual(stats.history, [result('2026-11-09')]);
    assert.equal(JSON.stringify([...local.values]).includes('Never retained'), false);
});

test('blocked reads and failed writes stay optional and report unavailable storage', async () => {
    const { saveResult, readStats } = await import('../public/personal-stats.mjs');
    const local = storage();
    Object.defineProperty(local, 'length', {get() { throw Error('Storage blocked'); }});
    assert.equal(readStats(local, today).available, false);
    const readBlocked = storage();
    readBlocked.setItem('steamdle.result.v1.' + today, JSON.stringify(result(today)));
    readBlocked.getItem = () => { throw Error('Storage blocked'); };
    assert.equal(readStats(readBlocked, today).available, false);
    assert.equal(saveResult(readBlocked, result(today), today), false);
    const full = storage();
    full.setItem = () => { throw Error('Quota exceeded'); };
    assert.equal(saveResult(full, result(today), today), false);
    assert.equal(readStats(full, today).available, false);
    assert.equal(readStats(null, today).available, false);
    assert.equal(saveResult(null, result(today), today), false);
});

test('UTC day boundaries and leap days drive streaks and the next-puzzle countdown', async () => {
    const { saveResult, readStats, nextPuzzleTime } = await import('../public/personal-stats.mjs');
    const local = storage();
    for (const date of ['2028-02-28','2028-02-29','2028-03-01']) saveResult(local, result(date), '2028-03-01');
    assert.equal(readStats(local, '2028-03-01').currentStreak, 3);
    const lastMoment = nextPuzzleTime(new Date('2026-11-10T23:59:59.900Z'));
    assert.equal(lastMoment.at, Date.parse('2026-11-11T00:00:00Z'));
    assert.equal(lastMoment.remaining, 100);
    assert.equal(lastMoment.countdown, '00:00:01');
    assert.equal(typeof lastMoment.localLabel, 'string');
    assert.equal(nextPuzzleTime(Date.parse('2026-11-11T00:00:00Z')).countdown, '24:00:00');
    assert.equal(nextPuzzleTime(Date.parse('2026-11-10T06:30:00-06:00')).countdown, '11:30:00');
    assert.equal(nextPuzzleTime(NaN), null);
});
