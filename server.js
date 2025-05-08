const express = require('express');
const cors = require('cors');
const db = require('./db.js'); // Your database connection and seeding logic

const app = express();
const PORT = process.env.PORT || 3000;

// --- Steam App List Cache (for autocomplete) ---
// In a larger app, this might use Redis or another external cache
let steamAppsCache = []; 
let lastSteamAppsFetchTime = 0;
const STEAM_APPS_CACHE_DURATION = 24 * 60 * 60 * 1000; // Cache for 24 hours

// --- Middleware ---
app.use(cors()); // Allows requests from different origins (useful for development)
app.use(express.json()); // Parses incoming JSON requests (not strictly needed for these GETs yet)
app.use(express.static('public')); // Serve static files (HTML, CSS, JS, images) from the 'public' directory

// --- Helper: Fetch and Cache Steam App List (for autocomplete) ---
async function fetchAndCacheSteamApps() {
    console.log("[STEAM_API_INFO] Attempting to fetch Steam app list for autocomplete...");
    try {
        const response = await fetch('https://api.steampowered.com/ISteamApps/GetAppList/v2/'); // Built-in fetch (Node 18+)
        if (!response.ok) {
            throw new Error(`Steam API request failed with status: ${response.status}`);
        }
        const data = await response.json();
        if (data.applist && data.applist.apps) {
            steamAppsCache = data.applist.apps
                .filter(app => app.name && app.name.trim() !== "") // Ensure name exists
                .map(app => (app.name)) // Keep only name
            steamAppsCache.sort((a, b) => a.localeCompare(b)); // Sort for consistency
            steamAppsCache = [ ...new Set(steamAppsCache) ]; //remove duplicate names
            lastSteamAppsFetchTime = Date.now();
            console.log(`[STEAM_API_SUCCESS] Successfully fetched and cached ${steamAppsCache.length} Steam apps.`);
        } else {
            console.error("[STEAM_API_ERROR] Steam API returned an unexpected data structure for app list.");
        }
    } catch (error) {
        console.error("[STEAM_API_ERROR] Failed to fetch or process Steam app list:", error.message);
    }
}

// --- API Endpoints ---

// Autocomplete for game titles
app.get('/api/search-steam-games', async (req, res) => {
    const currentTime = Date.now();
    if (steamAppsCache.length === 0 || (currentTime - lastSteamAppsFetchTime > STEAM_APPS_CACHE_DURATION)) {
        console.log("[SERVER_INFO] Autocomplete cache is empty or stale. Re-fetching Steam apps...");
        await fetchAndCacheSteamApps();
    }

    const searchTerm = req.query.term ? req.query.term.toLowerCase().trim() : "";
    const limit = parseInt(req.query.limit, 10) || 15; // Default to 15 suggestions

    if (!searchTerm || searchTerm.length < 2) { // Require at least 2 characters
        return res.json([]); 
    }

    const suggestions = steamAppsCache
        .filter(name => name.toLowerCase().includes(searchTerm))
        .slice(0, limit);

    res.json(suggestions); // Send back only the names
});

// Get the daily game and its review image URLs
app.get('/api/daily-game', (req, res) => {
    console.log("[SERVER_INFO] Request received for /api/daily-game");
    
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 0);
    const diff = now - startOfYear;
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);

    db.get("SELECT COUNT(*) as count FROM games", (err, row) => {
        if (err) {
            console.error("[DB_ERROR] Daily game: Error counting games in DB:", err.message);
            return res.status(500).json({ error: "Database error occurred while counting games." });
        }
        if (!row || row.count === 0) {
            console.warn("[DB_WARN] Daily game: 'games' table is empty or count is zero. Cannot serve a daily game.");
            return res.status(500).json({ error: "No games available in the database to select for today." });
        }
        
        const totalGames = row.count;
        const gameOffset = (dayOfYear -1) % totalGames; // dayOfYear is 1-indexed, offset is 0-indexed
        console.log(`[SERVER_INFO] Daily game: Total games: ${totalGames}, Day of year: ${dayOfYear}, Calculated offset: ${gameOffset}`);

        // Fetch the game by its offset in an ordered list (ensures somewhat consistent daily game)
        db.get("SELECT id, title, steam_app_id FROM games ORDER BY id LIMIT 1 OFFSET ?", [gameOffset], (err, game) => {
            if (err) {
                console.error("[DB_ERROR] Daily game: Error fetching game with offset:", err.message);
                return res.status(500).json({ error: "Could not fetch the selected game from database." });
            }
            if (!game) {
                console.warn(`[DB_WARN] Daily game: No game found for offset ${gameOffset}. Attempting fallback to the very first game.`);
                // Fallback if calculated offset yields no game (e.g., if IDs are not sequential or some deleted)
                db.get("SELECT id, title, steam_app_id FROM games ORDER BY id LIMIT 1", (errFallback, fallbackGame) => {
                    if(errFallback || !fallbackGame) {
                        console.error("[DB_ERROR] Daily game: Fallback to first game also failed.", errFallback?.message);
                        return res.status(404).json({ error: "Game not found for today and no fallback is available." });
                    }
                    console.log(`[SERVER_INFO] Daily game: Serving fallback game ID ${fallbackGame.id}: ${fallbackGame.title}`);
                    fetchReviewsForGameAndRespond(fallbackGame, res);
                });
            } else {
                console.log(`[SERVER_INFO] Daily game: Serving game ID ${game.id}: "${game.title}"`);
                fetchReviewsForGameAndRespond(game, res);
            }
        });
    });
});

// Helper to fetch reviews for a given game and send the response
function fetchReviewsForGameAndRespond(game, res) {
    db.all("SELECT review_image_url FROM game_reviews WHERE game_id = ? ORDER BY clue_order ASC LIMIT 6", [game.id], (err, reviews) => {
        if (err) {
            console.error(`[DB_ERROR] Error fetching reviews for game ID ${game.id} ("${game.title}"):`, err.message);
            return res.status(500).json({ error: "Could not fetch reviews for the selected game." });
        }
        if (reviews.length === 0) {
            console.warn(`[DB_WARN] No reviews found in database for game ID ${game.id} ("${game.title}"). The game will have no clues.`);
        } else if (reviews.length < 6) {
            console.warn(`[DB_WARN] Fewer than 6 reviews (${reviews.length}) found for game ID ${game.id} ("${game.title}").`);
        }
        console.log(`[SERVER_INFO] Found ${reviews.length} reviews for game ID ${game.id}.`);
        
        res.json({
            title: game.title,
            appId: game.steam_app_id,
            reviews: reviews.map(r => r.review_image_url) // Array of image URLs
        });
    });
}

// --- Start Server ---
// Initial fetch of Steam apps for autocomplete when server starts
fetchAndCacheSteamApps().then(() => {
    app.listen(PORT, () => {
        console.log(`[SERVER_INFO] Steamdle server started successfully on http://localhost:${PORT}`);
        console.log(`[SERVER_INFO] Frontend should be accessible at http://localhost:${PORT}/ (or /index.html)`);
    });
}).catch(initialError => {
    console.error("[SERVER_FATAL] A critical error occurred during server startup (e.g., initial Steam App fetch):", initialError);
    // Optionally, try to start server anyway for non-Steam API dependent parts or for easier debugging of DB issues.
    app.listen(PORT, () => { 
        console.warn(`[SERVER_WARN] Steamdle server started on http://localhost:${PORT} BUT with an initial error. Some features like autocomplete might be affected.`);
    });
});