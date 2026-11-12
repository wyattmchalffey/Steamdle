const { promisify } = require('node:util');

function prepareCuratedTrial(pack) {
    if (!pack || typeof pack.version !== 'string' || !pack.version.trim() || !Array.isArray(pack.games)) {
        throw new Error('Curated clue trial needs a version and games array.');
    }
    const games = new Map();
    for (const game of pack.games) {
        const appId = String(game.steam_app_id);
        if (!/^\d+$/.test(appId) || typeof game.title !== 'string' || !game.title.trim() ||
            games.has(appId) || !Array.isArray(game.clues) || game.clues.length !== 6) {
            throw new Error(`Invalid curated game: ${game.title || appId}`);
        }
        const recommendations = new Set();
        const authors = new Set();
        const clues = game.clues.map(clue => {
            const recommendationId = String(clue.recommendationid);
            const authorSteamId = String(clue.authorSteamId);
            const expectedUrl = `https://steamcommunity.com/profiles/${authorSteamId}/recommended/${appId}/`;
            if (!/^\d+$/.test(recommendationId) || !/^\d+$/.test(authorSteamId) ||
                recommendations.has(recommendationId) || authors.has(authorSteamId) ||
                clue.sourceUrl !== expectedUrl || typeof clue.displayText !== 'string' ||
                !clue.displayText.trim() || clue.displayText.trim().split(/\s+/u).length > 25 ||
                typeof clue.isExcerpt !== 'boolean') {
                throw new Error(`Invalid or duplicate curated clue for ${game.title}`);
            }
            recommendations.add(recommendationId);
            authors.add(authorSteamId);
            const metadata = clue.reviewMetadata || {};
            return {
                url: expectedUrl,
                data: {
                    originalUrl: expectedUrl,
                    reviewerName: metadata.reviewerName || 'A Steam User',
                    reviewerAvatarUrl: metadata.reviewerAvatarUrl || null,
                    recommendation: metadata.recommendation || 'Not specified',
                    playtime: metadata.playtime || 'Playtime not shown',
                    datePosted: metadata.datePosted || 'Date not found',
                    reviewText: clue.displayText.trim(),
                    recommendationId,
                    authorSteamId,
                    isExcerpt: clue.isExcerpt,
                    curationVersion: pack.version
                }
            };
        });
        games.set(appId, { title: game.title, steam_app_id: appId, clues });
    }
    return games;
}

// This finishes before db.ready resolves. New games remain visible to the
// no-repeat policy even while their ordinary Steam import is still pending.
async function registerCatalogAndCuratedReviews(db, catalog, curatedGames) {
    const run = promisify(db.run.bind(db));
    const get = promisify(db.get.bind(db));
    const all = promisify(db.all.bind(db));
    const catalogByTitle = new Map(catalog.map(game => [game.title, String(game.steam_app_id)]));
    for (const game of curatedGames.values()) {
        if (catalogByTitle.get(game.title) !== game.steam_app_id) {
            throw new Error(`Curated game does not match the catalog: ${game.title}`);
        }
    }
    const imported = [];
    const protectedGames = [];
    await run('BEGIN IMMEDIATE');
    try {
        for (const game of catalog) {
            // Never change an existing app ID before its replacement clues are
            // saved atomically; otherwise the ordinary importer could skip it.
            await run(`INSERT INTO games (title, steam_app_id) VALUES (?, ?)
                ON CONFLICT(title) DO UPDATE SET is_active = TRUE`, [game.title, String(game.steam_app_id)]);
        }
        if (catalog.length) {
            const existingGames = await all('SELECT id, title FROM games WHERE is_active = TRUE');
            for (const game of existingGames) {
                if (!catalogByTitle.has(game.title)) {
                    await run('UPDATE games SET is_active = FALSE WHERE id = ?', game.id);
                }
            }
        }
        for (const game of curatedGames.values()) {
            const existing = await get('SELECT id, steam_app_id, last_played_on FROM games WHERE title = ?', game.title);
            const legacyUse = await get(`SELECT 1 FROM games WHERE last_played_on IS NOT NULL
                AND CAST(steam_app_id AS TEXT) = ? LIMIT 1`, game.steam_app_id);
            const snapshot = await get(`SELECT 1 FROM daily_puzzles
                WHERE game_id = ? OR CAST(json_extract(puzzle_json, '$.appId') AS TEXT) = ? LIMIT 1`,
                [existing.id, game.steam_app_id]);
            // Apply this trial only to unused games. Frozen puzzles, including
            // tomorrow's prepared answer, remain exactly as originally saved.
            if (existing.last_played_on || legacyUse || snapshot) {
                protectedGames.push(game.steam_app_id);
                continue;
            }
            const current = await all(`SELECT review_page_url, review_data FROM game_reviews
                WHERE game_id = ? ORDER BY clue_order`, existing.id);
            if (existing.steam_app_id === game.steam_app_id && current.length === 6 &&
                current.every((row, index) => row.review_page_url === game.clues[index].url &&
                    row.review_data === JSON.stringify(game.clues[index].data))) continue;
            await run('UPDATE games SET steam_app_id = ? WHERE id = ?', [game.steam_app_id, existing.id]);
            await run('DELETE FROM game_reviews WHERE game_id = ?', existing.id);
            for (const [index, clue] of game.clues.entries()) {
                await run(`INSERT INTO game_reviews (game_id, review_page_url, clue_order, review_data)
                    VALUES (?, ?, ?, ?)`, [existing.id, clue.url, index + 1, JSON.stringify(clue.data)]);
            }
            imported.push(game.steam_app_id);
        }
        await run('COMMIT');
    } catch (error) {
        await run('ROLLBACK');
        throw error;
    }
    return { imported, protectedGames };
}

module.exports = { prepareCuratedTrial, registerCatalogAndCuratedReviews };
