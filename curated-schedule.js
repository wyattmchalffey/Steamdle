const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { prepareCuratedTrial } = require('./curated-trial');

const dayOf = date => date.toISOString().slice(0, 10);
const nextDay = day => dayOf(new Date(Date.parse(day + 'T00:00:00Z') + 86400000));
const fingerprint = pack => createHash('sha256').update(JSON.stringify(pack)).digest('hex');

async function ensureScheduleTables(db) {
    await promisify(db.exec.bind(db))(`
        CREATE TABLE IF NOT EXISTS curated_schedule_installations (
            version TEXT PRIMARY KEY, installed_at TEXT NOT NULL, start_date TEXT NOT NULL,
            end_date TEXT NOT NULL, pack_sha256 TEXT NOT NULL, game_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS curated_schedule_backups (
            version TEXT NOT NULL, puzzle_date TEXT NOT NULL, game_id INTEGER NOT NULL,
            puzzle_json TEXT NOT NULL, PRIMARY KEY (version, puzzle_date)
        );
    `);
}

function validateSchedule(pack) {
    const games = prepareCuratedTrial(pack);
    const days = pack.schedule?.days;
    if (!Array.isArray(days) || days.length !== 30 || games.size !== 30) {
        throw new Error('A curated month must contain exactly 30 games and 30 dates.');
    }
    const ids = new Set();
    for (const [index, day] of days.entries()) {
        const appId = String(day.steam_app_id);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
            dayOf(new Date(day.date + 'T00:00:00Z')) !== day.date ||
            (index && nextDay(days[index - 1].date) !== day.date) ||
            !games.has(appId) || ids.has(appId)) {
            throw new Error('Curated dates must be consecutive with one distinct game per day.');
        }
        ids.add(appId);
    }
    return { games, days };
}

async function installCuratedSchedule(db, pack, now = new Date()) {
    const { games, days } = validateSchedule(pack);
    const today = dayOf(now);
    const get = promisify(db.get.bind(db));
    const all = promisify(db.all.bind(db));
    const run = promisify(db.run.bind(db));
    await ensureScheduleTables(db);
    await run('BEGIN IMMEDIATE');
    try {
        const installed = await get('SELECT * FROM curated_schedule_installations WHERE version = ?', pack.version);
        if (installed) {
            if (installed.pack_sha256 !== fingerprint(pack)) throw new Error('An installed schedule version cannot change.');
            await run('COMMIT');
            return { status: 'already-installed', ...installed };
        }
        if (days[0].date !== nextDay(today)) {
            throw new Error('A new curated month must start at the next UTC puzzle reset; today and past dates are protected.');
        }
        const selected = [];
        const conflicts = [];
        for (const day of days) {
            const game = games.get(String(day.steam_app_id));
            const row = await get('SELECT id, steam_app_id FROM games WHERE title = ? AND is_active = TRUE', game.title);
            if (!row || String(row.steam_app_id) !== game.steam_app_id) throw new Error('Missing catalog identity: ' + game.title);
            const legacy = await get(`SELECT MAX(last_played_on) AS last_played FROM games
                WHERE CAST(steam_app_id AS TEXT) = ?`, game.steam_app_id);
            // Include inactive aliases and every immutable snapshot. A source-history
            // audit is useful, but live usage is authoritative at installation time.
            const prior = await all(`SELECT puzzle_date FROM daily_puzzles WHERE
                game_id = ? OR CAST(json_extract(puzzle_json, '$.appId') AS TEXT) = ?`, [row.id, game.steam_app_id]);
            if (legacy.last_played || prior.length) {
                conflicts.push({ title: game.title, appId: game.steam_app_id,
                    legacyDate: legacy.last_played, snapshotDates: prior.map(item => item.puzzle_date) });
            }
            selected.push({ day, game, row });
        }
        if (conflicts.length) {
            const error = new Error('Curated month contains games already used or reserved: ' + conflicts.map(item => item.title).join(', '));
            error.conflicts = conflicts;
            throw error;
        }
        for (const { day, game, row } of selected) {
            // Only future rows in this explicitly requested month may be replaced.
            // Save the previous unpublished choice before replacing it.
            await run(`INSERT INTO curated_schedule_backups (version, puzzle_date, game_id, puzzle_json)
                SELECT ?, puzzle_date, game_id, puzzle_json FROM daily_puzzles WHERE puzzle_date = ?`, [pack.version, day.date]);
            const puzzle = { title: game.title, appId: game.steam_app_id,
                reviews: game.clues.map(clue => clue.data), puzzleDate: day.date,
                puzzleDateFormatted: new Date(day.date + 'T00:00:00Z').toLocaleDateString('en-US', {
                    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric'
                }), curationVersion: pack.version };
            await run(`INSERT INTO daily_puzzles (puzzle_date, game_id, puzzle_json) VALUES (?, ?, ?)
                ON CONFLICT(puzzle_date) DO UPDATE SET game_id = excluded.game_id, puzzle_json = excluded.puzzle_json`,
                [day.date, row.id, JSON.stringify(puzzle)]);
        }
        await run(`INSERT INTO curated_schedule_installations
            (version, installed_at, start_date, end_date, pack_sha256, game_count) VALUES (?, ?, ?, ?, ?, ?)`,
            [pack.version, now.toISOString(), days[0].date, days.at(-1).date, fingerprint(pack), days.length]);
        await run('COMMIT');
        return { status: 'installed', version: pack.version, start_date: days[0].date, end_date: days.at(-1).date, game_count: days.length };
    } catch (error) {
        await run('ROLLBACK');
        throw error;
    }
}

async function curatedScheduleStatus(db, pack) {
    await db.ready;
    await ensureScheduleTables(db);
    const get = promisify(db.get.bind(db));
    const all = promisify(db.all.bind(db));
    const installed = await get('SELECT * FROM curated_schedule_installations WHERE version = ?', pack.version);
    const rows = await all(`SELECT puzzle_date, puzzle_json FROM daily_puzzles
        WHERE puzzle_date BETWEEN ? AND ? ORDER BY puzzle_date`, [pack.schedule.days[0].date, pack.schedule.days.at(-1).date]);
    const expected = new Map(pack.schedule.days.map(day => [day.date, String(day.steam_app_id)]));
    const prepared = prepareCuratedTrial(pack);
    const days = rows.map(row => {
        const puzzle = JSON.parse(row.puzzle_json);
        return { date: row.puzzle_date, title: puzzle.title, appId: String(puzzle.appId),
            clueCount: puzzle.reviews?.length || 0, curationVersion: puzzle.curationVersion || null,
            matches: expected.get(row.puzzle_date) === String(puzzle.appId) && puzzle.puzzleDate === row.puzzle_date &&
                puzzle.curationVersion === pack.version && puzzle.reviews?.length === 6 &&
                JSON.stringify(puzzle.reviews) === JSON.stringify(prepared.get(String(puzzle.appId))?.clues.map(clue => clue.data)) };
    });
    return { version: pack.version, installed: installed || null,
        complete: Boolean(installed) && installed.pack_sha256 === fingerprint(pack) && !db.scheduleInstallationError &&
            days.length === 30 && days.every(day => day.matches),
        error: db.scheduleInstallationError || null, today: dayOf(new Date()), days };
}

module.exports = { installCuratedSchedule, curatedScheduleStatus, validateSchedule };
