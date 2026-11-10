const PREFIX = 'steamdle.result.v1.';
const DAY_MS = 86400000;
const unavailableStorage = new WeakSet();
const utcToday = () => new Date().toISOString().slice(0, 10);

function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const time = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function resultForDay(value, date, today) {
    if (!value || typeof value !== 'object' || !validDay(date) || date > today || value.date !== date ||
        typeof value.won !== 'boolean' || !Number.isInteger(value.turns) || value.turns < 1 || value.turns > 6 ||
        (!value.won && value.turns !== 6)) return null;
    const appId = String(value.appId ?? '');
    if (!/^[1-9]\d{0,11}$/.test(appId)) return null;
    // Return only the compact result; guesses, game titles and review text do not belong here.
    return { date, appId, won: value.won, turns: value.turns };
}

function emptyStats(available) {
    return { available, played: 0, solved: 0, winRate: 0, currentStreak: 0, bestStreak: 0, history: [] };
}

function usableStorage(storage) {
    try {
        return storage && typeof storage === 'object' && typeof storage.getItem === 'function' &&
            typeof storage.setItem === 'function' && typeof storage.key === 'function';
    } catch { return false; }
}

export function saveResult(storage, result, today = utcToday()) {
    if (!usableStorage(storage) || !validDay(today)) return false;
    const clean = resultForDay(result, result?.date, today);
    if (!clean) return false;
    try {
        const key = PREFIX + clean.date;
        const saved = storage.getItem(key);
        let previous;
        try { previous = resultForDay(JSON.parse(saved), clean.date, today); }
        catch { /* A damaged result can be replaced by the actual completed round. */ }
        // One result per puzzle day. Reopening a finished round cannot add another play
        // or change a historical result after scoring rules have changed.
        if (previous) {
            unavailableStorage.delete(storage);
            return previous.appId === clean.appId && previous.won === clean.won && previous.turns === clean.turns;
        }
        // A separate key for each date prevents tabs completing different days from
        // overwriting an entire shared history. The game's turn lock serializes same-day play.
        storage.setItem(key, JSON.stringify(clean));
        unavailableStorage.delete(storage);
        return true;
    } catch {
        unavailableStorage.add(storage);
        return false;
    }
}

export function readStats(storage, today = utcToday()) {
    if (!usableStorage(storage) || !validDay(today) || unavailableStorage.has(storage)) return emptyStats(false);
    try {
        const history = [];
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (!key?.startsWith(PREFIX)) continue;
            const date = key.slice(PREFIX.length);
            const saved = storage.getItem(key);
            let result;
            try { result = resultForDay(JSON.parse(saved), date, today); }
            catch { continue; }
            if (result) history.push(result);
        }
        history.sort((a, b) => b.date.localeCompare(a.date));
        const stats = emptyStats(true);
        stats.history = history;
        stats.played = history.length;
        stats.solved = history.filter(result => result.won).length;
        stats.winRate = stats.played ? Math.round(stats.solved * 100 / stats.played) : 0;
        const completed = new Set(history.map(result => result.date));
        const todayTime = Date.parse(today + 'T00:00:00Z');
        // Today's unfinished puzzle does not break yesterday's streak. Completing a
        // puzzle counts whether it was solved or all six turns were used.
        let cursor = completed.has(today) ? todayTime : todayTime - DAY_MS;
        while (completed.has(new Date(cursor).toISOString().slice(0, 10))) {
            stats.currentStreak++;
            cursor -= DAY_MS;
        }
        let run = 0, previousTime;
        for (let i = history.length - 1; i >= 0; i--) {
            const time = Date.parse(history[i].date + 'T00:00:00Z');
            run = previousTime !== undefined && time - previousTime === DAY_MS ? run + 1 : 1;
            stats.bestStreak = Math.max(stats.bestStreak, run);
            previousTime = time;
        }
        return stats;
    } catch {
        unavailableStorage.add(storage);
        return emptyStats(false);
    }
}

export function nextPuzzleTime(now = Date.now()) {
    const time = now instanceof Date ? now.getTime() : now;
    if (typeof time !== 'number' || !Number.isFinite(time)) return null;
    const date = new Date(time);
    if (!Number.isFinite(date.getTime())) return null;
    const at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
    const remaining = Math.max(0, at - time);
    const seconds = Math.ceil(remaining / 1000);
    const countdown = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map(part => String(part).padStart(2, '0')).join(':');
    const localLabel = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    }).format(new Date(at));
    return { at, remaining, countdown, localLabel };
}
