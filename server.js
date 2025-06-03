const express = require('express');
const cors = require('cors');
const db = require('./db.js'); // Your database connection and seeding logic
const axios = require('axios'); // For fetching HTML
const cheerio = require('cheerio'); // For parsing HTML
const { format } = require('date-fns'); // For easy date formatting

const app = express();
const PORT = process.env.PORT || 3000;


// --- Steam App List Cache (for autocomplete) ---
let steamAppsCache = [];
let lastSteamAppsFetchTime = 0;
const STEAM_APPS_CACHE_DURATION = 24 * 60 * 60 * 1000; // Cache for 24 hours

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- Normalization Function (for forgiving autocomplete search) ---
function normalizeStringServer(str) {
    if (typeof str !== 'string') return '';
    // Remove ALL non-alphanumeric characters (including spaces, hyphens, colons, etc.)
    return str.toLowerCase().replace(/[^a-z0-9]/gi, '');
}

// --- Helper: Fetch and Cache Steam App List (for autocomplete) ---
// MODIFIED to store objects with original name for display, and allow filtering DLCs
const NON_GAME_KEYWORDS = [
    'dlc', 'soundtrack', 'ost', 'artbook', 'art book', 'expansion',
    'pack', 'demo', 'beta', 'playtest', 'bonus', 'season pass',
    'skin', 'wallpaper', 'trailer', 'key', 'server', 'dedicated server',
    'sdk', 'tool', 'editor', 'trial', 'vr edition'
];
async function fetchAndCacheSteamApps() {
    console.log("[STEAM_API_INFO] Attempting to fetch Steam app list for autocomplete...");
    try {
        const response = await fetch('https://api.steampowered.com/ISteamApps/GetAppList/v2/');
        if (!response.ok) {
            throw new Error(`Steam API request failed with status: ${response.status}`);
        }
        const data = await response.json();
        if (data.applist && data.applist.apps) {
            let rawApps = data.applist.apps;
            console.log(`[STEAM_API_INFO] Fetched ${rawApps.length} raw entries from Steam.`);

            steamAppsCache = rawApps
                .filter(app => { // Your DLC filtering logic
                    if (!app.name || app.name.trim() === "") return false;
                    const lowerCaseName = app.name.toLowerCase();
                    for (const keyword of NON_GAME_KEYWORDS) { // Make sure NON_GAME_KEYWORDS is defined
                        if (lowerCaseName.includes(keyword)) return false;
                    }
                    return true;
                })
                .map(app => ({ name: app.name, appid: app.appid })) // Store objects: original name + appid
                .filter((app, index, self) => // Remove duplicates based on name, keeping first occurrence
                    index === self.findIndex((t) => t.name === app.name)
                );

            steamAppsCache.sort((a, b) => a.name.localeCompare(b.name)); // Sort by original name
            lastSteamAppsFetchTime = Date.now();
            console.log(`[STEAM_API_SUCCESS] Successfully filtered and cached ${steamAppsCache.length} Steam apps (objects).`);
        } else {
            console.error("[STEAM_API_ERROR] Steam API returned an unexpected data structure for app list.");
        }
    } catch (error) {
        console.error("[STEAM_API_ERROR] Failed to fetch or process Steam app list:", error.message);
    }
}


// --- API Endpoints ---

// Autocomplete for game titles (Using Approach 1: Normalize search, filter normalized, display original)
app.get('/api/search-steam-games', async (req, res) => {
    const currentTime = Date.now();
    if (steamAppsCache.length === 0 || (currentTime - lastSteamAppsFetchTime > STEAM_APPS_CACHE_DURATION)) {
        console.log("[SERVER_INFO] Autocomplete cache is empty or stale. Re-fetching Steam apps...");
        await fetchAndCacheSteamApps();
    }

    const searchTermRaw = req.query.term ? req.query.term.trim() : "";
    const limit = parseInt(req.query.limit, 10) || 15;

    if (!searchTermRaw || searchTermRaw.length < 2) {
        return res.json([]);
    }

    const normalizedSearchTerm = normalizeStringServer(searchTermRaw);

    let suggestions = steamAppsCache // steamAppsCache is now array of {name, appid}
        .map(app => ({
            originalName: app.name,
            normalizedName: normalizeStringServer(app.name) // Normalize here for searching
            // appid: app.appid // Keep if needed for other things
        }))
        .filter(app => app.normalizedName.includes(normalizedSearchTerm))
        .sort((a, b) => {
            const aStartsWith = a.normalizedName.startsWith(normalizedSearchTerm);
            const bStartsWith = b.normalizedName.startsWith(normalizedSearchTerm);

            if (aStartsWith && !bStartsWith) return -1;
            if (!aStartsWith && bStartsWith) return 1;
            return a.normalizedName.localeCompare(b.normalizedName); // Then by normalized name
        })
        .slice(0, limit)
        .map(app => app.originalName); // Return only the ORIGINAL names for display

    res.json(suggestions);
});


