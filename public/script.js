import { decodeAttempts, guessError, MAX_GUESS_LENGTH, normalizeTitle } from './round.mjs';

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const reviewsContainer = document.getElementById('reviews-container');
    const loadingState = document.getElementById('loading-state');
    const loadErrorState = document.getElementById('load-error-state');
    const loadErrorMessage = document.getElementById('load-error-message');
    const retryLoadButton = document.getElementById('retry-load-button');
    const previousGuessesContainer = document.getElementById('previous-guesses-container');
    const inputArea = document.getElementById('input-area');
    const guessInput = document.getElementById('guess-input');
    const guessButton = document.getElementById('guess-button');
    const skipButton = document.getElementById('skip-button');
    const previousGuessesList = document.getElementById('previous-guesses-list');
    const guessesRemainingDesc = document.getElementById('guesses-remaining-desc');
    const guessesRemainingSpan = document.getElementById('guesses-remaining');
    const gameOverMessageDiv = document.getElementById('game-over-message');
    const winLoseText = document.getElementById('win-lose-text');
    const correctGameTitleSpan = document.getElementById('correct-game-title');
    const gameImage = document.getElementById('game-image');
    const steamLink = document.getElementById('steam-link');
    const shareButton = document.getElementById('share-button');
    const shareSection = document.getElementById('share-section');
    const twitterShareLink = document.getElementById('twitter-share-link');
    const resultStats = document.getElementById('result-stats');
    const toastEl = document.getElementById('toast');
    const creditEl = document.getElementById('credit');
    const autocompleteDropdown = document.getElementById('autocomplete-dropdown');

    // Game State
    let currentGame;
    let attempts = []; // Each turn is a guessed title, or null for a skip.
    let isGameOver = false;
    let loadingRound = false;
    let loadedOnDate;
    let rolloverTimer;
    let autocompleteDebounceTimer;

    // Autocomplete state
    let activeDropdownIndex = -1;
    let currentSuggestions = [];

    // LRU Cache for autocomplete (max 50 entries)
    const CACHE_MAX = 50;
    const autocompleteCache = new Map();

    function cachePut(key, value) {
        if (autocompleteCache.has(key)) {
            autocompleteCache.delete(key); // remove to re-insert at end
        } else if (autocompleteCache.size >= CACHE_MAX) {
            // Delete oldest entry (first key)
            const firstKey = autocompleteCache.keys().next().value;
            autocompleteCache.delete(firstKey);
        }
        autocompleteCache.set(key, value);
    }

    function cacheGet(key) {
        if (!autocompleteCache.has(key)) return undefined;
        const value = autocompleteCache.get(key);
        // Move to end (most recently used)
        autocompleteCache.delete(key);
        autocompleteCache.set(key, value);
        return value;
    }

    // Autocomplete Logic
    function highlightMatch(text, query) {
        if (!query) return document.createTextNode(text);

        const lowerText = text.toLowerCase();
        const lowerQuery = query.toLowerCase();
        const idx = lowerText.indexOf(lowerQuery);

        if (idx === -1) return document.createTextNode(text);

        const frag = document.createDocumentFragment();
        if (idx > 0) {
            frag.appendChild(document.createTextNode(text.substring(0, idx)));
        }
        const mark = document.createElement('span');
        mark.className = 'match-highlight';
        mark.textContent = text.substring(idx, idx + query.length);
        frag.appendChild(mark);
        if (idx + query.length < text.length) {
            frag.appendChild(document.createTextNode(text.substring(idx + query.length)));
        }
        return frag;
    }

    function renderDropdown(suggestions, query) {
        currentSuggestions = suggestions;
        activeDropdownIndex = -1;
        autocompleteDropdown.innerHTML = '';

        if (suggestions.length === 0) {
            autocompleteDropdown.classList.add('hidden');
            return;
        }

        suggestions.forEach((name, i) => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.appendChild(highlightMatch(name, query));
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Prevent blur from firing before selection
                selectSuggestion(name);
            });
            autocompleteDropdown.appendChild(item);
        });

        autocompleteDropdown.classList.remove('hidden');
    }

    function selectSuggestion(name) {
        guessInput.value = name;
        closeDropdown();
        guessInput.focus();
    }

    function closeDropdown() {
        autocompleteDropdown.classList.add('hidden');
        autocompleteDropdown.innerHTML = '';
        currentSuggestions = [];
        activeDropdownIndex = -1;
    }

    function updateActiveItem() {
        const items = autocompleteDropdown.querySelectorAll('.autocomplete-item');
        items.forEach((el, i) => {
            el.classList.toggle('active', i === activeDropdownIndex);
        });
        // Scroll active item into view
        if (activeDropdownIndex >= 0 && items[activeDropdownIndex]) {
            items[activeDropdownIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    async function fetchAutocompleteSuggestions(searchTerm) {
        const trimmed = searchTerm.trim();
        if (trimmed.length < 1) {
            closeDropdown();
            return;
        }

        // Check cache first
        const cached = cacheGet(trimmed.toLowerCase());
        if (cached !== undefined) {
            renderDropdown(cached, trimmed);
            return;
        }

        try {
            const response = await fetch(`/api/search-steam-games?term=${encodeURIComponent(trimmed)}&limit=10`);
            if (!response.ok) {
                console.error(`Autocomplete API request failed: ${response.status}`);
                closeDropdown();
                return;
            }
            const suggestions = await response.json();
            cachePut(trimmed.toLowerCase(), suggestions);
            // Only render if input still matches (user may have typed more)
            if (guessInput.value.trim().toLowerCase() === trimmed.toLowerCase()) {
                renderDropdown(suggestions, trimmed);
            }
        } catch (error) {
            console.error("Failed to fetch autocomplete suggestions from backend:", error);
            closeDropdown();
        }
    }

    // --- Game Initialization & Flow ---
    async function fetchDailyGame(canRetryDate = true) {
        const startedOn = new Date().toISOString().slice(0, 10);
        try {
            const response = await fetch('/api/daily-game', { cache: 'no-store' });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: "Failed to fetch daily game data." }));
                throw new Error(errorData.error || `Server error: ${response.status}`);
            }
            currentGame = await response.json();
            if (!currentGame || !currentGame.title || !currentGame.puzzleDate || !currentGame.appId || !Array.isArray(currentGame.reviews) || currentGame.reviews.length === 0) {
                throw new Error("Incomplete game data received from server.");
            }
            const nowDate = new Date().toISOString().slice(0, 10);
            const serverTime = Date.parse(response.headers.get('Date'));
            const serverDate = Number.isFinite(serverTime) ? new Date(serverTime).toISOString().slice(0, 10) : nowDate;
            if (currentGame.puzzleDate !== serverDate || (startedOn !== nowDate && currentGame.puzzleDate === startedOn)) {
                if (canRetryDate) return fetchDailyGame(false);
                throw new Error("The next daily puzzle is being prepared.");
            }
            return true;
        } catch (error) {
            console.error("Frontend: Error fetching daily game:", error.message);
            currentGame = null;
            if (loadingState) loadingState.classList.add('hidden');
            if (loadErrorState && loadErrorMessage) {
                loadErrorMessage.textContent = `${error.message} Try again or refresh the page.`;
                loadErrorState.classList.remove('hidden');
            }
            reviewsContainer.innerHTML = '';
            guessInput.disabled = true;
            guessButton.disabled = true;
            return false;
        }
    }

    function progressKey() {
        return `steamdle.round.v1.${currentGame.puzzleDate}.${currentGame.appId}`;
    }

    function isCorrect(guess) {
        return guess !== null && normalizeTitle(guess) === normalizeTitle(currentGame.title);
    }

    function readAttempts() {
        try {
            const saved = JSON.parse(localStorage.getItem(progressKey()));
            return decodeAttempts(saved, currentGame.title, currentGame.reviews.length);
        } catch {
            return [];
        }
    }

    function syncProgress() {
        if (!currentGame) return false;
        const saved = readAttempts();
        if (saved.length <= attempts.length) return false;
        attempts = saved;
        renderRound();
        return true;
    }

    function checkForNewDay() {
        if (!currentGame || loadedOnDate === new Date().toISOString().slice(0, 10)) return false;
        initGame();
        return true;
    }

    async function initGame() {
        if (loadingRound) return;
        loadingRound = true;
        currentGame = null;
        clearTimeout(rolloverTimer);
        closeDropdown();
        loadingState.classList.remove('hidden');
        loadErrorState.classList.add('hidden');
        inputArea.classList.add('hidden');
        guessesRemainingDesc.classList.add('hidden');
        previousGuessesContainer.classList.add('hidden');
        gameOverMessageDiv.classList.add('hidden');
        gameOverMessageDiv.classList.remove('win', 'lose');
        creditEl.classList.add('hidden');
        reviewsContainer.replaceChildren();

        const gameLoaded = await fetchDailyGame();
        loadingRound = false;
        loadingState.classList.add('hidden');
        if (!gameLoaded) return;

        const now = new Date();
        loadedOnDate = now.toISOString().slice(0, 10);
        const midnight = new Date(now);
        midnight.setUTCHours(24, 0, 0, 0);
        rolloverTimer = setTimeout(initGame, midnight - now);
        attempts = readAttempts();
        guessInput.value = '';
        guessInput.maxLength = MAX_GUESS_LENGTH;
        guessInput.placeholder = "Enter game title...";
        renderRound();
    }

    function renderRound(interactive = false) {
        const total = currentGame.reviews.length;
        const won = attempts.some(isCorrect);
        const remaining = total - attempts.length;
        isGameOver = won || remaining === 0;
        const visibleClues = isGameOver ? total : attempts.length + 1;
        for (let i = reviewsContainer.childElementCount; i < visibleClues; i++) {
            appendReview(i, interactive && !isGameOver);
        }

        previousGuessesList.replaceChildren();
        for (const guess of attempts) {
            if (isCorrect(guess)) continue;
            const item = document.createElement('li');
            item.textContent = guess === null ? 'Skipped' : guess;
            if (guess === null) item.classList.add('skipped');
            previousGuessesList.appendChild(item);
        }
        previousGuessesContainer.classList.toggle('hidden', !previousGuessesList.childElementCount);
        guessesRemainingSpan.textContent = remaining;
        guessInput.disabled = guessButton.disabled = skipButton.disabled = isGameOver;
        inputArea.classList.toggle('hidden', isGameOver);
        guessesRemainingDesc.classList.toggle('hidden', isGameOver);
        skipButton.textContent = remaining === 1 ? 'Skip and reveal answer' : 'Skip for next clue';

        if (isGameOver) endGame(won, interactive);
    }

    function appendReview(index, animate) {
        const reviewData = currentGame.reviews[index];
        if (reviewData.error) {
            // Handle cases where scraping failed for this specific review
            const errorWrapper = document.createElement('div');
            errorWrapper.classList.add('review-item-wrapper', 'loaded', 'review-error-item');
            errorWrapper.innerHTML = `
            <span class="clue-number">Clue ${index + 1} of ${currentGame.reviews.length}:</span>
            <p class="review-image-error">Oops! Could not load this review clue. '${reviewData.message}'</p>
            <p class="review-source-url-error">(Source: ${reviewData.originalUrl || 'N/A'})</p>
        `;
            reviewsContainer.appendChild(errorWrapper);
            reviewsContainer.scrollTop = reviewsContainer.scrollHeight;
            return;
        }

        // Create HTML structure for the review
        const reviewWrapper = document.createElement('div');
        reviewWrapper.classList.add('review-item-wrapper');

        // Clue Number
        const clueNumberSpan = document.createElement('span');
        clueNumberSpan.classList.add('clue-number');
        clueNumberSpan.textContent = `Clue ${index + 1} of ${currentGame.reviews.length}:`;
        reviewWrapper.appendChild(clueNumberSpan);

        // Main review card div (add recommendation state to card for left border styling)
        const reviewCard = document.createElement('div');
        reviewCard.classList.add('steam-review-card');
        const isRec = reviewData.recommendation && reviewData.recommendation.toLowerCase() === 'recommended';
        const isNotRec = reviewData.recommendation && reviewData.recommendation.toLowerCase() === 'not recommended';
        if (isRec) reviewCard.classList.add('recommended');
        else if (isNotRec) reviewCard.classList.add('not-recommended');

        // Review Header Section
        const reviewHeader = document.createElement('div');
        reviewHeader.classList.add('review-header');
        let headerHasContent = false;

        // Add Avatar if available
        if (reviewData.reviewerAvatarUrl) {
            const avatarImg = document.createElement('img');
            avatarImg.src = reviewData.reviewerAvatarUrl;
            avatarImg.alt = "Reviewer avatar";
            avatarImg.classList.add('reviewer-avatar');
            reviewHeader.appendChild(avatarImg);
            headerHasContent = true;
        }

        // Add Name if available (or use fallback)
        const reviewerNameSpan = document.createElement('span');
        reviewerNameSpan.classList.add('reviewer-name');
        reviewerNameSpan.textContent = reviewData.reviewerName || "A Steam User";
        reviewHeader.appendChild(reviewerNameSpan);
        headerHasContent = true;


        // Append header to card ONLY if it has content
        if (headerHasContent) {
            reviewCard.appendChild(reviewHeader);
        }
        // End Review Header Section


        // Recommendation Block
        const recommendationDiv = document.createElement('div');
        recommendationDiv.classList.add('review-recommendation');
        if (isRec) recommendationDiv.classList.add('recommended');
        else if (isNotRec) recommendationDiv.classList.add('not-recommended');

        const iconDiv = document.createElement('div');
        iconDiv.classList.add('recommendation-icon');
        recommendationDiv.appendChild(iconDiv);

        const detailsDiv = document.createElement('div');
        detailsDiv.classList.add('recommendation-details');

        if (reviewData.recommendation) {
            const recTextSpan = document.createElement('span');
            recTextSpan.classList.add('recommendation-text');
            recTextSpan.textContent = reviewData.recommendation;
            detailsDiv.appendChild(recTextSpan);
        }

        if (reviewData.playtime && reviewData.playtime !== "Playtime not shown") {
            const playtimeP = document.createElement('p');
            playtimeP.classList.add('review-playtime');
            playtimeP.textContent = reviewData.playtime;
            detailsDiv.appendChild(playtimeP);
        }

        if (detailsDiv.hasChildNodes()) { recommendationDiv.appendChild(detailsDiv); }
        if (recommendationDiv.hasChildNodes()) { reviewCard.appendChild(recommendationDiv); }
        // End Recommendation Block

        // Date Posted
        if (reviewData.datePosted && reviewData.datePosted !== "Date not found") {
            const dateP = document.createElement('p');
            dateP.classList.add('review-date');
            dateP.textContent = `Posted: ${reviewData.datePosted}`;
            reviewCard.appendChild(dateP);
        }

        // Review Text
        if (reviewData.reviewText && reviewData.reviewText !== "Could not load review text.") {
            const reviewTextP = document.createElement('p');
            reviewTextP.classList.add('review-text-content');
            reviewTextP.style.whiteSpace = 'pre-line';
            reviewTextP.textContent = reviewData.reviewText;
            reviewCard.appendChild(reviewTextP);
        }

        // End Review Card Content

        reviewWrapper.appendChild(reviewCard);
        reviewsContainer.appendChild(reviewWrapper);

        if (animate) {
            requestAnimationFrame(() => reviewWrapper.classList.add('loaded'));
            setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 50);
        } else {
            reviewWrapper.classList.add('loaded');
        }
    }

    function handleGuess() {
        takeTurn(guessInput.value.trim());
    }

    function takeTurn(guess) {
        if (!currentGame || isGameOver || checkForNewDay()) return;
        const game = currentGame;
        const turnNumber = attempts.length;
        const submit = () => {
            if (game !== currentGame || isGameOver || checkForNewDay()) return;
            if (syncProgress() || attempts.length !== turnNumber) {
                showToast('Your round was updated in another tab.');
                return;
            }
            const error = guessError(guess, attempts);
            if (error) {
                showToast(error);
                guessInput.select();
                return;
            }

            attempts.push(guess);
            try {
                localStorage.setItem(progressKey(), JSON.stringify(attempts));
            } catch {
                // Storage may be disabled. The round still works in this tab.
            }
            guessInput.value = '';
            closeDropdown();
            renderRound(true);
            if (!isGameOver) guessInput.focus();
        };

        // Two tabs can submit before either receives the other's storage event.
        if (!navigator.locks) return submit();
        navigator.locks.request(progressKey(), submit).catch(error => {
            if (error.name === 'SecurityError') submit();
            else showToast('Try that turn again.');
        });
    }

    function endGame(didWin, interactive) {
        closeDropdown();
        creditEl.classList.remove('hidden');
        gameOverMessageDiv.classList.remove('hidden');
        correctGameTitleSpan.textContent = currentGame.title;

        if (currentGame.appId) {
            steamLink.href = `https://store.steampowered.com/app/${currentGame.appId}/`;
            steamLink.classList.remove('hidden');
            gameImage.src = `https://cdn.akamai.steamstatic.com/steam/apps/${currentGame.appId}/header.jpg`;
            gameImage.onload = () => gameImage.classList.remove('hidden');
            gameImage.onerror = () => {
                console.warn(`[endGame] Failed to load game cover for AppID ${currentGame.appId}`);
                gameImage.classList.add('hidden');
            }
        } else {
            steamLink.classList.add('hidden');
            gameImage.classList.add('hidden');
        }

        if (didWin) {
            winLoseText.textContent = "Congratulations! You guessed it!";
            gameOverMessageDiv.classList.add('win');
            const cluesUsed = attempts.length;
            resultStats.textContent = `You got it in ${cluesUsed} ${cluesUsed === 1 ? 'clue' : 'clues'}!`;
            if (interactive) triggerConfetti();
        } else {
            winLoseText.textContent = "Game Over! Better luck next time.";
            gameOverMessageDiv.classList.add('lose');
            resultStats.textContent = `You used all ${currentGame.reviews.length} clues.`;
        }
        shareSection.classList.remove('hidden');
        const shareText = generateShareText();
        twitterShareLink.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
        if (interactive) shareButton.focus();
    }

    function triggerConfetti() {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const colors = ['#66c0f4', '#5c7e10', '#c7d5e0', '#ffd700', '#ff6b6b', '#a78bfa'];
        const particleCount = 70;
        const container = document.createElement('div');
        container.className = 'confetti-container';
        container.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < particleCount; i++) {
            const p = document.createElement('div');
            p.className = 'confetti-particle';
            p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            p.style.left = Math.random() * 100 + '%';
            p.style.animationDelay = (Math.random() * 0.6) + 's';
            p.style.animationDuration = (2.2 + Math.random() * 1.2) + 's';
            const size = 6 + Math.floor(Math.random() * 6);
            p.style.width = size + 'px';
            p.style.height = size + 'px';
            if (Math.random() > 0.5) p.style.borderRadius = '50%';
            container.appendChild(p);
        }
        document.body.appendChild(container);
        setTimeout(() => {
            container.remove();
        }, 4000);
    }

    function generateShareText() {
        const puzzleId = (currentGame.puzzleDateFormatted || currentGame.puzzleDate || 'Daily').replace(/\s+/g, '');
        const score = `${attempts.some(isCorrect) ? attempts.length : 'X'}/${currentGame.reviews.length}`;
        const gridVisual = attempts.map(guess => {
            if (guess === null) return '\u2b1c';
            return isCorrect(guess) ? '\u{1f7e9}' : '\u{1f7e5}';
        }).join('');
        const gameUrl = window.location.origin;

        return `Steamdle #${puzzleId} ${score}\n\n${gridVisual}\n\nCan you guess today's game? Play at ${gameUrl}`;
    }

    function showToast(message) {
        if (!toastEl) return;
        toastEl.textContent = message;
        toastEl.classList.remove('hidden');
        clearTimeout(toastEl._toastTimer);
        toastEl._toastTimer = setTimeout(() => {
            toastEl.classList.add('hidden');
        }, 2000);
    }

    // --- Event Listeners ---
    guessButton.addEventListener('click', handleGuess);
    skipButton.addEventListener('click', () => takeTurn(null));
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkForNewDay();
    });
    window.addEventListener('storage', event => {
        if (currentGame && event.key === progressKey()) syncProgress();
    });

    guessInput.addEventListener('keydown', (event) => {
        const dropdownVisible = !autocompleteDropdown.classList.contains('hidden');

        if (event.key === 'ArrowDown') {
            if (dropdownVisible && currentSuggestions.length > 0) {
                event.preventDefault();
                activeDropdownIndex = Math.min(activeDropdownIndex + 1, currentSuggestions.length - 1);
                updateActiveItem();
            }
        } else if (event.key === 'ArrowUp') {
            if (dropdownVisible && currentSuggestions.length > 0) {
                event.preventDefault();
                activeDropdownIndex = Math.max(activeDropdownIndex - 1, -1);
                updateActiveItem();
            }
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (dropdownVisible && activeDropdownIndex >= 0 && currentSuggestions[activeDropdownIndex]) {
                selectSuggestion(currentSuggestions[activeDropdownIndex]);
            } else {
                handleGuess();
            }
        } else if (event.key === 'Escape') {
            if (dropdownVisible) {
                event.preventDefault();
                closeDropdown();
            }
        } else if (event.key === 'Tab') {
            if (dropdownVisible && currentSuggestions.length > 0) {
                event.preventDefault();
                // Tab fills in the first (or active) suggestion
                const idx = activeDropdownIndex >= 0 ? activeDropdownIndex : 0;
                selectSuggestion(currentSuggestions[idx]);
            }
        }
    });

    guessInput.addEventListener('input', () => {
        const searchTerm = guessInput.value;
        clearTimeout(autocompleteDebounceTimer);
        autocompleteDebounceTimer = setTimeout(() => {
            fetchAutocompleteSuggestions(searchTerm);
        }, 150);
    });

    guessInput.addEventListener('focus', () => {
        // Reopen dropdown if there are cached results for the current input
        const trimmed = guessInput.value.trim();
        if (trimmed.length >= 1 && !isGameOver) {
            const cached = cacheGet(trimmed.toLowerCase());
            if (cached && cached.length > 0) {
                renderDropdown(cached, trimmed);
            }
        }
    });

    guessInput.addEventListener('blur', () => {
        // Small delay to allow mousedown on dropdown items to fire first
        setTimeout(() => {
            closeDropdown();
        }, 150);
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#autocomplete-wrapper')) {
            closeDropdown();
        }
    });

    shareButton.addEventListener('click', () => {
        const textToShare = generateShareText();
        if (navigator.share) {
            navigator.share({
                title: 'My Steamdle Result!',
                text: textToShare,
            }).catch(() => {
                copyToClipboard(textToShare);
            });
        } else {
            copyToClipboard(textToShare);
        }
    });

    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('Copied!');
            }).catch(() => fallbackCopy(text));
        } else {
            fallbackCopy(text);
        }
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showToast('Copied!');
        } catch (err) {
            showToast('Copy failed');
        }
        document.body.removeChild(ta);
    }

    if (retryLoadButton) {
        retryLoadButton.addEventListener('click', () => initGame());
    }

    // --- Initialize Game ---
    initGame();
});
