const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');

const page = cheerio.load(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'));
const templateHtml = page('#steam-review-template').html();
const avatar = 'https://avatars.akamai.steamstatic.com/' + 'a'.repeat(40) + '_medium.jpg';
const fixture = changes => ({ reviewerName: 'Steam reviewer', reviewerAvatarUrl: avatar,
    reviewerReviewCount: 12, recommendation: 'Recommended', playtime: '41.3 hrs at review time',
    datePosted: 'Nov 12, 2026', isExcerpt: false, reviewText: 'Original clue.\nSecond line.', ...changes });

// Use the actual HTML template with Cheerio's parser. This small DOM adapter
// checks binding semantics in the ordinary Node suite; browser QA separately
// verifies importNode, image events, layout and analytics in a real DOM.
async function render(review) {
    const { createSteamReviewCard } = await import('../public/steam-review.mjs');
    const $ = cheerio.load(templateHtml, null, false);
    const events = new Map();
    const wrap = node => node ? {
        node,
        get textContent() { return $(node).text(); },
        set textContent(value) { $(node).text(value); },
        set innerHTML(_value) { throw new Error('Review fields must not be bound as HTML'); },
        get hidden() { return $(node).attr('hidden') !== undefined; },
        set hidden(value) { if (value) $(node).attr('hidden', ''); else $(node).removeAttr('hidden'); },
        set src(value) { $(node).attr('src', value); },
        get src() { return $(node).attr('src'); },
        classList: { add: (...names) => $(node).addClass(names.join(' ')) },
        querySelector: selector => wrap($(node).find(selector).get(0)),
        remove: () => $(node).remove(),
        addEventListener: (event, listener, options) => events.set(node, { event, listener, options })
    } : null;
    const template = { content: {} };
    let imported = 0;
    const document = { importNode(content, deep) {
        assert.equal(content, template.content);
        assert.equal(deep, true);
        imported++;
        return { firstElementChild: wrap($.root().children().get(0)) };
    } };
    const original = JSON.stringify(review);
    const card = createSteamReviewCard(document, template, Object.freeze(review));
    assert.equal(imported, 1);
    assert.equal(card.node, $.root().children().get(0));
    assert.equal(JSON.stringify(review), original, 'Rendering changed the saved review');
    return { $, events };
}

test('the Steam-derived template is one inert card with no source links, handlers or duplicate IDs', () => {
    assert.equal(page('template#steam-review-template').length, 1);
    const $ = cheerio.load(templateHtml, null, false);
    assert.equal($.root().children().length, 1);
    assert.equal($('article.steam-review-card').length, 1);
    assert.deepEqual($('.steam-review-card').children().toArray().map(node => $(node).attr('class')),
        ['profile_small_header_bg', 'ratingSummaryBlock', 'review_area']);
    assert.equal($('.profile_small_header_bg > .profile_small_header_texture > .profile_small_header_avatar > .playerAvatar > picture > img.reviewer-avatar').length, 1);
    assert.equal($('.ratingSummaryBlock > .ratingSummaryHeader > img.recommendation-icon').length, 1);
    assert.equal($('.review_area > .review_area_content > .review-text-content').length, 1);
    assert.equal($('.review-text-content').text(), '', 'Template must not embed a source review');
    assert.equal($('script,style,iframe,object,embed,a,button,form,[id],[href],[src],[srcset]').length, 0);
    $('*').each((_index, node) => {
        for (const [name, value] of Object.entries(node.attribs || {})) {
            assert.ok(!/^on/i.test(name), `Inline event handler: ${name}`);
            assert.ok(!/https?:|javascript:/i.test(value), `Source URL leaked in ${name}`);
        }
    });
});

test('positive and negative cards bind exact text, the right local thumbs, author metadata and excerpt status', async () => {
    for (const [recommendation, className, icon] of [
        ['Recommended', 'recommended', '/images/thumb-up.png'],
        ['Not Recommended', 'not-recommended', '/images/thumb-down.png']
    ]) {
        const data = fixture({ recommendation, reviewerReviewCount: 1, isExcerpt: true });
        const { $ } = await render(data);
        assert.ok($('.steam-review-card').hasClass(className));
        assert.equal($('.recommendation-icon').attr('src'), icon);
        assert.equal($('.recommendation-text').text(), recommendation);
        assert.equal($('.reviewer-name').text(), data.reviewerName);
        assert.equal($('.reviewer-avatar').attr('src'), avatar);
        assert.equal($('.reviewer-review-count').text(), '1 review');
        assert.equal($('.reviewer-review-count').attr('hidden'), undefined);
        assert.equal($('.review-playtime').text(), data.playtime);
        assert.equal($('.review-date').text(), 'Posted: ' + data.datePosted);
        assert.equal($('.review-excerpt').attr('hidden'), undefined);
        assert.equal($('.review-text-content').length, 1, 'First-clue analytics requires one exact text target');
        assert.equal($('.review-text-content').text(), data.reviewText);
    }
    const { $ } = await render(fixture({ reviewerReviewCount: 0 }));
    assert.equal($('.reviewer-review-count').text(), '0 reviews');
    assert.notEqual($('.review-excerpt').attr('hidden'), undefined);
});

test('untrusted author and review markup stay literal text and source URLs are never rendered', async () => {
    const payload = '<img src=x onerror="globalThis.injected=true"><script>globalThis.injected=true</script>';
    const data = fixture({ reviewerName: payload, reviewText: payload + '\n& exact text',
        playtime: payload, datePosted: payload, recommendation: payload,
        originalUrl: 'https://steamcommunity.com/profiles/76561198049206668/recommended/1145350/',
        sourceUrl: 'javascript:globalThis.injected=true' });
    const { $ } = await render(data);
    assert.equal($('.reviewer-name').text(), payload);
    assert.equal($('.review-text-content').text(), payload + '\n& exact text');
    assert.equal($('.review-playtime').text(), payload);
    assert.equal($('.review-date').text(), 'Posted: ' + payload);
    assert.equal($('script,a,[href],[onerror]').length, 0);
    assert.equal($('img').length, 1, 'Only the trusted avatar remains; no injected image or unknown thumb');
    assert.equal($('.recommendation-text').text(), 'Recommendation unavailable');
    assert.ok(!$.html().includes(data.originalUrl));
    assert.ok(!$.html().includes(data.sourceUrl));
});

test('missing or unknown metadata cannot invent recommendation, counts, dates or excerpt labels', async () => {
    for (const count of [undefined, -1, '12', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const { $ } = await render(fixture({ reviewerName: '', reviewerAvatarUrl: null,
            recommendation: 'Not specified', reviewerReviewCount: count, playtime: 'Playtime not shown',
            datePosted: 'Date not found', isExcerpt: 'true', reviewText: '' }));
        assert.equal($('.reviewer-name').text(), 'Reviewer unavailable');
        assert.equal($('.profile_small_header_avatar,.reviewer-avatar,.recommendation-icon').length, 0);
        assert.equal($('.steam-review-card').hasClass('recommended'), false);
        assert.equal($('.steam-review-card').hasClass('not-recommended'), false);
        assert.equal($('.recommendation-text').text(), 'Recommendation unavailable');
        for (const selector of ['.reviewer-review-count', '.review-playtime', '.review-date', '.review-excerpt'])
            assert.notEqual($(selector).attr('hidden'), undefined, selector);
        assert.equal($('.review-text-content').text(), '');
    }
});

test('only trusted Steam avatar images are bound and image failure removes its complete header slot', async () => {
    for (const url of ['javascript:alert(1)', 'https://evil.test/avatar.jpg', avatar + '?redirect=evil',
        avatar.replace('https:', 'http:'), avatar.replace('.com/', '.com.evil.test/'), 'data:image/svg+xml,<svg/>']) {
        const { $ } = await render(fixture({ reviewerAvatarUrl: url }));
        assert.equal($('.profile_small_header_avatar,.reviewer-avatar').length, 0);
        assert.ok(!$.html().includes(url));
    }
    const { $, events } = await render(fixture());
    const binding = events.get($('.reviewer-avatar').get(0));
    assert.equal(binding.event, 'error');
    assert.deepEqual(binding.options, { once: true });
    binding.listener();
    assert.equal($('.profile_small_header_avatar').length, 0);
    assert.equal($('.reviewer-name').text(), fixture().reviewerName);
    assert.equal($('.review-text-content').text(), fixture().reviewText);
});