// Daily Game Selection (Using Method 1: last_played_on date)
app.get('/api/daily-game', async (req, res) => {
    console.log("[SERVER_INFO] Request received for /api/daily-game"); // Log 1
    const todayStr = format(new Date(), 'yyyy-MM-dd');

    try {
        // Block A: Check if a game is already marked for today
        console.log("[SERVER_INFO] Daily game: Checking for pre-selected game for", todayStr); // Log 2
        let game = await new Promise((resolve, reject) => {
            db.get("SELECT id, title, steam_app_id FROM games WHERE last_played_on = ? AND is_active = TRUE", [todayStr], (err, row) => {
                if (err) {
                    console.error("[DB_ERROR] Daily game A: Error checking for pre-selected game:", err.message); // Log A-Err
                    reject(err); // Make sure to reject on error
                } else {
                    console.log("[DB_INFO] Daily game A: Pre-selected game check result:", row); // Log A-Res
                    resolve(row);
                }
            });
        });

        if (game) {
            console.log(`[SERVER_INFO] Daily game: Found pre-selected game for ${todayStr}: ID ${game.id} ("${game.title}")`); // Log 3
        } else {
            console.log(`[SERVER_INFO] Daily game: No game pre-selected for ${todayStr}. Selecting a new one.`); // Log 4

            // Block B: Try to find an active game that has never been played
            console.log("[SERVER_INFO] Daily game: Checking for unplayed active game..."); // Log B-Check
            game = await new Promise((resolve, reject) => {
                db.get("SELECT id, title, steam_app_id FROM games WHERE last_played_on IS NULL AND is_active = TRUE ORDER BY RANDOM() LIMIT 1", (err, row) => {
                    if (err) {
                        console.error("[DB_ERROR] Daily game B: Error fetching unplayed game:", err.message); // Log B-Err
                        reject(err);
                    } else {
                        console.log("[DB_INFO] Daily game B: Unplayed game check result:", row); // Log B-Res
                        resolve(row);
                    }
                });
            });

            if (!game) {
                // Block C: All active games have been played, find the one played least recently
                console.log("[SERVER_INFO] Daily game: All active games have been played. Selecting least recently played."); // Log C-Check
                game = await new Promise((resolve, reject) => {
                    db.get("SELECT id, title, steam_app_id FROM games WHERE is_active = TRUE ORDER BY last_played_on ASC, RANDOM() LIMIT 1", (err, row) => {
                        if (err) {
                            console.error("[DB_ERROR] Daily game C: Error fetching least recently played game:", err.message); // Log C-Err
                            reject(err);
                        } else {
                            console.log("[DB_INFO] Daily game C: Least recently played check result:", row); // Log C-Res
                            resolve(row);
                        }
                    });
                });
            }

            if (game) {
                // Block D: Mark this game as played today
                console.log(`[SERVER_INFO] Daily game: Attempting to mark game ID ${game.id} as played.`); // Log D-Attempt
                await new Promise((resolve, reject) => {
                    db.run("UPDATE games SET last_played_on = ? WHERE id = ?", [todayStr, game.id], function (err) {
                        if (err) {
                            console.error(`[DB_ERROR] Daily game D: Failed to update last_played_on for game ID ${game.id}:`, err.message); // Log D-Err
                            reject(err); // CRITICAL: If this rejects and isn't caught, the route hangs
                        } else {
                            console.log(`[SERVER_INFO] Daily game D: Marked game ID ${game.id} ("${game.title}") as played on ${todayStr}. Changes: ${this.changes}`); // Log D-Success
                            resolve();
                        }
                    });
                });
            }
        }

        if (!game) {
            console.error("[DB_ERROR] Daily game: Could not select any game from the database after all checks."); // Log 5
            return res.status(500).json({ error: "No games available to select for today." });
        }

        console.log(`[SERVER_INFO] Daily game: Preparing to serve game ID ${game.id}: "${game.title}"`); // Log 6
        fetchReviewsForGameAndRespond(game, res); // This function itself is async and sends the response

    } catch (error) { // This catch block handles rejections from the awaited promises
        console.error("[SERVER_ERROR] Critical error in /api/daily-game's try block:", error);
        return res.status(500).json({ error: "Internal server error while selecting daily game." });
    }
});


