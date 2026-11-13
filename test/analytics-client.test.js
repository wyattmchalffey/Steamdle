const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { setImmediate: tick } = require('node:timers/promises');

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const origin = 'https://steamdle.com';

function browser(query = '', fetch = async () => ({ ok: true })) {
    const values = new Map();
    return {
        navigator: {}, crypto: webcrypto, location: { href: origin + '/' + query },
        fetch, addEventListener() {}, document: { referrer: '', addEventListener() {} },
        localStorage: {
            get length() { return values.size; }, key(i) { return [...values.keys()][i]; },
            getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); },
            removeItem(key) { values.delete(key); }
        }
    };
}

test('assigns bounded sources and sends only safe campaign slugs', async () => {
    const { sourceForVisit } = await import('../public/analytics.mjs');
    const visit = (source, referrerDomain = '', extra = {}) => ({ source, ...extra, attributionVersion: 3, referrerDomain });
    assert.deepEqual(sourceForVisit(origin, ''), visit('direct'));
    assert.deepEqual(sourceForVisit(origin, origin + '/other?private=value'), visit('direct'));
    assert.deepEqual(sourceForVisit(origin, 'https://www.alldle.net/game/private?q=foo'), visit('directory', 'alldle.net'));
    assert.deepEqual(sourceForVisit(origin, 'https://discord.com.evil.example/'), visit('other', 'discord.com.evil.example'));
    assert.deepEqual(sourceForVisit(origin + '/?utm_source=streamer&utm_campaign=Creator-1', ''), visit('streamer', '', { campaign: 'creator-1' }));
    assert.deepEqual(sourceForVisit(origin + '/?utm_source=secret&utm_campaign=a%40example.com', ''), visit('other'));
});

test('recognizes verified directory referrers and the exact Today\'s Dailies link tag', async () => {
    const { sourceForVisit } = await import('../public/analytics.mjs');
    for (const host of ['dles.aukspot.com', 'todaysdailies.com', 'www.todaysdailies.com',
        'listdle.com', 'www.listdle.com', 'wordleverse.net', 'www.wordleverse.net']) {
        assert.deepEqual(sourceForVisit(origin, `https://${host}/game/steamdle`), {
            source: 'directory', attributionVersion: 3, referrerDomain: host.replace(/^www\./, '')
        });
    }
    // Live link verified at https://todaysdailies.com/game/steamdle on 2026-11-13.
    const link = origin + '/?utm_source=todaysdailies&utm_medium=referral&utm_campaign=game-page';
    assert.deepEqual(sourceForVisit(link, ''), {
        source: 'directory', campaign: 'game-page', attributionVersion: 3, referrerDomain: ''
    });
    assert.equal(sourceForVisit(link.replace('todaysdailies', 'TodaysDailies'), '').source, 'directory');
    assert.equal('campaign' in sourceForVisit(link.replace('game-page', 'a%40example.com'), ''), false);
    for (const host of ['aukspot.com', 'notdles.aukspot.com', 'dles.aukspot.com.evil.example',
        'nottodaysdailies.com', 'todaysdailies.com.evil.example', 'notlistdle.com',
        'listdle.com.evil.example', 'notwordleverse.net', 'wordleverse.net.evil.example']) {
        assert.equal(sourceForVisit(origin, `https://${host}/`).source, 'other', host);
    }
    for (const tag of ['unknown', 'todays-dailies', 'todaysdailies.com']) {
        assert.equal(sourceForVisit(origin + '/?utm_source=' + tag, 'https://todaysdailies.com/').source, 'other');
    }
    assert.equal(sourceForVisit(origin + '/?utm_source=streamer', 'https://todaysdailies.com/').source, 'streamer');
});

test('tracks the first landing, subsequent round sources, and deduplicates acknowledged snapshots', async () => {
    const { createRoundAnalytics } = await import('../public/analytics.mjs');
    const requests = [];
    const client = browser('?utm_source=discord', async (path, options) => {
        assert.equal(path, '/api/analytics');
        assert.equal(options.referrerPolicy, 'no-referrer');
        requests.push(JSON.parse(options.body));
        return { ok: true };
    });
    createRoundAnalytics(client); // first visit leaves without playing
    client.location.href = origin;
    const play = createRoundAnalytics(client);
    assert.equal(requests.length, 0);
    play(yesterday, ['wrong']);
    await tick();
    play(yesterday, ['wrong', 'skip', 'solve']);
    await tick();
    play(yesterday, ['wrong', 'skip', 'solve']);
    createRoundAnalytics(client); // reload neither starts nor finishes the game again
    assert.equal(requests.length, 2);
    client.location.href = origin + '/?utm_source=player_share';
    createRoundAnalytics(client)(today, ['skip']);
    await tick();
    assert.equal(requests.length, 3);
    assert.equal(new Set(requests.map(r => r.browserId)).size, 1);
    assert.match(requests[0].browserId, /^[\da-f-]{36}$/);
    assert.deepEqual(requests[1], {
        browserId: requests[0].browserId, puzzleDate: yesterday, source: 'discord', turns: ['wrong', 'skip', 'solve'],
        attributionVersion: 3, referrerDomain: ''
    });
    assert.equal(requests[2].source, 'player_share');
});

test('coalesces turns during a request and retries an unacknowledged round after reload', async () => {
    const { createRoundAnalytics } = await import('../public/analytics.mjs');
    const calls = [];
    let settle;
    const client = browser('', (url, options) => {
        calls.push(JSON.parse(options.body).turns);
        return new Promise(resolve => { settle = resolve; });
    });
    const play = createRoundAnalytics(client);
    play(today, ['skip']);
    play(today, ['skip', 'wrong']);
    play(today, ['skip', 'wrong', 'solve']);
    assert.deepEqual(calls, [['skip']]);
    settle({ok: true}); await tick();
    assert.deepEqual(calls.at(-1), ['skip','wrong','solve']);
    settle({ok: false}); await tick();
    createRoundAnalytics(client);
    assert.deepEqual(calls, [['skip'], ['skip','wrong','solve'], ['skip','wrong','solve']]);
    settle({ok: true}); await tick();
    createRoundAnalytics(client);
    assert.equal(calls.length, 3);
});

test('restored pre-launch rounds, malformed turns, blocked storage and opted-out browsers do not emit', async () => {
    const { createRoundAnalytics } = await import('../public/analytics.mjs');
    let count = 0;
    const client = browser('', async () => { count++; return {ok: true}; });
    const restored = createRoundAnalytics(client);
    restored(today, ['skip', 'solve']); // first turn predates enrollment
    restored(today, ['an actual title']); // the protocol cannot carry raw guesses
    client.navigator.globalPrivacyControl = true;
    createRoundAnalytics(client)(today, ['skip']);
    client.navigator.globalPrivacyControl = false;
    Object.defineProperty(client, 'localStorage', { get() { throw Error('Storage disabled'); } });
    createRoundAnalytics(client)(today, ['skip']);
    assert.equal(count, 0);
});
