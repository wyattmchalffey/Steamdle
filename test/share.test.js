const { test } = require('node:test');
const assert = require('node:assert/strict');

const fixture = { puzzleDate: '2026-11-10', answer: 'Grand Theft Auto V',
    attempts: ['Portal 2', null, 'Grand Theft Auto V'], origin: 'https://steamdle.com/' };

test('share results contain only score and outcomes with an attributed link to today', async () => {
    const { buildShareResult } = await import('../public/share.mjs');
    const result = buildShareResult(fixture);
    assert.equal(result.date, '2026-11-10');
    assert.equal(result.dateLabel, 'Nov 10, 2026');
    assert.equal(result.score, '3/6');
    assert.equal(result.won, true);
    assert.deepEqual(result.outcomes, ['wrong','skip','solve']);
    assert.equal(result.grid, '🟥⬜🟩');
    assert.match(result.message, /Can you beat me\?/);
    assert.equal(result.text, result.message + '\n' + result.url);
    assert.ok(!result.message.includes('https:'));
    assert.equal(new URL(result.url).pathname, '/');
    assert.equal(new URL(result.url).searchParams.get('utm_source'), 'player_share');
    assert.equal(new URL(result.url).searchParams.get('share_date'), fixture.puzzleDate);
    for (const secret of ['Grand Theft Auto V','Portal 2','answer','attempts']) {
        assert.ok(!JSON.stringify(result).includes(secret), secret);
    }
});

test('one-clue wins, normalized titles and six-turn losses have accurate inviting share text', async () => {
    const { buildShareResult } = await import('../public/share.mjs');
    const win = buildShareResult({...fixture, attempts:['grand theft auto v!']});
    assert.equal(win.score,'1/6');
    assert.match(win.message,/1 clue\. Can you match it\?/);
    const loss = buildShareResult({...fixture, attempts:['Portal 2',null,null,'Hades',null,'Skyrim']});
    assert.equal(loss.won,false);
    assert.equal(loss.score,'X/6');
    assert.match(loss.message,/stumped me\. Can you solve it\?/);
    assert.equal(loss.grid,'🟥⬜⬜🟥⬜🟥');
    for (const secret of ['Portal','Hades','Skyrim',fixture.answer]) assert.ok(!JSON.stringify(loss).includes(secret));
});

test('unfinished, malformed and impossible-date rounds cannot be shared', async () => {
    const { buildShareResult } = await import('../public/share.mjs');
    for (const change of [{attempts:[]}, {attempts:[null]}, {attempts:[fixture.answer,null]},
        {attempts:Array(7).fill(null)}, {attempts:[{}]}, {answer:''}, {puzzleDate:'2026-02-30'},
        {puzzleDate:'Nov 10'}, {maxClues:0}, {origin:'file:///tmp/'}, {origin:'https://user:secret@steamdle.com'}]) {
        assert.throws(()=>buildShareResult({...fixture,...change}));
    }
});

test('share cards export a local 1200 by 630 PNG and never draw game content', async () => {
    const { buildShareResult, createShareCard } = await import('../public/share.mjs');
    const drawn=[];
    const ctx=new Proxy({}, {get(target,key) {
        if(key==='fillText')return text=>drawn.push(text);
        return target[key] ?? (()=>{});
    }});
    const blob=new Blob(['png'],{type:'image/png'});
    const canvas={getContext:type=>type==='2d'?ctx:null, toBlob(callback,type){assert.equal(type,'image/png');callback(blob);}};
    const document={createElement(tag){assert.equal(tag,'canvas');return canvas;}};
    const result=buildShareResult(fixture);
    assert.equal(await createShareCard(result,document),blob);
    assert.equal(canvas.width,1200);assert.equal(canvas.height,630);
    assert.ok(drawn.includes('STEAMDLE'));
    assert.ok(drawn.includes('steamdle.com'));
    assert.ok(drawn.includes('3/6'));
    assert.ok(!drawn.join(' ').includes(fixture.answer));
    assert.ok(!drawn.join(' ').includes('Portal 2'));
    await assert.rejects(createShareCard(result,{createElement:()=>({getContext:()=>null})}),/unavailable/);
    canvas.toBlob=callback=>callback(null);
    await assert.rejects(createShareCard(result,document),/could not be created/);
});
