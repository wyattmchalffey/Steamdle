// Bind verified data into the Steam Community HTML in #steam-review-template.
// Source and the small game-specific adaptations: docs/steam-review-template-source.txt.
function avatarUrl(value) {
    if (typeof value !== 'string') return null;
    return /^https:\/\/avatars(?:\.(?:akamai|cloudflare|fastly))?\.steamstatic\.com\/[a-f0-9]{40}(?:_medium|_full)?\.jpg$/i.test(value) ||
        /^https:\/\/steamcdn-a\.akamaihd\.net\/steamcommunity\/public\/images\/avatars\/[a-f0-9]{2}\/[a-f0-9]{40}(?:_medium|_full)?\.jpg$/i.test(value)
        ? value : null;
}

export function createSteamReviewCard(document, template, review) {
    const card = document.importNode(template.content, true).firstElementChild;
    const name = card.querySelector('.persona_name_text_content');
    name.textContent = review.reviewerName || 'Reviewer unavailable';
    const avatar = card.querySelector('.reviewer-avatar');
    const url = avatarUrl(review.reviewerAvatarUrl);
    if (url) {
        avatar.addEventListener('error', () => card.querySelector('.profile_small_header_avatar').remove(), {once:true});
        avatar.src = url;
    } else card.querySelector('.profile_small_header_avatar').remove();
    const count = card.querySelector('.reviewer-review-count');
    if (Number.isSafeInteger(review.reviewerReviewCount) && review.reviewerReviewCount >= 0) {
        count.textContent = `${review.reviewerReviewCount} ${review.reviewerReviewCount === 1 ? 'review' : 'reviews'}`;
        count.hidden = false;
    }

    const recommendation = typeof review.recommendation === 'string' ? review.recommendation.trim().toLowerCase() : '';
    const positive = recommendation === 'recommended';
    const negative = recommendation === 'not recommended';
    const icon = card.querySelector('.recommendation-icon');
    if (positive || negative) {
        card.classList.add(positive ? 'recommended' : 'not-recommended');
        icon.src = positive ? '/images/thumb-up.png' : '/images/thumb-down.png';
    } else icon.remove();
    card.querySelector('.ratingSummary').textContent = positive ? 'Recommended' : negative ? 'Not Recommended' : 'Recommendation unavailable';
    const playtime = card.querySelector('.playTime');
    if (review.playtime && review.playtime !== 'Playtime not shown') playtime.textContent = review.playtime;
    else playtime.hidden = true;
    const posted = card.querySelector('.recommendation_date');
    if (review.datePosted && review.datePosted !== 'Date not found') posted.textContent = `Posted: ${review.datePosted}`;
    else posted.hidden = true;
    card.querySelector('.review-excerpt').hidden = review.isExcerpt !== true;
    card.querySelector('.review-text-content').textContent = review.reviewText || '';
    return card;
}
