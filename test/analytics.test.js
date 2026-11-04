const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');
const { createAnalytics } = require('../analytics');

async function setup(t, start = '2026-11-04') {
    const db = new sqlite3.Database(':memory:');
    t.after(() => promisify(db.close.bind(db))());
    const run = promisify(db.run.bind(db));
    db.ready = run('CREATE TABLE daily_puzzles (puzzle_date TEXT PRIMARY KEY)');
    let day = start;
    const service = createAnalytics(db, { now: () => new Date(day + 'T12:00:00Z'), campaigns: ['channel-one'] });
    await service.ready;
    async function publish(date) {
        day = date;
        await run('INSERT OR IGNORE INTO daily_puzzles(puzzle_date) VALUES (?)', date);
    }
    await publish(start);
    return { db, service, publish };
}

test('round snapshots deduplicate, never overwrite a prefix or its source, and correctly count clue outcomes', async t => {
    const { db, service } = await setup(t);
    const a = { browserId: randomUUID(), puzzleDate: '2026-11-04', source: 'streamer', campaign: 'channel-one', turns: ['skip'] };
    await service.record(a);
    const win = ['skip', 'wrong', 'solve'];
    await Promise.all([
        service.record({ ...a, turns: win }), service.record(a),
        service.record({ ...a, browserId: a.browserId.toUpperCase(), turns: ['skip', 'wrong'] })
    ]);
    await service.record({ ...a, source: 'social', turns: ['skip', 'wrong', 'wrong', 'skip'] });
    await service.record({ ...a, browserId: randomUUID(), source: 'social', campaign: 'not-approved', turns: Array(6).fill('wrong') });
    await service.record({ ...a, browserId: randomUUID(), source: 'direct', campaign: '' });

    const report = await service.summary(1);
    assert.deepEqual(report.daily, [{ date: '2026-11-04', started: 3, finished: 2, solved: 1 }]);
    assert.deepEqual(report.clues.slice(0,3), [
        { clue: 1, reached: 3, wrong: 1, skipped: 2, solved: 0, unanswered: 0 },
        { clue: 2, reached: 3, wrong: 2, skipped: 0, solved: 0, unanswered: 1 },
        { clue: 3, reached: 2, wrong: 1, skipped: 0, solved: 1, unanswered: 0 }
    ]);
    assert.equal(report.clues[5].wrong, 1);
    assert.deepEqual(report.campaigns, ['channel-one']);
    assert.ok(report.sources.some(row => row.source === 'streamer' && row.campaign === 'channel-one' && row.starters === 1));
    assert.equal(report.sources.find(row => row.source === 'social').campaign, '');
    const stored = await promisify(db.get.bind(db))("SELECT * FROM analytics_rounds WHERE source='streamer'");
    assert.equal(stored.turns, 'KWS');
    assert.match(stored.browser_key, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(report).includes(stored.browser_key));
});

test('first-source cohorts use seven complete following UTC dates and count returning visitors once', async t => {
    const { service, publish } = await setup(t, '2026-10-20');
    const [a,b,c,existing] = Array.from({ length: 4 }, () => randomUUID());
    async function play(browserId, date, source) {
        await publish(date);
        assert.equal(await service.record({ browserId, puzzleDate: date, source, turns: ['wrong'] }), true);
    }
    await play(existing, '2026-10-20', 'search');
    await play(a, '2026-10-22', 'discord');
    await play(b, '2026-10-23', 'discord');
    await play(existing, '2026-10-25', 'discord');
    await play(existing, '2026-10-26', 'discord');
    await play(c, '2026-10-28', 'discord'); // Nov 4 hasn't ended; exclude from the mature denominator.
    await play(a, '2026-10-29', 'direct'); // Exactly seven days after first play.
    await play(b, '2026-10-31', 'direct'); // Eight days after first play.
    await play(c, '2026-11-02', 'direct');
    await publish('2026-11-04');

    const report = await service.summary(14);
    assert.equal(report.trackingSince, '2026-10-20');
    assert.equal(report.startDate, '2026-10-22');
    assert.equal(report.daily.length, 14);
    assert.deepEqual(report.daily.at(-1), { date: '2026-11-04', started: 0, finished: 0, solved: 0 });
    assert.deepEqual(report.sources.find(row => row.source === 'discord'), {
        source: 'discord', campaign: '', starters: 4, rounds: 5, newBrowsers: 3
    });
    assert.equal(report.sources.find(row => row.source === 'direct').newBrowsers, 0);
    assert.equal(report.retention.startDate, '2026-10-14');
    assert.equal(report.retention.endDate, '2026-10-27');
    assert.deepEqual(report.retention.sources.find(row => row.source === 'discord'), {
        source: 'discord', campaign: '', eligible: 2, returned: 1
    });
    const week = await service.summary(7);
    assert.equal(week.retention.startDate, '2026-10-21');
    assert.equal(week.retention.sources.length, 1);
    assert.deepEqual(week.retention.sources, [{ source: 'discord', campaign: '', eligible: 2, returned: 1 }]);
});

