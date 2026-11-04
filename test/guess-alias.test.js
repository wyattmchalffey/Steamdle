const { test } = require('node:test');
const assert = require('node:assert/strict');

const gta = 'Grand Theft Auto V';
const skyrim = 'The Elder Scrolls V: Skyrim Special Edition';
const aliases = { gtav: gta, gta5: gta, cs2: 'Counter-Strike 2', skyrim };

test('directly typed aliases persist as the accepted game and restore with the same outcome', async () => {
    const { canonicalGuess, decodeAttempts, guessError } = await import('../public/round.mjs');
    for (const [guess, answer] of [['G.T.A. 5', gta], ['cs2', 'Counter-Strike 2'], ['SKYRIM', skyrim]]) {
        assert.equal(guessError(guess, [], { answer, aliases }), '');
        const saved = [canonicalGuess(guess, aliases)];
        assert.deepEqual(saved, [answer]);
        assert.deepEqual(decodeAttempts(saved, answer, 6), saved);
    }
    assert.equal(canonicalGuess(null, aliases), null);
    assert.equal(canonicalGuess('Portal', aliases), 'Portal');
    assert.equal(canonicalGuess('constructor', aliases), 'constructor');
    assert.equal(canonicalGuess('Unlisted game'), 'Unlisted game');
});

test('new attempts recognize duplicate titles but keep different sequels available', async () => {
    const { guessError } = await import('../public/round.mjs');
    const puzzle = { answer: 'Portal 2', aliases };
    assert.equal(guessError('GTA 5', [gta], puzzle), 'You already guessed that game.');
    assert.equal(guessError(gta, ['GTA V'], puzzle), 'You already guessed that game.');
    assert.equal(guessError('GTA V', ['g.t.a. 5'], puzzle), 'You already guessed that game.');
    assert.equal(guessError('Portal 2', ['Portal'], puzzle), '');
    assert.equal(guessError('Grand Theft Auto IV', [gta], puzzle), '');
});

test('legacy shorthand misses retain their turn history and cannot block a new winning guess', async () => {
    const { canonicalGuess, decodeAttempts, guessError } = await import('../public/round.mjs');
    const prior = ['GTA V', 'GTA 5', null];
    assert.deepEqual(decodeAttempts(prior, gta, 6), prior);
    assert.equal(guessError('GTA V', prior, { answer: gta, aliases }), '');
    const won = [...prior, canonicalGuess('GTA V', aliases)];
    assert.deepEqual(decodeAttempts(won, gta, 6), ['GTA V', 'GTA 5', null, gta]);
    const lost = [...prior, null, null, null];
    assert.deepEqual(decodeAttempts(lost, gta, 6), lost);
});
