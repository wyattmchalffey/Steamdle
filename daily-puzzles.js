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

function createDailyPuzzles(db, scrapeReview) {
    const get = promisify(db.get.bind(db));
    const all = promisify(db.all.bind(db));
    const run = promisify(db.run.bind(db));
    const pending = new Map();
    const failedCandidates = new Map();

    async function loadOrBuild(day, preparing, storedOnly) {
        await db.ready;
        const readDaily = () => get('SELECT puzzle_json FROM daily_puzzles WHERE puzzle_date = ?', day);
        const saved = await readDaily();
        if (saved) return JSON.parse(saved.puzzle_json);

        // Keep the already-published answer during migration and exclude it from
        // tomorrow's draw. Prefer games that already have the actual review text.
        const candidates = await all(`
            SELECT g.id, g.title, g.steam_app_id
            FROM games g JOIN game_reviews r ON r.game_id = g.id
            WHERE g.is_active = TRUE AND ($ahead = 0 OR NOT EXISTS (
                SELECT 1 FROM daily_puzzles WHERE game_id = g.id AND puzzle_date = date($day, '-1 day')
            ))
            GROUP BY g.id
            HAVING COUNT(*) >= $count AND ($storedOnly = 0 OR COUNT(r.review_data) >= $count)
            ORDER BY (g.last_played_on IS $day) DESC,
                NOT EXISTS (SELECT 1 FROM daily_puzzles WHERE game_id = g.id AND puzzle_date = date($day, '-1 day')) DESC,
                (COUNT(r.review_data) >= $count) DESC,
                MAX(COALESCE(g.last_played_on, ''), COALESCE((
                    SELECT MAX(puzzle_date) FROM daily_puzzles WHERE game_id = g.id AND puzzle_date < $day
                ), '')), RANDOM()
        `, { $ahead: Number(preparing), $storedOnly: Number(storedOnly), $day: day, $count: CLUE_COUNT });

        const skipped = failedCandidates.get(day) || new Set();
        let remaining = candidates.filter(game => !skipped.has(game.id));
        if (!remaining.length) {
            skipped.clear();
            remaining = candidates;
        }
        for (const game of remaining.slice(0, MAX_CANDIDATES)) {
            const rows = await all(`SELECT review_data, review_page_url FROM game_reviews
                WHERE game_id = ? ORDER BY clue_order LIMIT ?`, [game.id, CLUE_COUNT]);
            const reviews = await Promise.all(rows.map(row =>
                storedReview(row) || (storedOnly ? null : scrapeReview(row.review_page_url))));
            if (reviews.length !== CLUE_COUNT || reviews.some(review => !review?.reviewText?.trim())) {
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
