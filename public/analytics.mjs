const PREFIX = 'steamdle.analytics.v1.';
const ID = PREFIX + 'browser';
const FIRST_VISIT = PREFIX + 'firstVisit';
const ROUND = PREFIX + 'round.';
const ACK = PREFIX + 'sent.';
const EVENT = 'steamdle.analytics.v2.event.';
const ACTIONS = new Set(['view', 'search_results', 'search_empty', 'search_pick', 'share_copy', 'share_native', 'share_x', 'share_image', 'share_download', 'feedback']);
const SOURCES = new Set(['direct', 'discord', 'streamer', 'player_share', 'directory', 'search', 'social', 'other']);
const CAMPAIGN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_MS = 86400000;
const utcDay = time => new Date(time).toISOString().slice(0, 10);

// Keep only a public website hostname. Paths, queries, credentials and addresses
// are never copied into storage or an analytics request.
function normalizedDomain(value) {
    if (typeof value !== 'string') return '';
    const host = value.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    if (host.length > 253 || !host.includes('.') ||
        !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        !/\.(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(host) ||
        /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
        /(^|\.)home\.arpa$/.test(host)) return '';
    return host;
}

function referrerDomain(referrer, currentHost) {
    try {
        const url = new URL(referrer);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
        const host = normalizedDomain(url.hostname);
        if (host === normalizedDomain(currentHost) || host === 'steamdle.com' || host === 'steamdle.onrender.com') return '';
        return host;
    } catch { return ''; }
}

function attributionFields(record) {
    // A missing version means this record predates domain tracking. Never fill
    // an older saved visit or retry with today's referring website.
    if (record?.attributionVersion !== 3 || typeof record.referrerDomain !== 'string' ||
        (record.referrerDomain && normalizedDomain(record.referrerDomain) !== record.referrerDomain)) return {};
    return { attributionVersion: 3, referrerDomain: record.referrerDomain };
}

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
    const visit = CAMPAIGN.test(campaign || '') ? { source, campaign } : { source };
    visit.attributionVersion = 3;
    visit.referrerDomain = referrerDomain(referrer, url.hostname);
    const shared = url.searchParams.get('share_date');
    if (source === 'player_share' && /^\d{4}-\d{2}-\d{2}$/.test(shared || '') &&
        Number.isFinite(Date.parse(shared)) && utcDay(Date.parse(shared)) === shared && shared <= utcDay(Date.now())) {
        visit.sharedPuzzle = shared;
    }
    return visit;
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

    function post(payload) {
        return browser.fetch('/api/analytics', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload), keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer'
        });
    }

    function withIdentity(work, unique = false) {
        const run = () => {
            try {
                if (!UUID.test(storage.getItem(ID))) storage.setItem(ID, browser.crypto.randomUUID());
                return work();
            } catch { /* Storage and analytics are optional. */ }
        };
        if (nav.locks && (!UUID.test(storage.getItem(ID)) || unique)) {
            return nav.locks.request(ID, run).catch(() => undefined);
        }
        return run();
    }

    function visitForDay(day) {
        const view = read(EVENT + day + '.view');
        if (view) return view;
        return day === arrivalDay ? landing : { source: 'direct', attributionVersion: 3, referrerDomain: '' };
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
            const payload = { browserId, puzzleDate: day, source: round.source, turns: round.turns, ...attributionFields(round) };
            if (CAMPAIGN.test(round.campaign || '')) payload.campaign = round.campaign;
            if (round.sharedPuzzle) payload.sharedPuzzle = round.sharedPuzzle;
            const result = await post(payload);
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

    async function sendEvent(key) {
        if (inFlight.has(key)) return;
        try {
            const event = read(key);
            if (!event || event.sent || !ACTIONS.has(event.event) || !SOURCES.has(event.source) ||
                !UUID.test(event.browserId) || !UUID.test(event.eventId) ||
                !/^\d{4}-\d{2}-\d{2}$/.test(event.puzzleDate)) return;
            inFlight.add(key);
            const { browserId, puzzleDate, source, eventId } = event;
            const payload = { browserId, puzzleDate, source, event: event.event, eventId, ...attributionFields(event) };
            if (CAMPAIGN.test(event.campaign || '')) payload.campaign = event.campaign;
            if (event.event === 'view' && source === 'player_share' && /^\d{4}-\d{2}-\d{2}$/.test(event.sharedPuzzle || '')) {
                payload.sharedPuzzle = event.sharedPuzzle;
            }
            if (event.event === 'feedback' || event.event.startsWith('share_')) {
                if (!validTurns(event.turns)) return;
                payload.turns = event.turns;
            }
            if (event.event === 'feedback') {
                if (!Number.isInteger(event.clue) || event.clue < 0 || event.clue > event.turns.length) return;
                payload.clue = event.clue;
            }
            const result = await post(payload);
            if (result.ok) {
                if (event.event === 'view' || event.event === 'feedback') {
                    storage.setItem(key, JSON.stringify({ ...event, sent: true }));
                } else {
                    storage.removeItem(key);
                }
            }
        } catch { /* Retry the same immutable event ID after reconnection or on the next visit. */ }
        finally { inFlight.delete(key); }
    }

    function retry() {
        try {
            const today = utcDay(Date.now());
            const oldest = utcDay(Date.now() - 6 * DAY_MS);
            for (let i = storage.length - 1; i >= 0; i--) {
                const key = storage.key(i);
                if (key?.startsWith(EVENT)) {
                    const day = key.slice(EVENT.length, EVENT.length + 10);
                    if (day < oldest || day > today) storage.removeItem(key);
                    else void sendEvent(key);
                    continue;
                }
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

    const recordRound = (day, turns) => {
        try {
            if (!validTurns(turns)) return;
            const existing = read(ROUND + day);
            // Only a newly accepted first turn enrolls a round. A saved round from
            // before analytics shipped must never be replayed as a new start.
            if (!existing && turns.length !== 1) return;
            if (existing && existing.turns.length >= turns.length) { void send(day); return; }
            return withIdentity(() => {
                // Another tab may have enrolled this round while waiting for
                // the identity lock. Preserve its earliest arrival metadata.
                const latest = read(ROUND + day);
                if (latest && latest.turns.length >= turns.length) { void send(day); return; }
                const attribution = latest || read(FIRST_VISIT) || visitForDay(day);
                const record = { source: attribution.source, turns, ...attributionFields(attribution) };
                if (attribution.campaign) record.campaign = attribution.campaign;
                if (attribution.sharedPuzzle && attribution.source === 'player_share') record.sharedPuzzle = attribution.sharedPuzzle;
                storage.setItem(ROUND + day, JSON.stringify(record));
                storage.removeItem(FIRST_VISIT);
                void send(day);
            });
        } catch { /* Analytics must never interrupt gameplay. */ }
    };

    function finished(day) {
        const turns = read(ROUND + day)?.turns;
        return validTurns(turns) && (turns.length === 6 || turns.at(-1) === 'solve') ? turns : null;
    }

    recordRound.feedback = day => {
        if (!finished(day)) return null;
        return { choice: read(EVENT + day + '.feedback')?.clue ?? null };
    };

    recordRound.event = (day, event, clue) => {
        if (!ACTIONS.has(event)) return;
        const unique = event === 'view' || event === 'feedback';
        try {
            return withIdentity(() => {
                const id = browser.crypto.randomUUID();
                const key = EVENT + day + '.' + (unique ? event : id);
                if (unique && read(key)) { void sendEvent(key); return true; }
                const visit = (event !== 'view' && read(ROUND + day)) || visitForDay(day);
                const payload = { browserId: storage.getItem(ID), puzzleDate: day, event, eventId: id,
                    source: visit.source, ...attributionFields(visit) };
                if (visit.campaign) payload.campaign = visit.campaign;
                if (event === 'view' && visit.sharedPuzzle) payload.sharedPuzzle = visit.sharedPuzzle;
                if (event.startsWith('share_') || event === 'feedback') {
                    const turns = finished(day);
                    if (!turns) return false;
                    payload.turns = turns;
                    if (event === 'feedback') {
                        if (!Number.isInteger(clue) || clue < 0 || clue > turns.length) return false;
                        payload.clue = clue;
                    }
                }
                storage.setItem(key, JSON.stringify(payload));
                void sendEvent(key);
                return true;
            }, unique);
        } catch { return false; }
    };
    return recordRound;
}
