const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// --- Configuration for Database Path ---
const isProduction = process.env.NODE_ENV === 'production'; // Render typically sets NODE_ENV to 'production'

let dbDirectory;
if (isProduction) {
    // Path for Render's persistent disk
    // Ensure RENDER_DISK_MOUNT_PATH environment variable is set in Render if you use it,
    // otherwise it defaults to /data.
    const persistentDiskMountPath = process.env.RENDER_DISK_MOUNT_PATH || '/data';
    dbDirectory = path.join(persistentDiskMountPath, 'database_files'); // Using 'database_files' as subdirectory name
    console.log(`[DB_INFO] PRODUCTION mode: Using persistent disk path for database: ${dbDirectory}`);
} else {
    // Path for local development
    dbDirectory = path.join(__dirname, 'local_sqlite_db'); // Creates 'local_sqlite_db' folder in your project root
    console.log(`[DB_INFO] DEVELOPMENT mode: Using local path for database: ${dbDirectory}`);
}

// Ensure the database directory exists (for both local and Render)
if (!fs.existsSync(dbDirectory)) {
    try {
        fs.mkdirSync(dbDirectory, { recursive: true });
        console.log(`[DB_INFO] Successfully created database directory: ${dbDirectory}`);
    } catch (e) {
        console.error(`[DB_CRITICAL_ERROR] Could not create database directory at ${dbDirectory}:`, e.message);
        throw e; // Stop if we can't create the DB directory, as DB operations will fail
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
        // SQLITE_CANTOPEN is a common error here if permissions are wrong on dbDirectory
        // or if the path is invalid. The application might continue, but DB ops will fail.
    } else {
        console.log("[DB_INFO] Successfully opened/created SQLite database file at:", DBSOURCE);
    }
    // Proceed to initialize structure even if initial open had issues,
    // as table creation attempts might give more specific errors or succeed if the file was just created.
    initializeDatabaseStructure();
});

function initializeDatabaseStructure() {
    console.log("[DB_INFO] Initializing database structure (tables 'games' and 'game_reviews')...");
    db.exec(`
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL UNIQUE,
            steam_app_id TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS game_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER NOT NULL,
            review_page_url TEXT NOT NULL UNIQUE, /* Stores URL to the Steam Review Page */
            clue_order INTEGER NOT NULL,          /* 1 through 6 */
            FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
        );
    `, (err) => {
        if (err) {
            console.error("[DB_ERROR] Error during table creation (games, game_reviews):", err.message);
        } else {
            console.log("[DB_INFO] Tables 'games' and 'game_reviews' integrity check/creation successful.");
            checkAndSeedDatabase(); // Proceed to check if seeding is needed
        }
    });
}

function checkAndSeedDatabase() {
    db.get("SELECT COUNT(*) as count FROM games", (err, row) => {
        if (err) {
            console.error("[DB_ERROR] Error checking 'games' table count for seeding:", err.message);
            return;
        }

        if (row && row.count === 0) {
            console.log("[DB_INFO] 'games' table is empty. Attempting to seed initial data...");
            seedInitialData();
        } else if (row) {
            console.log(`[DB_INFO] 'games' table already contains ${row.count} entries. Seeding process skipped.`);
        } else {
            // This case should ideally not be reached if the query itself doesn't error.
            console.warn("[DB_WARN] Could not retrieve game count for 'games' table. Seeding status unknown.");
        }
    });
}

async function seedInitialData() {
    console.log("[SEED_INFO] --- Starting seedInitialData ---");

    // >>> IMPORTANT ACTION FOR YOU: <<<
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
        console.warn("[SEED_WARN] 'gamesToSeed' array is empty or undefined. No data will be seeded.");
        return;
    }

    for (const gameData of gamesToSeed) {
        console.log(`[SEED_INFO] Processing game for seeding: "${gameData.title}" (App ID: ${gameData.steam_app_id})`);

        if (!gameData.title || !gameData.steam_app_id || !Array.isArray(gameData.reviews) || gameData.reviews.length === 0) {
            console.error(`[SEED_ERROR] Invalid data structure or missing reviews for "${gameData.title || 'UNKNOWN GAME'}". Skipping this entry.`);
            continue;
        }
        if (gameData.reviews.length !== 6) {
            console.warn(`[SEED_WARN] Game "${gameData.title}" has ${gameData.reviews.length} reviews, expected 6. Proceeding, but game might not have enough clues.`);
        }


        try {
            const gameRow = await new Promise((resolve, reject) => {
                db.get("SELECT id FROM games WHERE title = ?", [gameData.title], (err, row) => {
                    err ? reject(err) : resolve(row);
                });
            });

            if (gameRow) {
                console.log(`[SEED_INFO] Game "${gameData.title}" (ID: ${gameRow.id}) already exists. Skipping game and review insertion.`);
                continue;
            }

            const gameInsertResult = await new Promise((resolve, reject) => {
                db.run("INSERT INTO games (title, steam_app_id) VALUES (?, ?)",
                    [gameData.title, gameData.steam_app_id],
                    function (err) {
                        if (err) {
                            console.error(`[SEED_DB_ERROR] Error inserting game "${gameData.title}":`, err.message);
                            reject(err);
                        } else {
                            console.log(`[SEED_SUCCESS] Inserted game "${gameData.title}", new Game ID: ${this.lastID}`);
                            resolve(this.lastID);
                        }
                    });
            });
            const gameId = gameInsertResult;

            console.log(`[SEED_INFO] Attempting to insert ${gameData.reviews.length} review URLs for Game ID ${gameId} ("${gameData.title}")`);
            for (let i = 0; i < gameData.reviews.length; i++) {
                const reviewPageUrl = gameData.reviews[i];

                // Corrected Validation for full HTTP/HTTPS URLs
                if (!reviewPageUrl || typeof reviewPageUrl !== 'string' ||
                    !(reviewPageUrl.toLowerCase().startsWith('http://') || reviewPageUrl.toLowerCase().startsWith('https://'))) {
                    console.error(`[SEED_ERROR] Invalid review page URL format for game "${gameData.title}", review ${i + 1}: "${reviewPageUrl}". Skipping this review URL.`);
                    continue;
                }

                console.log(`[SEED_INFO]   Inserting review page URL ${i + 1}: "${reviewPageUrl}" for Game ID ${gameId}`);
                await new Promise((resolve_rev, reject_rev) => {
                    db.run("INSERT INTO game_reviews (game_id, review_page_url, clue_order) VALUES (?, ?, ?)",
                        [gameId, reviewPageUrl, i + 1], (err_rev) => {
                            if (err_rev) {
                                // SQLITE_CONSTRAINT_UNIQUE error here means the review_page_url is already in the DB (good for preventing duplicates)
                                console.error(`[SEED_DB_ERROR]   Error inserting review page URL "${reviewPageUrl}" for Game ID ${gameId}:`, err_rev.message);
                                reject_rev(err_rev);
                            } else {
                                console.log(`[SEED_SUCCESS]   Successfully inserted review page URL ${i + 1} for Game ID ${gameId}.`);
                                resolve_rev();
                            }
                        });
                });
            }
        } catch (err) {
            console.error(`[SEED_EXCEPTION] Exception during seeding process for game "${gameData.title || 'UNKNOWN GAME'}":`, err.message, err.stack);
        }
    }
    console.log("[SEED_INFO] --- Finished seedInitialData execution ---");
    console.log("[DB_INFO] Please check the logs above for any SEED_ERROR or SEED_DB_ERROR messages.");
}

module.exports = db;