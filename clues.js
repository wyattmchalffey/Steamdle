const axios = require('axios');
const cheerio = require('cheerio');

// Concrete terms from a game's own store description carry more weight than
// common mechanics. Generic praise, length and popularity aren't evidence.
const COMMON_WORDS = new Set(`about above across after again against along almost alone already also always
    amazing among another anyone anything around awesome back become before behind being below best better
    both bring build built called came coming complete completely content could deep deliver different
    discover during each easy either embark encounter endless enjoy enough enter entire even ever every
    everyone everything excellent exciting experience explore face facing fans favorite feature feel feeling
    feels fight find first follow following found free friends from full fully further game gameplay games
    gaming genre great greatest have having help here high highly hours huge iconic including incredible
    into journey just know large last latest lead learn leaving less life like little long look many make
    makes making master might more most much must need never next nothing offer once only open original
    other others over path people perfect play played player players playing popular possible powered
    praised prepare pretty push really real receive recommend release released return rich right role same
    second seem seemly series several should side since single something start still stop such take taken
    takes taking tell than that their them themselves then there these they thing things this those
    though through throughout time times title today together tons total truly turn under unique unlike
    until upon using variety very want well were what whatever when where which while with within without
    wonder work world would years your yourself beautiful action adventure level indie iconic steam
    classic award awards winning acclaimed edition developer franchise known available team teams
    hours hour complex constant regular totally update updates even matter change changes regular continue
    million millions everyone given hundreds hundred thousands ready brings history music graphics story
    everything sense personal chance computer successful learn positive gaming certain takes`.trim().split(/\s+/));

const MECHANICS = new Set(`combat boss craft inventory stealth puzzle platformer roguelike roguelite
    sandbox survival multiplayer coop pvp pve mmorpg moba rts rac horror dungeon loot respawn checkpoint
    cooldown stamina mana hitbox parry dodge heal quest dialogue cutscene campaign permadeath procedural
    weapon armor shield potion spell summon matchmaking loadout healer aggro rhythm farm harvest crop fish
    mine ore automation conveyor factory block jump turret gun shoot gravity chamber cook recipe deck card
    dice beat lane tower draft hero spaceship ship colony villager village monster island forest cave map
    biome train rail circuit rocket detective suspect witness courtroom evidence mystery relationship
    marriage romance animal horse prison planet alien zombie vampire ghost wizard dragon knight pirate
    robot dinosaur deckbuild platform swing grapple wheel drift skater ski climb paint reroll relic draw
    loop rewind timewarp trap portal companion spellcast runner movement dash melee ranged projectile
    counter combo ward creep safelane offlane jungle gank boon bless stratagem momentum launch core
    engineer physics`.trim().split(/\s+/));

