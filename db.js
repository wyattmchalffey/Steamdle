const sqlite3 = require('sqlite3').verbose();
const catalog = require('./catalog');
const path = require('path');
const fs = require('fs');
const { fetchGameClues } = require('./clues');
const { promisify } = require('util');

// --- Configuration for Database Path ---
const isProduction = process.env.NODE_ENV === 'production';

let dbDirectory;
if (isProduction) {
    const persistentDiskMountPath = process.env.RENDER_DISK_MOUNT_PATH || '/data';
    dbDirectory = path.join(persistentDiskMountPath, 'database_files');
    console.log(`[DB_INFO] PRODUCTION mode: Using persistent disk path for database: ${dbDirectory}`);
} else {
    dbDirectory = path.join(__dirname, 'local_sqlite_db');
    console.log(`[DB_INFO] DEVELOPMENT mode: Using local path for database: ${dbDirectory}`);
}

if (!fs.existsSync(dbDirectory)) {
    try {
        fs.mkdirSync(dbDirectory, { recursive: true });
        console.log(`[DB_INFO] Successfully created database directory: ${dbDirectory}`);
    } catch (e) {
        console.error(`[DB_CRITICAL_ERROR] Could not create database directory at ${dbDirectory}:`, e.message);
        throw e;
    }
} else {
    console.log(`[DB_INFO] Database directory already exists: ${dbDirectory}`);
}

const DBSOURCE = path.join(dbDirectory, "steamdle.sqlite");
// --- End Configuration for Database Path ---

console.log(`[DB_INFO] Attempting to connect to/create SQLite database at: ${DBSOURCE}`);
let db;
const opened = new Promise((resolve, reject) => {
    db = new sqlite3.Database(DBSOURCE, err => err ? reject(err) : resolve());
});

db.ready = opened.then(async () => {
    const exec = promisify(db.exec.bind(db));
    await exec("BEGIN IMMEDIATE");
    try {
        await exec(`
            CREATE TABLE IF NOT EXISTS games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL UNIQUE,
                steam_app_id TEXT NOT NULL,
                last_played_on DATE,
                is_active BOOLEAN DEFAULT TRUE
            );

            CREATE TABLE IF NOT EXISTS game_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id INTEGER NOT NULL,
                review_page_url TEXT NOT NULL UNIQUE,
                clue_order INTEGER NOT NULL,
                review_data TEXT,
                FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS daily_puzzles (
                puzzle_date TEXT PRIMARY KEY,
                game_id INTEGER NOT NULL,
                puzzle_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_daily_puzzles_game_date ON daily_puzzles(game_id, puzzle_date);
        `);
        const columns = await promisify(db.all.bind(db))('PRAGMA table_info(game_reviews)');
        if (!columns.some(column => column.name === 'review_data')) {
            await exec('ALTER TABLE game_reviews ADD COLUMN review_data TEXT');
        }
        await exec('COMMIT');
    } catch (error) {
        await exec('ROLLBACK');
        throw error;
    }
});
db.ready.then(checkAndSeedDatabase).catch(error => {
    console.error('[DB_ERROR] Could not initialize Steamdle data:', error.message);
});

function checkAndSeedDatabase() {
    // This function will now always call seedInitialData.
    // The upsert logic within seedInitialData handles existing/new data.
    // An optional environment variable could be used to disable seeding if ever needed.
    if (process.env.DISABLE_DB_SEED === 'true') {
        console.log("[DB_INFO] Database seeding is disabled via DISABLE_DB_SEED environment variable.");
        return;
    }
    console.log("[DB_INFO] Preparing to synchronize database with seed data (upsert mode)...");
    return seedInitialData();
}

async function saveGameReviews(game, clues) {
    // A separate connection keeps requests from reading uncommitted clue replacements.
    const writer = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(DBSOURCE, err => err ? reject(err) : resolve(connection));
    });
    const run = promisify(writer.run.bind(writer));
    const get = promisify(writer.get.bind(writer));
    try {
        await run("BEGIN IMMEDIATE");
        const { id } = await get(
            `INSERT INTO games (title, steam_app_id) VALUES (?, ?)
             ON CONFLICT(title) DO UPDATE SET steam_app_id = excluded.steam_app_id
             RETURNING id`, [game.title, game.steam_app_id]
        );
        await run("DELETE FROM game_reviews WHERE game_id = ?", [id]);
        for (const [index, clue] of clues.entries()) {
            await run("INSERT INTO game_reviews (game_id, review_page_url, clue_order, review_data) VALUES (?, ?, ?, ?)",
                [id, clue.url, index + 1, clue.data ? JSON.stringify(clue.data) : null]);
        }
        await run("COMMIT");
    } finally {
        // SQLite rolls back an uncommitted transaction when its connection closes.
        await promisify(writer.close.bind(writer))();
    }
}

