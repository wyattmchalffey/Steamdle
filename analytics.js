const { createHash } = require('node:crypto');
const { promisify } = require('node:util');

const DAY_MS = 86400000;
const SOURCES = new Set(['direct', 'discord', 'streamer', 'player_share', 'directory', 'search', 'social', 'other']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAMPAIGN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OUTCOMES = new Map([['wrong', 'W'], ['skip', 'K'], ['solve', 'S']]);

function dayOffset(date, offset = 0) {
    return new Date(date.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
}

function validCampaign(slug) {
    return typeof slug === 'string' && slug.length <= 40 && CAMPAIGN.test(slug);
}

function createAnalytics(db, options = {}) {
    const now = options.now || (() => new Date());
    const approved = options.campaigns ?? (process.env.STEAMDLE_ANALYTICS_CAMPAIGNS || '').split(',');
    const configuredCampaigns = new Set(approved.map(name => name.trim()).filter(validCampaign).slice(0, 64));
    const exec = promisify(db.exec.bind(db));
    const get = promisify(db.get.bind(db));
    const all = promisify(db.all.bind(db));
    const run = promisify(db.run.bind(db));

    async function insertCampaign(slug) {
        // Evaluate the limit and insert under a single SQLite write lock, including across processes.
        const row = await get(`INSERT INTO analytics_campaigns(slug)
            SELECT $slug WHERE (SELECT COUNT(*) FROM analytics_campaigns) < 64
                OR EXISTS (SELECT 1 FROM analytics_campaigns WHERE slug = $slug)
            ON CONFLICT(slug) DO UPDATE SET slug = excluded.slug RETURNING slug`, { $slug: slug });
        return Boolean(row);
    }

    const ready = Promise.resolve(db.ready).then(async () => {
        await exec(`
            CREATE TABLE IF NOT EXISTS analytics_rounds (
                browser_key TEXT NOT NULL,
                puzzle_date TEXT NOT NULL,
                source TEXT NOT NULL,
                campaign TEXT NOT NULL,
                turns TEXT NOT NULL,
                PRIMARY KEY (browser_key, puzzle_date)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS analytics_rounds_date ON analytics_rounds(puzzle_date);
            CREATE TABLE IF NOT EXISTS analytics_metadata (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                tracking_since TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS analytics_campaigns (slug TEXT PRIMARY KEY) WITHOUT ROWID;
        `);
        await run('INSERT OR IGNORE INTO analytics_metadata (id, tracking_since) VALUES (1, ?)', dayOffset(now()));
        for (const slug of configuredCampaigns) await insertCampaign(slug);
        return (await get('SELECT tracking_since FROM analytics_metadata WHERE id = 1')).tracking_since;
    });
    // Initialization errors are also reported to callers; analytics is independent of game availability.
    ready.catch(error => console.error('[ANALYTICS] Could not initialize:', error.message));

    async function addCampaign(slug) {
        if (!validCampaign(slug)) return false;
        await ready;
        return insertCampaign(slug);
    }

    async function record(payload) {
        if (!payload || typeof payload !== 'object') return false;
        const { browserId, puzzleDate, source, campaign, turns } = payload;
        if (typeof browserId !== 'string' || !UUID_V4.test(browserId) ||
            typeof puzzleDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(puzzleDate) ||
            !SOURCES.has(source) || (campaign !== undefined && typeof campaign !== 'string') ||
            !Array.isArray(turns) || turns.length < 1 || turns.length > 6) return false;
        if (!turns.every((turn, i) => OUTCOMES.has(turn) && (turn !== 'solve' || i === turns.length - 1))) return false;

        const since = await ready;
        const received = now();
        if (puzzleDate < since || puzzleDate < dayOffset(received, -6) || puzzleDate > dayOffset(received)) return false;
        const browserKey = createHash('sha256').update(browserId.toLowerCase()).digest('hex');
        const encoded = turns.map(turn => OUTCOMES.get(turn)).join('');
        // The first acknowledged history wins; later snapshots may only extend its prefix.
        // RETURNING also acknowledges an already-recorded turn while rejecting an unpublished date.
        const row = await get(`
            INSERT INTO analytics_rounds (browser_key, puzzle_date, source, campaign, turns)
            SELECT ?, puzzle_date, ?, COALESCE((SELECT slug FROM analytics_campaigns WHERE slug = ?), ''), ?
            FROM daily_puzzles WHERE puzzle_date = ?
            ON CONFLICT(browser_key, puzzle_date) DO UPDATE SET turns =
                CASE WHEN length(excluded.turns) > length(analytics_rounds.turns)
                    AND substr(excluded.turns, 1, length(analytics_rounds.turns)) = analytics_rounds.turns
                THEN excluded.turns ELSE analytics_rounds.turns END
            RETURNING 1 AS recorded
        `, [browserKey, source, campaign || '', encoded, puzzleDate]);
        return Boolean(row);
    }

    async function summary(days = 7) {
        if (!Number.isInteger(days) || days < 1 || days > 90) throw new RangeError('Report range must be 1 to 90 days.');
        const trackingSince = await ready;
        const asOf = now();
        const today = dayOffset(asOf);
        const startDate = dayOffset(asOf, 1 - days);
        // Seven subsequent UTC dates must be fully observed before counting a return rate.
        const retention = { startDate: dayOffset(asOf, -7 - days), endDate: dayOffset(asOf, -8), sources: [] };
        const daily = Array.from({ length: days }, (_, i) => ({
            date: dayOffset(asOf, i + 1 - days), started: 0, finished: 0, solved: 0
        }));
        const dailyByDate = new Map(daily.map(day => [day.date, day]));
        const clues = Array.from({ length: 6 }, (_, i) => ({
            clue: i + 1, reached: 0, wrong: 0, skipped: 0, solved: 0, unanswered: 0
        }));
        // One SQLite read snapshot keeps the report consistent while new turns arrive.
        // The indexed history lookups reach outside the selected range for first-touch and retention.
        const rounds = await all(`
            SELECT r.puzzle_date, r.source, r.campaign, r.turns,
                   ROW_NUMBER() OVER (PARTITION BY (r.puzzle_date >= $start), r.source, r.campaign, r.browser_key
                       ORDER BY r.puzzle_date) AS source_visit,
                   NOT EXISTS (SELECT 1 FROM analytics_rounds prior
                       WHERE prior.browser_key = r.browser_key AND prior.puzzle_date < r.puzzle_date) AS first_start,
                   EXISTS (SELECT 1 FROM analytics_rounds later WHERE later.browser_key = r.browser_key
                       AND later.puzzle_date > r.puzzle_date AND later.puzzle_date <= date(r.puzzle_date,'+7 days')) AS came_back
            FROM analytics_rounds r
            WHERE r.puzzle_date BETWEEN $start AND $today OR r.puzzle_date BETWEEN $cohortStart AND $cohortEnd
        `, { $start: startDate, $today: today, $cohortStart: retention.startDate, $cohortEnd: retention.endDate });
        const sourceGroups = new Map();
        const cohorts = new Map();
        for (const round of rounds) {
            const key = round.source + ':' + round.campaign;
            if (round.first_start && round.puzzle_date >= retention.startDate && round.puzzle_date <= retention.endDate) {
                if (!cohorts.has(key)) cohorts.set(key, { source: round.source, campaign: round.campaign, eligible: 0, returned: 0 });
                const cohort = cohorts.get(key);
                cohort.eligible++;
                if (round.came_back) cohort.returned++;
            }
            const day = dailyByDate.get(round.puzzle_date);
            if (!day) continue;
            const solved = round.turns.endsWith('S');
            const finished = solved || round.turns.length === 6;
            day.started++;
            if (finished) day.finished++;
            if (solved) day.solved++;

            for (let i = 0; i < round.turns.length; i++) {
                const slot = clues[i];
                slot.reached++;
                if (round.turns[i] === 'W') slot.wrong++;
                else if (round.turns[i] === 'K') slot.skipped++;
                else slot.solved++;
            }
            if (!finished) {
                const next = clues[round.turns.length];
                next.reached++;
                next.unanswered++;
            }

            if (!sourceGroups.has(key)) {
                sourceGroups.set(key, { source: round.source, campaign: round.campaign,
                    starters: 0, rounds: 0, newBrowsers: 0 });
            }
            const group = sourceGroups.get(key);
            group.rounds++;
            if (round.source_visit === 1) group.starters++;
            if (round.first_start) group.newBrowsers++;
        }

        const sources = [...sourceGroups.values()].sort((a, b) => b.rounds - a.rounds ||
            a.source.localeCompare(b.source) || a.campaign.localeCompare(b.campaign));
        retention.sources = [...cohorts.values()].sort((a, b) => b.eligible - a.eligible ||
            a.source.localeCompare(b.source) || a.campaign.localeCompare(b.campaign));
        const campaigns = (await all('SELECT slug FROM analytics_campaigns ORDER BY slug')).map(row => row.slug);
        return { today, startDate, endDate: today, days, trackingSince, campaigns, daily, clues, sources, retention };
    }

    return { ready, record, summary, addCampaign };
}

module.exports = { createAnalytics };
