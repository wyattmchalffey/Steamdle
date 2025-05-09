const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

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
let db = new sqlite3.Database(DBSOURCE, (err) => {
    if (err) {
        console.error("[DB_ERROR] Could not connect to/create database file. Error:", err.message);
    } else {
        console.log("[DB_INFO] Successfully opened/created SQLite database file at:", DBSOURCE);
    }
    initializeDatabaseStructure();
});

function initializeDatabaseStructure() {
    console.log("[DB_INFO] Initializing database structure (tables 'games' and 'game_reviews')...");
    db.serialize(() => { // Use serialize to ensure table creation finishes before seeding check
        db.exec(`
            CREATE TABLE IF NOT EXISTS games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL UNIQUE,
                steam_app_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS game_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id INTEGER NOT NULL,
                review_page_url TEXT NOT NULL UNIQUE,
                clue_order INTEGER NOT NULL,
                FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
            );
        `, (err) => {
            if (err) {
                console.error("[DB_ERROR] Error during table creation (games, game_reviews):", err.message);
            } else {
                console.log("[DB_INFO] Tables 'games' and 'game_reviews' integrity check/creation successful.");
                // Call checkAndSeedDatabase AFTER tables are confirmed to exist
                checkAndSeedDatabase();
            }
        });
    });
}

function checkAndSeedDatabase() {
    // This function will now always call seedInitialData.
    // The upsert logic within seedInitialData handles existing/new data.
    // An optional environment variable could be used to disable seeding if ever needed.
    if (process.env.DISABLE_DB_SEED === 'true') {
        console.log("[DB_INFO] Database seeding is disabled via DISABLE_DB_SEED environment variable.");
        return;
    }
    console.log("[DB_INFO] Preparing to synchronize database with seed data (upsert mode)...");
    seedInitialData();
}