function words(text) {
    return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function rootWord(word) {
    if (word.endsWith('heroes')) return 'hero';
    if (word.endsWith('bosses')) return 'boss';
    if (word.length > 5 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
    if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
}

function selectClues(reviews, title, description = '') {
    const titleWords = words(title);
    const titlePhrase = titleWords.join(' ');
    const titleTerms = new Set(titleWords.filter(word => word.length >= 4 && !COMMON_WORDS.has(word)));
    const storeTerms = new Set(words(description)
        .filter(word => word.length >= 4 && !COMMON_WORDS.has(word) && !titleTerms.has(word))
        .map(rootWord));
    // CamelCase and capitalized names within sentences catch settings/characters
    // such as Aperture Science. Sentence-initial marketing copy is weaker.
    const namePhrases = description.match(/\b[A-Za-z]*[a-z][A-Z][A-Za-z]*\b|\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+\b|(?<=[a-z] )[A-Z][a-zA-Z]{3,}\b/g) || [];
    const storeNames = new Set(words(namePhrases.join(' ')).map(rootWord).filter(word => storeTerms.has(word)));
    const seenText = new Set();
    const seenAuthors = new Set();
    const weightOf = term => storeNames.has(term) ? 14 : storeTerms.has(term) ? 3 : 2;
    const candidates = [];
    for (const review of reviews) {
        const raw = review.review;
        if (!raw || /\[spoiler\]|spoiler alert|https?:\/\//i.test(raw) || !review.author?.steamid ||
            (raw.match(/[✔✘☑☒☐✅❌🔲]|\[[ x]\]/giu) || []).length > 2) continue;
        const text = raw.replace(/\[\/?[a-z][a-z0-9_]*(?:=[^\]]+)?\]/gi, '').trim();
        const tokens = words(text);
        const phrase = tokens.join(' ');
        if (text.length < 30 || text.length > 850 || tokens.length < 5 ||
            text.replace(/[^A-Za-z]/g, '').length / text.length < 0.4 ||
            seenText.has(phrase) || seenAuthors.has(review.author.steamid) ||
            (' ' + phrase + ' ').includes(' ' + titlePhrase + ' ') ||
            tokens.some(word => titleTerms.has(word) || word === titleWords.join(''))) continue;
        seenText.add(phrase);
        seenAuthors.add(review.author.steamid);

        const terms = new Set(tokens.map(rootWord).filter(word => storeTerms.has(word) || MECHANICS.has(word))
            .sort((a, b) => weightOf(b) - weightOf(a)));
        // Prefer a concentrated, readable clue when two cover the same details.
        const evidence = [...terms].slice(0, 4).reduce((total, term) => total + weightOf(term), 0);
        const score = evidence - text.length / 350;
        candidates.push({ review: { ...review, review: text }, terms, evidence, score });
    }
    if (candidates.length < 6) return [];
    candidates.sort((a, b) => b.score - a.score);
    const detailed = candidates.filter(candidate => candidate.terms.size > 0);

    // Reserve one fresh piece of evidence for each of the last two turns.
    for (const last of detailed) {
        for (const fifth of detailed) {
            const finalTerm = [...last.terms].find(term => !fifth.terms.has(term));
            const fifthTerm = [...fifth.terms].find(term => !last.terms.has(term));
            if (!finalTerm || !fifthTerm) continue;
            const early = candidates.filter(candidate => !candidate.terms.has(finalTerm) && !candidate.terms.has(fifthTerm));
            if (early.length < 4) continue;
            early.sort((a, b) => a.evidence - b.evidence || a.review.review.length - b.review.review.length);
            const funny = early.filter(candidate => candidate.review._source === 'funny' &&
                candidate.terms.size <= 1 && candidate.review.review.length <= 220);
            funny.sort((a, b) => (b.review.votes_funny || 0) - (a.review.votes_funny || 0));
            const opener = funny[0] || early[0];
            const middle = early.filter(candidate => candidate !== opener);
            // Advance from a vague review to moderately informative ones.
            const step = (middle.length - 1) / 3;
            return [opener, middle[0], middle[Math.max(1, Math.round(step))],
                middle[Math.max(2, Math.round(2 * step))], fifth, last].map(candidate => candidate.review);
        }
    }
    return [];
}

async function fetchPage(appId, filter, pageSize) {
    const input = {
        appid: Number(appId), languages: ['english'], purchase_type: 1, filter,
        num_per_page: pageSize
    };
    if (filter === 0) input.day_range = 0; // Helpful reviews from the game's whole lifetime.
    try {
        const { data } = await axios.get('https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/', {
            params: { input_json: JSON.stringify(input) }, timeout: 15000
        });
        if (!Array.isArray(data?.response?.reviews)) throw new Error('Missing review list');
        return data.response.reviews
            .filter(review => typeof review?.review === 'string' && /^\d+$/.test(review.author?.steamid))
            .map(review => ({ ...review, _source: filter === 3 ? 'funny' : 'helpful' }));
    } catch (error) {
        console.warn(`[REVIEW_POOL] Could not fetch review sort ${filter} for ${appId}: ${error.message}`);
        return [];
    }
}

async function fetchDescription(appId) {
    try {
        const { data } = await axios.get('https://store.steampowered.com/api/appdetails', {
            params: { appids: appId, filters: 'basic', l: 'english' }, timeout: 6000
        });
        const item = data?.[appId]?.data;
        const html = [item?.short_description, item?.about_the_game].filter(Boolean).join(' ');
        return cheerio.load(html.replace(/<[^>]+>/g, ' ')).text().replace(/\s+/g, ' ').slice(0, 1500);
    } catch {
        // Concrete mechanics can still qualify a set when store metadata is unavailable.
        return '';
    }
}

async function fetchProfiles(steamIds) {
    const profiles = new Map();
    if (!process.env.STEAM_API_KEY) return profiles;
    try {
        const { data } = await axios.get('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/', {
            params: { key: process.env.STEAM_API_KEY, steamids: steamIds.join(',') }, timeout: 6000
        });
        for (const profile of data.response.players) profiles.set(profile.steamid, profile);
    } catch {
        console.warn('[REVIEW_POOL] Reviewer profiles unavailable. Using generic attribution.');
    }
    return profiles;
}

async function fetchGameClues(appId, title) {
    const [funny, description] = await Promise.all([fetchPage(appId, 3, 50), fetchDescription(appId)]);
    await new Promise(resolve => setTimeout(resolve, 300));
    const helpful = await fetchPage(appId, 0, 100);
    const selected = selectClues([...funny, ...helpful], title, description);
    if (selected.length !== 6) return [];
    const profiles = await fetchProfiles(selected.map(review => review.author.steamid));
    return selected.map(review => {
        const author = review.author;
        const url = `https://steamcommunity.com/profiles/${author.steamid}/recommended/${appId}/`;
        const profile = profiles.get(author.steamid);
        const minutes = author.playtime_at_review ?? author.playtime_forever;
        const date = new Date(review.timestamp_created * 1000);
        return { url, data: {
            originalUrl: url,
            reviewerName: profile?.personaname || 'A Steam User',
            reviewerAvatarUrl: profile?.avatarmedium || null,
            recommendation: review.voted_up ? 'Recommended' : 'Not Recommended',
            playtime: minutes == null ? 'Playtime not shown' : `${(minutes / 60).toFixed(1)} hrs`,
            datePosted: Number.isNaN(date.getTime()) ? 'Date not found' :
                date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }),
            reviewText: review.review
        } };
    });
}

module.exports = { selectClues, fetchGameClues };
