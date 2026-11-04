const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('cheerio');
const { renderLogin, renderStats } = require('../admin-stats');

test('owner view escapes labels, hides untracked dates, and keeps immature cohorts out of the denominator', () => {
    const report = {
        today: '2026-11-04', startDate: '2026-10-06', endDate: '2026-11-04', days: 30,
        trackingSince: '2026-10-07', campaigns: ['november'],
        daily: [{date:'2026-10-06', started:0, finished:0, solved:0},
            {date:'2026-11-04', started:4, finished:3, solved:2}],
        clues: [{clue:1, reached:4, wrong:1, skipped:1, solved:2, unanswered:0}],
        sources: [{source:'discord', campaign:'<script>alert(1)</script>', starters:3, rounds:4, newBrowsers:3}],
        retention: { startDate:'2026-09-28', endDate:'2026-10-27',
            sources:[{source:'discord', campaign:'', eligible:2, returned:1}] }
    };
    const $ = load(renderStats(report));
    assert.equal($('script').length, 0);
    assert.equal($('a[aria-current]').text(), '30 days');
    assert.equal($('table[aria-label="Daily rounds"] tbody tr').length, 1);
    assert.equal($('table[aria-label="Clue outcomes"] tbody tr td').last().text(), '25%');
    assert.equal($('table[aria-label="Seven-day return by first source"] tbody tr td').last().text(), '50%');
    assert.equal($('table[aria-label="Outreach sources"] tbody th').text(), 'Discord / <script>alert(1)</script>');
    assert.equal($('input[aria-label="Discord outreach link"]').val(), 'https://steamdle.com/?utm_source=discord');
    const $empty = load(renderStats({...report, days:1, daily:[], sources:[], clues:[], campaigns:[],
        retention:{startDate:'2026-10-27', endDate:'2026-10-27', sources:[]}}));
    assert.equal($empty('dd').first().text(), '0');
    assert.match($empty('main').text(), /No first-time browsers were recorded in this earlier period/);
    assert.doesNotMatch($empty('main').text(), /NaN|Infinity|undefined/);

    const $named = load(renderStats(report, 'november'));
    assert.equal($named('select[name="campaign"]').val(), 'november');
    assert.equal($named('form[action="/stats#outreach"] input[name="days"]').val(), '30');
    assert.equal($named('input[aria-label="Streamer outreach link"]').val(),
        'https://steamdle.com/?utm_source=streamer&utm_campaign=november');
    assert.equal($named('form[action="/stats/campaign"]').attr('method'), 'post');
    assert.equal($named('form[action="/stats/campaign"] input[name="campaign"]').attr('maxlength'), '40');
    const $invalid = load(renderStats(report, 'unapproved', 'Invalid <script>name</script>'));
    assert.equal($invalid('input[aria-label="Discord outreach link"]').val(), 'https://steamdle.com/?utm_source=discord');
    assert.equal($invalid('details[open] [role="alert"]').text(), 'Invalid <script>name</script>');
    assert.equal($invalid('script').length, 0);
});

test('owner key is submitted by POST, never echoed and no scripts are used', () => {
    const $ = load(renderLogin('Try again <script>bad()</script>'));
    assert.equal($('form').attr('action'), '/stats/login');
    assert.equal($('form').attr('method'), 'post');
    assert.equal($('input[name="key"]').attr('type'), 'password');
    assert.equal($('input[name="key"]').attr('value'), undefined);
    assert.equal($('script').length, 0);
    assert.equal($('[role="alert"]').text(), 'Try again <script>bad()</script>');
});
