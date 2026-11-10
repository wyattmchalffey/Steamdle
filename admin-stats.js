const style = `
    :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #182d37; background: #f4f7f8; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(68rem, 100%); margin: auto; padding: 2.5rem clamp(1rem, 4vw, 3rem) 4rem; }
    header { background: #172d3b; color: #f4f8fa; }
    header > div { width: min(68rem, 100%); margin: auto; padding: .75rem clamp(1rem, 4vw, 3rem); display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .brand { font-weight: 750; letter-spacing: .02em; }
    .brand span { font-weight: 450; margin-left: .7rem; color: #bdd0da; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: clamp(1.9rem, 4vw, 2.65rem); line-height: 1.15; letter-spacing: -.04em; }
    h2 { font-size: 1.25rem; line-height: 1.3; letter-spacing: -.02em; }
    p { color: #455e6c; }
    h1 + p, h2 + p { margin-top: .4rem; }
    a { color: #11586d; text-underline-offset: .16em; }
    header a { color: #e1f2f6; }
    input, select, button { font: inherit; }
    button { cursor: pointer; }
    :focus-visible { outline: 3px solid #257a9b; outline-offset: 3px; }
    header :focus-visible { outline-color: #9ce0fa; }
    .logout { background: transparent; border: 1px solid #879ba7; color: inherit; border-radius: .35rem; padding: .35rem .8rem; }
    .period { display: flex; flex-wrap: wrap; gap: .25rem; margin: 1rem 0; }
    .period a { padding: .45rem .95rem; border-radius: .4rem; text-decoration: none; color: #244758; border: 1px solid #c0d0d5; background: white; }
    .period [aria-current] { color: white; background: #234e60; border-color: #234e60; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; margin: 1.25rem 0 0; }
    .cards > div, section { background: #fff; border: 1px solid #cddade; border-radius: .65rem; padding: 1.25rem; }
    .cards dt { font-size: .9rem; font-weight: 650; }
    .cards dd { margin: .2rem 0; font-variant-numeric: tabular-nums; font-size: clamp(1.6rem, 4vw, 2.4rem); font-weight: 730; line-height: 1.2; }
    .cards small, .note { color: #4b626d; }
    section { margin-top: 1rem; }
    .grid { overflow-x: auto; margin-top: 1rem; }
    table { border-collapse: collapse; width: 100%; text-align: right; font-size: .93rem; font-variant-numeric: tabular-nums; }
    th, td { padding: .5rem .7rem; border-bottom: 1px solid #e1e9eb; white-space: nowrap; }
    thead { color: #3a5866; background: #edf3f5; }
    th { font-weight: 620; }
    th:first-child, td:first-child { text-align: left; }
    tbody tr:last-child > * { border-bottom: 0; }
    .note { margin-top: .8rem; font-size: .9rem; }
    .links { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1rem; margin-top: 1rem; }
    label { display: block; font-weight: 620; }
    input, select { display: block; width: 100%; border: 1px solid #9fb3bd; border-radius: .35rem; padding: .5rem; margin-top: .3rem; color: #172d3b; background: #fff; }
    input[readonly] { font: .875rem/1.5 ui-monospace, monospace; background: #f6f9fa; }
    .login { max-width: 28rem; margin: 2rem auto; }
    .login form { margin-top: 1.25rem; }
    .login button, .campaign button { background: #234e60; border: 0; color: white; border-radius: .35rem; padding: .55rem 1rem; margin-top: .85rem; }
    .campaign { display: flex; align-items: end; flex-wrap: wrap; gap: .5rem; margin-top: .8rem; }
    .campaign label { flex: 0 1 20rem; min-width: 0; }
    #outreach details { margin-top: 1rem; }
    #outreach summary { color: #11586d; cursor: pointer; width: fit-content; }
    .error { color: #932d24; margin-top: .75rem; }
    .jump { display: flex; flex-wrap: wrap; gap: .45rem 1rem; font-size: .9rem; }
    .review-table th[scope="row"] a { display: block; white-space: pre-line; min-width: 9rem; max-width: 18rem; }
    .measure { font-weight: 650; }
    .attribution-return { margin-top: 1.5rem; }
    .review-list { padding-left: 1.6rem; }
    .review-list li { padding: 1rem 0; border-bottom: 1px solid #dce7e9; }
    .review-list blockquote { max-width: 75ch; margin: .45rem 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .review-list .attribution, .review-list .counts { font-size: .9rem; color: #455e6c; }
    .review-list .counts { margin-top: .5rem; }
    #review-title { overflow-wrap: anywhere; }
    @media (max-width: 40rem) {
        main { padding-top: 1.5rem; }
        .links { grid-template-columns: 1fr; }
        .cards { gap: .35rem; }
        .cards > div { padding: .65rem .45rem; }
        .cards small { display: block; font-size: .77rem; }
        section { padding: 1rem .8rem; }
    }
`;

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

