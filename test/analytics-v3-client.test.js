const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { setImmediate: tick } = require('node:timers/promises');

const origin = 'https://steamdle.com';
const today = new Date().toISOString().slice(0, 10);
const prior = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const prefix = 'steamdle.analytics.v1.';
const events = 'steamdle.analytics.v2.event.';

function fixture(values = new Map()) {
    const requests = [];
    const browser = {
        location: { href: origin }, navigator: {}, crypto: webcrypto,
        document: { referrer: '', addEventListener() {} }, addEventListener() {},
        localStorage: {
            getItem: key => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, value),
            removeItem: key => values.delete(key), key: index => [...values.keys()][index],
            get length() { return values.size; }
        },
        fetch: async (url, options) => {
            assert.equal(url, '/api/analytics');
            assert.equal(options.referrerPolicy, 'no-referrer');
            requests.push(JSON.parse(options.body));
            return { ok: true };
        }
    };
    return { browser, values, requests };
}

test('referrer attribution stores only normalized external website domains', async () => {
    const { sourceForVisit } = await import('../public/analytics.mjs');
    const visit = sourceForVisit(origin, 'https://WWW.Example.COM.:8443/member/private?email=secret#token');
    assert.equal(visit.referrerDomain, 'example.com');
    assert.equal(visit.attributionVersion, 3);
    assert.equal(JSON.stringify(visit).includes('secret'), false);
    for (const referrer of [
        '', 'broken', 'file:///private/file.html', 'ftp://example.com/file',
        'https://username:secret@example.com/private', 'http://127.0.0.1/private',
        'http://2130706433/private', 'http://[::1]/private', 'http://localhost/',
        'https://router.local/', 'https://app.internal/', 'http://office/',
        'https://printer.home.arpa/', 'https://app.invalid/', 'http://app.test/',
        'https://www.steamdle.com/private', 'https://steamdle.onrender.com/private',
        'https://steamdle.com/private'
    ]) assert.equal(sourceForVisit(origin, referrer).referrerDomain, '', referrer);
    assert.equal(sourceForVisit('https://preview.example.com', 'https://www.preview.example.com/path').referrerDomain, '');
    assert.equal(sourceForVisit(origin + '/?utm_source=streamer', 'https://www.youtube.com/watch?private=x').referrerDomain, 'youtube.com');
});

test('first acquisition, later round arrivals and saved retries keep their original domains', async () => {
    const { createRoundAnalytics } = await import('../public/analytics.mjs');
    const { browser, requests, values } = fixture();
    browser.document.referrer = 'https://www.alldle.net/private?secret=one';
    createRoundAnalytics(browser); // first visit leaves without playing
    browser.document.referrer = 'https://reddit.com/private?secret=two';
    const first = createRoundAnalytics(browser);
    first(prior, ['solve']);
    await tick();
    assert.equal(requests.at(-1).referrerDomain, 'alldle.net');
    assert.equal(requests.at(-1).source, 'directory');

    const realFetch = browser.fetch;
    browser.fetch = async (...args) => { await realFetch(...args); return { ok: false }; };
    first.event(today, 'view');
    first(today, ['skip']);
    await tick();
    const initial = requests.filter(request => request.puzzleDate === today);
    assert.equal(initial.length, 2);
    assert.ok(initial.every(request => request.referrerDomain === 'reddit.com' && request.attributionVersion === 3));
    browser.document.referrer = 'https://google.com/private?secret=three';
    browser.fetch = realFetch;
    const again = createRoundAnalytics(browser);
    await tick();
    const retried = requests.slice(-2);
    assert.ok(retried.every(request => request.referrerDomain === 'reddit.com'));
    again(today, ['skip', 'solve']);
    await tick();
    again.event(today, 'share_copy');
    await tick();
    assert.ok(requests.slice(-2).every(request => request.referrerDomain === 'reddit.com'));
    assert.equal(JSON.stringify([...values]).includes('secret'), false);
    assert.equal(JSON.stringify(requests).includes('private'), false);
});

test('old rounds, events and first visits never acquire a referrer from a later visit', async () => {
    const { createRoundAnalytics } = await import('../public/analytics.mjs');
    const { browser, values, requests } = fixture();
    const browserId = webcrypto.randomUUID();
    values.set(prefix + 'browser', browserId);
    values.set(prefix + 'round.' + today, JSON.stringify({ source: 'other', turns: ['wrong'] }));
    values.set(events + today + '.view', JSON.stringify({
        browserId, puzzleDate: today, source: 'other', event: 'view', eventId: webcrypto.randomUUID()
    }));
    browser.document.referrer = 'https://reddit.com/private';
    const play = createRoundAnalytics(browser);
    await tick();
    play(today, ['wrong', 'solve']);
    await tick();
    play.event(today, 'share_copy');
    await tick();
    assert.equal(requests.length, 4);
    assert.ok(requests.every(request => !('attributionVersion' in request) && !('referrerDomain' in request)));

    const legacy = fixture();
    legacy.values.set(prefix + 'firstVisit', JSON.stringify({ source: 'directory' }));
    legacy.browser.document.referrer = 'https://google.com/';
    createRoundAnalytics(legacy.browser)(today, ['skip']);
    await tick();
    assert.equal(legacy.requests[0].source, 'directory');
    assert.equal('attributionVersion' in legacy.requests[0], false);
    assert.equal('referrerDomain' in legacy.requests[0], false);
});

test('simultaneous tabs preserve the round that enrolled first', async () => {
    const { createRoundAnalytics } = await import('../public/analytics.mjs');
    const shared = new Map();
    const first = fixture(shared), second = fixture(shared);
    const waiting = [];
    const locks = { request: (key, run) => new Promise(resolve => waiting.push(() => resolve(run()))) };
    first.browser.navigator.locks = locks;
    second.browser.navigator.locks = locks;
    first.browser.document.referrer = 'https://alldle.net/';
    second.browser.document.referrer = 'https://reddit.com/';
    const playFirst = createRoundAnalytics(first.browser);
    const playSecond = createRoundAnalytics(second.browser);
    playFirst(today, ['skip']);
    playSecond(today, ['solve']);
    assert.equal(waiting.length, 2);
    waiting.shift()();
    await tick();
    waiting.shift()();
    await tick();
    const saved = JSON.parse(shared.get(prefix + 'round.' + today));
    assert.equal(saved.referrerDomain, 'alldle.net');
    assert.deepEqual(saved.turns, ['skip']);
    assert.ok([...first.requests, ...second.requests].every(request => request.referrerDomain === 'alldle.net'));
});
