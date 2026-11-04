const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createStatsRoutes } = require('../stats-routes');
const owner = require('../stats-owner.json');

async function server(t, data, env) {
    const app = express();
    app.use(createStatsRoutes(data, env));
    const handle = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    t.after(() => new Promise(resolve => handle.close(resolve)));
    return 'http://127.0.0.1:' + handle.address().port;
}

test('owner data needs a real session, which is private, revocable and independent of the verifier', async t => {
    const calls = [];
    const key = 'test'.repeat(10);
    const data = { async addCampaign(slug) { return slug === 'test-creator'; }, async summary(days) {
        calls.push(days);
        return { today: '2026-11-04', startDate: '2026-11-04', endDate: '2026-11-04', trackingSince: '2026-11-04',
            days, daily: [], clues: [], sources: [], retention: {startDate:'2026-10-28', endDate:'2026-10-28', sources:[]} };
    }};
    const url = await server(t, data, {STEAMDLE_STATS_KEY: key, NODE_ENV:'production'});
    const get = (path, headers={}) => fetch(url + path, { headers, redirect:'manual' });
    const post = (path, value, headers={}) => fetch(url + path, {
        method:'POST', redirect:'manual', headers, body:new URLSearchParams({key:value})
    });

    const loggedOut = await get('/stats');
    assert.match(await loggedOut.text(), /Owner key/);
    assert.match(loggedOut.headers.get('cache-control'), /no-store/);
    assert.equal((await post('/stats/campaign', '')).status, 401);
    assert.equal((await post('/stats/login', owner.keySha256)).status, 401);
    assert.equal((await post('/stats/login', key, {Origin:'https://external.example'})).status, 403);
    assert.deepEqual(calls, []);
    const login = await post('/stats/login', key, {Origin:url});
    assert.equal(login.status, 303);
    const setCookie = login.headers.get('set-cookie');
    for (const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/stats']) assert.ok(setCookie.includes(flag));
    assert.ok(!setCookie.includes(key));
    const session = {Cookie:setCookie.split(';')[0]};
    assert.match(await (await get('/stats?days=30', session)).text(), /Clue outcomes/);
    const campaign = await fetch(url+'/stats/campaign', {method:'POST',redirect:'manual',headers:session,
        body:new URLSearchParams({campaign:'test-creator',days:'30'})});
    assert.equal(campaign.status,303);
    assert.equal(campaign.headers.get('location'),'/stats?days=30&campaign=test-creator#outreach');
    assert.deepEqual(calls, [30]);
    assert.equal((await post('/stats/logout', '', session)).status, 303);
    assert.match(await (await get('/stats', session)).text(), /Owner key/);
    const fork = await server(t, data, {RENDER_EXTERNAL_HOSTNAME:'someone-else.onrender.com'});
    assert.equal((await fetch(fork+'/stats/login', {method:'POST',body:new URLSearchParams({key})})).status,503);
});

test('analytics accepts same-site JSON, honors opt-out and rejects foreign or oversized writes', async t => {
    const saved = [];
    const url = await server(t, { async record(payload) { saved.push(payload); return true; } }, {});
    const post = (extra, body='{}') => fetch(url+'/api/analytics', {method:'POST',
        headers:{'Content-Type':'application/json',...extra},body});
    assert.equal((await post({Origin:'null'})).status, 403);
    assert.equal((await post({'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await post({'Content-Type':'text/plain'})).status,415);
    assert.equal((await post({}, '{')).status,400);
    assert.equal((await post({}, JSON.stringify({x:'a'.repeat(1500)}))).status,413);
    assert.equal((await post({'Sec-GPC':'1'})).status,204);
    assert.equal((await post({DNT:'1'})).status,204);
    assert.equal(saved.length,0);
    assert.equal((await post({Origin:url})).status,204);
    assert.deepEqual(saved,[{}]);
});