async function seedInitialData() {
    console.log("[SEED_INFO] --- Starting seedInitialData (Auto-fetch Mode) ---");

    const forceReseed = process.env.FORCE_RESEED === 'true';
    if (forceReseed) {
        console.log("[SEED_INFO] FORCE_RESEED=true: All games will be re-fetched with the new tiered algorithm.");
    }

    const gamesToSeed = [...catalog];

    if (!gamesToSeed || gamesToSeed.length === 0) {
        console.warn("[SEED_WARN] 'gamesToSeed' array is empty. No data will be seeded or cleaned up.");
        return;
    }

    // Get all current games from the database with their review counts
    const dbGames = await new Promise((resolve, reject) => {
        db.all(`SELECT g.id, g.title, g.steam_app_id, COUNT(r.id) AS review_count, COUNT(r.review_data) AS stored_count,
                       g.last_played_on = DATE('now') AS played_today
                FROM games g LEFT JOIN game_reviews r ON r.game_id = g.id GROUP BY g.id`, (err, rows) => {
            err ? reject(err) : resolve(rows || []);
        });
    });

    const titlesToSeed = gamesToSeed.map(g => g.title);
    const existingByTitle = new Map(dbGames.map(game => [game.title, game]));
    // Repair today's puzzle first on startup, before the rest of the catalog.
    gamesToSeed.sort((a, b) => (existingByTitle.get(b.title)?.played_today || 0)
        - (existingByTitle.get(a.title)?.played_today || 0));

    // 1. Process games in gamesToSeed
    let apiCallCount = 0;
    for (const gameData of gamesToSeed) {
        // Basic validation
        if (!gameData.title || !gameData.steam_app_id) {
            console.error(`[SEED_ERROR] Invalid data for "${gameData.title || 'UNTITLED'}". Skipping.`);
            continue;
        }

        try {
            const existingGame = existingByTitle.get(gameData.title);
            // Keep today's published game and its clue order intact across the migration.
            const manualReviews = Array.isArray(gameData.reviews) && gameData.reviews.length >= 6;
            if (existingGame?.steam_app_id === gameData.steam_app_id && existingGame.review_count >= 6 &&
                (existingGame.played_today || (!forceReseed && (manualReviews || existingGame.stored_count >= 6)))) {
                continue;
            }

            // Get review URLs: manual override or auto-fetch from API
            let clues;
            if (manualReviews) {
                console.log(`[SEED_INFO] Using manual review URLs for "${gameData.title}".`);
                const urls = [...new Set(gameData.reviews.filter(url => typeof url === 'string' && /^https:\/\/\S+$/i.test(url)))];
                clues = urls.slice(0, 6).map(url => ({ url, data: null }));
            } else {
                // Rate limit: 1.5s delay between API calls
                if (apiCallCount > 0) {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
                apiCallCount++;
                clues = await fetchGameClues(gameData.steam_app_id, gameData.title);
            }

            if (clues.length !== 6) {
                console.warn(`[SEED_WARN] No complete set with two distinct closing clues for "${gameData.title}". Keeping existing clues.`);
                continue;
            }

            await saveGameReviews(gameData, clues);
            console.log(`[SEED_SUCCESS] Saved six reviews for "${gameData.title}".`);
        } catch (err) {
            console.error(`[SEED_EXCEPTION] During upsert for "${gameData.title || 'UNTITLED'}":`, err.message, err.stack);
        }
    }

    // 2. Clean up: Remove games from DB that are no longer in gamesToSeed
    for (const dbGame of dbGames) {
        if (!titlesToSeed.includes(dbGame.title)) {
            console.log(`[SEED_INFO] Game "${dbGame.title}" (ID: ${dbGame.id}) is in DB but not in seed list. Deleting.`);
            try {
                await new Promise((resolve, reject) => {
                    // FOREIGN KEY ON DELETE CASCADE will also remove its reviews
                    db.run("DELETE FROM games WHERE id = ?", [dbGame.id], (err) => {
                        if (err) {
                            console.error(`[SEED_DB_ERROR] Error deleting obsolete game "${dbGame.title}":`, err.message);
                            reject(err);
                        } else {
                            console.log(`[SEED_SUCCESS] Deleted obsolete game "${dbGame.title}".`);
                            resolve();
                        }
                    });
                });
            } catch (err) {
                console.error(`[SEED_EXCEPTION] During cleanup of "${dbGame.title}":`, err.message);
            }
        }
    }

    console.log("[SEED_INFO] --- Finished seedInitialData (Auto-fetch Mode) ---");
}

module.exports = db;
