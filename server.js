require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db.js');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;


// --- Steam App List Cache (for autocomplete) ---
let steamAppsCache = [];
let lastSteamAppsFetchTime = 0;
const STEAM_APPS_CACHE_DURATION = 24 * 60 * 60 * 1000;
let lastSteamAppsFetchFailTime = 0;
const STEAM_APPS_RETRY_COOLDOWN = 5 * 60 * 1000; // 5 min cooldown after failed fetch

const STEAM_API_KEY = process.env.STEAM_API_KEY || '';

// Share the in-flight lookup so concurrent players get the same daily puzzle.
let dailyGameCache = null;
const unreadableGames = new Set();
const CLUES_PER_GAME = 6;
const MAX_CANDIDATES_PER_REQUEST = 3;

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
const NON_GAME_KEYWORDS = [
    'dlc', 'soundtrack', 'ost', 'artbook', 'art book', 'expansion',
    'pack', 'demo', 'beta', 'playtest', 'bonus', 'season pass',
    'skin', 'wallpaper', 'trailer', 'key', 'server', 'dedicated server',
    'sdk', 'tool', 'editor', 'trial', 'vr edition'
];
// Fetch all apps using IStoreService/GetAppList (paginated, requires API key)
async function fetchViaStoreService() {
    console.log("[STEAM_API_INFO] Using IStoreService/GetAppList/v1 (with API key)...");
    let allApps = [];
    let lastAppId = 0;
    while (true) {
        const url = `https://api.steampowered.com/IStoreService/GetAppList/v1/?key=${STEAM_API_KEY}&max_results=50000${lastAppId ? '&last_appid=' + lastAppId : ''}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`IStoreService API failed with status: ${response.status}`);
        }
        const data = await response.json();
        const apps = data.response && data.response.apps;
        if (!apps || apps.length === 0) break;
        allApps = allApps.concat(apps);
        if (!data.response.have_more_results) break;
        lastAppId = data.response.last_appid;
    }
    return allApps.map(a => ({ name: a.name, appid: a.appid }));
}

// Fetch all apps using old ISteamApps/GetAppList (no key needed, deprecated)
async function fetchViaLegacyEndpoint() {
    console.log("[STEAM_API_INFO] Using legacy ISteamApps/GetAppList/v2 (no key)...");
    const response = await fetch('https://api.steampowered.com/ISteamApps/GetAppList/v2/');
    if (!response.ok) {
        throw new Error(`Legacy Steam API request failed with status: ${response.status}`);
    }
    const data = await response.json();
    if (data.applist && data.applist.apps) {
        return data.applist.apps.map(a => ({ name: a.name, appid: a.appid }));
    }
    throw new Error("Legacy API returned unexpected data structure.");
}

async function fetchAndCacheSteamApps() {
    console.log("[STEAM_API_INFO] Attempting to fetch Steam app list for autocomplete...");
    try {
        let rawApps;
        if (STEAM_API_KEY) {
            rawApps = await fetchViaStoreService();
        } else {
            console.warn("[STEAM_API_WARN] No STEAM_API_KEY set. Trying legacy endpoint (deprecated, may fail).");
            rawApps = await fetchViaLegacyEndpoint();
        }
        console.log(`[STEAM_API_INFO] Fetched ${rawApps.length} raw entries from Steam.`);

        let processedApps = rawApps
            .filter(app => {
                if (!app.name || app.name.trim() === "") return false;
                const lowerCaseName = app.name.toLowerCase();
                for (const keyword of NON_GAME_KEYWORDS) {
                    if (lowerCaseName.includes(keyword)) return false;
                }
                return true;
            });

        const uniqueAppsByName = new Map();
        processedApps.forEach(app => {
            if (!uniqueAppsByName.has(app.name)) {
                uniqueAppsByName.set(app.name, app);
            }
        });
        steamAppsCache = Array.from(uniqueAppsByName.values());
        steamAppsCache.sort((a, b) => a.name.localeCompare(b.name));
        // Pre-compute normalized/lower names once at startup
        steamAppsCache.forEach(app => {
            app.lowerName = app.name.toLowerCase();
            app.normalizedName = normalizeStringServer(app.name);
        });
        lastSteamAppsFetchTime = Date.now();
        lastSteamAppsFetchFailTime = 0;
        console.log(`[STEAM_API_SUCCESS] Successfully filtered and cached ${steamAppsCache.length} Steam apps (objects).`);
    } catch (error) {
        lastSteamAppsFetchFailTime = Date.now();
        console.error("[STEAM_API_ERROR] Failed to fetch or process Steam app list:", error.message);
        if (!STEAM_API_KEY) {
            console.error("[STEAM_API_ERROR] The legacy endpoint may be down. Set STEAM_API_KEY env var to use the new IStoreService endpoint.");
            console.error("[STEAM_API_ERROR] Get a free key at: https://steamcommunity.com/dev/apikey");
        }
    }
}


// --- API Endpoints ---

// Autocomplete for game titles (Normalize search, filter normalized, display original)
app.get('/api/search-steam-games', async (req, res) => {
    const currentTime = Date.now();
    const cacheStale = steamAppsCache.length === 0 || (lastSteamAppsFetchTime > 0 && currentTime - lastSteamAppsFetchTime > STEAM_APPS_CACHE_DURATION);
    const retryCooledDown = currentTime - lastSteamAppsFetchFailTime > STEAM_APPS_RETRY_COOLDOWN;
    if (cacheStale && retryCooledDown) {
        console.log("[SERVER_INFO] Autocomplete cache is empty or stale. Re-fetching Steam apps...");
        await fetchAndCacheSteamApps();
    }

    const searchTermRaw = req.query.term ? req.query.term.trim() : "";
    const limit = parseInt(req.query.limit, 10) || 15;

    if (!searchTermRaw || searchTermRaw.length < 1) {
        return res.json([]);
    }

    const normalizedSearchTerm = normalizeStringServer(searchTermRaw);
    const lowerSearchTerm = searchTermRaw.toLowerCase();

    // Tiered scoring pass
    let scored = [];
    for (const app of steamAppsCache) {
        let score = 0;

        if (app.normalizedName === normalizedSearchTerm) {
            score = 100; // exact match
        } else if (app.normalizedName.startsWith(normalizedSearchTerm)) {
            score = 80; // prefix match
        } else {
            // Word-boundary match: check if any word in the name starts with the search term
            const words = app.lowerName.split(/[\s\-:.,!?()\/]+/);
            const wordBoundary = words.some(w => normalizeStringServer(w).startsWith(normalizedSearchTerm));
            if (wordBoundary) {
                score = 60;
            } else if (app.normalizedName.includes(normalizedSearchTerm)) {
                score = 40; // substring match
            }
        }

        if (score > 0) {
            scored.push({ name: app.name, score, len: app.name.length });
        }
    }

    // If fewer than 3 results, try fuzzy subsequence matching
    if (scored.length < 3 && normalizedSearchTerm.length >= 2) {
        const existing = new Set(scored.map(s => s.name));
        for (const app of steamAppsCache) {
            if (existing.has(app.name)) continue;
            // Check if search term chars appear in order in the name
            let si = 0;
            for (let ci = 0; ci < app.normalizedName.length && si < normalizedSearchTerm.length; ci++) {
                if (app.normalizedName[ci] === normalizedSearchTerm[si]) si++;
            }
            if (si === normalizedSearchTerm.length) {
                scored.push({ name: app.name, score: 20, len: app.name.length });
                if (scored.length >= limit * 2) break; // don't scan everything
            }
        }
    }

    // Sort: higher score first, then shorter name first
    scored.sort((a, b) => b.score - a.score || a.len - b.len);

    const suggestions = scored.slice(0, limit).map(s => s.name);
    res.json(suggestions);
});

async function selectDailyGame(date, puzzleDate) {
    // Prefer today's game, then unplayed games, then the least recently played.
    // SQLite sorts NULL dates first. Bound retries if Steam is unavailable.
    const candidates = await new Promise((resolve, reject) => {
        db.all(`
            SELECT g.id, g.title, g.steam_app_id
            FROM games g
            JOIN game_reviews r ON r.game_id = g.id
            WHERE g.is_active = TRUE
            GROUP BY g.id
            HAVING COUNT(*) >= ?
            ORDER BY (g.last_played_on IS ?) DESC, g.last_played_on ASC, RANDOM()
        `, [CLUES_PER_GAME, puzzleDate], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });

    // On retry, reach past stale review pages without hammering Steam in one request.
    let remaining = candidates.filter(game => !unreadableGames.has(game.id));
    if (!remaining.length) {
        unreadableGames.clear();
        remaining = candidates;
    }
    for (const game of remaining.slice(0, MAX_CANDIDATES_PER_REQUEST)) {
        const urls = await new Promise((resolve, reject) => {
            db.all('SELECT review_page_url FROM game_reviews WHERE game_id = ? ORDER BY clue_order LIMIT ?',
                [game.id, CLUES_PER_GAME], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
        });
        const reviews = await Promise.all(urls.map(row => scrapeSteamReview(row.review_page_url)));
        if (reviews.length !== CLUES_PER_GAME || reviews.some(review => !review)) {
            unreadableGames.add(game.id);
            console.warn(`[DAILY_GAME] Skipping "${game.title}" because it has unreadable clues.`);
            continue;
        }

        // A previous release may have marked an incomplete game as today's pick.
        // Replace that marker only after we have a playable puzzle.
        await new Promise((resolve, reject) => {
            db.run(`UPDATE games SET last_played_on = CASE WHEN id = ? THEN ? ELSE NULL END
                    WHERE id = ? OR last_played_on = ?`, [game.id, puzzleDate, game.id, puzzleDate], err => {
                if (err) reject(err);
                else resolve();
            });
        });
        unreadableGames.clear();
        return {
            title: game.title,
            appId: game.steam_app_id,
            reviews,
            puzzleDate,
            puzzleDateFormatted: date.toLocaleDateString('en-US', {
                timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric'
            })
        };
    }
    return null;
}

app.get('/api/daily-game', async (req, res) => {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    if (dailyGameCache?.date !== date) {
        dailyGameCache = { date, result: selectDailyGame(now, date) };
    }

    const lookup = dailyGameCache;
    try {
        const game = await lookup.result;
        if (game) return res.json(game);
        res.status(503).json({ error: "A complete set of review clues isn't available yet." });
    } catch (err) {
        console.error('[DAILY_GAME] Could not load the daily puzzle:', err.message);
        res.status(500).json({ error: 'Could not load the daily puzzle.' });
    }
    // Retrying can succeed after the background seed runs or Steam recovers.
    if (dailyGameCache === lookup) dailyGameCache = null;
});

// Helper function to scrape a single Steam review page
async function scrapeSteamReview(reviewUrl) {
    
    try {
        const { data: html } = await axios.get(reviewUrl, {
            timeout: 6000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        const $ = cheerio.load(html);
        const reviewData = {
            reviewerName: "A Steam User",
            reviewerAvatarUrl: null,
            recommendation: "Not specified",
            playtime: "Playtime not shown",
            datePosted: "Date not found",
            reviewText: ""
        };

        
        let tempName = $('.profile_small_header_name a.persona_name_text_content').text().trim();
        if (tempName) reviewData.reviewerName = tempName;
        else {
            tempName = $('.profile_small_header_name').clone().children().remove().end().text().trim();
            if (tempName) reviewData.reviewerName = tempName;
        }

        // Steam uses <picture> elements; the actual avatar is the direct child
        // <picture> of .playerAvatar (not the one inside .profile_avatar_frame).
        // The <img> may have srcset instead of src.
        let avatarSrc = null;
        const avatarContainer = $('.profile_small_header_avatar .playerAvatar');
        // Get the last <img> that is NOT inside .profile_avatar_frame
        const avatarImgs = avatarContainer.find('> picture > img, > a > img, > img');
        if (avatarImgs.length > 0) {
            const lastImg = avatarImgs.last();
            avatarSrc = lastImg.attr('src') || lastImg.attr('srcset');
        }
        // Fallback: try any img in playerAvatar
        if (!avatarSrc) {
            const allImgs = avatarContainer.find('img');
            for (let i = allImgs.length - 1; i >= 0; i--) {
                const img = $(allImgs[i]);
                // Skip images inside avatar frames
                if (img.closest('.profile_avatar_frame').length > 0) continue;
                avatarSrc = img.attr('src') || img.attr('srcset');
                if (avatarSrc) break;
            }
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
        

        
        return reviewData.reviewText ? reviewData : null;

    } catch (error) {
        console.error(`[SCRAPER_ERROR] Failed to scrape ${reviewUrl}: ${error.message}`);
        return null;
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
