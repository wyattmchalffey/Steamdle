require('dotenv').config();
const express = require('express');
const { buildSearchIndex, buildGuessAliases, searchGames } = require('./game-search');
const cors = require('cors');
const db = require('./db.js');
const { createDailyPuzzles, utcDay } = require('./daily-puzzles');
const { decoratePuzzleReviewers } = require('./reviewer-profiles');
const { createGameArtwork } = require('./game-artwork');
const { createArtworkHandler } = require('./artwork-route');
const { createAnalytics } = require('./analytics');
const { createStatsRoutes } = require('./stats-routes');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;


// Autocomplete and submitted guesses must use the same version of the catalog.
function buildSearchCatalog(steamApps) {
    const entries = buildSearchIndex(steamApps);
    return { entries, guessAliases: buildGuessAliases(entries) };
}
let searchCatalog = buildSearchCatalog();
let refreshInProgress = false;
let lastSteamAppsFetchTime = 0;
let lastSteamAppsAttempt = 0;
const STEAM_APPS_CACHE_DURATION = 24 * 60 * 60 * 1000;
const STEAM_APPS_RETRY_COOLDOWN = 5 * 60 * 1000;
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';

const clueTrial = require('./active-curation');
const { curatedScheduleStatus } = require('./curated-schedule');
const dailyPuzzles = createDailyPuzzles(db, scrapeSteamReview, {
    priorityAppIds: clueTrial.games.map(game => game.steam_app_id)
});
let preparedThrough = null;
const gameArtwork = createGameArtwork();

// --- Middleware ---
app.use(createStatsRoutes(createAnalytics(db), process.env, {
    scheduleStatus: clueTrial.schedule ? () => curatedScheduleStatus(db, clueTrial) : undefined
}));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

async function fetchViaStoreService() {
    console.log("[STEAM_API_INFO] Using IStoreService/GetAppList/v1 (with API key)...");
    let allApps = [];
    let lastAppId = 0;
    while (true) {
        const url = `https://api.steampowered.com/IStoreService/GetAppList/v1/?key=${STEAM_API_KEY}&max_results=50000${lastAppId ? '&last_appid=' + lastAppId : ''}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
            throw new Error(`IStoreService API failed with status: ${response.status}`);
        }
        const data = await response.json();
        const apps = data.response && data.response.apps;
        if (!Array.isArray(apps)) throw new Error('Steam did not return a game list.');
        if (!apps.length) break;
        allApps = allApps.concat(apps);
        if (!data.response.have_more_results) break;
        const nextId = Number(data.response.last_appid);
        if (!(nextId > lastAppId)) throw new Error('Steam game list pagination did not advance.');
        lastAppId = nextId;
    }
    if (!allApps.length) throw new Error('Steam returned an empty game list.');
    return allApps;
}

function refreshSteamAppsIfNeeded() {
    const now = Date.now();
    if (!STEAM_API_KEY || refreshInProgress || now - lastSteamAppsFetchTime < STEAM_APPS_CACHE_DURATION ||
        now - lastSteamAppsAttempt < STEAM_APPS_RETRY_COOLDOWN) return;

    refreshInProgress = true;
    lastSteamAppsAttempt = now;
    fetchViaStoreService().then(apps => {
        searchCatalog = buildSearchCatalog(apps);
        lastSteamAppsFetchTime = Date.now();
    }).catch(error => {
        console.error('[STEAM_API_ERROR] Could not refresh Steam game search:', error.message);
    }).finally(() => {
        refreshInProgress = false;
    });
}

app.get('/api/search-steam-games', (req, res) => {
    const term = typeof req.query.term === 'string' ? req.query.term : '';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 15, 100));
    refreshSteamAppsIfNeeded();
    res.json(searchGames(searchCatalog.entries, term, limit));
});

function startPuzzlePreparation() {
    async function prepare() {
        let retryIn = 60000;
        try {
            preparedThrough = await dailyPuzzles.prepareThroughTomorrow(new Date());
            if (preparedThrough) {
                console.log(`[DAILY_GAME] Puzzles ready through ${preparedThrough} UTC.`);
                retryIn = Math.max(1000, Date.parse(preparedThrough + 'T00:00:00Z') - Date.now());
            }
        } catch (err) {
            console.error('[DAILY_GAME] Could not prepare puzzles:', err.message);
        }
        setTimeout(prepare, retryIn).unref();
    }
    prepare();
}

app.get('/api/daily-game', async (req, res) => {
    const day = utcDay(new Date());
    try {
        const game = await dailyPuzzles.forDay(day);
        res.set('X-Next-Puzzle-Ready', preparedThrough && preparedThrough > day ? 'true' : 'false');
        if (game) return res.json({ ...decoratePuzzleReviewers(game), guessAliases: searchCatalog.guessAliases });
        res.status(503).json({ error: "A complete set of review clues isn't available yet." });
    } catch (err) {
        console.error('[DAILY_GAME] Could not load the daily puzzle:', err.message);
        res.status(500).json({ error: 'Could not load the daily puzzle.' });
    }
});

app.get('/api/daily-artwork', createArtworkHandler({ dailyPuzzles, artwork: gameArtwork }));

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
            originalUrl: reviewUrl,
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
app.listen(PORT, () => {
    console.log(`[SERVER_INFO] Steamdle server listening on port ${PORT}.`);
    refreshSteamAppsIfNeeded();
    startPuzzlePreparation();
});
