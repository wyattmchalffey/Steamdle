const { createHash } = require('node:crypto');
const { promisify } = require('node:util');

const DAY_MS = 86400000;
const SOURCES = new Set(['direct', 'discord', 'streamer', 'player_share', 'directory', 'search', 'social', 'other']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAMPAIGN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OUTCOMES = new Map([['wrong', 'W'], ['skip', 'K'], ['solve', 'S']]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONS = new Set(['search_results', 'search_empty', 'search_pick', 'share_copy', 'share_native', 'share_x', 'feedback']);
const SHARE_METRICS = new Map([['share_copy', 'copies'], ['share_native', 'native'], ['share_x', 'x']]);
const EVENT_FIELDS = new Set(['browserId', 'puzzleDate', 'source', 'campaign', 'event', 'eventId', 'sharedPuzzle', 'clue', 'turns']);

function emptyClues() {
    return Array.from({ length: 6 }, (_, i) => ({
        clue: i + 1, reached: 0, wrong: 0, skipped: 0, solved: 0, unanswered: 0
    }));
}

function countClues(slots, turns) {
    for (let i = 0; i < turns.length; i++) {
        const slot = slots[i];
        slot.reached++;
        if (turns[i] === 'W') slot.wrong++;
        else if (turns[i] === 'K') slot.skipped++;
        else slot.solved++;
    }
    if (turns.length < 6 && !turns.endsWith('S')) {
        slots[turns.length].reached++;
        slots[turns.length].unanswered++;
    }
}

function puzzleCounts(date, title) {
    return { date, title, started: 0, solves: Array(6).fill(0), losses: 0, unfinished: 0 };
}

function countDifficulty(puzzle, turns) {
    puzzle.started++;
    if (turns.endsWith('S')) puzzle.solves[turns.length - 1]++;
    else if (turns.length === 6) puzzle.losses++;
    else puzzle.unfinished++;
}

function feedbackCounts(rows) {
    const counts = { votes: Array(6).fill(0), none: 0 };
    for (const row of rows) {
        if (row.clue === 0) counts.none += row.total;
        else counts.votes[row.clue - 1] += row.total;
    }
    return counts;
}

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

    let engagementSince;
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
            CREATE TABLE IF NOT EXISTS analytics_exposures (
                browser_key TEXT NOT NULL,
                puzzle_date TEXT NOT NULL,
                source TEXT NOT NULL,
                campaign TEXT NOT NULL,
                shared_puzzle TEXT,
                shown INTEGER NOT NULL,
                PRIMARY KEY (puzzle_date, browser_key)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS analytics_share_origin ON analytics_exposures(shared_puzzle)
                WHERE shared_puzzle IS NOT NULL;
            CREATE TABLE IF NOT EXISTS analytics_actions (
                puzzle_date TEXT NOT NULL,
                browser_key TEXT NOT NULL,
                event_id TEXT NOT NULL,
                event TEXT NOT NULL,
                clue INTEGER,
                PRIMARY KEY (puzzle_date, browser_key, event_id)
            ) WITHOUT ROWID;
            CREATE UNIQUE INDEX IF NOT EXISTS analytics_feedback_once ON analytics_actions(puzzle_date, browser_key)
                WHERE event = 'feedback';
            CREATE TABLE IF NOT EXISTS analytics_coverage (version INTEGER PRIMARY KEY, since TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS analytics_campaigns (slug TEXT PRIMARY KEY) WITHOUT ROWID;
        `);
        await run('INSERT OR IGNORE INTO analytics_metadata (id, tracking_since) VALUES (1, ?)', dayOffset(now()));
        await run('INSERT OR IGNORE INTO analytics_coverage(version, since) VALUES (2, ?)', dayOffset(now()));
        engagementSince = (await get('SELECT since FROM analytics_coverage WHERE version = 2')).since;
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
        const { browserId, puzzleDate, source, campaign, turns, event, eventId, sharedPuzzle, clue } = payload;
        if (typeof browserId !== 'string' || !UUID_V4.test(browserId) ||
            typeof puzzleDate !== 'string' || !DATE.test(puzzleDate) || !SOURCES.has(source) ||
            (campaign !== undefined && typeof campaign !== 'string')) return false;
        const isAction = event !== undefined;
        const needsFinish = event === 'feedback' || SHARE_METRICS.has(event);
        if (isAction && ((event !== 'view' && !ACTIONS.has(event)) ||
            typeof eventId !== 'string' || !UUID_V4.test(eventId) ||
            Object.keys(payload).some(name => !EVENT_FIELDS.has(name)))) return false;
        if (isAction && clue !== undefined && event !== 'feedback') return false;
        if (event === 'feedback' && (!Number.isInteger(clue) || clue < 0 || clue > 6)) return false;
        if (!isAction || turns !== undefined) {
            if ((isAction && !needsFinish) || !Array.isArray(turns) || turns.length < 1 || turns.length > 6 ||
                !turns.every((turn, i) => OUTCOMES.has(turn) && (turn !== 'solve' || i === turns.length - 1))) return false;
            if (needsFinish && ((turns.length < 6 && turns.at(-1) !== 'solve') || clue > turns.length)) return false;
        }

        const since = await ready;
        const received = now();
        if (puzzleDate < (isAction ? engagementSince : since) ||
            puzzleDate < dayOffset(received, -6) || puzzleDate > dayOffset(received)) return false;
        const key = createHash('sha256').update(browserId.toLowerCase()).digest('hex');
        // A share tag is only attribution. A bad or unpublished origin cannot suppress a real play.
        const origin = source === 'player_share' && typeof sharedPuzzle === 'string' && DATE.test(sharedPuzzle) &&
            sharedPuzzle <= puzzleDate && sharedPuzzle >= engagementSince ? sharedPuzzle : null;
        let round;
        if (turns) {
            const encoded = turns.map(turn => OUTCOMES.get(turn)).join('');
            // Retry snapshots may only extend a previously accepted prefix.
            round = await get(`
                INSERT INTO analytics_rounds (browser_key, puzzle_date, source, campaign, turns)
                SELECT ?, puzzle_date, ?, COALESCE((SELECT slug FROM analytics_campaigns WHERE slug = ?), ''), ?
                FROM daily_puzzles WHERE puzzle_date = ?
                ON CONFLICT(browser_key, puzzle_date) DO UPDATE SET turns =
                    CASE WHEN length(excluded.turns) > length(analytics_rounds.turns)
                        AND substr(excluded.turns, 1, length(analytics_rounds.turns)) = analytics_rounds.turns
                    THEN excluded.turns ELSE analytics_rounds.turns END
                RETURNING source
            `, [key, source, campaign || '', encoded, puzzleDate]);
            if (!round) return false;
        }
        // A share-tagged turn can arrive before the first-clue event. Credit a referred start
        // without inventing a view. If the view eventually arrives it upgrades this row.
        if (event === 'view' || (round?.source === 'player_share' && origin)) {
            const exposure = await get(`
                INSERT INTO analytics_exposures (browser_key, puzzle_date, source, campaign, shared_puzzle, shown)
                SELECT ?, puzzle_date, ?, COALESCE((SELECT slug FROM analytics_campaigns WHERE slug = ?), ''),
                       (SELECT puzzle_date FROM daily_puzzles WHERE puzzle_date = ?), ?
                FROM daily_puzzles WHERE puzzle_date = ?
                ON CONFLICT(puzzle_date, browser_key) DO UPDATE SET
                    source = CASE WHEN shown = 0 AND excluded.shown = 1 THEN excluded.source ELSE source END,
                    campaign = CASE WHEN shown = 0 AND excluded.shown = 1 THEN excluded.campaign ELSE campaign END,
                    shared_puzzle = CASE WHEN shown = 0 AND excluded.shown = 1 THEN excluded.shared_puzzle ELSE shared_puzzle END,
                    shown = MAX(shown, excluded.shown)
                RETURNING 1 AS recorded
            `, [key, source, campaign || '', origin, Number(event === 'view'), puzzleDate]);
            if (!exposure) return false;
        }
        if (!isAction || event === 'view') return true;

        // Record clicks and successful deliveries once per event ID. A separate unique
        // constraint records only the first feedback vote per browser and puzzle.
        const saved = await get(`
            INSERT INTO analytics_actions (puzzle_date, browser_key, event_id, event, clue)
            SELECT puzzle_date, $key, $id, $event, $clue FROM daily_puzzles WHERE puzzle_date = $day
            AND ($finished = 0 OR EXISTS (
                SELECT 1 FROM analytics_rounds WHERE browser_key = $key AND puzzle_date = $day
                  AND (length(turns) = 6 OR substr(turns, -1) = 'S') AND length(turns) >= COALESCE($clue, 0)
            ))
            ON CONFLICT DO UPDATE SET event = analytics_actions.event
            RETURNING event
        `, { $key: key, $id: eventId.toLowerCase(), $event: event, $clue: event === 'feedback' ? clue : null,
            $day: puzzleDate, $finished: Number(needsFinish) });
        return saved?.event === event;
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
        const clues = emptyClues();
        const closed = await all(`SELECT puzzle_date AS date, json_extract(puzzle_json, '$.title') AS title
            FROM daily_puzzles WHERE puzzle_date BETWEEN ? AND ? AND puzzle_date < ? ORDER BY puzzle_date DESC`,
            [startDate > trackingSince ? startDate : trackingSince, today, today]);
        const puzzles = closed.map(row => puzzleCounts(row.date, row.title));
        const byDate = new Map(puzzles.map(row => [row.date, row]));
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

            countClues(clues, round.turns);
            if (byDate.has(day.date)) countDifficulty(byDate.get(day.date), round.turns);

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
        const views = await all(`SELECT e.source, e.campaign, COUNT(*) AS viewed, COUNT(r.turns) AS started
            FROM analytics_exposures e LEFT JOIN analytics_rounds r USING (puzzle_date, browser_key)
            WHERE e.shown = 1 AND e.puzzle_date BETWEEN ? AND ?
            GROUP BY e.source, e.campaign ORDER BY viewed DESC, e.source, e.campaign`, [startDate, today]);
        const actions = await all(`SELECT puzzle_date AS date, event, clue, COUNT(*) AS total FROM analytics_actions
            WHERE puzzle_date BETWEEN ? AND ? GROUP BY puzzle_date, event, clue`, [startDate, today]);
        const referrals = await all(`SELECT e.shared_puzzle AS date, COUNT(*) AS starts
            FROM analytics_exposures e JOIN analytics_rounds r USING (puzzle_date, browser_key)
            WHERE e.shared_puzzle BETWEEN ? AND ? GROUP BY e.shared_puzzle`, [startDate, today]);
        const shares = daily.filter(row => row.date >= engagementSince).map(({ date }) => ({
            date, copies: 0, native: 0, x: 0, starts: 0
        }));
        const sharesByDate = new Map(shares.map(row => [row.date, row]));
        for (const row of referrals) sharesByDate.get(row.date).starts = row.starts;
        const search = { queries: 0, empty: 0, selected: 0 };
        for (const row of actions) {
            if (SHARE_METRICS.has(row.event)) sharesByDate.get(row.date)[SHARE_METRICS.get(row.event)] += row.total;
            if (row.event === 'search_results' || row.event === 'search_empty') search.queries += row.total;
            if (row.event === 'search_empty') search.empty += row.total;
            if (row.event === 'search_pick') search.selected += row.total;
        }
        const feedback = feedbackCounts(actions.filter(row => row.event === 'feedback'));
        return { today, startDate, endDate: today, days, trackingSince, campaigns, daily, clues, sources, retention,
            engagementSince, puzzles, views, shares, search, feedback };
    }

    async function puzzleReview(date) {
        if (typeof date !== 'string' || !DATE.test(date)) return null;
        const since = await ready;
        if (date < since || date >= dayOffset(now())) return null;
        const snapshot = await get('SELECT puzzle_json FROM daily_puzzles WHERE puzzle_date = ?', date);
        if (!snapshot) return null;
        const { title, reviews } = JSON.parse(snapshot.puzzle_json);
        const puzzle = puzzleCounts(date, title);
        const clues = emptyClues();
        const rounds = await all('SELECT turns FROM analytics_rounds WHERE puzzle_date = ?', date);
        for (const { turns } of rounds) {
            countDifficulty(puzzle, turns);
            countClues(clues, turns);
        }
        const votes = await all(`SELECT clue, COUNT(*) AS total FROM analytics_actions
            WHERE puzzle_date = ? AND event = 'feedback' GROUP BY clue`, date);
        return { ...puzzle, reviews, clues, feedback: feedbackCounts(votes), engagementSince };
    }

    return { ready, record, summary, addCampaign, puzzleReview };
}

module.exports = { createAnalytics };