// Helper function to scrape a single Steam review page
async function scrapeSteamReview(reviewUrl) {
    // console.log(`[SCRAPER_INFO] Attempting to scrape review: ${reviewUrl}`); // Optional: keep for basic tracking
    try {
        const { data: html } = await axios.get(reviewUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        const $ = cheerio.load(html);
        const reviewData = { // Initialize with defaults
            reviewerName: "A Steam User",
            reviewerAvatarUrl: null,
            recommendation: "Not specified",
            playtime: "Playtime not shown",
            datePosted: "Date not found",
            reviewText: "Could not load review text."
        };

        // Scraper Selectors (keep these refined versions)
        let tempName = $('.profile_small_header_name a.persona_name_text_content').text().trim();
        if (tempName) reviewData.reviewerName = tempName;
        else {
            tempName = $('.profile_small_header_name').clone().children().remove().end().text().trim();
            if (tempName) reviewData.reviewerName = tempName;
        }

        let avatarSrc = $('.profile_small_header_avatar .playerAvatar > img:last-child').attr('src');
        if (!avatarSrc) {
            avatarSrc = $('.profile_small_header_avatar .playerAvatar img').eq(1).attr('src');
        }
        if (avatarSrc) reviewData.reviewerAvatarUrl = avatarSrc;

        let tempRec = $('.ratingSummaryBlock .ratingSummaryHeader .ratingSummary').text().trim();
        if (tempRec) reviewData.recommendation = tempRec;

        const playTimeText = $('.ratingSummaryBlock .ratingSummaryHeader .playTime').text().trim();
        const atReviewTimeMatch = playTimeText.match(/\(([^)]+) at review time\)/);
        if (atReviewTimeMatch && atReviewTimeMatch[1]) {
            reviewData.playtime = atReviewTimeMatch[1];
        } else if (playTimeText) {
            let fallbackPlaytime = playTimeText.split('/')[1]?.trim().split(' on record')[0]?.trim();
            if (fallbackPlaytime) {
                reviewData.playtime = fallbackPlaytime;
                if (!reviewData.playtime.includes("hrs")) reviewData.playtime += " hrs";
                if (reviewData.playtime === "hrs") reviewData.playtime = "Playtime not shown";
            }
        }

        let tempDate = $('.ratingSummaryBlock .recommendation_date').text().trim().replace('Posted: ', '');
        if (tempDate) reviewData.datePosted = tempDate;

        let reviewContentHTML = $('#ReviewText').html();
        if (reviewContentHTML) {
            reviewContentHTML = reviewContentHTML.replace(/<br\s*\/?>/gi, '\n');
            reviewData.reviewText = $('<div>').html(reviewContentHTML).text().trim();
        }
        // End Scraper Selectors

        // console.log(`[SCRAPER_SUCCESS] Scraped: ${reviewData.reviewerName?.substring(0,10)} for ${reviewUrl.substring(0,50)}`); // Shorter success log
        return reviewData;

    } catch (error) {
        console.error(`[SCRAPER_ERROR] Failed to scrape ${reviewUrl}: ${error.message}`);
        return { error: true, message: `Scraping failed`, originalUrl: reviewUrl, reviewerName: "Error" };
    }
}

// --- Helper to fetch reviews for a given game and send the response ---
async function fetchReviewsForGameAndRespond(game, res) {
    console.log(`[FETCH_REVIEWS_INFO] Fetching reviews for game ID ${game.id} ("${game.title}")`);
    try {
        const reviewPageUrls = await new Promise((resolve, reject) => {
            db.all("SELECT review_page_url FROM game_reviews WHERE game_id = ? ORDER BY clue_order ASC LIMIT 6", [game.id], (err, rows) => {
                if (err) {
                    console.error(`[DB_ERROR] Error fetching review URLs for game ID ${game.id}:`, err.message);
                    reject(new Error("Could not fetch review URLs."));
                } else {
                    if (!rows) {
                        console.error("[DB_ERROR] db.all returned null rows for review URLs.");
                        reject(new Error("Database returned unexpected null for review URLs."));
                        return;
                    }
                    resolve(rows.map(r => r.review_page_url));
                }
            });
        });

        if (reviewPageUrls.length === 0) {
            console.warn(`[DB_WARN] No review URLs found for game ID ${game.id} ("${game.title}"). Sending empty reviews array.`);
            return res.json({ title: game.title, appId: game.steam_app_id, reviews: [] });
        }

        const scrapedReviewsPromises = reviewPageUrls.map(url => scrapeSteamReview(url));
        const scrapedReviews = await Promise.all(scrapedReviewsPromises);

        const successfulScrapesCount = scrapedReviews.filter(r => !(r && r.error)).length;
        console.log(`[SERVER_INFO] Sending ${successfulScrapesCount} (of ${scrapedReviews.length}) scraped reviews for game ID ${game.id}.`);

        res.json({
            title: game.title,
            appId: game.steam_app_id,
            reviews: scrapedReviews
        });

    } catch (errorInPromiseChain) {
        console.error(`[FETCH_REVIEWS_ERROR] Error in fetchReviewsForGameAndRespond for game ID ${game.id}:`, errorInPromiseChain);
        if (!res.headersSent) {
            res.status(500).json({ error: errorInPromiseChain.message || "Internal server error while fetching/scraping reviews." });
        }
    }
}

// --- Start Server ---
fetchAndCacheSteamApps().then(() => {
    app.listen(PORT, () => {
        console.log(`[SERVER_INFO] Steamdle server started successfully on http://localhost:${PORT}`);
        console.log(`[SERVER_INFO] Frontend should be accessible at http://localhost:${PORT}/ (or /index.html)`);
    });
}).catch(initialError => {
    console.error("[SERVER_FATAL] A critical error occurred during server startup:", initialError);
    app.listen(PORT, () => {
        console.warn(`[SERVER_WARN] Steamdle server started on http://localhost:${PORT} BUT with an initial error.`);
    });
});