async function seedInitialData() {
    console.log("[SEED_INFO] --- Starting seedInitialData (Upsert & Cleanup Mode) ---");

    // Define your games here.
    // - 'title': The exact game title players will guess.
    // - 'steam_app_id': The game's ID on Steam (from its store page URL).
    // - 'reviews': An array of 6 strings. Each string MUST be a FULL URL
    //              to an actual Steam review page.
    //              Example: "https://steamcommunity.com/id/someuser/recommended/12345/"
    const gamesToSeed = [
        {
            title: "Portal 2",
            steam_app_id: "620",
            reviews: [
                "https://steamcommunity.com/id/Etra_/recommended/620/", // MAKE SURE THIS FILE EXISTS
                "https://steamcommunity.com/profiles/76561198883403386/recommended/400/", // MAKE SURE THIS FILE EXISTS
                "https://steamcommunity.com/profiles/76561198401838613/recommended/620/", // MAKE SURE THIS FILE EXISTS
                "https://steamcommunity.com/id/possysillyboy/recommended/620/", // MAKE SURE THIS FILE EXISTS
                "https://steamcommunity.com/profiles/76561199076991591/recommended/620/", // MAKE SURE THIS FILE EXISTS
                "https://steamcommunity.com/id/hangover66st/recommended/620/"  // MAKE SURE THIS FILE EXISTS
            ]
        },
        {
            title: "Stardew Valley",
            steam_app_id: "413150",
            reviews: [
                "https://steamcommunity.com/id/Kekkykekkekkekky/recommended/413150/",
                "https://steamcommunity.com/id/Focusta_/recommended/413150/",
                "https://steamcommunity.com/id/ItsDommyMommy/recommended/413150/",
                "https://steamcommunity.com/profiles/76561198261179773/recommended/413150/",
                "https://steamcommunity.com/id/nuance/recommended/413150/",
                "https://steamcommunity.com/id/killerzimmer/recommended/413150/"
            ]
        },
        {
            title: "Terraria",
            steam_app_id: "105600",
            reviews: [
                "https://steamcommunity.com/id/sugarfanged/recommended/105600/",
                "https://steamcommunity.com/id/CornetTheory/recommended/105600/",
                "https://steamcommunity.com/profiles/76561199014671970/recommended/105600/",
                "https://steamcommunity.com/profiles/76561199003326280/recommended/105600/",
                "https://steamcommunity.com/id/ClarifiedClara/recommended/105600/",
                "https://steamcommunity.com/profiles/76561199480521925/recommended/105600/"
            ]
        },
        {
            title: "Satisfactory",
            steam_app_id: "526870",
            reviews: [
                "https://steamcommunity.com/profiles/76561198994752998/recommended/526870/",
                "https://steamcommunity.com/id/GalaxyFops/recommended/526870/",
                "https://steamcommunity.com/profiles/76561198119457419/recommended/526870/",
                "https://steamcommunity.com/id/aByZMaI/recommended/526870/",
                "https://steamcommunity.com/profiles/76561198127775791/recommended/526870/",
                "https://steamcommunity.com/id/NeoVexan/recommended/526870/"
            ]
        },
        {
            title: "Apex Legends",
            steam_app_id: "1172470",
            reviews: [
                "https://steamcommunity.com/id/Impades/recommended/1172470/",
                "https://steamcommunity.com/id/jacobmuno/recommended/1172470/",
                "https://steamcommunity.com/profiles/76561198258941202/recommended/1172470/",
                "https://steamcommunity.com/id/IWasAbadGirl/recommended/1172470/",
                "https://steamcommunity.com/id/kenyylol/recommended/1172470/",
                "https://steamcommunity.com/id/5tock/recommended/1172470/"
            ]
        },
        {
            title: "Elden Ring",
            steam_app_id: "1245620",
            reviews: [
                "https://steamcommunity.com/profiles/76561198038703897/recommended/1245620/",
                "https://steamcommunity.com/id/RtKitty/recommended/1245620/",
                "https://steamcommunity.com/id/TheRealDripMonkey/recommended/1245620/",
                "https://steamcommunity.com/id/76561198004031162/recommended/1245620/",
                "https://steamcommunity.com/id/haisyub/recommended/1245620/",
                "https://steamcommunity.com/id/schyeah/recommended/1245620/"
            ]
        },
        // {
        //     title: "Your Next Game Title",
        //     steam_app_id: "YOUR_APP_ID",
        //     reviews: [
        //         "https://steamcommunity.com/link/to/review1",
        //         "https://steamcommunity.com/link/to/review2",
        //         "https://steamcommunity.com/link/to/review3",
        //         "https://steamcommunity.com/link/to/review4",
        //         "https://steamcommunity.com/link/to/review5",
        //         "https://steamcommunity.com/link/to/review6"
        //     ]
        // }
        // Add more game objects here
    ];

    if (!gamesToSeed || gamesToSeed.length === 0) {
        console.warn("[SEED_WARN] 'gamesToSeed' array is empty. No data will be seeded or cleaned up.");
        // Optionally, you might want to delete all existing games if gamesToSeed is empty.
        // await new Promise((resolve, reject) => db.run("DELETE FROM games", err => err ? reject(err) : resolve()));
        // console.log("[SEED_INFO] All games deleted as gamesToSeed was empty.");
        return;
    }

    // Get all current game titles from the database to compare against gamesToSeed
    const dbGames = await new Promise((resolve, reject) => {
        db.all("SELECT id, title FROM games", (err, rows) => {
            err ? reject(err) : resolve(rows);
        });
    });

    const titlesToSeed = gamesToSeed.map(g => g.title);
    const titlesInDb = dbGames.map(g => g.title);

    // 1. Process games in gamesToSeed (Upsert: Update existing, Insert new)
    for (const gameData of gamesToSeed) {
        console.log(`[SEED_INFO] Processing (Upsert): "${gameData.title}" (App ID: ${gameData.steam_app_id})`);

        // Basic validation
        if (!gameData.title || !gameData.steam_app_id || !Array.isArray(gameData.reviews) || gameData.reviews.length === 0) {
            console.error(`[SEED_ERROR] Invalid data for "${gameData.title || 'UNTITLED'}". Skipping.`);
            continue;
        }
        if (gameData.reviews.length !== 6) {
            console.warn(`[SEED_WARN] Game "${gameData.title}" has ${gameData.reviews.length} review URLs, expected 6. Game clues might be incomplete.`);
        }

        try {
            const existingGame = dbGames.find(g => g.title === gameData.title);
            let gameId;

            if (existingGame) {
                gameId = existingGame.id;
                console.log(`[SEED_INFO] Game "${gameData.title}" (ID: ${gameId}) exists. Checking for AppID update and re-seeding reviews.`);
                // Update steam_app_id if different
                if (existingGame.steam_app_id !== gameData.steam_app_id) {
                    await new Promise((resolve, reject) => {
                        db.run("UPDATE games SET steam_app_id = ? WHERE id = ?", [gameData.steam_app_id, gameId], function (err) {
                            this.changes > 0 ? console.log(`[SEED_SUCCESS] Updated AppID for "${gameData.title}".`) : console.log(`[SEED_INFO] AppID for "${gameData.title}" is current.`);
                            err ? reject(err) : resolve();
                        });
                    });
                }
                // Delete old reviews for this game to ensure fresh list
                await new Promise((resolve, reject) => {
                    db.run("DELETE FROM game_reviews WHERE game_id = ?", [gameId], (err) => {
                        console.log(`[SEED_INFO] Deleted existing reviews for Game ID ${gameId} ("${gameData.title}") to prepare for re-seed.`);
                        err ? reject(err) : resolve();
                    });
                });
            } else {
                console.log(`[SEED_INFO] Game "${gameData.title}" is new. Inserting.`);
                const result = await new Promise((resolve, reject) => {
                    db.run("INSERT INTO games (title, steam_app_id) VALUES (?, ?)", [gameData.title, gameData.steam_app_id], function (err) {
                        if (err) {
                            console.error(`[SEED_DB_ERROR] Error inserting new game "${gameData.title}":`, err.message);
                            reject(err);
                        } else {
                            console.log(`[SEED_SUCCESS] Inserted new game "${gameData.title}", Game ID: ${this.lastID}`);
                            resolve(this.lastID);
                        }
                    });
                });
                gameId = result;
            }

            // Insert current reviews for this game
            console.log(`[SEED_INFO] Inserting ${gameData.reviews.length} review URLs for Game ID ${gameId} ("${gameData.title}")`);
            for (let i = 0; i < gameData.reviews.length; i++) {
                const reviewPageUrl = gameData.reviews[i];
                if (!reviewPageUrl || typeof reviewPageUrl !== 'string' || !(reviewPageUrl.toLowerCase().startsWith('http://') || reviewPageUrl.toLowerCase().startsWith('https://'))) {
                    console.error(`[SEED_ERROR] Invalid review page URL for "${gameData.title}", URL ${i + 1}: "${reviewPageUrl}". Skipping.`);
                    continue;
                }
                await new Promise((resolve_rev, reject_rev) => {
                    // Using INSERT OR IGNORE because review_page_url is UNIQUE.
                    // This mainly helps if somehow an old review wasn't deleted and a URL is identical.
                    db.run("INSERT OR IGNORE INTO game_reviews (game_id, review_page_url, clue_order) VALUES (?, ?, ?)",
                        [gameId, reviewPageUrl, i + 1], function (err_rev) { // Use function for this.changes
                            if (err_rev) {
                                console.error(`[SEED_DB_ERROR] Error inserting review URL "${reviewPageUrl}" for Game ID ${gameId}:`, err_rev.message);
                                reject_rev(err_rev);
                            } else {
                                if (this.changes > 0) {
                                    console.log(`[SEED_SUCCESS] Inserted review URL ${i + 1} for Game ID ${gameId}.`);
                                } else {
                                    // This might happen if the URL somehow still existed and was identical (due to UNIQUE constraint)
                                    console.log(`[SEED_INFO] Review URL ${i + 1} ("${reviewPageUrl}") for Game ID ${gameId} was not inserted (possibly already exists and matched UNIQUE constraint).`);
                                }
                                resolve_rev();
                            }
                        });
                });
            }
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

    console.log("[SEED_INFO] --- Finished seedInitialData (Upsert & Cleanup Mode) ---");
}

module.exports = db;