function page(title, body, signedIn) {
    const session = signedIn
        ? '<form action="/stats/logout" method="post"><button class="logout">Sign out</button></form>'
        : '<a href="/">Play Steamdle</a>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <meta name="robots" content="noindex,nofollow"><title>${title} · Steamdle</title>
        <style>${style}</style></head><body><header><div>
        <div class="brand">Steamdle <span>Owner dashboard</span></div>${session}</div></header>
        <main>${body}</main></body></html>`;
}

function renderLogin(error = '') {
    return page('Owner sign-in', `<section class="login"><h1>Owner sign-in</h1>
        <p>Enter your owner key to view Steamdle’s player analytics.</p>
        <form method="post" action="/stats/login">
        <label for="owner-key">Owner key</label>
        <input id="owner-key" type="password" name="key" required autocomplete="current-password" autocapitalize="none" spellcheck="false">
        ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
        <button>Sign in</button></form></section>`, false);
}

const count = new Intl.NumberFormat('en-US');

function rate(part, total) {
    return total > 0 ? Math.round(part * 100 / total) + '%' : '—';
}

function table(label, columns, rows, rowLink) {
    return `<div class="grid" role="region" aria-label="${label}" tabindex="0"><table aria-label="${label}">
        <thead><tr>${columns.map(name => `<th scope="col">${escapeHtml(name)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((row, rowIndex) => '<tr>' + row.map((value, index) => index === 0
            ? `<th scope="row">${rowLink ? `<a href="${escapeHtml(rowLink(rowIndex))}">${escapeHtml(value)}</a>` : escapeHtml(value)}</th>`
            : `<td>${escapeHtml(value)}</td>`).join('') + '</tr>').join('')}</tbody></table></div>`;
}

const sourceLabels = {
    direct: 'Direct', discord: 'Discord', streamer: 'Streamer', player_share: 'Player share',
    directory: 'Directory', search: 'Search', social: 'Social', other: 'Other'
};

function sourceName(row) {
    const name = Object.hasOwn(sourceLabels, row.source) ? sourceLabels[row.source] : row.source;
    return row.campaign ? name + ' / ' + row.campaign : name;
}

function countWithRate(value, total) {
    return total ? `${count.format(value)} (${rate(value, total)})` : count.format(value);
}

function puzzleSection(report, campaign, order) {
    const puzzles = (report.puzzles || []).filter(p => p.date < report.today && p.date >= report.trackingSince)
        .sort((a, b) => order === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));
    const sortQuery = new URLSearchParams({days: report.days, order: order === 'asc' ? 'desc' : 'asc'});
    if (campaign) sortQuery.set('campaign', campaign);
    const rows = puzzles.map(p => [`${p.date}\n${p.title}`, count.format(p.started),
        ...[...p.solves, p.losses, p.unfinished].map(value => countWithRate(value, p.started))]);
    return `<section id="puzzles" class="review-table"><h2>Puzzles to review</h2>
        <p>Open a completed UTC day to read its reviews alongside the results. Each percentage uses all rounds started that day.</p>
        ${rows.length ? `<p class="note">Sorted ${order === 'asc' ? 'oldest' : 'newest'} first. <a href="/stats?${escapeHtml(sortQuery)}#puzzles">Show ${order === 'asc' ? 'newest' : 'oldest'} first</a></p>
        ${table('Puzzles to review', ['Puzzle', 'Starts', 'Solved on 1', 'On 2', 'On 3', 'On 4', 'On 5', 'On 6', 'Six-try loss', 'Unfinished'], rows,
            i => `/stats/puzzles/${encodeURIComponent(puzzles[i].date)}?days=${report.days}`)}`
        : '<p class="note">No completed puzzle in this period has tracking history. Today’s puzzle becomes available after midnight UTC. Choose a longer period to see earlier days.</p>'}
    </section>`;
}

function sharingSection(report) {
    const shares = [...(report.shares || [])].filter(s => s.copies || s.native || s.x || s.images || s.downloads || s.starts)
        .sort((a, b) => b.date.localeCompare(a.date));
    const rows = shares.map(s => {
        const actions = s.copies + s.native + s.x + (s.images || 0);
        const imageMeasured = report.sharingSince && s.date >= report.sharingSince;
        return [s.date, count.format(s.copies), count.format(s.native), count.format(s.x),
            imageMeasured ? count.format(s.images || 0) : '—', imageMeasured ? count.format(s.downloads || 0) : '—', count.format(s.starts),
            actions ? (s.starts / actions).toFixed(2) : '—'];
    });
    const activity = [...(report.shareActivity || [])].filter(row => row.finished || row.sharers)
        .sort((a, b) => b.date.localeCompare(a.date));
    const referrals = report.referralOutcomes || [];
    return `<section id="sharing"><h2>Result sharing</h2>
        <p>Compare result copies, completed device-share handoffs, and clicks on “Share on X” with first turns from tagged result links.</p>
        ${rows.length ? table('Result sharing by originating puzzle', ['Originating puzzle', 'Copies', 'Text handoffs', 'X clicks', 'Image handoffs', 'Image downloads', 'Referred starts', 'Starts per action'], rows)
        : '<p class="note">No measured share actions or attributed starts for puzzles in this period yet.</p>'}
        <p class="note">Starts are credited to the date in the shared link, even when a friend starts a later puzzle. One link can bring several starts. Copies, handoffs and X clicks do not confirm that a result was posted. Image downloads count initiated downloads and are excluded from starts per action and sharer counts.</p>
        ${report.sharingSince ? `<p class="note">Image sharing and download tracking began ${escapeHtml(report.sharingSince)} UTC. Earlier dates are unmeasured.</p>` : ''}
        <h3 class="attribution-return">Sharing participation</h3>
        ${activity.length ? table('Daily sharing participation', ['Puzzle date', 'Finished rounds', 'Unique browser sharers', 'Share rate'], activity.map(row => [
            row.date, count.format(row.finished), count.format(row.sharers), rate(row.sharers, row.finished)
        ])) : '<p class="note">Sharing participation appears after tracked rounds finish.</p>'}
        <p class="note">A browser counts once per puzzle after copying, using device sharing, or clicking Share on X. The share rate uses finished rounds. These counts can be calculated from existing sharing history.</p>
        <h3 class="attribution-return">Players arriving from shared links</h3>
        ${referrals.length ? table('Shared-link round outcomes', ['Played date', 'Referred starts', 'Finished', 'Eligible for next-day return', 'Returned next day'], referrals.map(row => [
            row.date, count.format(row.started), countWithRate(row.finished, row.started), count.format(row.eligible),
            row.eligible ? countWithRate(row.returned, row.eligible) : '—'
        ])) : '<p class="note">Referral outcomes appear when a browser starts after a tagged player-share link.</p>'}
        <p class="note">These rows use the date actually played. Each browser counts once per date and can appear on several dates. A next-day return means another first turn on the following UTC date, from any source. That entire following day must have ended before a round is eligible; today and yesterday are still pending.</p>
    </section>`;
}

function searchSection(search = {}) {
    const queries = search.queries || 0, empty = search.empty || 0, selected = search.selected || 0;
    const nonempty = queries - empty;
    return `<section id="search"><h2>Search friction</h2>
        <p>Count completed searches whose results reached the player. Cached results count. Typed queries and game names are excluded.</p>
        ${table('Search friction', ['Outcome', 'Count', 'Rate'], [
            ['Searches shown', count.format(queries), '—'],
            ['No suggestions', count.format(empty), rate(empty, queries)],
            ['Had suggestions', count.format(nonempty), rate(nonempty, queries)],
            ['Selected a suggestion', count.format(selected), rate(selected, nonempty)]
        ])}<p class="note">Selection rate uses only searches that offered suggestions.</p></section>`;
}

const countryNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

function countryName(code) {
    if (!/^[A-Z]{2}$/.test(code || '') || code === 'ZZ') return 'Unknown';
    return countryNames.of(code) || 'Unknown';
}

function attributionSections(report) {
    const attribution = report.attribution;
    if (!attribution) return '';
    const countries = attribution.countries || [], referrers = attribution.referrers || [];
    const measured = attribution.measuredRounds ?? countries.reduce((sum, row) => sum + row.rounds, 0);
    const started = report.daily.reduce((sum, row) => sum + row.started, 0);
    const retention = attribution.retention || { countries: [], referrers: [] };
    const cohortDates = retention.startDate === retention.endDate ? retention.endDate
        : retention.startDate + ' – ' + retention.endDate;
    const matureFrom = new Date(Date.parse(attribution.since + 'T00:00:00Z') + 8 * 86400000).toISOString().slice(0, 10);
    const activityRows = (rows, label) => rows.map(row => [label(row.name), count.format(row.browsers),
        count.format(row.rounds), countWithRate(row.finished, row.rounds), countWithRate(row.solved, row.rounds)]);
    const returns = (rows, label, kind) => {
        if (!rows?.length) return `<p class="note">${report.today < matureFrom
            ? `The first fully observed seven-day return cohort can appear on ${escapeHtml(matureFrom)} UTC.`
            : 'No first-time browsers with this attribution were recorded in the eligible period.'}</p>`;
        return `<h3 class="attribution-return">Seven-day return</h3>
            <p class="note">Browsers that first played ${escapeHtml(cohortDates)} UTC, grouped by their first ${kind === 'country' ? 'country' : 'referring website'}. Each had seven complete UTC days to return.</p>
            ${table('Seven-day return by first ' + kind, [kind === 'country' ? 'First country' : 'First referring website', 'Eligible browsers', 'Returned', 'Return rate'],
                rows.map(row => [label(row.name), count.format(row.eligible), count.format(row.returned), rate(row.returned, row.eligible)]))}`;
    };
    const referrerName = name => name || 'No referrer available';
    return `<section id="countries"><h2>Player countries</h2>
        <p>Countries and referring websites have been measured since ${escapeHtml(attribution.since)} UTC. Earlier rounds cannot be filled in.</p>
        <p class="note">New attribution covers ${count.format(measured)} of ${count.format(started)} started rounds in this period (${rate(measured, started)}). The first day may be partial.</p>
        ${countries.length ? table('Player countries', ['Country', 'Browsers with a start', 'Rounds started', 'Finished', 'Solved'], activityRows(countries, countryName))
            : '<p class="note">Country totals appear after a round starts with the new tracking.</p>'}
        <p class="note">Country is estimated from the network connection. VPNs and proxies can affect it. Unknown means a country could not be determined. Finish and solve percentages use rounds started.</p>
        <p class="note">A browser is counted once within each country or referring website during this period. It may appear in multiple groups across different days, so browser counts do not add up to unique people.</p>
        ${returns(retention.countries, countryName, 'country')}
    </section>
    <section id="referrers"><h2>Referring websites</h2>
        <p>For a browser’s first round, this is its first recorded referring website. Later rounds use that day’s arrival. Only the domain is retained.</p>
        ${referrers.length ? table('Referring websites', ['Referring website', 'Browsers with a start', 'Rounds started', 'Finished', 'Solved'], activityRows(referrers, referrerName))
            : '<p class="note">Referring website totals appear after a round starts with the new tracking.</p>'}
        <p class="note">No referrer available includes bookmarks, typed addresses, and apps or browsers that omit the referring website. A campaign label can still identify the channel in the source table above.</p>
        ${returns(retention.referrers, referrerName, 'referring website')}
    </section>`;
}

function safeReviewUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && url.hostname === 'steamcommunity.com' && !url.username && !url.password &&
            !url.port && /^\/(?:id|profiles)\/[^/]+\/recommended\/\d+\/?$/.test(url.pathname)) {
            return url.origin + url.pathname;
        }
    } catch { /* An older snapshot may have no source URL. */ }
    return null;
}

