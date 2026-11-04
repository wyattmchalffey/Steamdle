const style = `
    :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #182d37; background: #f4f7f8; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(68rem, 100%); margin: auto; padding: 2.5rem clamp(1rem, 4vw, 3rem) 4rem; }
    header { background: #172d3b; color: #f4f8fa; }
    header > div { width: min(68rem, 100%); margin: auto; padding: .75rem clamp(1rem, 4vw, 3rem); display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .brand { font-weight: 750; letter-spacing: .02em; }
    .brand span { font-weight: 450; margin-left: .7rem; color: #bdd0da; }
    h1, h2, p { margin: 0; }
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

function table(label, columns, rows) {
    return `<div class="grid" role="region" aria-label="${label}" tabindex="0"><table aria-label="${label}">
        <thead><tr>${columns.map(name => `<th scope="col">${escapeHtml(name)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(row => '<tr>' + row.map((value, index) => index === 0
            ? `<th scope="row">${escapeHtml(value)}</th>`
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

function renderStats(report, selectedCampaign = '', campaignError = '') {
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
    const clueRows = clues.map(row => [row.clue, row.reached, row.wrong, row.skipped, row.solved,
        row.unanswered, rate(row.skipped, row.reached)]);
    const sourceRows = sources.map(row => [sourceName(row), row.starters, row.rounds, row.newBrowsers]);
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
        <dl class="cards">
            <div><dt>Started</dt><dd>${count.format(started)}</dd><small>Rounds with a first turn</small></div>
            <div><dt>Finished</dt><dd>${count.format(finished)}</dd><small>${started ? rate(finished, started) + ' of starts' : 'Solved or used all six tries'}</small></div>
            <div><dt>Solved</dt><dd>${count.format(solved)}</dd><small>${started ? rate(solved, started) + ' of starts' : 'Rounds with a correct guess'}</small></div>
        </dl>
        <section><h2>Daily rounds</h2><p>Each browser can start one round per UTC puzzle day. A first guess or skip starts the round.</p>
            ${table('Daily rounds', ['Puzzle date','Started','Finished','Solved','Finish rate'], dailyRows)}
        </section>
        <section><h2>Clue outcomes</h2><p>See what players did after reaching each clue in a started round.</p>
            ${table('Clue outcomes', ['Clue','Reached','Wrong guess','Skipped','Solved','No turn yet','Skip rate'], clueRows)}
            <p class="note">Skip rate uses rounds that reached that clue. “No turn yet” includes players who may still finish today. Opening the page alone does not count as reaching clue one.</p>
        </section>
        <section><h2>Where players came from</h2><p>Browsers and rounds are grouped by the source of the round. New browsers are credited to their first start.</p>
            ${sourceRows.length ? table('Outreach sources', ['Source / campaign','Browsers','Rounds','New browsers'], sourceRows)
                : '<p class="note">Source totals appear after the first recorded turn.</p>'}
        </section>
        <section><h2>Seven-day return</h2><p>Of browsers that first played <strong>${escapeHtml(cohortDates)} UTC</strong>, how many played again on one of the next seven UTC dates?</p>
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

module.exports = { renderLogin, renderStats };
