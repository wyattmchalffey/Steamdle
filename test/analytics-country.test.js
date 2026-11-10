const test = require('node:test');
const assert = require('node:assert/strict');
const { requestCountry, normalizeCountry, createCountryLookup } = require('../analytics-country');

const render = { RENDER: 'true' };
const request = (headers = {}) => ({get: name => headers[name.toLowerCase()]});
const edge = { 'cf-ray': '9e9963d6393df78c-ORD', 'cf-connecting-ip': '8.8.8.8' };

test('country lookup trusts the Render edge only and never a supplied country or XFF prefix', () => {
    const seen = [];
    const lookup = address => { seen.push(address); return address.includes(':') ? 'GB' : 'US'; };
    assert.equal(requestCountry(request(edge), {}, lookup), '');
    assert.equal(requestCountry(request({'cf-connecting-ip':'8.8.8.8'}), render, lookup), '');
    assert.equal(requestCountry(request({'cf-ray':edge['cf-ray'],'cf-ipcountry':'US','x-forwarded-for':'8.8.8.8'}), render, lookup), '');
    assert.equal(requestCountry(request({...edge,'x-forwarded-for':'1.2.3.4','cf-ipcountry':'FR'}), render, lookup), 'US');
    assert.equal(requestCountry(request({...edge,'cf-connecting-ip':'2001:4860:4860::8888'}), render, lookup), 'GB');
    assert.deepEqual(seen, ['8.8.8.8','2001:4860:4860::8888']);
});

test('country lookup rejects local, reserved, malformed and multi-valued IPs', () => {
    for (const address of ['', 'not-an-ip', '8.8.8.8, 1.1.1.1', '8.8.8.8:443', '192.168.1.1',
        '127.0.0.1', '10.1.2.3', '169.254.1.1', '100.64.0.1', '203.0.113.1', '224.0.0.1',
        '::', '::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1', 'fc00::1', 'fe80::1', '2001:db8::1',
        'fe80::1%eth0', 'ff02::1', '2a06:98c0::103']) {
        assert.equal(requestCountry(request({...edge,'cf-connecting-ip':address}), render,
            () => { assert.fail('lookup must not receive reserved IP'); }), '', address);
    }
    assert.equal(requestCountry(request({...edge,'cf-connecting-ip':'::ffff:8.8.8.8'}), render, () => 'US'), 'US');
    assert.equal(requestCountry(request(edge), render, () => { throw Error('unavailable'); }), '');
});

test('country normalization allows real ISO codes and keeps unknown codes unknown', () => {
    for (const country of ['US','gb','DE','AU','BR','JP']) assert.equal(normalizeCountry(country), country.toUpperCase());
    for (const country of ['XX','T1','EU','ZZ','USA',' US','US ',null,3]) assert.equal(normalizeCountry(country), '');
});

test('country database startup is nonblocking, deduplicated and retries after failure', async () => {
    let clock = 0, calls = 0, finish;
    const country = createCountryLookup(async () => {
        calls++;
        if (calls === 1) throw Error('network unavailable');
        return new Promise(resolve => { finish = () => resolve({lookup: () => ({country:'US'})}); });
    }, () => clock);
    assert.equal(country.lookup('8.8.8.8'), '');
    await country.start(render);
    assert.equal(country.status(), 'unavailable');
    await country.start(render);
    assert.equal(calls, 1);
    clock = 5 * 60000;
    const pending = country.start(render);
    assert.equal(country.start(render), pending);
    assert.equal(country.lookup('8.8.8.8'), '');
    await Promise.resolve();
    finish();
    await pending;
    assert.equal(country.status(), 'ready');
    assert.equal(country.lookup('8.8.8.8'), 'US');
});
