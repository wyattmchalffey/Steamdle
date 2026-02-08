const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const axios = require('axios');

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
                steam_app_id TEXT NOT NULL,
                last_played_on DATE,
                is_active BOOLEAN DEFAULT TRUE
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

// --- Mechanic keywords for revealingness scoring ---
const MECHANIC_KEYWORDS_SINGLE = [
    'combat', 'rpg', 'boss', 'crafting', 'inventory', 'leveling', 'stealth',
    'puzzle', 'platformer', 'roguelike', 'roguelite', 'sandbox', 'survival',
    'multiplayer', 'singleplayer', 'coop', 'pvp', 'pve', 'mmorpg', 'fps',
    'moba', 'rts', 'strategy', 'simulation', 'racing', 'horror', 'dungeon',
    'loot', 'grinding', 'respawn', 'checkpoint', 'cooldown', 'stamina',
    'mana', 'hitbox', 'parry', 'dodge', 'healing', 'upgrade', 'quest',
    'dialogue', 'cutscene', 'tutorial', 'campaign', 'permadeath', 'procedural',
    'weapon', 'armor', 'shield', 'potion', 'spell', 'summon', 'minigame',
    'leaderboard', 'matchmaking', 'loadout', 'class', 'tank', 'healer',
    'dps', 'aggro', 'meta'
];

const MECHANIC_KEYWORDS_MULTI = [
    'open world', 'skill tree', 'turn-based', 'real-time', 'base building',
    'character creation', 'fast travel', 'new game plus', 'level design',
    'save system', 'health bar', 'experience points', 'side quest',
    'main quest', 'boss fight', 'final boss', 'difficulty spike',
    'early access', 'battle royale', 'deck building', 'resource management',
    'bullet hell', 'hack and slash', 'point and click', 'third person',
    'first person', 'top down', 'co-op'
];

// --- Review pool fetching (funny + all) ---
async function fetchReviewPool(appId) {
    const baseUrl = `https://store.steampowered.com/appreviews/${appId}?json=1&language=english&purchase_type=all&review_type=all`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    let funnyReviews = [];
    let allReviews = [];

    // Fetch funny reviews first
    try {
        const funnyUrl = `${baseUrl}&filter=funny&num_per_page=50`;
        const { data } = await axios.get(funnyUrl, { headers });
        if (data && data.success === 1 && data.reviews) {
            funnyReviews = data.reviews.map(r => ({ ...r, _source: 'funny' }));
            console.log(`[REVIEW_POOL] Fetched ${funnyReviews.length} funny reviews for AppID ${appId}`);
        }
    } catch (error) {
        console.warn(`[REVIEW_POOL] Failed to fetch funny reviews for AppID ${appId}: ${error.message}. Continuing with all-only.`);
    }

    // 300ms delay between calls
    await new Promise(resolve => setTimeout(resolve, 300));

    // Fetch all (helpfulness-sorted) reviews
    try {
        const allUrl = `${baseUrl}&filter=updated&num_per_page=100`;
        const { data } = await axios.get(allUrl, { headers });
        if (data && data.success === 1 && data.reviews) {
            allReviews = data.reviews.map(r => ({ ...r, _source: 'all' }));
            console.log(`[REVIEW_POOL] Fetched ${allReviews.length} all-sorted reviews for AppID ${appId}`);
        }
    } catch (error) {
        console.error(`[REVIEW_POOL] Failed to fetch all reviews for AppID ${appId}: ${error.message}`);
        // If both failed, return empty
        if (funnyReviews.length === 0) return [];
    }

    // Deduplicate by recommendationid, preferring funny-sourced
    const seen = new Map();
    for (const review of funnyReviews) {
        seen.set(review.recommendationid, review);
    }
    for (const review of allReviews) {
        if (!seen.has(review.recommendationid)) {
            seen.set(review.recommendationid, review);
        }
    }

    const pool = Array.from(seen.values());
    console.log(`[REVIEW_POOL] Total deduplicated pool: ${pool.length} reviews for AppID ${appId}`);
    return pool;
}

// --- Review filtering ---
function filterReviews(reviews, gameTitle) {
    // Build filter words from game title: full normalized title + individual words 4+ chars
    const normalizedTitle = gameTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const titleWords = normalizedTitle.split(/\s+/).filter(w => w.length >= 4);
    const filterTerms = [normalizedTitle, ...titleWords];

    return reviews.filter(review => {
        const text = (review.review || '').trim();

        // Source-aware minimum length
        const minLength = review._source === 'funny' ? 30 : 50;
        if (text.length < minLength) return false;

        // Check for game title mention (spoiler)
        const lowerText = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
        for (const term of filterTerms) {
            if (lowerText.includes(term)) return false;
        }

        // Filter ASCII art / meme reviews (high non-alpha ratio)
        const alphaChars = text.replace(/[^a-zA-Z]/g, '').length;
        if (alphaChars / text.length < 0.4) return false;

        return true;
    });
}

// --- Revealingness scoring ---
function scoreRevealingness(review) {
    const text = (review.review || '').trim();
    const lowerText = text.toLowerCase();

    // Component 1: Text length (35%)
    const lengthScore = Math.min(text.length / 1500, 1.0);

    // Component 2: Helpful ratio (25%) - high helpful = more revealing
    const votesUp = review.votes_up || 0;
    const votesFunny = review.votes_funny || 0;
    const totalVotes = votesUp + votesFunny;
    const helpfulRatio = totalVotes > 0 ? votesUp / totalVotes : 0.5;

    // Component 3: Keyword density (25%)
    let keywordMatches = 0;
    for (const keyword of MECHANIC_KEYWORDS_SINGLE) {
        // Word boundary match using regex
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        if (regex.test(lowerText)) keywordMatches++;
    }
    for (const keyword of MECHANIC_KEYWORDS_MULTI) {
        if (lowerText.includes(keyword)) keywordMatches++;
    }
    const keywordScore = Math.min(keywordMatches / 8, 1.0);

    // Component 4: Sentence count (15%)
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
    const sentenceScore = Math.min(sentences / 10, 1.0);

    // Weighted total
    const score = (lengthScore * 0.35) + (helpfulRatio * 0.25) + (keywordScore * 0.25) + (sentenceScore * 0.15);

    return score;
}

