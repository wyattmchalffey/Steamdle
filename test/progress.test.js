const assert = require('node:assert/strict');
const { test } = require('node:test');

test('restores wrong guesses and skips, and rejects repeated guesses without using a turn', async () => {
    const { decodeAttempts, guessError } = await import('../public/round.mjs');
    const attempts = decodeAttempts(['Half-Life', null, null], 'Portal', 6);
    assert.deepEqual(attempts, ['Half-Life', null, null]);
    assert.equal(guessError('half LIFE!', attempts), 'You already guessed that game.');
    assert.equal(guessError(null, attempts), '');
    assert.equal(attempts.length, 3);
});

test('restores completed rounds and ignores damaged or oversized saved attempts', async () => {
    const { decodeAttempts, MAX_GUESS_LENGTH } = await import('../public/round.mjs');
    const won = ['Half-Life', null, 'Pórtal'];
    const lost = Array(6).fill(null);
    assert.deepEqual(decodeAttempts(won, 'Portal', 6), won);
    assert.deepEqual(decodeAttempts(lost, 'Portal', 6), lost);
    for (const invalid of [null, [...lost, null], ['Portal', null], ['Test', 'test'],
        [true], [42], ['!!!'], ['a'.repeat(MAX_GUESS_LENGTH + 1)]]) {
        assert.deepEqual(decodeAttempts(invalid, 'Portal', 6), []);
    }
});