test('only accepts published, recent rounds since tracking began and six or fewer valid outcomes', async t => {
    const { service, publish } = await setup(t);
    const valid = { browserId: randomUUID(), puzzleDate: '2026-11-04', source: 'directory', turns: ['wrong'] };
    for (const report of [
        {}, null, { ...valid, browserId: 'some identifier' }, { ...valid, source: 'arbitrary source' },
        { ...valid, turns: [] }, { ...valid, turns: ['raw typed guess'] }, { ...valid, turns: ['solve','skip'] },
        { ...valid, turns: Array(7).fill('skip') }, { ...valid, puzzleDate: '2026-11-05' },
        { ...valid, puzzleDate: '2026-11-03' }
    ]) assert.equal(await service.record(report), false);
    await publish('2026-11-10');
    assert.equal(await service.record(valid), true, 'six-day retry is accepted');
    assert.equal(await service.record({ ...valid, puzzleDate: '2026-11-09' }), false, 'unpublished day');
    await publish('2026-11-11');
    assert.equal(await service.record(valid), false, 'older than retry window');
    await assert.rejects(service.summary(500), RangeError);
});

test('owner-approved campaigns persist, govern future attribution, and have one shared cap across connections', async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'steamdle-stats-'));
    const file = path.join(dir, 'analytics.sqlite');
    const connections = [];
    function open() {
        const db = new sqlite3.Database(file);
        connections.push(db);
        const now = () => new Date('2026-11-04T12:00Z');
        return { db, service: createAnalytics(db, { now, campaigns: [] }) };
    }
    async function closeAll() {
        await Promise.all(connections.splice(0).map(db => promisify(db.close.bind(db))()));
    }
    t.after(async () => {
        await closeAll();
        await rm(dir, { recursive: true, force: true });
    });
    const first = open();
    await first.service.ready;
    const second = open();
    await second.service.ready;
    await promisify(first.db.exec.bind(first.db))(`
        CREATE TABLE daily_puzzles(puzzle_date TEXT PRIMARY KEY);
        INSERT INTO daily_puzzles VALUES ('2026-11-04');`);
    const play = () => second.service.record({ browserId: randomUUID(), source: 'streamer',
        campaign: 'indie-night', puzzleDate: '2026-11-04', turns: ['wrong'] });
    assert.equal(await play(), true);
    for (const bad of ['', 'a--b', 'name@domain', '<html>', 'a'.repeat(41)]) {
        assert.equal(await first.service.addCampaign(bad), false);
    }
    assert.equal(await first.service.addCampaign('indie-night'), true);
    assert.equal(await play(), true, 'another process immediately recognizes a new campaign');
    const report = await second.service.summary();
    assert.deepEqual(report.sources.map(row => [row.campaign, row.rounds]), [['', 1], ['indie-night', 1]]);

    for (let i = 0; i < 62; i++) assert.equal(await first.service.addCampaign('test-' + i), true);
    const race = await Promise.all([first.service.addCampaign('last-slot-one'), second.service.addCampaign('last-slot-two')]);
    assert.deepEqual(race.sort(), [false, true]);
    assert.equal(await first.service.addCampaign('indie-night'), true, 'approval remains idempotent at capacity');
    await closeAll();
    const reopened = open().service;
    const campaigns = (await reopened.summary()).campaigns;
    assert.equal(campaigns.length, 64);
    assert.deepEqual(campaigns, [...campaigns].sort());
    assert.ok(campaigns.includes('indie-night'));
    assert.equal(await reopened.addCampaign('overflow'), false);
});
