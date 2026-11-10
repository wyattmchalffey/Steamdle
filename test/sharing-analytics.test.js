const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');
const cheerio = require('cheerio');
const { createAnalytics } = require('../analytics');
const { renderStats } = require('../admin-stats');

async function fixture(t) {
    const db = new sqlite3.Database(':memory:');
    t.after(() => promisify(db.close.bind(db))());
    const run = promisify(db.run.bind(db));
    let day = '2026-11-10';
    db.ready = promisify(db.exec.bind(db))(`
        CREATE TABLE daily_puzzles(puzzle_date TEXT PRIMARY KEY, puzzle_json TEXT DEFAULT '{}');
        CREATE TABLE analytics_metadata(id INTEGER PRIMARY KEY, tracking_since TEXT NOT NULL);
        INSERT INTO analytics_metadata VALUES(1,'2026-11-04');
        CREATE TABLE analytics_coverage(version INTEGER PRIMARY KEY, since TEXT NOT NULL);
        INSERT INTO analytics_coverage VALUES(2,'2026-11-04');
    `);
    const service = createAnalytics(db, {now: () => new Date(day + 'T12:00Z')});
    await service.ready;
    async function publish(date) {
        day = date;
        await run('INSERT OR IGNORE INTO daily_puzzles(puzzle_date) VALUES(?)', date);
    }
    await publish(day);
    return { service, publish };
}

function player(puzzleDate = '2026-11-10', source = 'direct', browserId = randomUUID()) {
    return {browserId, puzzleDate, source};
}
const event = (who, name, extra = {}) => ({...who, event:name, eventId:randomUUID(), ...extra});

test('sharing participation deduplicates browsers while counting image downloads separately', async t => {
    const {service} = await fixture(t);
    const first = player(), second = player(), downloader = player(), unfinished = player();
    await service.record({...first, turns:['solve']});
    await service.record({...second, turns:Array(6).fill('skip')});
    await service.record({...downloader, turns:['wrong','solve']});
    await service.record({...unfinished, turns:['wrong']});
    const image = event(first, 'share_image');
    assert.equal(await service.record(image), true);
    assert.equal(await service.record(image), true);
    await service.record(event(first, 'share_copy'));
    await service.record(event(first, 'share_copy'));
    await service.record(event(first, 'share_native'));
    await service.record(event(second, 'share_x'));
    await service.record(event(downloader, 'share_download'));
    await service.record(event(downloader, 'share_download'));
    assert.equal(await service.record(event(unfinished, 'share_download')), false);
    assert.equal(await service.record(event(unfinished, 'share_image')), false);
    const report = await service.summary(1);
    assert.deepEqual(report.shareActivity, [{date:'2026-11-10', finished:3, sharers:2}]);
    assert.deepEqual(report.shares, [{date:'2026-11-10', copies:2, native:1, x:1, images:1, downloads:2, starts:0}]);
    assert.equal(report.sharingSince, '2026-11-10');
});

test('referred round completion and next-day returns use played dates and fully observed following days', async t => {
    const {service, publish} = await fixture(t);
    const [a,b,c,d] = Array.from({length:4}, () => randomUUID());
    const referred = player('2026-11-10', 'player_share', a);
    await service.record({...referred, sharedPuzzle:'2026-11-10', turns:['solve']});
    await service.record({...player('2026-11-10','player_share',b), turns:['wrong']});
    // Actual view attribution identifies a referral even if first acquisition came elsewhere.
    const actualReferral = player('2026-11-10', 'discord', c);
    await service.record(event({...actualReferral,source:'player_share'}, 'view'));
    await service.record({...actualReferral, turns:Array(6).fill('skip')});
    // Conversely, an actual non-share view overrides an earlier acquisition tag.
    const oldReferral = player('2026-11-10', 'player_share', d);
    await service.record(event({...oldReferral,source:'search'}, 'view'));
    await service.record({...oldReferral, turns:['solve']});
    let report = await service.summary(1);
    assert.deepEqual(report.referralOutcomes, [{date:'2026-11-10',started:3,finished:2,eligible:0,returned:0}]);
    await publish('2026-11-11');
    await service.record({...player('2026-11-11','direct',a), turns:['skip']});
    await service.record({...player('2026-11-11','search',c), turns:['solve']});
    report = await service.summary(2);
    assert.equal(report.referralOutcomes[0].eligible, 0, 'following day has not ended');
    await publish('2026-11-12');
    await service.record({...player('2026-11-12','direct',b), turns:['solve']});
    await service.record({...player('2026-11-12','player_share'), turns:['solve']});
    report = await service.summary(3);
    assert.deepEqual(report.referralOutcomes, [
        {date:'2026-11-12',started:1,finished:1,eligible:0,returned:0},
        {date:'2026-11-10',started:3,finished:2,eligible:3,returned:2}
    ]);
    assert.equal(report.shares.find(row=>row.date==='2026-11-10').starts,1, 'origin-date attribution remains separate');
    await publish('2026-11-19');
    report = await service.summary(10);
    assert.equal(report.referralOutcomes.find(row=>row.date==='2026-11-10').returned,2, 'history lookups survive the client retry window');
});

test('existing sharing history yields participation without inventing old image measurements', async t => {
    const {service,publish} = await fixture(t);
    await publish('2026-11-04');
    const old = player('2026-11-04');
    await service.record({...old,turns:['solve']});
    await service.record(event(old,'share_copy'));
    assert.equal(await service.record(event(old,'share_image')),false);
    assert.equal(await service.record(event(old,'share_download')),false);
    await publish('2026-11-10');
    const report=await service.summary(7);
    assert.equal(report.shareActivity[0].sharers,1);
    assert.equal(report.sharingSince,'2026-11-10');
    const $=cheerio.load(renderStats(report));
    const cells=$('table[aria-label="Result sharing by originating puzzle"] tbody tr').first().find('td').map((_,el)=>$(el).text()).get();
    assert.equal(cells[3],'—');
    assert.equal(cells[4],'—');
    assert.match($('#sharing').text(),/Image sharing and download tracking began 2026-11-10/);
});

test('dashboard separates downloads, distinct sharers and mature referral denominators', async t => {
    const {service}=await fixture(t);
    const report=await service.summary(1);
    report.shares=[{date:'2026-11-10',copies:1,native:1,x:0,images:1,downloads:20,starts:6}];
    report.shareActivity=[{date:'2026-11-10',finished:10,sharers:2}];
    report.referralOutcomes=[
        {date:'2026-11-10',started:3,finished:2,eligible:0,returned:0},
        {date:'2026-11-08',started:4,finished:3,eligible:4,returned:2}
    ];
    const $=cheerio.load(renderStats(report));
    assert.equal($('table[aria-label="Result sharing by originating puzzle"] tbody tr td').last().text(),'2.00');
    assert.equal($('table[aria-label="Daily sharing participation"] tbody tr td').last().text(),'20%');
    const rows=$('table[aria-label="Shared-link round outcomes"] tbody tr');
    assert.equal(rows.first().find('td').last().text(),'—');
    assert.equal(rows.last().find('td').last().text(),'2 (50%)');
    assert.match($('#sharing').text(),/today and yesterday are still pending/);
});
