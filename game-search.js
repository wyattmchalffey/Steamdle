const catalog = require('./catalog');
const titleAliases = require('./title-aliases');

// Steam's game list can still contain demos and extras. Match labels at the end
// of a title or following a separator, so e.g. "Frostpunk" remains a game.
const extraContent = /(?:\b(?:dlc|ost|soundtrack|art ?book|demo|playtest|season pass|dedicated server|skin pack)\s*$|\s[-–—:]\s*(?:dlc|ost|soundtrack|art ?book|demo|playtest|season pass|skin pack)\b)/i;

function searchWords(value) {
    return value.normalize('NFD').toLowerCase().replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function buildSearchIndex(steamApps = []) {
    const entries = new Map();
    const catalogById = new Map(catalog.map(game => [game.steam_app_id, game.title]));
    const extraStoreMatches = [];
    function add(name, displayName, origin) {
        const words = searchWords(name);
        const compact = words.replace(/ /g, '');
        if (!compact) return;
        const curated = origin !== 'steam';
        const existing = entries.get(compact);
        if (!existing || (curated && !existing.curated)) {
            entries.set(compact, { name: displayName, words, compact, curated, storeAlias: origin === 'storeAlias' });
        } else if (origin === 'storeAlias' && existing.storeAlias && existing.name !== displayName) {
            // A store spelling shared by two playable apps can suggest either,
            // but can't identify a typed guess until the player selects one.
            existing.ambiguous = true;
            if (!extraStoreMatches.some(entry => entry.compact === compact && entry.name === displayName)) {
                extraStoreMatches.push({ name: displayName, words, compact, curated, ambiguous: true });
            }
        }
    }
    for (const { title } of catalog) add(title, title, 'catalog');
    for (const [appId, aliases] of Object.entries(titleAliases)) {
        const title = catalogById.get(appId);
        if (!title) continue;
        for (const alias of aliases) add(alias, title, 'catalog');
    }
    for (const app of steamApps) {
        if (typeof app.name !== 'string' || extraContent.test(app.name)) continue;
        const catalogName = catalogById.get(String(app.appid));
        add(app.name, catalogName || app.name, catalogName ? 'storeAlias' : 'steam');
    }
    return [...entries.values(), ...extraStoreMatches];
}

// Only alternate names of playable titles need to travel with a puzzle.
// The browser already accepts their canonical display names directly.
function buildGuessAliases(entries) {
    const aliases = Object.create(null);
    for (const entry of entries) {
        if (entry.curated && !entry.ambiguous && entry.compact !== searchWords(entry.name).replace(/ /g, '')) {
            aliases[entry.compact] = entry.name;
        }
    }
    return aliases;
}

function searchGames(entries, term, limit) {
    const words = searchWords(term);
    const query = words.replace(/ /g, '');
    if (!query) return [];

    const matches = new Map();
    function record(entry, score) {
        // Steam can use a different title for a curated app ID. Both spellings
        // must suggest the title accepted by the game.
        if (!matches.has(entry.name) || matches.get(entry.name).score < score) {
            matches.set(entry.name, { name: entry.name, score, curated: entry.curated });
        }
    }
    for (const entry of entries) {
        if (entry.compact === query) record(entry, 100);
        else if (entry.compact.startsWith(query)) record(entry, 80);
        else if (entry.words.includes(' ' + words)) record(entry, 60);
        else if (entry.compact.includes(query)) record(entry, 40);
    }
    if (matches.size < 3 && query.length >= 2) {
        for (const entry of entries) {
            // Only suggest close subsequence matches, not an unrelated long
            // title that happens to contain the same letters somewhere.
            if (entry.compact.length > query.length + 4 || matches.has(entry.name)) continue;
            let offset = 0;
            for (const char of entry.compact) {
                if (char === query[offset]) offset++;
            }
            if (offset === query.length) record(entry, 20);
        }
    }
    return [...matches.values()].sort((a, b) =>
        b.score - a.score || Number(b.curated) - Number(a.curated) ||
        a.name.length - b.name.length || a.name.localeCompare(b.name)
    ).slice(0, limit).map(match => match.name);
}

module.exports = { buildSearchIndex, buildGuessAliases, searchGames };