function renderPuzzle(detail, days = 7) {
    const range = [1, 7, 30].includes(days) ? days : 7;
    const {date, title, reviews, clues, started, solves, losses, unfinished, feedback, engagementSince} = detail;
    const measured = date >= engagementSince;
    const solved = solves.reduce((a, b) => a + b, 0);
    const responses = feedback.votes.reduce((a, b) => a + b, feedback.none);
    const cards = reviews.map((review, i) => {
        const clue = clues[i];
        const url = safeReviewUrl(review.originalUrl);
        const author = escapeHtml(review.reviewerName || 'Steam reviewer');
        return `<li><h3>Clue ${i + 1}</h3>
            <blockquote>${escapeHtml(review.reviewText)}</blockquote>
            <p class="attribution">${author}${url ? ` · <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Original Steam review</a>` : ''}</p>
            <p class="counts">Reached ${count.format(clue.reached)} · Solved ${countWithRate(solves[i], started)} · Wrong ${count.format(clue.wrong)} · Skipped ${count.format(clue.skipped)} · Unfinished here ${count.format(clue.unanswered)}${measured ? ` · Helpful votes ${count.format(feedback.votes[i])}` : ''}</p></li>`;
    }).join('');
    return page('Puzzle review', `<p><a href="/stats?days=${range}#puzzles">Back to player analytics</a></p>
        <h1 id="review-title">${escapeHtml(title)}</h1><p>Published ${escapeHtml(date)} UTC</p>
        <section><h2>Round outcomes</h2>
        <p><strong>${count.format(started)} starts</strong> · Solved ${countWithRate(solved, started)} · Six-try losses ${countWithRate(losses, started)} · Unfinished ${countWithRate(unfinished, started)}</p>
        <p class="note">Solve percentages use all starts, including unfinished rounds.</p></section>
        <section><h2>The six reviews</h2>
        <p>${measured ? `${count.format(responses)} ${responses === 1 ? 'player answered' : 'players answered'} the optional clue question after the reveal. ${count.format(feedback.none)} chose “None of them.”` :
        `Feedback tracking began ${escapeHtml(engagementSince)} UTC, after this puzzle.`}</p>
        <ol class="review-list">${cards}</ol></section>`, true);
}

