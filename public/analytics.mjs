const PREFIX = 'steamdle.analytics.v1.';
const ID = PREFIX + 'browser';
const FIRST_VISIT = PREFIX + 'firstVisit';
const ROUND = PREFIX + 'round.';
const ACK = PREFIX + 'sent.';
const SOURCES = new Set(['direct', 'discord', 'streamer', 'player_share', 'directory', 'search', 'social', 'other']);
const CAMPAIGN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_MS = 86400000;
const utcDay = time => new Date(time).toISOString().slice(0, 10);

export function sourceForVisit(href, referrer) {
    const url = new URL(href);
    const tag = url.searchParams.get('utm_source')?.toLowerCase();
    const campaign = url.searchParams.get('utm_campaign')?.toLowerCase();
    let source = 'direct';
    if (tag) {
        source = SOURCES.has(tag) ? tag : 'other';
    } else if (referrer) {
        let host = '';
        try { host = new URL(referrer).hostname; } catch { /* Unrecognized referrer. */ }
        if (host === url.hostname) source = 'direct';
        else if (/(^|\.)(discord\.com|discord\.gg)$/.test(host)) source = 'discord';
        else if (/(^|\.)(alldle\.net|dles\.gg|dledirectory\.com|dailygamestoplay\.com)$/.test(host)) source = 'directory';
        else if (/(^|\.)(google\.com|bing\.com|duckduckgo\.com)$/.test(host)) source = 'search';
        else if (/(^|\.)(reddit\.com|x\.com|t\.co|youtube\.com|twitch\.tv|bsky\.app)$/.test(host)) source = 'social';
        else source = 'other';
    }
    return CAMPAIGN.test(campaign || '') ? { source, campaign } : { source };
}

function validTurns(turns) {
    return Array.isArray(turns) && turns.length >= 1 && turns.length <= 6 &&
        turns.every((turn, i) => turn === 'wrong' || turn === 'skip' || (turn === 'solve' && i === turns.length - 1));
}

export function createRoundAnalytics(browser) {
    const noop = () => {};
    const nav = browser.navigator;
    if (!browser.crypto?.randomUUID || nav.globalPrivacyControl || nav.doNotTrack === '1') return noop;

    let storage, landing;
    try {
        storage = browser.localStorage;
        landing = sourceForVisit(browser.location.href, browser.document.referrer);
        if (!storage.getItem(ID) && !storage.getItem(FIRST_VISIT)) {
            storage.setItem(FIRST_VISIT, JSON.stringify(landing));
        }
    } catch { return noop; }

    const arrivalDay = utcDay(Date.now());
    const inFlight = new Set();

    function read(key) {
        try { return JSON.parse(storage.getItem(key)); } catch { return null; }
    }

    async function send(day) {
        if (inFlight.has(day)) return;
        let length = 0;
        try {
            const round = read(ROUND + day);
            const browserId = storage.getItem(ID);
            if (!UUID.test(browserId) || !validTurns(round?.turns) || !SOURCES.has(round.source)) return;
            length = round.turns.length;
            if (Number(storage.getItem(ACK + day)) >= length) return;
            inFlight.add(day);
            const payload = { browserId, puzzleDate: day, source: round.source, turns: round.turns };
            if (CAMPAIGN.test(round.campaign || '')) payload.campaign = round.campaign;
            const result = await browser.fetch('/api/analytics', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload), keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer'
            });
            if (result.ok) {
                storage.setItem(ACK + day, String(Math.max(length, Number(storage.getItem(ACK + day)) || 0)));
            }
        } catch {
            // Unacknowledged snapshots are retried on the next turn, visit, or reconnection.
        } finally {
            inFlight.delete(day);
            if (length && (read(ROUND + day)?.turns?.length || 0) > length) void send(day);
        }
    }

    function retry() {
        try {
            const today = utcDay(Date.now());
            const oldest = utcDay(Date.now() - 6 * DAY_MS);
            for (let i = storage.length - 1; i >= 0; i--) {
                const key = storage.key(i);
                if (!key?.startsWith(ROUND) && !key?.startsWith(ACK)) continue;
                const day = key.slice(key.lastIndexOf('.') + 1);
                if (day < oldest || day > today) storage.removeItem(key);
                else if (key.startsWith(ROUND)) void send(day);
            }
        } catch { /* Storage can be unavailable in private or embedded browsers. */ }
    }
    retry();
    browser.addEventListener('online', retry);
    browser.document.addEventListener('visibilitychange', () => { if (!browser.document.hidden) retry(); });

    return (day, turns) => {
        try {
            if (!validTurns(turns)) return;
            const existing = read(ROUND + day);
            // Only a newly accepted first turn enrolls a round. A saved round from
            // before analytics shipped must never be replayed as a new start.
            if (!existing && turns.length !== 1) return;
            if (existing && existing.turns.length >= turns.length) { void send(day); return; }
            let attribution = existing || (day === arrivalDay ? landing : { source: 'direct' });
            if (!UUID.test(storage.getItem(ID))) {
                attribution = read(FIRST_VISIT) || attribution;
                storage.setItem(ID, browser.crypto.randomUUID());
                storage.removeItem(FIRST_VISIT);
            }
            const record = { source: attribution.source, turns };
            if (attribution.campaign) record.campaign = attribution.campaign;
            storage.setItem(ROUND + day, JSON.stringify(record));
            void send(day);
        } catch { /* Analytics must never interrupt gameplay. */ }
    };
}
