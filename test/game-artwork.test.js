const test = require('node:test');
const assert = require('node:assert/strict');
const { createGameArtwork } = require('../game-artwork');

const appId = '3527290';
const header = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/a1b2c3d4/header.jpg?t=1794000000`;
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);
const metadata = (url = header, id = appId) => Response.json({
    [appId]: { success: true, data: { steam_appid: Number(id), header_image: url } }
});
const image = () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });

test('uses the verified metadata artwork URL including asset hash and query, with bounded requests', async () => {
    const calls = [];
    const artwork = createGameArtwork({ fetch: async (url, options) => {
        calls.push(url);
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        return calls.length === 1 ? metadata() : image();
    } });
    const result = await artwork.get(appId);
    assert.deepEqual(calls, [
        `https://store.steampowered.com/api/appdetails?appids=${appId}&l=english`, header
    ]);
    assert.equal(result.contentType, 'image/jpeg');
    assert.ok(Buffer.isBuffer(result.body));
    assert.deepEqual(result.body, jpeg);
});

test('deduplicates concurrent requests, caches success for 24 hours, then refreshes', async () => {
    let clock = 0, calls = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const artwork = createGameArtwork({ now: () => clock, fetch: async url => {
        calls++;
        if (url.includes('/api/appdetails')) { await gate; return metadata(); }
        return image();
    } });
    const first = artwork.get(appId), second = artwork.get(Number(appId));
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    assert.equal(calls, 2);
    clock = 24 * 60 * 60 * 1000 - 1;
    assert.equal(await artwork.get(appId), a);
    assert.equal(calls, 2);
    clock++;
    assert.deepEqual(await artwork.get(appId), a);
    assert.equal(calls, 4);
});

test('rejects malformed IDs and untrusted or wrong-app artwork without fetching the image', async () => {
    const artwork = createGameArtwork({ fetch: () => assert.fail('Invalid IDs must not fetch') });
    for (const id of [null, undefined, {}, '', '0', '01', '../123', 1.5, -1, Infinity, '1&other=2', '1'.repeat(20)])
        assert.equal(await artwork.get(id), null);
    const rejected = [
        header.replace('https:', 'http:'),
        header.replace('shared.akamai.steamstatic.com', 'shared.akamai.steamstatic.com.evil.test'),
        header.replace('shared.akamai.steamstatic.com', '127.0.0.1'),
        header.replace('https://', 'https://user:pass@'),
        header.replace('.com/', '.com:444/'),
        header.replace(`/apps/${appId}/`, '/apps/999/'),
        header.replace('header.jpg', 'header.svg'),
        header.replace('/a1b2c3d4/', '/%2f../'),
        'data:image/jpeg;base64,abc'
    ];
    for (const url of rejected) {
        let calls = 0;
        const lookup = createGameArtwork({ fetch: async () => { calls++; return metadata(url); } });
        assert.equal(await lookup.get(appId), null, url);
        assert.equal(calls, 1);
    }
    let calls = 0;
    const mismatch = createGameArtwork({ fetch: async () => { calls++; return metadata(header, '999'); } });
    assert.equal(await mismatch.get(appId), null);
    assert.equal(calls, 1);
});

test('network errors fail softly and are retried after a short negative cache', async () => {
    let clock = 0, calls = 0;
    const artwork = createGameArtwork({ now: () => clock, fetch: async url => {
        calls++;
        if (calls === 1) throw new Error('Steam unavailable');
        return url.includes('/api/appdetails') ? metadata() : image();
    } });
    assert.equal(await artwork.get(appId), null);
    clock = 29999;
    assert.equal(await artwork.get(appId), null);
    assert.equal(calls, 1);
    clock = 30000;
    assert.deepEqual((await artwork.get(appId)).body, jpeg);
    assert.equal(calls, 3);
});

test('rejects oversized streamed bodies, unsupported types and mislabeled image data', async () => {
    let canceled = false;
    const tooLarge = new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { canceled = true; }
    });
    const cases = [
        new Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': String(3 * 1024 * 1024) } }),
        new Response(tooLarge, { headers: { 'content-type': 'image/jpeg' } }),
        new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
        new Response('<html>not an image</html>', { headers: { 'content-type': 'image/jpeg' } }),
        new Response(null, { status: 404 })
    ];
    for (const response of cases) {
        const artwork = createGameArtwork({ fetch: async url => url.includes('/api/appdetails') ? metadata() : response });
        assert.equal(await artwork.get(appId), null);
    }
    assert.equal(canceled, true, 'Streaming must stop when the byte limit is crossed');
});

test('bounded LRU cache keeps only eight entries and refreshes the evicted game', async () => {
    let calls = 0;
    const artwork = createGameArtwork({ fetch: async url => {
        calls++;
        if (!url.includes('/api/appdetails')) return image();
        const id = new URL(url).searchParams.get('appids');
        return Response.json({ [id]: { success: true, data: { steam_appid: Number(id),
            header_image: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg` } } });
    } });
    for (let id = 1; id <= 8; id++) assert.ok(await artwork.get(id));
    await artwork.get(1); // Recently used entry survives insertion of the ninth.
    await artwork.get(9);
    assert.equal(calls, 18);
    await artwork.get(1);
    assert.equal(calls, 18);
    await artwork.get(2);
    assert.equal(calls, 20);
});
