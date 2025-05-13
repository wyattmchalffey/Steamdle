const express = require('express');
const cors = require('cors');
const db = require('./db.js'); // Your database connection and seeding logic

const axios = require('axios'); // For fetching HTML
const cheerio = require('cheerio'); // For parsing HTML

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
        await fetchAndCacheSteamApps(); // This populates steamAppsCache
    }

    const searchTermLower = req.query.term ? req.query.term.toLowerCase().trim() : "";
    const limit = parseInt(req.query.limit, 10) || 15;

    if (!searchTermLower || searchTermLower.length < 2) {
        return res.json([]);
    }

    // 1. Filter all names that include the search term
    let allMatches = steamAppsCache.filter(appName => {
        if (typeof appName === 'string') { // Ensure we are working with strings
            return appName.toLowerCase().includes(searchTermLower);
        }
        return false;
    });

    // 2. Sort these matches to prioritize those that start with the search term
    allMatches.sort((a, b) => {
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();

        const aStartsWith = aLower.startsWith(searchTermLower);
        const bStartsWith = bLower.startsWith(searchTermLower);

        if (aStartsWith && !bStartsWith) {
            return -1; // a comes before b
        }
        if (!aStartsWith && bStartsWith) {
            return 1;  // b comes before a
        }

        // If both start with the term, or neither does (but both include it),
        // sort alphabetically as a secondary criterion.
        return aLower.localeCompare(bLower);
    });

    // 3. Take the top 'limit' results
    const finalSuggestions = allMatches.slice(0, limit);

    // If steamAppsCache stores strings:
    res.json(finalSuggestions);
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