// --- Tiered clue selection ---
function selectTieredClues(scoredReviews) {
    if (scoredReviews.length === 0) return [];

    // Sort by score ascending
    const sorted = [...scoredReviews].sort((a, b) => a._score - b._score);

    // If fewer than 6 reviews, return what we have sorted by score
    if (sorted.length < 6) {
        console.log(`[REVIEW_TIER] Only ${sorted.length} reviews available, returning all sorted by score`);
        return sorted;
    }

    // Divide into 3 tiers (terciles)
    const tierSize = Math.floor(sorted.length / 3);
    const tiers = [
        sorted.slice(0, tierSize),                           // Tier 1: vague (lowest scores)
        sorted.slice(tierSize, tierSize * 2),                // Tier 2: medium
        sorted.slice(tierSize * 2)                           // Tier 3: detailed (highest scores)
    ];

    const selected = [];

    for (let t = 0; t < 3; t++) {
        let tier = tiers[t];

        // Edge case: if a tier has <2 reviews, steal from adjacent tier
        if (tier.length < 2) {
            const adjacentIdx = t === 0 ? 1 : (t === 2 ? 1 : (tiers[0].length > tiers[2].length ? 0 : 2));
            while (tier.length < 2 && tiers[adjacentIdx].length > 2) {
                // Steal the review closest to this tier's boundary
                if (t < adjacentIdx) {
                    tier.push(tiers[adjacentIdx].shift());
                } else {
                    tier.push(tiers[adjacentIdx].pop());
                }
            }
        }

        if (tier.length >= 2) {
            // Pick diversity within tier: highest + lowest weighted_vote_score
            const tierByVoteScore = [...tier].sort((a, b) => (a.weighted_vote_score || 0) - (b.weighted_vote_score || 0));
            selected.push(tierByVoteScore[0]);
            selected.push(tierByVoteScore[tierByVoteScore.length - 1]);
        } else if (tier.length === 1) {
            selected.push(tier[0]);
        }

        const tierLabel = ['VAGUE', 'MEDIUM', 'DETAILED'][t];
        const tierScores = tier.map(r => r._score.toFixed(3));
        console.log(`[REVIEW_TIER] Tier ${t + 1} (${tierLabel}): ${tier.length} reviews, scores: [${tierScores.join(', ')}], picked ${Math.min(tier.length, 2)}`);
    }

    return selected;
}

// --- Auto-fetch reviews from Steam Review API ---
async function fetchReviewsFromSteamAPI(appId, gameTitle) {
    console.log(`[STEAM_REVIEW_API] Fetching reviews for "${gameTitle}" (AppID: ${appId})...`);

    try {
        // Step 1: Fetch review pool (funny + all)
        const pool = await fetchReviewPool(appId);

        if (!pool || pool.length === 0) {
            console.warn(`[STEAM_REVIEW_API] No reviews returned for "${gameTitle}" (AppID: ${appId}).`);
            return [];
        }

        // Step 2: Filter reviews
        const filtered = filterReviews(pool, gameTitle);

        if (filtered.length === 0) {
            console.warn(`[STEAM_REVIEW_API] No reviews passed filters for "${gameTitle}" (AppID: ${appId}).`);
            return [];
        }

        // Step 3: Score revealingness
        const scored = filtered.map(review => ({
            ...review,
            _score: scoreRevealingness(review)
        }));

        // Step 4: Select tiered clues
        const selected = selectTieredClues(scored);

        // Step 5: Construct review page URLs
        const urls = selected.map(review => {
            const steamId = review.author?.steamid;
            if (!steamId) return null;
            return `https://steamcommunity.com/profiles/${steamId}/recommended/${appId}/`;
        }).filter(Boolean);

        console.log(`[STEAM_REVIEW_API] Selected ${urls.length} tiered reviews for "${gameTitle}" (from ${pool.length} total pool, ${filtered.length} passed filters).`);
        return urls;
    } catch (error) {
        console.error(`[STEAM_REVIEW_API_ERROR] Failed to fetch reviews for "${gameTitle}" (AppID: ${appId}):`, error.message);
        return [];
    }
}

