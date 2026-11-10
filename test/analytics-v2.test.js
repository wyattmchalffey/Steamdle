const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');
const { createAnalytics } = require('../analytics');

const start = '2026-11-04';
const next = '2026-11-05';

async function fixture(t) {
    const db = new sqlite3.Database(':memory:');
    const run = promisify(db.run.bind(db));
    t.after(() => promisify(db.close.bind(db))());
    let today = start;
    db.ready = run('CREATE TABLE daily_puzzles (puzzle_date TEXT PRIMARY KEY, puzzle_json TEXT NOT NULL)');
    const service = createAnalytics(db, { now: () => new Date(today + 'T12:00:00Z'), campaigns: ['launch'] });
    await service.ready;
    for (const date of [start, next, '2026-11-06']) {
        const reviews = Array.from({length: 6}, (_, i) => ({ reviewText: 'Clue ' + (i + 1) }));
        await run('INSERT INTO daily_puzzles VALUES (?, ?)', [date, JSON.stringify({title:'Answer ' + date, reviews})]);
    }
    return { service, advance: day => { today = day; } };
}

function browser(source = 'direct', puzzleDate = start) {
    return {browserId: randomUUID(), puzzleDate, source};
}

function event(who, kind, extras = {}) {
    return { ...who, event: kind, eventId: randomUUID(), ...extras };
}

test('activation intersects unique shown browser-days with starts and share links credit the originating date', async t => {
    const {service, advance} = await fixture(t);
    const referrer = browser('streamer');
    const handoff = event(referrer, 'share_native', {turns:['skip','solve']});
    assert.equal(await service.record(handoff), true, 'completion event may precede turn acknowledgement');
    assert.equal(await service.record(handoff), true);
    assert.equal(await service.record(event(referrer, 'share_copy')), true);
    assert.equal(await service.record(event(referrer, 'share_copy')), true, 'separate deliberate action');
    assert.equal(await service.record(event(referrer, 'share_x')), true);
    await service.record(event(referrer, 'view', {campaign:'launch'}));
    await service.record(event(browser('streamer'), 'view', {campaign:'launch'})); // saw it, never played
    await service.record({...browser(), turns:['wrong']}); // v1 start has no impression

    advance(next);
    const friend = { ...browser('player_share', next), sharedPuzzle: start };
    await service.record({...friend,turns:['wrong']});
    let report = await service.summary(2);
    assert.deepEqual(report.views, [{source:'streamer',campaign:'launch',viewed:2,started:1}]);
    assert.deepEqual(report.shares[0], {date:start,copies:2,native:1,x:1,images:0,downloads:0,starts:1});
    const impression = event(friend,'view');
    await Promise.all([service.record(impression), service.record(impression), service.record(event(friend,'view'))]);
    await service.record(event({...friend,source:'social'},'view'));
    await service.record(event(browser('player_share',next),'view',{sharedPuzzle:start})); // never started
    const invalid = browser('player_share',next);
    await service.record(event(invalid,'view',{sharedPuzzle:'2026-11-06'})); // prepared but unpublished
    await service.record({...invalid,turns:['solve']});
    // A first-touch source for the turn can differ from the source of the actual impression.
    const delayed = {...browser('player_share',next),sharedPuzzle:start};
    await service.record({...delayed, turns:['skip']});
    await service.record(event({...delayed,source:'discord'},'view'));
    report = await service.summary(2);
    assert.deepEqual(report.views.find(row=>row.source==='player_share'),
        {source:'player_share',campaign:'',viewed:3,started:2});
    assert.deepEqual(report.views.find(row=>row.source==='discord'),
        {source:'discord',campaign:'',viewed:1,started:1});
    assert.equal(report.shares[0].starts,1);
    assert.equal(report.shares[1].starts,0);
    assert.equal(report.engagementSince,start);
});