// Helper function to scrape a single Steam review page
async function scrapeSteamReview(reviewUrl) {
    console.log(`[SCRAPER_INFO] Attempting to scrape review: ${reviewUrl}`);
    try {
        const { data: html } = await axios.get(reviewUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        const $ = cheerio.load(html);
        const reviewData = {};

        // 1. Reviewer Name
        // From: <a class="whiteLink persona_name_text_content" href="https://steamcommunity.com/id/Etra_">etra</a>
        reviewData.reviewerName = $('.profile_small_header_name a.persona_name_text_content').text().trim();
        if (!reviewData.reviewerName) { // Fallback if the above is not found (e.g., different profile structure)
            reviewData.reviewerName = "A Steam User"; // Default
        }

        // 2. Reviewer Avatar URL
        // From: <div class="playerAvatar medium offline"> ... <img src="URL_HERE"> (second img tag)
        // The first img seems to be a frame, the second is the actual avatar.
        reviewData.reviewerAvatarUrl = $('.profile_small_header_avatar .playerAvatar img').eq(1).attr('src'); // .eq(1) gets the second img
        if (!reviewData.reviewerAvatarUrl) { // Fallback if the above is not found
            reviewData.reviewerAvatarUrl = $('.profile_small_header_avatar .playerAvatar img').first().attr('src'); // try the first one
        }


        // 3. Recommendation (Thumbs Up/Down Text)
        // From: <div class="ratingSummary">Recommended</div>
        reviewData.recommendation = $('.ratingSummaryBlock .ratingSummaryHeader .ratingSummary').text().trim();
        if (!reviewData.recommendation) {
            reviewData.recommendation = "Not specified";
        }

        // 4. Playtime (Specifically "at review time" if available)
        // From: <div class="playTime"> ... (119.4 hrs at review time) ... </div>
        const playTimeText = $('.ratingSummaryBlock .ratingSummaryHeader .playTime').text().trim();
        const atReviewTimeMatch = playTimeText.match(/\(([^)]+) at review time\)/);
        if (atReviewTimeMatch && atReviewTimeMatch[1]) {
            reviewData.playtime = atReviewTimeMatch[1]; // "119.4 hrs"
        } else {
            // Fallback to the main playtime text if "at review time" is not found
            reviewData.playtime = playTimeText.split('/')[1]?.trim().split('on record')[0]?.trim() || "Playtime not shown";
            if (reviewData.playtime && !reviewData.playtime.includes("hrs")) { // Add "hrs" if missing
                reviewData.playtime += " hrs";
            }
        }
        if (reviewData.playtime === "hrs") reviewData.playtime = "Playtime not shown"; // Cleanup if only "hrs" was captured


        // 5. Date Posted
        // From: <div class="recommendation_date">Posted: Nov 27, 2022 @ 11:20pm</div>
        reviewData.datePosted = $('.ratingSummaryBlock .recommendation_date').text().trim().replace('Posted: ', '');
        if (!reviewData.datePosted) {
            reviewData.datePosted = "Date not found";
        }

        // 6. Review Text
        // From: <div id="ReviewText"> ... review content ... </div>
        // This ID looks promising and more stable.
        let reviewContentHTML = $('#ReviewText').html(); // Using the ID selector
        if (reviewContentHTML) {
            // Basic cleanup: remove "Show more/less" links (if any, though not apparent in this snippet for #ReviewText),
            // convert <br> to newlines.
            // The provided HTML for #ReviewText is clean, so complex regex might not be needed here.
            reviewContentHTML = reviewContentHTML.replace(/<br\s*\/?>/gi, '\n');
            const tempElement = $('<div>').html(reviewContentHTML);
            reviewData.reviewText = tempElement.text().trim();
        } else {
            reviewData.reviewText = "Could not load review text.";
        }

        // Log the extracted data for debugging
        console.log(`[SCRAPER_SUCCESS] Scraped data for ${reviewUrl}:`, {
            name: reviewData.reviewerName,
            avatar: reviewData.reviewerAvatarUrl,
            rec: reviewData.recommendation,
            playtime: reviewData.playtime,
            date: reviewData.datePosted,
            textLength: reviewData.reviewText?.length
        });
        return reviewData;

    } catch (error) {
        // ... (your existing error handling) ...
        console.error(`[SCRAPER_ERROR] Failed to scrape ${reviewUrl}:`, error.message);
        if (error.response) {
            console.error(`[SCRAPER_ERROR] Status: ${error.response.status}`);
        }
        return { error: true, message: "Could not load review details.", originalUrl: reviewUrl };
    }
}


// Helper to fetch reviews for a given game and send the response
async function fetchReviewsForGameAndRespond(game, res) { // Make it async
    try {
        const reviewPageUrls = await new Promise((resolve, reject) => {
            db.all("SELECT review_page_url FROM game_reviews WHERE game_id = ? ORDER BY clue_order ASC LIMIT 6", [game.id], (err, rows) => {
                if (err) {
                    console.error(`[DB_ERROR] Error fetching review URLs for game ID ${game.id} ("${game.title}"):`, err.message);
                    reject(new Error("Could not fetch review URLs."));
                } else {
                    resolve(rows.map(r => r.review_page_url));
                }
            });
        });

        if (reviewPageUrls.length === 0) {
            console.warn(`[DB_WARN] No review URLs found for game ID ${game.id} ("${game.title}").`);
            return res.json({ title: game.title, appId: game.steam_app_id, reviews: [] }); // Send empty reviews
        }

        // Scrape all review pages in parallel
        const scrapedReviewsPromises = reviewPageUrls.map(url => scrapeSteamReview(url));
        const scrapedReviews = await Promise.all(scrapedReviewsPromises);

        console.log(`[SERVER_INFO] Sending ${scrapedReviews.filter(r => !r.error).length} successfully scraped reviews for game ID ${game.id}.`);

        res.json({
            title: game.title,
            appId: game.steam_app_id,
            reviews: scrapedReviews // Array of scraped review data objects
        });

    } catch (dbError) {
        // This catch is for errors from the db.all promise
        return res.status(500).json({ error: dbError.message || "Database error while fetching review URLs." });
    }
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