async function seedInitialData() {
    console.log("[SEED_INFO] --- Starting seedInitialData (Auto-fetch Mode) ---");

    const forceReseed = process.env.FORCE_RESEED === 'true';
    if (forceReseed) {
        console.log("[SEED_INFO] FORCE_RESEED=true: All games will be re-fetched with the new tiered algorithm.");
    }

    // Define your games here. Just title and steam_app_id needed!
    // Reviews are auto-fetched from the Steam Review API.
    // You can optionally provide a 'reviews' array to override auto-fetch.
    const gamesToSeed = [
        // --- Existing games (71) ---
        { title: "Portal 2", steam_app_id: "620" },
        { title: "Stardew Valley", steam_app_id: "413150" },
        { title: "Terraria", steam_app_id: "105600" },
        { title: "Satisfactory", steam_app_id: "526870" },
        { title: "Apex Legends", steam_app_id: "1172470" },
        { title: "Elden Ring", steam_app_id: "1245620" },
        { title: "R.E.P.O", steam_app_id: "3241660" },
        { title: "Resident Evil 4", steam_app_id: "2050650" },
        { title: "The Forest", steam_app_id: "242760" },
        { title: "Subnautica", steam_app_id: "264710" },
        { title: "Halo Infinite", steam_app_id: "1240440" },
        { title: "Borderlands 2", steam_app_id: "49520" },
        { title: "ANIMAL WELL", steam_app_id: "813230" },
        { title: "Outer Wilds", steam_app_id: "753640" },
        { title: "Storyteller", steam_app_id: "1624540" },
        { title: "Myst", steam_app_id: "1255560" },
        { title: "Lies of P", steam_app_id: "1627720" },
        { title: "Hogwarts Legacy", steam_app_id: "990080" },
        { title: "Among Us", steam_app_id: "945360" },
        { title: "Gorilla Tag", steam_app_id: "1533390" },
        { title: "Pizza Tower", steam_app_id: "2231450" },
        { title: "Half-Life", steam_app_id: "70" },
        { title: "Dwarf Fortress", steam_app_id: "975370" },
        { title: "Vampire Survivors", steam_app_id: "1794680" },
        { title: "Counter-Strike 2", steam_app_id: "730" },
        { title: "Marvel Rivals", steam_app_id: "2767030" },
        { title: "Balatro", steam_app_id: "2379780" },
        { title: "Path of Exile", steam_app_id: "238960" },
        { title: "The Witcher 3: Wild Hunt", steam_app_id: "292030" },
        { title: "Dead by Daylight", steam_app_id: "381210" },
        { title: "Lethal Company", steam_app_id: "1966720" },
        { title: "Warframe", steam_app_id: "230410" },
        { title: "Rust", steam_app_id: "252490" },
        { title: "Baldur's Gate 3", steam_app_id: "1086940" },
        { title: "HELLDIVERS\u2122 2", steam_app_id: "553850" },
        { title: "Cyberpunk 2077", steam_app_id: "1091500" },
        { title: "The Sims\u2122 4", steam_app_id: "1222670" },
        { title: "VRChat", steam_app_id: "438100" },
        { title: "Yu-Gi-Oh! Master Duel", steam_app_id: "1449850" },
        { title: "Magic: The Gathering Arena", steam_app_id: "2141910" },
        { title: "Undertale", steam_app_id: "391540" },
        { title: "DELTARUNE", steam_app_id: "1671210" },
        { title: "Victoria 3", steam_app_id: "529340" },
        { title: "Destiny 2", steam_app_id: "1085660" },
        { title: "Geometry Dash", steam_app_id: "322170" },
        { title: "Don't Starve Together", steam_app_id: "322330" },
        { title: "PAYDAY 2", steam_app_id: "218620" },
        { title: "Bloons TD 6", steam_app_id: "960090" },
        { title: "ELDEN RING NIGHTREIGN", steam_app_id: "2622380" },
        { title: "WEBFISHING", steam_app_id: "3146520" },
        { title: "Barony", steam_app_id: "371970" },
        { title: "Halo: The Master Chief Collection", steam_app_id: "976730" },
        { title: "ARMORED CORE\u2122 VI FIRES OF RUBICON\u2122", steam_app_id: "1888160" },
        { title: "SIGNALIS", steam_app_id: "1262350" },
        { title: "Solar Ash", steam_app_id: "1867530" },
        { title: "Neon White", steam_app_id: "1533420" },
        { title: "Psychonauts 2", steam_app_id: "607080" },
        { title: "Psychonauts", steam_app_id: "3830" },
        { title: "ACE COMBAT\u2122 7: SKIES UNKNOWN", steam_app_id: "502500" },
        { title: "Rain World", steam_app_id: "312520" },
        { title: "Barotrauma", steam_app_id: "602960" },
        { title: "Poco", steam_app_id: "3454610" },
        { title: "Limbus Company", steam_app_id: "1973530" },
        { title: "Stray", steam_app_id: "1332010" },
        { title: "REMNANT II", steam_app_id: "1282100" },
        { title: "Phasmophobia", steam_app_id: "739630" },
        { title: "Content Warning", steam_app_id: "2881650" },
        { title: "BELOW", steam_app_id: "250680" },
        { title: "NieR Replicant\u2122 ver.1.22474487139...", steam_app_id: "1113560" },
        { title: "LOCKDOWN Protocol", steam_app_id: "2780980" },
        { title: "Guild Wars 2", steam_app_id: "1284210" },

        // --- AAA Action/Adventure & Open World (30) ---
        { title: "Grand Theft Auto V", steam_app_id: "271590" },
        { title: "Red Dead Redemption 2", steam_app_id: "1174180" },
        { title: "God of War", steam_app_id: "1593500" },
        { title: "Horizon Zero Dawn Remastered", steam_app_id: "2561580" },
        { title: "Ghost of Tsushima DIRECTOR'S CUT", steam_app_id: "2215430" },
        { title: "Marvel's Spider-Man Remastered", steam_app_id: "1817070" },
        { title: "Marvel's Spider-Man: Miles Morales", steam_app_id: "1817190" },
        { title: "Death Stranding Director's Cut", steam_app_id: "1850570" },
        { title: "The Last of Us\u2122 Part I", steam_app_id: "1888930" },
        { title: "Days Gone", steam_app_id: "1259420" },
        { title: "Ratchet & Clank: Rift Apart", steam_app_id: "1895880" },
        { title: "UNCHARTED\u2122: Legacy of Thieves Collection", steam_app_id: "1659420" },
        { title: "Returnal\u2122", steam_app_id: "1649240" },
        { title: "Black Myth: Wukong", steam_app_id: "2358720" },
        { title: "Hi-Fi RUSH", steam_app_id: "1817230" },
        { title: "Control", steam_app_id: "870780" },
        { title: "STAR WARS Jedi: Fallen Order\u2122", steam_app_id: "1172380" },
        { title: "STAR WARS Jedi: Survivor\u2122", steam_app_id: "1774580" },
        { title: "METAL GEAR SOLID V: THE PHANTOM PAIN", steam_app_id: "287700" },
        { title: "METAL GEAR RISING: REVENGEANCE", steam_app_id: "235460" },
        { title: "Devil May Cry 5", steam_app_id: "601150" },
        { title: "Bayonetta", steam_app_id: "460790" },
        { title: "Sleeping Dogs: Definitive Edition", steam_app_id: "307690" },
        { title: "Mafia: Definitive Edition", steam_app_id: "1030840" },
        { title: "L.A. Noire", steam_app_id: "110800" },
        { title: "Batman\u2122: Arkham Knight", steam_app_id: "208650" },
        { title: "Middle-earth\u2122: Shadow of Mordor\u2122", steam_app_id: "241930" },
        { title: "Mad Max", steam_app_id: "234140" },
        { title: "Just Cause 3", steam_app_id: "225540" },
        { title: "Ghostwire: Tokyo", steam_app_id: "1475810" },

        // --- Souls-like / Challenging Action RPG (15) ---
        { title: "DARK SOULS\u2122 III", steam_app_id: "374320" },
        { title: "DARK SOULS\u2122: REMASTERED", steam_app_id: "570940" },
        { title: "Sekiro\u2122: Shadows Die Twice - GOTY Edition", steam_app_id: "814380" },
        { title: "Nioh 2 \u2013 The Complete Edition", steam_app_id: "1325200" },
        { title: "CODE VEIN", steam_app_id: "678960" },
        { title: "Mortal Shell", steam_app_id: "1110910" },
        { title: "Salt and Sanctuary", steam_app_id: "283640" },
        { title: "Sifu", steam_app_id: "2138710" },
        { title: "Blasphemous", steam_app_id: "774361" },
        { title: "Blasphemous 2", steam_app_id: "2114740" },
        { title: "Remnant: From the Ashes", steam_app_id: "617290" },
        { title: "Wo Long: Fallen Dynasty", steam_app_id: "1448440" },
        { title: "Trek to Yomi", steam_app_id: "1370050" },
        { title: "ENDER LILIES: Quietus of the Knights", steam_app_id: "1369630" },
        { title: "Thymesia", steam_app_id: "1343240" },

        // --- Western RPG (20) ---
        { title: "The Elder Scrolls V: Skyrim Special Edition", steam_app_id: "489830" },
        { title: "Fallout 4", steam_app_id: "377160" },
        { title: "Fallout: New Vegas", steam_app_id: "22380" },
        { title: "Starfield", steam_app_id: "1716740" },
        { title: "The Outer Worlds", steam_app_id: "578650" },
        { title: "Divinity: Original Sin 2 - Definitive Edition", steam_app_id: "435150" },
        { title: "Disco Elysium - The Final Cut", steam_app_id: "632470" },
        { title: "Mass Effect\u2122 Legendary Edition", steam_app_id: "1328670" },
        { title: "Dragon Age: Origins - Ultimate Edition", steam_app_id: "47810" },
        { title: "Dragon's Dogma 2", steam_app_id: "2054970" },
        { title: "Dragon's Dogma: Dark Arisen", steam_app_id: "367500" },
        { title: "Kingdom Come: Deliverance", steam_app_id: "379430" },
        { title: "Mount & Blade II: Bannerlord", steam_app_id: "261550" },
        { title: "Kenshi", steam_app_id: "233860" },
        { title: "Pillars of Eternity", steam_app_id: "291650" },
        { title: "Prey", steam_app_id: "480490" },
        { title: "Dishonored", steam_app_id: "205100" },
        { title: "Dishonored 2", steam_app_id: "403640" },
        { title: "DEATHLOOP", steam_app_id: "1252330" },
        { title: "South Park\u2122: The Stick of Truth\u2122", steam_app_id: "213670" },

        // --- JRPG / Eastern RPG (20) ---
        { title: "Persona 5 Royal", steam_app_id: "1687950" },
        { title: "Persona 4 Golden", steam_app_id: "1113000" },
        { title: "Persona 3 Reload", steam_app_id: "2161700" },
        { title: "FINAL FANTASY VII REMAKE INTERGRADE", steam_app_id: "1462040" },
        { title: "NieR:Automata\u2122", steam_app_id: "524220" },
        { title: "Yakuza 0", steam_app_id: "638970" },
        { title: "Yakuza: Like a Dragon", steam_app_id: "1235140" },
        { title: "Like a Dragon: Infinite Wealth", steam_app_id: "2072450" },
        { title: "Tales of Arise", steam_app_id: "740130" },
        { title: "OCTOPATH TRAVELER", steam_app_id: "921570" },
        { title: "OCTOPATH TRAVELER II", steam_app_id: "1971650" },
        { title: "CHRONO TRIGGER", steam_app_id: "613830" },
        { title: "Metaphor: ReFantazio", steam_app_id: "2679460" },
        { title: "Granblue Fantasy: Relink", steam_app_id: "881020" },
        { title: "SCARLET NEXUS", steam_app_id: "775500" },
        { title: "Monster Hunter: World", steam_app_id: "582010" },
        { title: "Monster Hunter Rise", steam_app_id: "1446780" },
        { title: "DRAGON BALL FighterZ", steam_app_id: "678950" },
        { title: "Ni no Kuni\u2122 Wrath of the White Witch\u2122 Remastered", steam_app_id: "798460" },
        { title: "CrossCode", steam_app_id: "368340" },

        // --- FPS / Shooters (25) ---
        { title: "DOOM Eternal", steam_app_id: "782330" },
        { title: "DOOM", steam_app_id: "379720" },
        { title: "Half-Life 2", steam_app_id: "220" },
        { title: "Half-Life: Alyx", steam_app_id: "546560" },
        { title: "Black Mesa", steam_app_id: "362890" },
        { title: "Portal", steam_app_id: "400" },
        { title: "Left 4 Dead 2", steam_app_id: "550" },
        { title: "Team Fortress 2", steam_app_id: "440" },
        { title: "BioShock Infinite", steam_app_id: "8870" },
        { title: "Titanfall\u00ae 2", steam_app_id: "1237970" },
        { title: "ULTRAKILL", steam_app_id: "1229490" },
        { title: "DUSK", steam_app_id: "519860" },
        { title: "AMID EVIL", steam_app_id: "673130" },
        { title: "Prodeus", steam_app_id: "964800" },
        { title: "Ghostrunner", steam_app_id: "1139900" },
        { title: "SUPERHOT", steam_app_id: "322500" },
        { title: "Spec Ops: The Line", steam_app_id: "50300" },
        { title: "Tom Clancy's Rainbow Six\u00ae Siege", steam_app_id: "359550" },
        { title: "Insurgency: Sandstorm", steam_app_id: "581320" },
        { title: "Hell Let Loose", steam_app_id: "686810" },
        { title: "Squad", steam_app_id: "393380" },
        { title: "Arma 3", steam_app_id: "107410" },
        { title: "Ready or Not", steam_app_id: "1144200" },
        { title: "Hunt: Showdown 1896", steam_app_id: "594650" },
        { title: "Deep Rock Galactic", steam_app_id: "548430" },

        // --- Horror (20) ---
        { title: "Resident Evil Village", steam_app_id: "1196590" },
        { title: "Resident Evil 2", steam_app_id: "883710" },
        { title: "Dead Space", steam_app_id: "1693980" },
        { title: "Silent Hill 2", steam_app_id: "2124490" },
        { title: "Alien: Isolation", steam_app_id: "214490" },
        { title: "Amnesia: The Dark Descent", steam_app_id: "57300" },
        { title: "SOMA", steam_app_id: "282140" },
        { title: "Outlast", steam_app_id: "238320" },
        { title: "Little Nightmares", steam_app_id: "424840" },
        { title: "Little Nightmares II", steam_app_id: "860510" },
        { title: "INSIDE", steam_app_id: "304430" },
        { title: "LIMBO", steam_app_id: "48000" },
        { title: "Darkwood", steam_app_id: "274520" },
        { title: "Layers of Fear", steam_app_id: "391720" },
        { title: "Resident Evil 7 Biohazard", steam_app_id: "418370" },
        { title: "Alan Wake Remastered", steam_app_id: "1335790" },
        { title: "Amnesia: Rebirth", steam_app_id: "999220" },
        { title: "The Evil Within 2", steam_app_id: "601430" },
        { title: "WORLD OF HORROR", steam_app_id: "913740" },
        { title: "Visage", steam_app_id: "594330" },

        // --- Survival / Crafting (20) ---
        { title: "Valheim", steam_app_id: "892970" },
        { title: "No Man's Sky", steam_app_id: "275850" },
        { title: "Palworld", steam_app_id: "1623730" },
        { title: "ARK: Survival Evolved", steam_app_id: "346110" },
        { title: "DayZ", steam_app_id: "221100" },
        { title: "Project Zomboid", steam_app_id: "108600" },
        { title: "7 Days to Die", steam_app_id: "251570" },
        { title: "V Rising", steam_app_id: "1604030" },
        { title: "Sons Of The Forest", steam_app_id: "1326470" },
        { title: "Subnautica: Below Zero", steam_app_id: "848450" },
        { title: "Grounded", steam_app_id: "962130" },
        { title: "The Long Dark", steam_app_id: "305620" },
        { title: "Green Hell", steam_app_id: "815370" },
        { title: "Raft", steam_app_id: "648800" },
        { title: "Sea of Thieves", steam_app_id: "1172620" },
        { title: "ASTRONEER", steam_app_id: "361420" },
        { title: "Conan Exiles", steam_app_id: "440900" },
        { title: "Enshrouded", steam_app_id: "1203620" },
        { title: "Don't Starve", steam_app_id: "219740" },
        { title: "DREDGE", steam_app_id: "1562430" },

        // --- Roguelike / Roguelite (20) ---
        { title: "Hades", steam_app_id: "1145360" },
        { title: "Slay the Spire", steam_app_id: "646570" },
        { title: "The Binding of Isaac: Rebirth", steam_app_id: "250900" },
        { title: "Dead Cells", steam_app_id: "588650" },
        { title: "Inscryption", steam_app_id: "1092790" },
        { title: "Risk of Rain 2", steam_app_id: "632360" },
        { title: "Enter the Gungeon", steam_app_id: "311690" },
        { title: "Noita", steam_app_id: "881100" },
        { title: "Nuclear Throne", steam_app_id: "242680" },
        { title: "Darkest Dungeon\u00ae", steam_app_id: "262060" },
        { title: "Rogue Legacy 2", steam_app_id: "1253920" },
        { title: "Crypt of the NecroDancer", steam_app_id: "247080" },
        { title: "Gunfire Reborn", steam_app_id: "1217060" },
        { title: "Cult of the Lamb", steam_app_id: "1313140" },
        { title: "Loop Hero", steam_app_id: "1282730" },
        { title: "Brotato", steam_app_id: "1942280" },
        { title: "FTL: Faster Than Light", steam_app_id: "212680" },
        { title: "Into the Breach", steam_app_id: "590380" },
        { title: "Void Bastards", steam_app_id: "857980" },
        { title: "Streets of Rogue", steam_app_id: "512900" },

        // --- Platformer / Metroidvania (20) ---
        { title: "Hollow Knight", steam_app_id: "367520" },
        { title: "Celeste", steam_app_id: "504230" },
        { title: "Cuphead", steam_app_id: "268910" },
        { title: "Ori and the Blind Forest: Definitive Edition", steam_app_id: "261570" },
        { title: "Ori and the Will of the Wisps", steam_app_id: "1057090" },
        { title: "Shovel Knight: Treasure Trove", steam_app_id: "250760" },
        { title: "A Hat in Time", steam_app_id: "253230" },
        { title: "Super Meat Boy", steam_app_id: "40800" },
        { title: "FEZ", steam_app_id: "224760" },
        { title: "Katana ZERO", steam_app_id: "460950" },
        { title: "The Messenger", steam_app_id: "764790" },
        { title: "Bloodstained: Ritual of the Night", steam_app_id: "692850" },
        { title: "Axiom Verge", steam_app_id: "332200" },
        { title: "Sonic Mania", steam_app_id: "584400" },
        { title: "Sonic Frontiers", steam_app_id: "1237320" },
        { title: "Crash Bandicoot\u2122 N. Sane Trilogy", steam_app_id: "731490" },
        { title: "Spyro\u2122 Reignited Trilogy", steam_app_id: "996580" },
        { title: "Mega Man 11", steam_app_id: "742300" },
        { title: "Tinykin", steam_app_id: "1599020" },
        { title: "Momodora: Reverie Under The Moonlight", steam_app_id: "428550" },

        // --- Grand Strategy / 4X / Tactics (15) ---
        { title: "Sid Meier\u2019s Civilization\u00ae VI", steam_app_id: "289070" },
        { title: "Crusader Kings III", steam_app_id: "1158310" },
        { title: "Europa Universalis IV", steam_app_id: "236850" },
        { title: "Hearts of Iron IV", steam_app_id: "394360" },
        { title: "Stellaris", steam_app_id: "281990" },
        { title: "XCOM\u00ae 2", steam_app_id: "268500" },
        { title: "Total War: WARHAMMER III", steam_app_id: "1142710" },
        { title: "Manor Lords", steam_app_id: "1363080" },
        { title: "Against the Storm", steam_app_id: "1336490" },
        { title: "Northgard", steam_app_id: "466560" },
        { title: "They Are Billions", steam_app_id: "644930" },
        { title: "Invisible, Inc.", steam_app_id: "243970" },
        { title: "Caves of Qud", steam_app_id: "333640" },
        { title: "Warhammer 40,000: Darktide", steam_app_id: "1361210" },
        { title: "Warhammer: Vermintide 2", steam_app_id: "552500" },

        // --- City Builder / Management / Simulation (20) ---
        { title: "Cities: Skylines", steam_app_id: "255710" },
        { title: "Factorio", steam_app_id: "427520" },
        { title: "RimWorld", steam_app_id: "294100" },
        { title: "Frostpunk", steam_app_id: "323190" },
        { title: "Frostpunk 2", steam_app_id: "1601580" },
        { title: "Oxygen Not Included", steam_app_id: "457140" },
        { title: "Prison Architect", steam_app_id: "233450" },
        { title: "Kerbal Space Program", steam_app_id: "220200" },
        { title: "Planet Zoo", steam_app_id: "703080" },
        { title: "Two Point Hospital", steam_app_id: "535930" },
        { title: "Euro Truck Simulator 2", steam_app_id: "227300" },
        { title: "American Truck Simulator", steam_app_id: "270880" },
        { title: "Tropico 6", steam_app_id: "492720" },
        { title: "Parkitect", steam_app_id: "453090" },
        { title: "This War of Mine", steam_app_id: "282070" },
        { title: "Dyson Sphere Program", steam_app_id: "1366540" },
        { title: "PowerWash Simulator", steam_app_id: "1290000" },
        { title: "Unpacking", steam_app_id: "1135690" },
        { title: "Dorfromantik", steam_app_id: "1455840" },
        { title: "DAVE THE DIVER", steam_app_id: "1868140" },

        // --- Puzzle / Narrative / Walking Sim (25) ---
        { title: "Return of the Obra Dinn", steam_app_id: "653530" },
        { title: "Papers, Please", steam_app_id: "239030" },
        { title: "The Witness", steam_app_id: "210970" },
        { title: "Baba Is You", steam_app_id: "736260" },
        { title: "The Stanley Parable: Ultra Deluxe", steam_app_id: "1703340" },
        { title: "Superliminal", steam_app_id: "1049410" },
        { title: "The Talos Principle", steam_app_id: "257510" },
        { title: "Antichamber", steam_app_id: "219890" },
        { title: "Braid", steam_app_id: "26800" },
        { title: "Firewatch", steam_app_id: "383870" },
        { title: "What Remains of Edith Finch", steam_app_id: "501300" },
        { title: "Gone Home", steam_app_id: "232430" },
        { title: "Oxenfree", steam_app_id: "388880" },
        { title: "Life is Strange", steam_app_id: "319630" },
        { title: "Night in the Woods", steam_app_id: "481510" },
        { title: "Spiritfarer\u00ae: Farewell Edition", steam_app_id: "972660" },
        { title: "A Short Hike", steam_app_id: "1055540" },
        { title: "Untitled Goose Game", steam_app_id: "837470" },
        { title: "To the Moon", steam_app_id: "206440" },
        { title: "Brothers - A Tale of Two Sons", steam_app_id: "225080" },
        { title: "ABZ\u00db", steam_app_id: "384190" },
        { title: "Journey", steam_app_id: "638230" },
        { title: "GRIS", steam_app_id: "683320" },
        { title: "Neva", steam_app_id: "2420660" },
        { title: "Chicory: A Colorful Tale", steam_app_id: "1123450" },

        // --- Visual Novel / Story-Driven Indie (14) ---
        { title: "Doki Doki Literature Club Plus!", steam_app_id: "1388880" },
        { title: "OMORI", steam_app_id: "1150690" },
        { title: "OneShot", steam_app_id: "420530" },
        { title: "VA-11 Hall-A: Cyberpunk Bartender Action", steam_app_id: "447530" },
        { title: "STEINS;GATE", steam_app_id: "412830" },
        { title: "Danganronpa: Trigger Happy Havoc", steam_app_id: "413410" },
        { title: "Phoenix Wright: Ace Attorney Trilogy", steam_app_id: "787480" },
        { title: "LISA: The Painful", steam_app_id: "335670" },
        { title: "Eastward", steam_app_id: "977880" },
        { title: "Everhood", steam_app_id: "1229380" },
        { title: "Coffee Talk", steam_app_id: "914800" },
        { title: "Rakuen", steam_app_id: "559210" },
        { title: "Strange Horticulture", steam_app_id: "1574580" },
        { title: "Moonlighter", steam_app_id: "606150" },

        // --- Coop / Party / Multiplayer Fun (20) ---
        { title: "It Takes Two", steam_app_id: "1426210" },
        { title: "A Way Out", steam_app_id: "1222700" },
        { title: "Overcooked! 2", steam_app_id: "728880" },
        { title: "PlateUp!", steam_app_id: "1599600" },
        { title: "Human: Fall Flat", steam_app_id: "477160" },
        { title: "Gang Beasts", steam_app_id: "285900" },
        { title: "Stick Fight: The Game", steam_app_id: "674940" },
        { title: "Totally Accurate Battle Simulator", steam_app_id: "508440" },
        { title: "Castle Crashers\u00ae", steam_app_id: "204360" },
        { title: "BattleBlock Theater\u00ae", steam_app_id: "238460" },
        { title: "Broforce", steam_app_id: "274190" },
        { title: "Worms W.M.D", steam_app_id: "327030" },
        { title: "Fall Guys", steam_app_id: "1097150" },
        { title: "PUBG: BATTLEGROUNDS", steam_app_id: "578080" },
        { title: "Dota 2", steam_app_id: "570" },
        { title: "Garry's Mod", steam_app_id: "4000" },
        { title: "Tabletop Simulator", steam_app_id: "286160" },
        { title: "Goat Simulator", steam_app_id: "265930" },
        { title: "Getting Over It with Bennett Foddy", steam_app_id: "240720" },
        { title: "Unrailed!", steam_app_id: "1016920" },

        // --- Fighting / Racing (10) ---
        { title: "Street Fighter\u2122 6", steam_app_id: "1364780" },
        { title: "TEKKEN 8", steam_app_id: "1778820" },
        { title: "GUILTY GEAR -STRIVE-", steam_app_id: "1384160" },
        { title: "Mortal Kombat 11", steam_app_id: "976310" },
        { title: "Brawlhalla", steam_app_id: "291550" },
        { title: "Lethal League Blaze", steam_app_id: "553310" },
        { title: "Nidhogg 2", steam_app_id: "535520" },
        { title: "Forza Horizon 5", steam_app_id: "1551360" },
        { title: "Forza Horizon 4", steam_app_id: "1293830" },
        { title: "Rocket League\u00ae", steam_app_id: "252950" },

        // --- Action Indie / Misc (20) ---
        { title: "Hotline Miami", steam_app_id: "219150" },
        { title: "Hotline Miami 2: Wrong Number", steam_app_id: "274170" },
        { title: "Hyper Light Drifter", steam_app_id: "257850" },
        { title: "TUNIC", steam_app_id: "553420" },
        { title: "Furi", steam_app_id: "423230" },
        { title: "Transistor", steam_app_id: "237930" },
        { title: "Bastion", steam_app_id: "107100" },
        { title: "Okami HD", steam_app_id: "587620" },
        { title: "HITMAN World of Assassination", steam_app_id: "1659040" },
        { title: "Mark of the Ninja: Remastered", steam_app_id: "860950" },
        { title: "Aragami", steam_app_id: "280160" },
        { title: "Children of Morta", steam_app_id: "330020" },
        { title: "Wizard of Legend", steam_app_id: "445980" },
        { title: "Spelunky 2", steam_app_id: "418530" },
        { title: "Dying Light", steam_app_id: "239140" },
        { title: "Dying Light 2 Stay Human", steam_app_id: "534380" },
        { title: "Slime Rancher", steam_app_id: "433340" },
        { title: "Coral Island", steam_app_id: "1158160" },
        { title: "Recettear: An Item Shop's Tale", steam_app_id: "70400" },
        { title: "Graveyard Keeper", steam_app_id: "599140" },

        // --- Recent / Trending (15) ---
        { title: "UFO 50", steam_app_id: "1147860" },
        { title: "Warhammer 40,000: Space Marine 2", steam_app_id: "2183900" },
        { title: "Pacific Drive", steam_app_id: "1458140" },
        { title: "Thank Goodness You're Here!", steam_app_id: "2366980" },
        { title: "1000xRESIST", steam_app_id: "1675560" },
        { title: "Potion Craft: Alchemist Simulator", steam_app_id: "1210320" },
        { title: "Bear and Breakfast", steam_app_id: "1136370" },
        { title: "Mini Motorways", steam_app_id: "1127500" },
        { title: "Soulstone Survivors", steam_app_id: "2066020" },
        { title: "Exo One", steam_app_id: "773370" },
        { title: "Manifold Garden", steam_app_id: "473950" },
        { title: "Opus Magnum", steam_app_id: "558990" },
        { title: "Darkest Dungeon\u00ae II", steam_app_id: "1940340" },
        { title: "Cassette Beasts", steam_app_id: "1321440" },
        { title: "Schedule I", steam_app_id: "3164500" },
    ];

    if (!gamesToSeed || gamesToSeed.length === 0) {
        console.warn("[SEED_WARN] 'gamesToSeed' array is empty. No data will be seeded or cleaned up.");
        return;
    }

    // Get all current games from the database with their review counts
    const dbGames = await new Promise((resolve, reject) => {
        db.all("SELECT id, title, steam_app_id FROM games", (err, rows) => {
            err ? reject(err) : resolve(rows || []);
        });
    });

    const titlesToSeed = gamesToSeed.map(g => g.title);

    // 1. Process games in gamesToSeed
    let apiCallCount = 0;
    for (const gameData of gamesToSeed) {
        // Basic validation
        if (!gameData.title || !gameData.steam_app_id) {
            console.error(`[SEED_ERROR] Invalid data for "${gameData.title || 'UNTITLED'}". Skipping.`);
            continue;
        }

        try {
            const existingGame = dbGames.find(g => g.title === gameData.title);
            let gameId;

            if (existingGame) {
                gameId = existingGame.id;

                // Update steam_app_id if different
                if (existingGame.steam_app_id !== gameData.steam_app_id) {
                    await new Promise((resolve, reject) => {
                        db.run("UPDATE games SET steam_app_id = ? WHERE id = ?", [gameData.steam_app_id, gameId], function (err) {
                            if (err) return reject(err);
                            if (this.changes > 0) console.log(`[SEED_SUCCESS] Updated AppID for "${gameData.title}" to ${gameData.steam_app_id}.`);
                            resolve();
                        });
                    });
                }

                // Check how many reviews exist for this game
                const reviewCount = await new Promise((resolve, reject) => {
                    db.get("SELECT COUNT(*) as count FROM game_reviews WHERE game_id = ?", [gameId], (err, row) => {
                        err ? reject(err) : resolve(row ? row.count : 0);
                    });
                });

                // FORCE_RESEED bypasses the "already has reviews" skip
                if (!forceReseed && reviewCount >= 6) {
                    console.log(`[SEED_INFO] Game "${gameData.title}" already has ${reviewCount} reviews. Skipping.`);
                    continue;
                }

                if (forceReseed && reviewCount >= 6) {
                    console.log(`[SEED_INFO] FORCE_RESEED: Re-fetching reviews for "${gameData.title}" (had ${reviewCount}).`);
                } else {
                    console.log(`[SEED_INFO] Game "${gameData.title}" has ${reviewCount} reviews (need 6). Will fetch new reviews.`);
                }

                // Delete existing reviews to re-fetch fresh set
                await new Promise((resolve, reject) => {
                    db.run("DELETE FROM game_reviews WHERE game_id = ?", [gameId], (err) => {
                        err ? reject(err) : resolve();
                    });
                });
            } else {
                console.log(`[SEED_INFO] Game "${gameData.title}" is new. Inserting.`);
                gameId = await new Promise((resolve, reject) => {
                    db.run("INSERT INTO games (title, steam_app_id) VALUES (?, ?)", [gameData.title, gameData.steam_app_id], function (err) {
                        if (err) {
                            console.error(`[SEED_DB_ERROR] Error inserting new game "${gameData.title}":`, err.message);
                            reject(err);
                        } else {
                            resolve(this.lastID);
                        }
                    });
                });
            }

            // Get review URLs: manual override or auto-fetch from API
            let reviewUrls;
            if (Array.isArray(gameData.reviews) && gameData.reviews.length >= 6) {
                console.log(`[SEED_INFO] Using manual review URLs for "${gameData.title}".`);
                reviewUrls = gameData.reviews;
            } else {
                // Rate limit: 1.5s delay between API calls
                if (apiCallCount > 0) {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
                reviewUrls = await fetchReviewsFromSteamAPI(gameData.steam_app_id, gameData.title);
                apiCallCount++;
            }

            if (!reviewUrls || reviewUrls.length === 0) {
                console.warn(`[SEED_WARN] No review URLs available for "${gameData.title}". Game will have no clues.`);
                continue;
            }

            if (reviewUrls.length < 6) {
                console.warn(`[SEED_WARN] Only ${reviewUrls.length} review URLs for "${gameData.title}" (expected 6).`);
            }

            // Insert reviews
            for (let i = 0; i < reviewUrls.length; i++) {
                const reviewPageUrl = reviewUrls[i];
                if (!reviewPageUrl || typeof reviewPageUrl !== 'string' || !reviewPageUrl.toLowerCase().startsWith('https://')) {
                    console.error(`[SEED_ERROR] Invalid review URL for "${gameData.title}", URL ${i + 1}: "${reviewPageUrl}". Skipping.`);
                    continue;
                }
                await new Promise((resolve_rev, reject_rev) => {
                    db.run("INSERT OR IGNORE INTO game_reviews (game_id, review_page_url, clue_order) VALUES (?, ?, ?)",
                        [gameId, reviewPageUrl, i + 1], function (err_rev) {
                            if (err_rev) {
                                console.error(`[SEED_DB_ERROR] Error inserting review URL for Game ID ${gameId}:`, err_rev.message);
                                reject_rev(err_rev);
                            } else {
                                resolve_rev();
                            }
                        });
                });
            }
            console.log(`[SEED_SUCCESS] Inserted ${reviewUrls.length} reviews for "${gameData.title}".`);
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
