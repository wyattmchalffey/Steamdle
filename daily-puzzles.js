const { promisify } = require('node:util');

const CLUE_COUNT = 6;
const MAX_CANDIDATES = 3;

function utcDay(date) {
    return date.toISOString().slice(0, 10);
}

function storedReview(row) {
    if (!row.review_data) return null;
    try {
        const review = JSON.parse(row.review_data);
        return typeof review?.reviewText === 'string' && review.reviewText.trim() ? review : null;
    } catch {
        return null;
    }
}

function createDailyPuzzles(db, scrapeReview, { playedAppIds = [], priorityAppIds = [] } = {}) {
    const get = promisify(db.get.bind(db));
    const all = promisify(db.all.bind(db));
    const run = promisify(db.run.bind(db));
    const pending = new Map();
    const failedCandidates = new Map();
    // Optional recovered history contains games known to have been played, not
    // merely games that appeared in an old catalog. It supplements both DB sources.
    const recoveredPlayed = new Set(Array.from(playedAppIds, String));
    const unusedPriority = new Map([...new Set(Array.from(priorityAppIds, String))]
        .map((appId, index) => [appId, index]));

    async function loadOrBuild(day, preparing, storedOnly) {
        await db.ready;
        const readDaily = () => get('SELECT puzzle_json FROM daily_puzzles WHERE puzzle_date = ?', day);
        const saved = await readDaily();
        if (saved) return JSON.parse(saved.puzzle_json);

        // A frozen snapshot retains the original app identity even if a catalog
        // label changes or its database row is recreated. The row match also
        // preserves history when correcting a mistaken catalog app ID in place.
        // Legacy usage includes inactive aliases retained during catalog renames.
        const candidates = await all(`
            SELECT g.id, g.title, g.steam_app_id, legacy.last_played_on AS legacy_last_played,
                COUNT(r.review_data) AS stored_count,
                (SELECT MAX(d.puzzle_date) FROM daily_puzzles d
                    WHERE d.puzzle_date <> $day AND (d.game_id = g.id OR
                        CAST(json_extract(d.puzzle_json, '$.appId') AS TEXT) = CAST(g.steam_app_id AS TEXT))) AS snapshot_last_played
            FROM games g LEFT JOIN game_reviews r ON r.game_id = g.id
            LEFT JOIN (
                SELECT CAST(steam_app_id AS TEXT) AS app_id, MAX(last_played_on) AS last_played_on
                FROM games GROUP BY CAST(steam_app_id AS TEXT)
            ) legacy ON legacy.app_id = CAST(g.steam_app_id AS TEXT)
            WHERE g.is_active = TRUE AND (
                ($ahead = 0 AND legacy.last_played_on = $day) OR (
                    legacy.last_played_on IS NOT date($day, '-1 day') AND NOT EXISTS (
                        SELECT 1 FROM daily_puzzles d
                        WHERE d.puzzle_date IN (date($day, '-1 day'), date($day, '+1 day'))
                        AND (d.game_id = g.id OR
                            CAST(json_extract(d.puzzle_json, '$.appId') AS TEXT) = CAST(g.steam_app_id AS TEXT))
                    )
                )
            )
            GROUP BY g.id
            ORDER BY RANDOM()
        `, { $ahead: Number(preparing), $day: day });

        for (const game of candidates) {
            game.lastUsed = [game.legacy_last_played || '', game.snapshot_last_played || ''].sort().at(-1);
            game.used = Boolean(game.lastUsed) || recoveredPlayed.has(String(game.steam_app_id));
        }
        // Preserve a legacy answer already served today before snapshots existed.
        // Adjacent snapshots are excluded above, including an already-prebuilt
        // tomorrow. Otherwise, missing, unavailable or uncached unused clues must never
        // promote a repeat. Incomplete imports or transient Steam failures defer
        // preparation and are retried.
        const publishedToday = preparing ? [] : candidates.filter(game => game.legacy_last_played === day);
        const unused = candidates.filter(game => !game.used);
        const eligible = publishedToday.length ? publishedToday : unused.length ? unused : candidates;
        // Trial ordering applies only to unused games; it never promotes a repeat
        // or alters the oldest-first order once every game has been used.
        eligible.sort((a, b) => (!a.used && !b.used ?
            (unusedPriority.get(String(a.steam_app_id)) ?? unusedPriority.size) -
            (unusedPriority.get(String(b.steam_app_id)) ?? unusedPriority.size) : 0) ||
            a.lastUsed.localeCompare(b.lastUsed) ||
            Number(b.stored_count >= CLUE_COUNT) - Number(a.stored_count >= CLUE_COUNT));

        const skipped = failedCandidates.get(day) || new Set();
        let remaining = eligible.filter(game => !skipped.has(game.id));
        if (!remaining.length) {
            skipped.clear();
            remaining = eligible;
        }
        for (const game of remaining.slice(0, MAX_CANDIDATES)) {
            const rows = await all(`SELECT review_data, review_page_url FROM game_reviews
                WHERE game_id = ? ORDER BY clue_order LIMIT ?`, [game.id, CLUE_COUNT]);
            const reviews = await Promise.all(rows.map(row =>
                storedReview(row) || (storedOnly ? null : Promise.resolve().then(() => scrapeReview(row.review_page_url)))))
                .catch(() => null);
            if (!reviews || reviews.length !== CLUE_COUNT || reviews.some(review => !review?.reviewText?.trim())) {
                skipped.add(game.id);
                failedCandidates.set(day, skipped);
                continue;
            }

            const puzzle = {
                title: game.title, appId: game.steam_app_id, reviews, puzzleDate: day,
                puzzleDateFormatted: new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', {
                    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric'
                })
            };
            // Two processes may prepare the same date. Always return the puzzle that won the insert.
            await run(`INSERT INTO daily_puzzles (puzzle_date, game_id, puzzle_json) VALUES (?, ?, ?)
                ON CONFLICT(puzzle_date) DO NOTHING`, [day, game.id, JSON.stringify(puzzle)]);
            failedCandidates.delete(day);
            return JSON.parse((await readDaily()).puzzle_json);
        }
        return null;
    }

    function forDay(day, { preparing = false, storedOnly = false } = {}) {
        if (!pending.has(day)) {
            const lookup = loadOrBuild(day, preparing, storedOnly).finally(() => pending.delete(day));
            pending.set(day, lookup);
        }
        return pending.get(day);
    }

    async function prepareThroughTomorrow(now) {
        const today = utcDay(now);
        for (const day of failedCandidates.keys()) {
            if (day < today) failedCandidates.delete(day);
        }
        if (!await forDay(today)) return null;
        // Maintain the old play-history field only for a published date.
        await run(`UPDATE games SET last_played_on = CASE WHEN id = today.game_id THEN $day ELSE NULL END
            FROM (SELECT game_id FROM daily_puzzles WHERE puzzle_date = $day) AS today
            WHERE (id = today.game_id AND last_played_on IS NOT $day)
               OR (id <> today.game_id AND last_played_on = $day)`, { $day: today });
        const tomorrow = utcDay(new Date(now.getTime() + 86400000));
        // Give the importer time to upgrade old clue sets. If it is disabled or
        // midnight is near, snapshot verified legacy pages while they are reachable.
        const storedOnly = process.env.DISABLE_DB_SEED !== 'true' && now.getUTCHours() < 23;
        return await forDay(tomorrow, { preparing: true, storedOnly }) ? tomorrow : null;
    }

    return { forDay, prepareThroughTomorrow };
}

module.exports = { createDailyPuzzles, utcDay };
