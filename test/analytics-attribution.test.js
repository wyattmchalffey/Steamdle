const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');
const { createAnalytics } = require('../analytics');

async function fixture(t, legacy = false) {
    const db = new sqlite3.Database(':memory:');
    t.after(() => promisify(db.close.bind(db))());
    const exec = promisify(db.exec.bind(db)), run = promisify(db.run.bind(db));
    const all = promisify(db.all.bind(db));
    let day = '2026-11-10';
    const oldId = randomUUID();
    db.ready = exec(`CREATE TABLE daily_puzzles(puzzle_date TEXT PRIMARY KEY, puzzle_json TEXT DEFAULT '{}');`);
    await db.ready;
    if (legacy) {
        await exec(`CREATE TABLE analytics_rounds(browser_key TEXT, puzzle_date TEXT, source TEXT, campaign TEXT, turns TEXT,
            PRIMARY KEY(browser_key,puzzle_date)) WITHOUT ROWID;
            CREATE TABLE analytics_metadata(id INTEGER PRIMARY KEY, tracking_since TEXT NOT NULL);
            INSERT INTO analytics_metadata VALUES (1,'2026-11-04');`);
        await run('INSERT INTO analytics_rounds VALUES (?,?,?,?,?)',
            [createHash('sha256').update(oldId).digest('hex'), day, 'other', '', 'W']);
    }
    const service = createAnalytics(db, { now: () => new Date(day + 'T12:00:00Z') });
    await service.ready;
    const publish = async date => {
        day = date;
        await run('INSERT OR IGNORE INTO daily_puzzles(puzzle_date) VALUES (?)', date);
    };
    await publish(day);
    return { service, publish, all, oldId, advance: date => { day = date; } };
}

const play = (browserId = randomUUID(), date = '2026-11-10', domain = 'reddit.com') => ({
    browserId, puzzleDate: date, source: 'social', turns: ['wrong'], attributionVersion: 3, referrerDomain: domain
});

test('attribution counts started browser rounds and preserves the first country/domain through retries', async t => {
    const { service, publish, all } = await fixture(t);
    const a = play();
    assert.equal(await service.record(a, { country: 'US' }), true);
    await Promise.all([
        service.record({ ...a, turns: ['wrong', 'solve'], referrerDomain: 'google.com' }, { country: 'GB' }),
        service.record(a, { country: 'CA' })
    ]);
    await service.record({ ...play(), turns: Array(6).fill('skip') }, { country: 'US' });
    await service.record(play(randomUUID(), '2026-11-10', ''), { country: '' });
    await service.record({ ...play(), event: 'view', eventId: randomUUID(), turns: undefined }, { country: 'CA' });
    await publish('2026-11-11');
    await service.record({ ...play(a.browserId, '2026-11-11'), turns: ['solve'] }, { country: 'US' });
    const report = await service.summary(2);
    assert.equal(report.attribution.since, '2026-11-10');
    assert.equal(report.attribution.measuredRounds, 4);
    assert.deepEqual(report.attribution.countries, [
        {name:'US', browsers:2, rounds:3, finished:3, solved:2},
        {name:'', browsers:1, rounds:1, finished:0, solved:0}
    ]);
    assert.deepEqual(report.attribution.referrers, [
        {name:'reddit.com', browsers:2, rounds:3, finished:3, solved:2},
        {name:'', browsers:1, rounds:1, finished:0, solved:0}
    ]);
    const stored = await all('SELECT attribution_json FROM analytics_rounds');
    assert.ok(stored.every(row => !row.attribution_json.includes('google.com')));
    assert.ok(!JSON.stringify(report).includes(a.browserId));
    assert.ok(!JSON.stringify(report).includes(createHash('sha256').update(a.browserId).digest('hex')));
});

test('migration and later turns never backfill unmeasured historical rounds', async t => {
    const { service, all, oldId } = await fixture(t, true);
    assert.equal(await service.record({ ...play(oldId), turns: ['wrong','solve'] }, { country: 'US' }), true);
    const oldClient = { browserId: randomUUID(), puzzleDate: '2026-11-10', source: 'direct', turns: ['solve'] };
    assert.equal(await service.record(oldClient, { country:'US' }), true);
    await service.record(play(), {country:'CA'});
    const report = await service.summary(7);
    assert.equal(report.daily.at(-1).started, 3);
    assert.equal(report.attribution.measuredRounds, 1);
    assert.equal(report.trackingSince, '2026-11-04');
    assert.equal(report.attribution.since, '2026-11-10');
    assert.equal((await all('SELECT * FROM analytics_rounds WHERE attribution_json IS NULL')).length, 2);
});

test('only hostname metadata is accepted and country comes from server context', async t => {
    const { service, all } = await fixture(t);
    for (const bad of ['https://reddit.com/private?email=me', 'user@reddit.com', '127.0.0.1', '::1',
        'private.local', 'server.internal', 'localhost', '<script>.com', 'www.reddit.com', 'Reddit.com',
        'a'.repeat(64)+'.com', 'steamdle.com', 'steamdle.onrender.com', null, undefined]) {
        assert.equal(await service.record({...play(), referrerDomain:bad}, {country:'US'}), false, String(bad));
    }
    assert.equal(await service.record({...play(), attributionVersion:2}), false);
    assert.equal(await service.record({...play(), attributionVersion:undefined}), false);
    assert.equal(await service.record({...play(), country:'US'}, {country:'ZZ'}), true);
    assert.equal(await service.record(play(randomUUID(), '2026-11-10', 'xn--bcher-kva.de'), {country:'DE'}), true);
    const stored = (await all('SELECT attribution_json FROM analytics_rounds')).map(row => JSON.parse(row.attribution_json));
    assert.deepEqual(new Set(stored.map(row => row.country)), new Set(['','DE']));
    assert.ok(stored.every(row => Object.keys(row).sort().join() === 'country,referrerDomain'));
});

test('late first delivery preserves the captured domain but cannot locate a past visit', async t => {
    const { service, publish } = await fixture(t);
    await publish('2026-11-11');
    await service.record(play(), {country:'US'});
    const report = await service.summary(2);
    assert.equal(report.attribution.countries[0].name, '');
    assert.equal(report.attribution.referrers[0].name, 'reddit.com');
});

test('return cohorts need seven complete following days and only include attributed first-ever starts', async t => {
    const { service, publish } = await fixture(t);
    const [a,b,existing] = Array.from({length:3}, randomUUID);
    await service.record({browserId:existing, puzzleDate:'2026-11-10', source:'direct', turns:['solve']});
    await service.record(play(a), {country:'US'});
    await publish('2026-11-11');
    await service.record(play(existing, '2026-11-11', 'google.com'), {country:'GB'});
    await service.record(play(b, '2026-11-11', 'google.com'), {country:'GB'});
    await publish('2026-11-17');
    await service.record(play(a, '2026-11-17', ''), {country:'CA'});
    assert.deepEqual((await service.summary(7)).attribution.retention.countries, []);
    await publish('2026-11-18');
    let report = await service.summary(7);
    assert.deepEqual(report.attribution.retention.countries, [{name:'US',eligible:1,returned:1}]);
    assert.deepEqual(report.attribution.retention.referrers, [{name:'reddit.com',eligible:1,returned:1}]);
    await publish('2026-11-19');
    await service.record(play(b, '2026-11-19', ''), {country:'GB'}); // Eight days later does not count.
    report = await service.summary(7);
    assert.deepEqual(report.attribution.retention.countries,
        [{name:'GB',eligible:1,returned:0}, {name:'US',eligible:1,returned:1}]);
});
