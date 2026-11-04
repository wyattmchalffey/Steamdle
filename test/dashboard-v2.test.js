const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('cheerio');
const { renderStats, renderPuzzle } = require('../admin-stats');

const zeroes = () => Array(6).fill(0);
const day = '2026-11-07';
const snapshot = {
    date: '2026-11-06', title: 'A test game', started: 10,
    solves: [0,1,2,0,0,0], losses: 2, unfinished: 5
};
const report = {
    days: 7, today: day, startDate: '2026-11-01', endDate: day, trackingSince: '2026-11-04', engagementSince: '2026-11-06',
    daily: [], sources: [], campaigns: [], clues: [], retention: {sources:[], startDate:'2026-10-24', endDate:'2026-10-30'},
    puzzles: [snapshot, {...snapshot, date:'2026-11-05', title:'Older'}, {...snapshot, date:day, title:'Secret answer'}],
    views: [{source:'directory',campaign:'',viewed:12,started:3}],
    shares: [{date:'2026-11-05', copies:2, native:1, x:1, starts:6}],
    feedback: {votes:zeroes(),none:2}, search:{queries:20, empty:5, selected:9}
};

test('review table shows all eight outcomes with starts as denominator and links only to completed days', () => {
    const $ = load(renderStats(report));
    const rows = $('table[aria-label="Puzzles to review"] tbody tr');
    assert.equal(rows.length, 2);
    assert.match(rows.first().text(), /1 \(10%\).*2 \(20%\).*2 \(20%\).*5 \(50%\)/);
    assert.equal(rows.first().find('a').attr('href'),'/stats/puzzles/2026-11-06?days=7');
    assert.doesNotMatch($.html(), /Secret answer/);
    const asc = load(renderStats(report,'','','asc'));
    assert.match(asc('#puzzles tbody th').first().text(), /Older/);
    assert.equal(asc('#puzzles a').first().attr('href'),'/stats?days=7&order=desc#puzzles');
    const empty = load(renderStats({...report, days:1, puzzles:[]}));
    assert.match(empty('#puzzles').text(), /after midnight UTC/);
});

test('view-linked starts include view-only sources; search and sharing metrics retain their own denominators', () => {
    const $ = load(renderStats(report));
    assert.deepEqual($('#sources tbody tr td').map((_,cell) => $(cell).text()).get(), ['0','0','0','12','3','25%']);
    assert.equal($('#search tbody tr').last().find('td').last().text(),'60%');
    assert.equal($('#search tbody tr').eq(1).find('td').last().text(),'25%');
    assert.equal($('#sharing tbody tr').first().find('td').last().text(),'1.50');
    assert.match($('#clues').text(),/2 chose “None of them.”/);
    assert.match($('main').text(),/tracking began 2026-11-06/);
});

test('owner puzzle detail renders original clues as text and links only to Steam reviews', () => {
    const urls = ['https://steamcommunity.com/profiles/123/recommended/245/?ref=unused',
        'javascript:alert(1)', 'https://steamcommunity.com.evil.example/profiles/123/recommended/245/',
        'https://evil.example@steamcommunity.com/profiles/123/recommended/245/', undefined, 'https://steamcommunity.com/id/name/recommended/123/'];
    const detail = {...snapshot, title:'Game <script>evil()</script>', engagementSince:'2026-11-06',
        reviews:urls.map((originalUrl, i)=>({originalUrl,reviewerName:'<b>Name</b>',reviewText:`Text <img src=x> ${i}`})),
        clues:snapshot.solves.map((solved,i)=>({clue:i+1,reached:10,wrong:1,skipped:3,unanswered:0,solved})),
        feedback:{votes:[0,0,2,1,0,0],none:1}};
    const $ = load(renderPuzzle(detail,7));
    assert.equal($('h1').text(),detail.title);
    assert.equal($('li blockquote').length,6);
    assert.equal($('li blockquote').first().text(),'Text <img src=x> 0');
    assert.equal($('script,img').length,0);
    assert.deepEqual($('li a').map((_,a)=>$(a).attr('href')).get(),['https://steamcommunity.com/profiles/123/recommended/245/','https://steamcommunity.com/id/name/recommended/123/']);
    assert.match($('main').text(), /4 players answered.+1 chose “None of them.”/);
    assert.match($('li .counts').eq(2).text(),/Helpful votes 2/);
    const before = load(renderPuzzle({...detail, date:'2026-11-05'}));
    assert.match(before('main').text(), /Feedback tracking began 2026-11-06/);
    assert.doesNotMatch(before('li').text(), /Helpful votes/);
});
