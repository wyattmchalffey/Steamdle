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

function attributionReport(overrides = {}) {
    return {
        today: '2026-11-20', startDate: '2026-11-14', endDate: '2026-11-20', days: 7,
        trackingSince: '2026-11-04', daily: [{date: '2026-11-20', started: 8, finished: 5, solved: 3}],
        clues: [], sources: [], retention: {startDate: '2026-11-06', endDate: '2026-11-12', sources: []},
        ...overrides
    };
}

test('country and domain tables show coverage, outcomes and mature first-start returns without links or markup', () => {
    const $ = load(renderStats(attributionReport({attribution: {
        since: '2026-11-10',
        countries: [{name: 'US', browsers: 3, rounds: 4, finished: 3, solved: 2},
            {name: '', browsers: 1, rounds: 1, finished: 0, solved: 0}],
        referrers: [{name: '<img src=x onerror=alert(1)>', browsers: 3, rounds: 4, finished: 3, solved: 2},
            {name: '', browsers: 1, rounds: 1, finished: 0, solved: 0}],
        retention: {startDate: '2026-11-10', endDate: '2026-11-12',
            countries: [{name: 'US', eligible: 3, returned: 1}],
            referrers: [{name: '<script>bad()</script>', eligible: 2, returned: 1}]}
    }})));
    assert.deepEqual($('table[aria-label="Player countries"] tbody th').map((_, el) => $(el).text()).get(),
        ['United States', 'Unknown']);
    assert.deepEqual($('table[aria-label="Player countries"] tbody tr').first().find('td').map((_, el) => $(el).text()).get(),
        ['3', '4', '3 (75%)', '2 (50%)']);
    assert.match($('#countries').text(), /covers 5 of 8 started rounds in this period \(63%\)/);
    assert.match($('#countries').text(), /Earlier rounds cannot be filled in/);
    assert.match($('#countries').text(), /may appear in multiple groups/);
    assert.equal($('table[aria-label="Referring websites"] tbody th').first().text(), '<img src=x onerror=alert(1)>');
    assert.equal($('table[aria-label="Referring websites"] tbody th').last().text(), 'No referrer available');
    assert.equal($('#countries a, #referrers a, #referrers img, #referrers script').length, 0);
    assert.equal($('table[aria-label="Seven-day return by first country"] tbody td').last().text(), '33%');
    assert.equal($('table[aria-label="Seven-day return by first referring website"] tbody td').last().text(), '50%');
    assert.match($('#referrers').text(), /2026-11-10 – 2026-11-12 UTC/);
    assert.equal($('.jump a[href="#countries"]').length, 1);
});

test('new attribution explains empty coverage and immature returns while older reports still render', () => {
    const report = attributionReport({today: '2026-11-10', attribution: {
        since: '2026-11-10', countries: [], referrers: [],
        retention: {startDate: '2026-10-27', endDate: '2026-11-02', countries: [], referrers: []}
    }});
    const $ = load(renderStats(report));
    assert.match($('#countries').text(), /covers 0 of 8 started rounds/);
    assert.match($('#countries').text(), /totals appear after a round starts/);
    assert.match($('#referrers').text(), /cohort can appear on 2026-11-18 UTC/);
    assert.equal($('#countries table, #referrers table').length, 0);
    assert.doesNotMatch($('main').text(), /NaN|Infinity|undefined/);
    const legacy = load(renderStats(attributionReport()));
    assert.equal(legacy('#countries, #referrers, .jump a[href="#countries"]').length, 0);
    assert.doesNotMatch(legacy('main').text(), /NaN|Infinity|undefined/);
});