function renderStats(report, selectedCampaign = '', campaignError = '', order = 'desc') {
    const { today, startDate, endDate, days, trackingSince, daily, clues, sources, retention, campaigns = [] } = report;
    const sum = field => daily.reduce((total, row) => total + row[field], 0);
    const started = sum('started'), finished = sum('finished'), solved = sum('solved');
    const navigation = [[1, 'Today'], [7, '7 days'], [30, '30 days']].map(([duration, name]) =>
        `<a href="/stats?days=${duration}"${days === duration ? ' aria-current="page"' : ''}>${name}</a>`).join('');
    const dates = startDate === endDate ? endDate : startDate + ' – ' + endDate;

    // Daily rows before installation have no measurements.
    const dailyRows = daily.filter(row => row.date >= trackingSince).slice().reverse().map(row => [
        row.date + (row.date === today ? ' · today' : ''), count.format(row.started), count.format(row.finished),
        count.format(row.solved), rate(row.finished, row.started)
    ]);
    const feedback = report.feedback || {votes: Array(6).fill(0), none: 0};
    const respondents = feedback.votes.reduce((sum, n) => sum + n, feedback.none);
    const clueRows = clues.map(row => [row.clue, row.reached, row.wrong, row.skipped, row.solved,
        row.unanswered, feedback.votes[row.clue - 1], rate(row.skipped, row.reached)]);
    const bySource = new Map(sources.map(row => [sourceName(row), row]));
    const byView = new Map((report.views || []).map(row => [sourceName(row), row]));
    const sourceRows = [...new Set([...bySource.keys(), ...byView.keys()])].map(name => {
        const source = bySource.get(name), view = byView.get(name);
        return [name, source?.starters ?? 0, source?.rounds ?? 0, source?.newBrowsers ?? 0,
            view?.viewed ?? 0, view?.started ?? 0, rate(view?.started, view?.viewed)];
    });
    const returnRows = retention.sources.map(row =>
        [sourceName(row), row.eligible, row.returned, rate(row.returned, row.eligible)]);
    const cohortDates = retention.startDate === retention.endDate
        ? retention.startDate : retention.startDate + ' – ' + retention.endDate;
    const campaign = campaigns.includes(selectedCampaign) ? selectedCampaign : '';
    const campaignOptions = campaigns.map(name =>
        `<option value="${escapeHtml(name)}"${name === campaign ? ' selected' : ''}>${escapeHtml(name)}</option>`
    ).join('');
    const sourceLinks = ['discord', 'streamer'].map(source => {
        const link = new URL('https://steamdle.com/');
        link.searchParams.set('utm_source', source);
        if (campaign) link.searchParams.set('utm_campaign', campaign);
        return `<label>${sourceLabels[source]}<input aria-label="${sourceLabels[source]} outreach link" readonly value="${escapeHtml(link.href)}"></label>`;
    }).join('');

    return page('Player analytics', `
        <h1>Player analytics</h1><p>${escapeHtml(dates)} UTC · Tracking since ${escapeHtml(trackingSince)}.</p>
        <nav class="period" aria-label="Reporting period">${navigation}</nav>
        <nav class="jump" aria-label="Dashboard sections"><a href="#puzzles">Puzzles to review</a><a href="#clues">Clue feedback</a>
            <a href="#sources">First-clue conversion</a><a href="#sharing">Sharing</a><a href="#search">Search</a>
            ${report.attribution ? '<a href="#countries">Countries</a><a href="#referrers">Referring websites</a>' : ''}
            <a href="#retention">Returns</a><a href="#outreach">Outreach links</a></nav>
        ${report.engagementSince ? `<p class="note">First-clue views, sharing, feedback and search tracking began ${escapeHtml(report.engagementSince)} UTC. The first day may be partial.</p>` : ''}
        <dl class="cards">
            <div><dt>Started</dt><dd>${count.format(started)}</dd><small>Rounds with a first turn</small></div>
            <div><dt>Finished</dt><dd>${count.format(finished)}</dd><small>${started ? rate(finished, started) + ' of starts' : 'Solved or used all six tries'}</small></div>
            <div><dt>Solved</dt><dd>${count.format(solved)}</dd><small>${started ? rate(solved, started) + ' of starts' : 'Rounds with a correct guess'}</small></div>
        </dl>
        <section><h2>Daily rounds</h2><p>Each browser can start one round per UTC puzzle day. A first guess or skip starts the round.</p>
            ${table('Daily rounds', ['Puzzle date','Started','Finished','Solved','Finish rate'], dailyRows)}
        </section>
        ${puzzleSection(report, campaign, order)}
        <section id="clues"><h2>Clue outcomes and feedback</h2><p>See what players did after reaching each clue in a started round.</p>
            ${table('Clue outcomes', ['Clue','Reached','Wrong guess','Skipped','Solved','No turn yet','Helpful votes','Skip rate'], clueRows)}
            <p class="note">Skip rate uses rounds that reached that clue. “No turn yet” includes players who may still finish today. Opening the page alone does not count as reaching clue one.</p>
            <p class="note">After the reveal, a player can name one review that helped them recognize the game. Of ${count.format(respondents)} responses, ${count.format(feedback.none)} chose “None of them.”</p>
        </section>
        <section id="sources"><h2>Where players came from</h2><p>Browsers and rounds are grouped by the source of the round. New browsers are credited to their first start.</p>
            ${sourceRows.length ? table('Outreach sources', ['Source / campaign','Browsers with a start','Rounds started','New browsers','Saw clue one','Started after view','View to start'], sourceRows)
                : '<p class="note">Source totals appear after the first measured view or turn.</p>'}
            <p class="note">First-clue conversion counts one measured view per browser and puzzle. The numerator counts those same browser rounds with a recorded first guess or skip.</p>
        </section>
        ${attributionSections(report)}
        ${sharingSection(report)}
        ${searchSection(report.search)}
        <section id="retention"><h2>Seven-day return</h2><p>Of browsers that first played <strong>${escapeHtml(cohortDates)} UTC</strong>, how many played again on one of the next seven UTC dates?</p>
            ${returnRows.length ? table('Seven-day return by first source', ['First source / campaign','Eligible browsers','Returned','Return rate'], returnRows)
                : '<p class="note">No first-time browsers were recorded in this earlier period.</p>'}
            <p class="note">This period ends eight days ago so every browser has a full seven days to return. Clearing browser storage or switching devices can count the same person more than once.</p>
        </section>
        <section id="outreach"><h2>Outreach links</h2><p>Copy the link for your channel. Use a campaign to track a specific community or creator separately.</p>
            ${campaigns.length ? `<form class="campaign" action="/stats#outreach" method="get">
                <input type="hidden" name="days" value="${escapeHtml(days)}">
                <label>Campaign<select name="campaign"><option value="">General links</option>${campaignOptions}</select></label>
                <button>Show links</button></form>` : ''}
            <div class="links">${sourceLinks}</div>
            <details${campaignError ? ' open' : ''}><summary>Create a campaign</summary>
                <form class="campaign" method="post" action="/stats/campaign">
                    <input type="hidden" name="days" value="${escapeHtml(days)}">
                    <label>Campaign name<input name="campaign" required maxlength="40"
                        pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="friday-puzzle-club" aria-describedby="campaign-hint"
                        autocapitalize="none" spellcheck="false"${campaignError ? ' aria-invalid="true" autofocus' : ''}></label>
                    <button>Create links</button>
                </form>
                <p class="note" id="campaign-hint">Use up to 40 lowercase letters, digits and single hyphens. This name appears in the links you share.</p>
                ${campaignError ? `<p role="alert" class="error">${escapeHtml(campaignError)}</p>` : ''}
            </details>
        </section>`, true);
}

module.exports = { renderLogin, renderStats, renderPuzzle };
