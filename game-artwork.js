const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 512 * 1024;
const SUCCESS_TTL = 24 * 60 * 60 * 1000;
const FAILURE_TTL = 30 * 1000;
const MAX_CACHE_ENTRIES = 8;
const CDN_HOSTS = new Set([
    'shared.akamai.steamstatic.com', 'shared.cloudflare.steamstatic.com', 'shared.fastly.steamstatic.com',
    'cdn.akamai.steamstatic.com', 'cdn.cloudflare.steamstatic.com', 'cdn.fastly.steamstatic.com',
    'shared.steamstatic.com', 'cdn.steamstatic.com', 'steamcdn-a.akamaihd.net'
]);

function artworkUrl(value, appId) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        const path = new RegExp(`^/(?:store_item_assets/)?steam/apps/${appId}/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+\\.(?:jpe?g|png|webp)$`, 'i');
        return url.protocol === 'https:' && CDN_HOSTS.has(url.hostname) && !url.username && !url.password &&
            !url.port && !url.hash && path.test(url.pathname) ? url.href : null;
    } catch { return null; }
}

async function boundedBody(response, maximum) {
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Artwork response unavailable');
    }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
        await response.body.cancel();
        throw new Error('Artwork response exceeds size limit');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maximum) throw new Error('Artwork response exceeds size limit');
        chunks.push(Buffer.from(chunk));
    }
    if (!size) throw new Error('Artwork response is empty');
    return Buffer.concat(chunks, size);
}

function isImage(body, contentType) {
    if (contentType === 'image/jpeg') return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
    if (contentType === 'image/png') return body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return contentType === 'image/webp' && body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' &&
        body.toString('ascii', 8, 12) === 'WEBP';
}

// Presentation-only cache: no puzzle snapshots, clue packs or database writes.
function createGameArtwork({ fetch = globalThis.fetch, now = Date.now } = {}) {
    const cache = new Map();
    const pending = new Map();

    async function load(appId) {
        const metadata = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=english`,
            { redirect: 'error', signal: AbortSignal.timeout(6000) });
        const entry = JSON.parse((await boundedBody(metadata, MAX_METADATA_BYTES)).toString('utf8'))[appId];
        if (entry?.success !== true || String(entry.data?.steam_appid) !== appId) return null;
        const url = artworkUrl(entry.data?.header_image, appId);
        if (!url) return null;
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(6000) });
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
            await response.body?.cancel();
            return null;
        }
        const body = await boundedBody(response, MAX_IMAGE_BYTES);
        return isImage(body, contentType) ? { body, contentType } : null;
    }

    async function get(appId) {
        const id = typeof appId === 'number' && Number.isSafeInteger(appId) ? String(appId) : appId;
        if (typeof id !== 'string' || !/^[1-9]\d{0,9}$/.test(id)) return null;
        const saved = cache.get(id);
        if (saved && saved.expires > now()) {
            cache.delete(id);
            cache.set(id, saved);
            return saved.value;
        }
        if (pending.has(id)) return pending.get(id);
        const task = load(id).catch(() => null).then(value => {
            cache.delete(id);
            cache.set(id, { value, expires: now() + (value ? SUCCESS_TTL : FAILURE_TTL) });
            while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
            return value;
        }).finally(() => pending.delete(id));
        pending.set(id, task);
        return task;
    }

    return { get };
}

module.exports = { createGameArtwork };
