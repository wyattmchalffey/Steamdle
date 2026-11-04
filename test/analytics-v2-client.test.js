const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { setImmediate: tick } = require('node:timers/promises');

const now = new Date().toISOString().slice(0, 10);
const prior = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const root = 'https://steamdle.com';

function fixture() {
    const values = new Map();
    const requests = [];
    const window = {
        location: { href: root }, navigator: {}, crypto: webcrypto,
        document: { referrer: '', addEventListener() {} }, addEventListener() {},
        localStorage: {
            getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k),
            key: i => [...values.keys()][i], get length() { return values.size; }
        },
        fetch: async (url, { body }) => { assert.equal(url, '/api/analytics'); requests.push(JSON.parse(body)); return {ok:true}; }
    };
    return { window, values, requests };
}

test('first visible clue can be recorded without starting, with actual share-link date and a stable event on retry', async () => {
    const {createRoundAnalytics} = await import('../public/analytics.mjs');
    const {window, requests} = fixture();
    window.location.href = root + '/?utm_source=player_share&share_date=' + prior;
    const realFetch = window.fetch;
    window.fetch = async (...args) => { await realFetch(...args); return {ok:false}; };
    const play = createRoundAnalytics(window);
    assert.equal(requests.length, 0);
    play.event(now, 'view');
    await tick();
    assert.equal(requests[0].sharedPuzzle, prior);
    assert.ok(!('turns' in requests[0]));
    window.fetch = realFetch;
    window.location.href = root;
    const again = createRoundAnalytics(window);
    again.event(now, 'view');
    await tick();
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(requests.length, 2);
    again(now, ['skip']);
    await tick();
    assert.equal(requests[2].browserId, requests[0].browserId);
    assert.equal(requests[2].sharedPuzzle, prior);
    assert.equal(requests[2].source, 'player_share');
    assert.equal(requests[2].event, undefined);
    createRoundAnalytics(window).event(now,'view');
    await tick();
    assert.equal(requests.length, 3);
});

test('first acquisition and later actual exposure remain independently measurable', async () => {
    const {createRoundAnalytics, sourceForVisit} = await import('../public/analytics.mjs');
    const {window, requests} = fixture();
    window.location.href = root + '/?utm_source=discord';
    createRoundAnalytics(window).event(prior, 'view');
    await tick();
    window.location.href = root + '/?utm_source=player_share&share_date=' + prior;
    const play=createRoundAnalytics(window);
    play.event(now,'view'); await tick(); play(now,['wrong']); await tick();
    assert.equal(requests[1].source,'player_share');
    assert.equal(requests[1].sharedPuzzle,prior);
    assert.equal(requests[2].source,'discord');
    for (const date of ['2040-01-01','2024-02-31','private-query','2024-05']) {
        assert.deepEqual(sourceForVisit(root+'/?utm_source=player_share&share_date='+date,''),{source:'player_share'});
    }
});

test('search signals contain no text; feedback is a single choice from encountered clues, including None', async () => {
    const {createRoundAnalytics}=await import('../public/analytics.mjs');
    const {window,requests}=fixture();
    window.location.href=root+'/?q=private-text';
    const play=createRoundAnalytics(window);
    play.event(now, 'search_results');
    play.event(now, 'search_pick');
    play.event(now, 'search_empty');
    play.event(now, 'private-text');
    play.event(now, 'feedback', 0);
    assert.deepEqual(requests.map(p=>p.event),['search_results','search_pick','search_empty']);
    assert.equal(JSON.stringify(requests).includes('private-text'),false);
    assert.equal(play.feedback(now),null);
    play(now,['wrong']); await tick();
    assert.equal(play.feedback(now),null);
    play(now,['wrong','solve']); await tick();
    assert.deepEqual(play.feedback(now),{choice:null});
    assert.equal(play.event(now,'feedback',3),false);
    assert.equal(play.event(now,'feedback',0),true);
    await tick();
    assert.deepEqual(play.feedback(now),{choice:0});
    createRoundAnalytics(window).event(now,'feedback',1);
    await tick();
    assert.equal(requests.filter(p=>p.event==='feedback').length,1);
    assert.deepEqual(requests.at(-1).turns,['wrong','solve']);
    assert.equal(requests.at(-1).clue,0);
    play.event(now,'share_copy'); play.event(now,'share_copy'); play.event(now,'share_native'); play.event(now,'share_x');
    const shares = requests.filter(p=>p.event?.startsWith('share_'));
    assert.deepEqual(shares.map(p=>p.event),['share_copy','share_copy','share_native','share_x']);
    assert.equal(new Set(shares.map(p=>p.eventId)).size,4);
});

test('opting out prevents all new tracking and transmission of queued actions', async () => {
    const {createRoundAnalytics}=await import('../public/analytics.mjs');
    const {window,requests}=fixture();
    window.fetch=async (url,opt)=>{requests.push(JSON.parse(opt.body)); return {ok:false};};
    createRoundAnalytics(window).event(now,'search_results');
    await tick();
    window.navigator.globalPrivacyControl=true;
    const optedOut=createRoundAnalytics(window);
    optedOut.event?.(now,'view'); optedOut(now,['solve']); await tick();
    assert.equal(requests.length,1);
});
