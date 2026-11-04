const catalog = require('./catalog');

// Steam's game list can still contain demos and extras. Match labels at the end
// of a title or following a separator, so e.g. "Frostpunk" remains a game.
const extraContent = /(?:\b(?:dlc|ost|soundtrack|art ?book|demo|playtest|season pass|dedicated server|skin pack)\s*$|\s[-–—:]\s*(?:dlc|ost|soundtrack|art ?book|demo|playtest|season pass|skin pack)\b)/i;

function searchWords(value) {
    return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function buildSearchIndex(steamApps = []) {
    const entries = new Map();
    const catalogById = new Map(catalog.map(game => [game.steam_app_id, game.title]));
    function add(name, displayName, curated) {
        const words = searchWords(name);
        const compact = words.replace(/ /g, '');
        if (compact && !entries.has(compact)) {
            entries.set(compact, { name: displayName, words, compact, curated });
        }
    }
    for (const { title } of catalog) add(title, title, true);
    for (const app of steamApps) {
        if (typeof app.name !== 'string' || extraContent.test(app.name)) continue;
        const catalogName = catalogById.get(String(app.appid));
        add(app.name, catalogName || app.name, Boolean(catalogName));
    }
    return [...entries.values()];
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

module.exports = { buildSearchIndex, searchGames };