test('search and feedback deduplicate independently; finished players can vote only for an encountered clue or None', async t => {
    const {service} = await fixture(t);
    const player = browser();
    const empty = event(player,'search_empty');
    const hit = event(player,'search_results');
    await Promise.all([service.record(hit),service.record(empty),service.record(empty)]);
    await service.record(event(player,'search_pick'));
    assert.equal(await service.record({...empty,eventId:randomUUID(),query:'a raw phrase'}), false);
    assert.equal(await service.record(event(player,'feedback',{clue:1})), false);
    assert.equal(await service.record(event(player,'share_copy')), false);
    assert.equal(await service.record(event(player,'share_native',{turns:['solve'],eventId:[randomUUID()]})), false);
    assert.equal((await service.summary(1)).daily[0].started,0);
    assert.equal(await service.record(event(player,'feedback',{turns:['wrong','solve'],clue:3})),false);
    const vote = event(player,'feedback',{turns:['wrong','solve'],clue:2});
    assert.equal(await service.record(vote),true);
    assert.equal(await service.record(vote),true);
    assert.equal(await service.record(event(player,'feedback',{clue:1})),true); // first choice sticks
    assert.equal(await service.record(event(player,'feedback',{clue:3})),false);
    assert.equal(await service.record(event(browser(),'feedback',{turns:Array(6).fill('wrong'),clue:0})),true);
    const report = await service.summary(1);
    assert.deepEqual(report.feedback,{votes:[0,1,0,0,0,0],none:1});
    assert.deepEqual(report.search,{queries:2,empty:1,selected:1});
    assert.equal(await service.record(event(browser('social',next),'search_empty')),false);
});

test('past puzzle inspection preserves six exact clues and distinguishes wins, six-try losses, and unfinished rounds', async t => {
    const {service,advance} = await fixture(t);
    for (const turns of [['solve'],['wrong','skip','solve'],[...Array(5).fill('skip'),'solve'],Array(6).fill('wrong'),['wrong']]) {
        await service.record({...browser(),turns});
    }
    assert.equal(await service.puzzleReview(start),null);
    assert.equal(await service.puzzleReview(next),null);
    assert.equal(await service.puzzleReview('2019-01-01'),null);
    assert.deepEqual((await service.summary(7)).puzzles,[]);
    advance(next);
    const [row] = (await service.summary(7)).puzzles;
    assert.deepEqual(row, {date:start,title:'Answer '+start, started:5, solves:[1,0,1,0,0,1], losses:1,unfinished:1});
    const detail = await service.puzzleReview(start);
    assert.deepEqual(detail.solves,row.solves);
    assert.equal(detail.clues[1].unanswered,1);
    assert.equal(detail.reviews.length,6);
    assert.equal(detail.reviews[5].reviewText,'Clue 6');
    assert.deepEqual(detail.feedback,{votes:[0,0,0,0,0,0],none:0});
    assert.equal(await service.puzzleReview(next),null);
    advance('2026-11-06');
    assert.equal((await service.summary(7)).puzzles[0].started,0,'closed zero-play puzzles are reviewable');
    assert.equal(await service.puzzleReview('2026-11-06'),null);
});

test('upgrading a v1 database preserves historical difficulty without manufacturing v2 observations', async t => {
    const db = new sqlite3.Database(':memory:');
    t.after(() => promisify(db.close.bind(db))());
    db.ready = promisify(db.exec.bind(db))(`
        CREATE TABLE daily_puzzles(puzzle_date TEXT PRIMARY KEY, puzzle_json TEXT);
        INSERT INTO daily_puzzles VALUES ('2026-11-04','{"title":"Old puzzle","reviews":[]}');
        CREATE TABLE analytics_metadata(id INTEGER PRIMARY KEY, tracking_since TEXT NOT NULL);
        INSERT INTO analytics_metadata VALUES(1,'2026-11-04');
        CREATE TABLE analytics_rounds(browser_key TEXT, puzzle_date TEXT, source TEXT, campaign TEXT, turns TEXT,
                                    PRIMARY KEY(browser_key, puzzle_date)) WITHOUT ROWID;
        INSERT INTO analytics_rounds VALUES('old-browser','2026-11-04','direct','','KWS');
    `);
    const service = createAnalytics(db, {now: () => new Date(next + 'T12:00Z')});
    const report = await service.summary(7);
    assert.equal(report.trackingSince, start);
    assert.equal(report.engagementSince, next);
    assert.deepEqual(report.puzzles[0].solves,[0,0,1,0,0,0]);
    assert.deepEqual(report.shares.map(row=>row.date),[next]);
    assert.equal(report.views.length,0);
    assert.equal((await service.puzzleReview(start)).engagementSince,next);
    assert.equal(await service.record(event(browser(),'view')),false);
    assert.equal(await service.record({...browser(),turns:['solve']}),true); // old queued v1 start can still arrive
});
