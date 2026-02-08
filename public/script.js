document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const reviewsContainer = document.getElementById('reviews-container');
    const loadingMessage = document.getElementById('loading-message');
    const guessInput = document.getElementById('guess-input');
    const guessButton = document.getElementById('guess-button');
    const previousGuessesList = document.getElementById('previous-guesses-list');
    const guessesRemainingSpan = document.getElementById('guesses-remaining');
    const gameOverMessageDiv = document.getElementById('game-over-message');
    const winLoseText = document.getElementById('win-lose-text');
    const correctGameTitleSpan = document.getElementById('correct-game-title');
    const gameImage = document.getElementById('game-image');
    const steamLink = document.getElementById('steam-link');
    const shareButton = document.getElementById('share-button');
    const autocompleteDropdown = document.getElementById('autocomplete-dropdown');

    // Game State
    let currentGame; // Will be fetched from backend { title, appId, reviews: [urls] }
    let currentReviewIndex;
    let guessesLeft;
    let isGameOver;
    let shareGrid = [];
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

    // Helper Functions
    function normalizeString(str) {
        if (typeof str !== 'string') return '';

        let normalized = str.toLowerCase();

        normalized = normalized.replace(/[^a-z0-9]/gi, '');

        return normalized;
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
    async function fetchDailyGame() {
        try {
            const response = await fetch('/api/daily-game');
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: "Failed to fetch daily game data." }));
                throw new Error(errorData.error || `Server error: ${response.status}`);
            }
            currentGame = await response.json();
            if (!currentGame || !currentGame.title || !currentGame.reviews || currentGame.reviews.length === 0) {
                throw new Error("Incomplete game data received from server.");
            }
            console.log("Frontend: Received daily game data:", currentGame);
            return true;
        } catch (error) {
            console.error("Frontend: Error fetching daily game:", error.message);
            if(loadingMessage) loadingMessage.textContent = `Error: ${error.message} Please try refreshing.`;
            reviewsContainer.innerHTML = `<p class="review-image-error">Error loading today's game: ${error.message}. Please try refreshing the page.</p>`;
            guessInput.disabled = true;
            guessButton.disabled = true;
            return false;
        }
    }

    async function initGame() {
        console.log("Frontend: Initializing game...");
        if(loadingMessage) loadingMessage.classList.remove('hidden');

        const gameLoaded = await fetchDailyGame();

        if(loadingMessage) loadingMessage.classList.add('hidden');

        if (!gameLoaded) {
            // Error message already displayed by fetchDailyGame
            return;
        }

        currentReviewIndex = 0;
        guessesLeft = 6;
        isGameOver = false;
        shareGrid = [];

        reviewsContainer.innerHTML = '';
        previousGuessesList.innerHTML = '';
        guessesRemainingSpan.textContent = guessesLeft;

        gameOverMessageDiv.classList.add('hidden');
        gameOverMessageDiv.classList.remove('win', 'lose');
        winLoseText.textContent = '';
        correctGameTitleSpan.textContent = '';
        gameImage.classList.add('hidden');
        gameImage.src = '';
        steamLink.classList.add('hidden');
        steamLink.href = '#';
        shareButton.classList.add('hidden');

        guessInput.value = '';
        guessInput.disabled = false;
        guessInput.placeholder = "Enter game title...";
        guessButton.disabled = false;

        closeDropdown();

        displayNextReview();
        console.log("Frontend: Game initialized.");
    }

    function displayNextReview() {
        if (isGameOver || !currentGame || currentReviewIndex >= currentGame.reviews.length) {
            return;
        }

        const reviewData = currentGame.reviews[currentReviewIndex];
        console.log(`Frontend: Displaying review clue ${currentReviewIndex + 1} data:`, reviewData);

        if (reviewData.error) {
            // Handle cases where scraping failed for this specific review
            const errorWrapper = document.createElement('div');
            errorWrapper.classList.add('review-item-wrapper', 'loaded', 'review-error-item');
            errorWrapper.innerHTML = `
            <span class="clue-number">Clue ${currentReviewIndex + 1} of ${currentGame.reviews.length}:</span>
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
        clueNumberSpan.textContent = `Clue ${currentReviewIndex + 1} of ${currentGame.reviews.length}:`;
        reviewWrapper.appendChild(clueNumberSpan);

        // Main review card div
        const reviewCard = document.createElement('div');
        reviewCard.classList.add('steam-review-card');

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
        const isRecommended = reviewData.recommendation && reviewData.recommendation.toLowerCase() === 'recommended';
        const notRecommended = reviewData.recommendation && reviewData.recommendation.toLowerCase() === 'not recommended';

        if (isRecommended) { recommendationDiv.classList.add('recommended'); }
        else if (notRecommended) { recommendationDiv.classList.add('not-recommended'); }

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

        // Animation trigger
        setTimeout(() => {
            reviewWrapper.classList.add('loaded');
        }, 10);

        setTimeout(() => {
            window.scrollTo(0, document.body.scrollHeight);
        }, 50);
    }

    function handleGuess() {
        console.log("[handleGuess] Function called.");
        if (isGameOver || guessInput.disabled) {
            console.log("[handleGuess] Condition met to ignore guess (game over or input disabled).");
            return;
        }

        const guessedTitle = guessInput.value.trim();
        console.log(`[handleGuess] Guessed title (raw): "${guessInput.value}", Trimmed: "${guessedTitle}"`);

        if (!guessedTitle) {
            alert("Please enter a game title to guess.");
            console.log("[handleGuess] No title entered.");
            return;
        }

        if (!currentGame || !currentGame.title) {
            console.error("[handleGuess_ERROR] Critical error: currentGame or currentGame.title is not defined!");
            alert("A critical error occurred: Game data is missing. Please refresh.");
            return;
        }
        console.log(`[handleGuess] Current game title for comparison: "${currentGame.title}"`);

        const normalizedGuessedTitle = normalizeString(guessedTitle);
        const normalizedCorrectTitle = normalizeString(currentGame.title);
        console.log(`[handleGuess] Normalized guess: "${normalizedGuessedTitle}", Normalized correct: "${normalizedCorrectTitle}"`);

        if (normalizedGuessedTitle === normalizedCorrectTitle) {
            console.log("[handleGuess] Correct guess!");
            shareGrid.push('\u{1f7e9}');
            endGame(true);
        } else {
            console.log("[handleGuess] Incorrect guess.");
            shareGrid.push('\u{1f7e5}'); // Using red square for incorrect, like Wordle
            guessesLeft--;
            guessesRemainingSpan.textContent = guessesLeft;

            const li = document.createElement('li');
            li.textContent = guessedTitle;
            previousGuessesList.appendChild(li);

            currentReviewIndex++;
            if (guessesLeft <= 0) {
                console.log("[handleGuess] Out of guesses. Ending game as loss.");
                endGame(false);
            } else if (currentReviewIndex < currentGame.reviews.length) {
                console.log("[handleGuess] Displaying next review clue.");
                displayNextReview();
            } else {
                console.warn("[handleGuess] Ran out of review clues but still have guesses. Ending game as loss.");
                endGame(false);
            }
        }
        guessInput.value = '';
        closeDropdown();
        guessInput.focus();
    }

    function endGame(didWin) {
        console.log(`[endGame] Game ended. Player ${didWin ? 'WON' : 'LOST'}.`);
        isGameOver = true;
        guessInput.disabled = true;
        guessButton.disabled = true;
        closeDropdown();

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

        // Reveal all clues
        reviewsContainer.innerHTML = '';

        currentGame.reviews.forEach((reviewData, index) => {

            const clueWrapper = document.createElement('div');
            clueWrapper.classList.add('review-item-wrapper', 'loaded');

            const clueNumberSpan = document.createElement('span');
            clueNumberSpan.classList.add('clue-number');
            clueNumberSpan.textContent = `Clue ${index + 1} of ${currentGame.reviews.length}:`;
            clueWrapper.appendChild(clueNumberSpan);

            const reviewCard = document.createElement('div');
            reviewCard.classList.add('steam-review-card');

            // Handle cases where reviewData might be an error object from the scraper
            if (reviewData.error) {
                reviewCard.innerHTML = `
                <p class="review-image-error">Oops! Could not load this review clue. '${reviewData.message}'</p>
                <p class="review-source-url-error">(Source: ${reviewData.originalUrl || 'N/A'})</p>
            `;
            } else {
                // Header: Avatar and Reviewer Name
                const reviewHeader = document.createElement('div');
                reviewHeader.classList.add('review-header');
                let headerHasContent = false;
                if (reviewData.reviewerAvatarUrl) {
                    const avatarImg = document.createElement('img');
                    avatarImg.src = reviewData.reviewerAvatarUrl;
                    avatarImg.alt = "Reviewer avatar";
                    avatarImg.classList.add('reviewer-avatar');
                    reviewHeader.appendChild(avatarImg);
                    headerHasContent = true;
                }
                const reviewerNameSpan = document.createElement('span');
                reviewerNameSpan.classList.add('reviewer-name');
                reviewerNameSpan.textContent = reviewData.reviewerName || "A Steam User";
                reviewHeader.appendChild(reviewerNameSpan);
                headerHasContent = true;

                if (headerHasContent) {
                    reviewCard.appendChild(reviewHeader);
                }

                // Recommendation Block
                const recommendationDiv = document.createElement('div');
                recommendationDiv.classList.add('review-recommendation');
                const isRecommended = reviewData.recommendation && reviewData.recommendation.toLowerCase() === 'recommended';
                const notRecommended = reviewData.recommendation && reviewData.recommendation.toLowerCase() === 'not recommended';
                if (isRecommended) recommendationDiv.classList.add('recommended');
                else if (notRecommended) recommendationDiv.classList.add('not-recommended');

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
                if (detailsDiv.hasChildNodes()) recommendationDiv.appendChild(detailsDiv);
                if (recommendationDiv.hasChildNodes()) reviewCard.appendChild(recommendationDiv);

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
            }
            clueWrapper.appendChild(reviewCard);
            reviewsContainer.appendChild(clueWrapper);
        });
        // End reveal logic


        if (didWin) {
            winLoseText.textContent = "Congratulations! You guessed it!";
            gameOverMessageDiv.classList.add('win');
        } else {
            winLoseText.textContent = "Game Over! Better luck next time.";
            gameOverMessageDiv.classList.add('lose');
        }
        shareButton.classList.remove('hidden');
        function scrollToPageBottom() {
            window.scrollTo(0, document.body.scrollHeight);
            console.log("[endGame] Scrolled page to bottom after answer reveal.");
        }
        setTimeout(scrollToPageBottom, 100);
    }

    function generateShareText() {
        let puzzleIdentifier = "Daily";
        // If you implement a puzzle ID system from backend, use it here:
        // puzzleIdentifier = currentGame.puzzleId || "Daily";

        const title = `Steamdle #${puzzleIdentifier} ${shareGrid.length}/${currentGame.reviews.length}`;
        const gridVisual = shareGrid.join('');
        // You'll need to host this game somewhere for the URL to be useful
        const gameUrl = window.location.origin; // Gets base URL like http://localhost:3000

        return `${title}\n${gridVisual}\nPlay Steamdle: ${gameUrl}`;
    }

    // --- Event Listeners ---
    guessButton.addEventListener('click', handleGuess);

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
            }).catch(err => {
                console.warn("Share API failed, falling back to clipboard:", err);
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(textToShare).then(() => alert("Results copied to clipboard!"))
                        .catch(clipErr => console.error('Failed to copy to clipboard: ', clipErr));
                }
            });
        } else if (navigator.clipboard) {
            navigator.clipboard.writeText(textToShare).then(() => {
                alert("Results copied to clipboard!");
            }).catch(err => {
                console.error('Failed to copy results to clipboard: ', err);
                alert("Could not copy results. Please copy manually.");
            });
        } else {
             alert("Sharing not supported on this browser. Results:\n\n" + textToShare);
        }
    });

    // --- Initialize Game ---
    initGame();
});
