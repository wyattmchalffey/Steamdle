import { normalizeTitle } from './round.mjs';

const dateFormat = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
});
const tiles = { wrong: '\u{1f7e5}', skip: '\u2b1c', solve: '\u{1f7e9}' };

// Return only the result. Neither the answer nor a player's guesses belong in a share.
export function buildShareResult({ puzzleDate, attempts, answer, maxClues = 6, origin }) {
    const day = typeof puzzleDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(puzzleDate)
        ? new Date(puzzleDate + 'T00:00:00Z') : new Date(NaN);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== puzzleDate) {
        throw new RangeError('A valid puzzle date is required.');
    }
    if (!Number.isInteger(maxClues) || maxClues < 1 || maxClues > 6 || !Array.isArray(attempts) ||
        !attempts.length || attempts.length > maxClues ||
        attempts.some(guess => guess !== null && typeof guess !== 'string') || !normalizeTitle(answer)) {
        throw new RangeError('A completed round is required.');
    }
    const correct = normalizeTitle(answer);
    const outcomes = attempts.map(guess => guess === null ? 'skip'
        : normalizeTitle(guess) === correct ? 'solve' : 'wrong');
    const winIndex = outcomes.indexOf('solve');
    const won = winIndex !== -1;
    if ((won && winIndex !== attempts.length - 1) || (!won && attempts.length !== maxClues)) {
        throw new RangeError('Only completed rounds can be shared.');
    }
    const target = new URL('/', origin);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
        throw new TypeError('A website origin is required.');
    }
    target.searchParams.set('utm_source', 'player_share');
    target.searchParams.set('share_date', puzzleDate);
    const score = `${won ? attempts.length : 'X'}/${maxClues}`;
    const grid = outcomes.map(outcome => tiles[outcome]).join('');
    const dateLabel = dateFormat.format(day);
    const invitation = won
        ? `I guessed the Steam game in ${attempts.length} ${attempts.length === 1 ? 'clue. Can you match it?' : 'clues. Can you beat me?'}`
        : 'This Steam game stumped me. Can you solve it?';
    const message = `Steamdle · ${dateLabel} · ${score}\n${grid}\n\n${invitation}`;
    const url = target.href;
    return { date: puzzleDate, dateLabel, won, score, grid, outcomes,
        message, text: `${message}\n${url}`, url, title: 'Steamdle — Guess the Steam game' };
}

function roundedBox(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

function drawTile(ctx, outcome, x, y) {
    const size = 76;
    roundedBox(ctx, x, y, size, size, 12);
    ctx.fillStyle = ({ wrong: '#d76b6b', skip: '#d6e0e8', solve: '#8abd55' })[outcome] || '#172a3b';
    ctx.fill();
    if (!outcome) {
        ctx.strokeStyle = '#38546a';
        ctx.lineWidth = 2;
        ctx.stroke();
        return;
    }
    ctx.strokeStyle = '#102030';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (outcome === 'solve') {
        ctx.moveTo(x + 22, y + 39);
        ctx.lineTo(x + 34, y + 51);
        ctx.lineTo(x + 55, y + 26);
    } else if (outcome === 'wrong') {
        ctx.moveTo(x + 25, y + 25);
        ctx.lineTo(x + 51, y + 51);
        ctx.moveTo(x + 51, y + 25);
        ctx.lineTo(x + 25, y + 51);
    } else {
        ctx.moveTo(x + 24, y + 38);
        ctx.lineTo(x + 52, y + 38);
    }
    ctx.stroke();
}

// Draw with local fonts and paths so the PNG cannot accidentally include a clue,
// a game cover, third-party content, or a tainted canvas image.
export async function createShareCard(result, document = globalThis.document) {
    const canvas = document?.createElement('canvas');
    if (!canvas) throw new Error('Image sharing is unavailable.');
    canvas.width = 1200;
    canvas.height = 630;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.toBlob !== 'function') throw new Error('Image sharing is unavailable.');

    ctx.fillStyle = '#101d2a';
    ctx.fillRect(0, 0, 1200, 630);
    ctx.fillStyle = '#66c0f4';
    ctx.fillRect(0, 0, 1200, 8);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.font = '700 34px Arial, sans-serif';
    ctx.fillText('STEAMDLE', 72, 88);
    ctx.font = '400 23px Arial, sans-serif';
    ctx.fillStyle = '#a8bac9';
    ctx.textAlign = 'right';
    ctx.fillText(result.dateLabel, 1128, 86);
    ctx.textAlign = 'left';

    ctx.fillStyle = '#f1f6fa';
    ctx.font = '700 58px Arial, sans-serif';
    const used = result.outcomes.length;
    ctx.fillText(result.won ? `Solved in ${used} ${used === 1 ? 'clue' : 'clues'}.` : 'This one got me.', 72, 205);
    ctx.font = '400 27px Arial, sans-serif';
    ctx.fillStyle = '#a8bac9';
    ctx.fillText('Guess the Steam game from its reviews.', 72, 255);

    const total = Number(result.score.split('/')[1]);
    for (let i = 0; i < total; i++) drawTile(ctx, result.outcomes[i], 72 + i * 90, 310);
    ctx.textAlign = 'right';
    ctx.font = '700 100px Arial, sans-serif';
    ctx.fillStyle = result.won ? '#8abd55' : '#d6e0e8';
    ctx.fillText(result.score, 1128, 386);
    ctx.textAlign = 'left';

    ctx.fillStyle = '#30485d';
    ctx.fillRect(72, 441, 1056, 1);
    ctx.fillStyle = '#f1f6fa';
    ctx.font = '700 33px Arial, sans-serif';
    ctx.fillText(result.won ? used === 1 ? 'Can you match my score?' : 'Can you beat my score?' : 'Can you solve it?', 72, 505);
    ctx.fillStyle = '#66c0f4';
    ctx.font = '700 29px Arial, sans-serif';
    ctx.fillText('steamdle.com', 72, 558);
    ctx.font = '400 22px Arial, sans-serif';
    ctx.fillStyle = '#a8bac9';
    ctx.textAlign = 'right';
    ctx.fillText('A new puzzle every day', 1128, 557);

    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The result image could not be created.')), 'image/png');
    });
}
