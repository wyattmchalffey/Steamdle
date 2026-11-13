const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createArtworkHandler } = require('../artwork-route');

async function withServer(options, run) {
    const app = express();
    app.get('/api/daily-artwork', createArtworkHandler({
        now: () => new Date('2026-11-13T12:00:00Z'), ...options
    }));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try { await run(`http://127.0.0.1:${server.address().port}/api/daily-artwork`); }
    finally { await new Promise(resolve => server.close(resolve)); }
}

test('artwork serves only the current puzzle image with a dated cache key', async () => {
    const calls = [];
    const puzzle = Object.freeze({ appId: '3527290', reviews: Object.freeze([]) });
    await withServer({
        dailyPuzzles: { async forDay(day) { calls.push(day); return puzzle; } },
        artwork: { async get(appId) { calls.push(appId); return {body: Buffer.from('image'), contentType:'image/jpeg'}; } }
    }, async origin => {
        for (const suffix of ['', '?date=2026-11-14', '?date=2026-11-12', '?date[]=2026-11-13']) {
            const response = await fetch(origin + suffix);
            assert.equal(response.status, 404);
            assert.equal(response.headers.get('cache-control'), 'no-store');
        }
        assert.deepEqual(calls, [], 'Other dates cannot fetch a puzzle or its artwork');
        const response = await fetch(origin + '?date=2026-11-13');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/jpeg');
        assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(await response.text(), 'image');
        assert.deepEqual(calls, ['2026-11-13', '3527290']);
        assert.deepEqual(puzzle, {appId:'3527290', reviews:[]});
    });
});

test('unavailable puzzle or artwork fails without caching an empty image or leaking errors', async () => {
    for (const failure of ['no-puzzle', 'no-artwork', 'exception']) {
        await withServer({
            dailyPuzzles: { async forDay() { return failure === 'no-puzzle' ? null : {appId:'3527290'}; } },
            artwork: { async get() { if (failure === 'exception') throw new Error('upstream private detail'); return null; } }
        }, async origin => {
            const response = await fetch(origin + '?date=2026-11-13');
            assert.equal(response.status, 503);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(response.headers.get('retry-after'), '30');
            assert.equal(await response.text(), '');
        });
    }
});
