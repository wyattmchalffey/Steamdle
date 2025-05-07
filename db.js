const sqlite3 = require('sqlite3').verbose();
const path = require('path'); // Import path module

// Render's persistent disk is typically mounted at /data or /var/data
// Use an environment variable for flexibility or default to a persistent path
const persistentDiskMountPath = process.env.SQLITE_DISK_PATH || '/data'; // Render example path
const DBSOURCE = path.join(persistentDiskMountPath, "steamdle.sqlite");

console.log(`[DB_INFO] Using SQLite database at: ${DBSOURCE}`);

let db = new sqlite3.Database(DBSOURCE, (err) => {
    if (err) {
        console.error("[DB_ERROR] Could not connect to/create database file at " + DBSOURCE + ":", err.message);
        // If EACCES here, it means your app can't WRITE the steamdle.sqlite file into /data
        // This would point to a problem with disk permissions or the disk not being mounted.
        // No need to throw err here, as initializeDatabaseStructure will be called and log further if it fails.
    } else {
        console.log("[DB_INFO] Successfully opened/created SQLite database file at:", DBSOURCE);
    }
    // Proceed to initialize structure regardless of initial open error,
    // as table creation might also provide more specific errors.
    initializeDatabaseStructure();
});

function initializeDatabaseStructure() {
    console.log("[DB_INFO] Initializing database structure...");
    db.exec(`
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL UNIQUE,
            steam_app_id TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS game_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER NOT NULL,
            review_image_url TEXT NOT NULL, /* Stores relative path like /images/reviews/image.png */
            clue_order INTEGER NOT NULL,    /* 1 through 6 */
            FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
        );
    `, (err) => {
        if (err) {
            console.error("[DB_ERROR] Error creating tables:", err.message);
        } else {
            console.log("[DB_INFO] Tables 'games' and 'game_reviews' integrity check/creation successful.");
            checkAndSeedDatabase();
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
            console.warn("[DB_WARN] Could not retrieve game count for 'games' table. Seeding status unknown.");
        }
    });
}

async function seedInitialData() {
    console.log("[SEED_INFO] --- Starting seedInitialData ---");

    //
    // >>> IMPORTANT ACTION FOR YOU: <<<<
    // Define your games here.
    // - 'title': The exact game title players will guess.
    // - 'steam_app_id': The game's ID on Steam (from its store page URL).
    // - 'reviews': An array of 6 strings. Each string MUST be a RELATIVE PATH
    //              to a review screenshot image you have saved in your
    //              `public/images/reviews/` folder.
    //              Example path: "/images/reviews/portal2_clue1.png"
    //
    const gamesToSeed = [
        {
            title: "Portal 2",
            steam_app_id: "620",
            reviews: [
                "/images/reviews/portal2_1.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/portal2_2.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/portal2_3.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/portal2_4.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/portal2_5.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/portal2_6.png"  // MAKE SURE THIS FILE EXISTS
            ]
        },
        {
            title: "Stardew Valley",
            steam_app_id: "413150",
            reviews: [
                "/images/reviews/stardew_review1.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/stardew_review2.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/stardew_review3.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/stardew_review4.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/stardew_review5.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/stardew_review6.png"  // MAKE SURE THIS FILE EXISTS
            ]
        },
        {
            title: "Blue Prince",
            steam_app_id: "1569580",
            reviews: [
                "/images/reviews/blueprince_1.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/blueprince_1.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/blueprince_1.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/blueprince_1.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/blueprince_1.png", // MAKE SURE THIS FILE EXISTS
                "/images/reviews/blueprince_1.png"  // MAKE SURE THIS FILE EXISTS
            ]
        },
        {
            title: "Factorio",
            steam_app_id: "427520",
            reviews: [
                "/images/reviews/factorio_review1.png",
                "/images/reviews/factorio_review2.png",
                "/images/reviews/factorio_review3.png",
                "/images/reviews/factorio_review4.png",
                "/images/reviews/factorio_review5.png",
                "/images/reviews/factorio_review6.png"
            ]
        },
        // Add more game objects here following the exact same structure.
        // Ensure you have 6 review image paths for each.
        // {
        //     title: "Your Next Game Title",
        //     steam_app_id: "YOUR_APP_ID",
        //     reviews: [
        //         "/images/reviews/yourgame_clue1.png",
        //         "/images/reviews/yourgame_clue2.png",
        //         "/images/reviews/yourgame_clue3.png",
        //         "/images/reviews/yourgame_clue4.png",
        //         "/images/reviews/yourgame_clue5.png",
        //         "/images/reviews/yourgame_clue6.png"
        //     ]
        // }
    ];

    if (!gamesToSeed || gamesToSeed.length === 0) {
        console.warn("[SEED_WARN] 'gamesToSeed' array is empty or undefined. No data will be seeded.");
        return;
    }

    for (const gameData of gamesToSeed) {
        console.log(`[SEED_INFO] Processing game for seeding: "${gameData.title}" (App ID: ${gameData.steam_app_id})`);

        // Basic validation of gameData structure
        if (!gameData.title || !gameData.steam_app_id || !gameData.reviews || gameData.reviews.length !== 6) {
            console.error(`[SEED_ERROR] Invalid data structure or missing 6 reviews for "${gameData.title || 'UNKNOWN GAME'}". Skipping this entry.`, gameData);
            continue;
        }

        try {
            // Check if game already exists by title (to prevent duplicates if script runs multiple times on populated DB)
            const gameRow = await new Promise((resolve, reject) => {
                db.get("SELECT id FROM games WHERE title = ?", [gameData.title], (err, row) => {
                    err ? reject(err) : resolve(row);
                });
            });

            if (gameRow) {
                console.log(`[SEED_INFO] Game "${gameData.title}" (ID: ${gameRow.id}) already exists. Skipping game and review insertion for this entry.`);
                continue; 
            }
            
            // Insert the game
            const gameInsertResult = await new Promise((resolve, reject) => {
                db.run("INSERT INTO games (title, steam_app_id) VALUES (?, ?)", 
                       [gameData.title, gameData.steam_app_id], 
                       function(err) { // Must use 'function' for 'this.lastID'
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

            // Insert its reviews
            console.log(`[SEED_INFO] Attempting to insert ${gameData.reviews.length} reviews for Game ID ${gameId} ("${gameData.title}")`);
            for (let i = 0; i < gameData.reviews.length; i++) {
                const reviewImageUrl = gameData.reviews[i];
                 if (!reviewImageUrl || typeof reviewImageUrl !== 'string' || !reviewImageUrl.startsWith('/images/reviews/')) {
                    console.error(`[SEED_ERROR] Invalid review image URL for game "${gameData.title}", review ${i+1}: "${reviewImageUrl}". Skipping this review.`);
                    continue;
                }
                await new Promise((resolve_rev, reject_rev) => {
                    db.run("INSERT INTO game_reviews (game_id, review_image_url, clue_order) VALUES (?, ?, ?)", 
                           [gameId, reviewImageUrl, i + 1], (err_rev) => {
                        if (err_rev) {
                            console.error(`[SEED_DB_ERROR]   Error inserting review "${reviewImageUrl}" for Game ID ${gameId}:`, err_rev.message);
                            reject_rev(err_rev);
                        } else {
                            console.log(`[SEED_SUCCESS]   Successfully inserted review ${i+1} ("${reviewImageUrl}") for Game ID ${gameId}.`);
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