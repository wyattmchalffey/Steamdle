document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
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
    const gameTitlesDatalist = document.getElementById('game-titles-list');

    // --- Game State ---
    let currentGame; // Will be fetched from backend { title, appId, reviews: [urls] }
    let currentReviewIndex;
    let guessesLeft;
    let isGameOver;
    let shareGrid = []; // For Wordle-like sharing results
    let autocompleteDebounceTimer;

    // --- Helper Functions ---
    function normalizeString(str) {
        if (typeof str !== 'string') return '';
        return str.toLowerCase().replace(/[^a-z0-9\s]/gi, '').replace(/\s+/g, ' ').trim();
    }

    // --- Autocomplete Logic ---
    async function fetchAutocompleteSuggestions(searchTerm) {
        if (searchTerm.length < 2) { // Don't search for very short terms
            gameTitlesDatalist.innerHTML = '';
            return;
        }
        try {
            const response = await fetch(`/api/search-steam-games?term=${encodeURIComponent(searchTerm)}&limit=10`);
            if (!response.ok) {
                console.error(`Autocomplete API request failed: ${response.status}`);
                gameTitlesDatalist.innerHTML = '<option value="Error loading suggestions"></option>';
                return;
            }
            const suggestions = await response.json();
            populateAutocompleteDatalist(suggestions);
        } catch (error) {
            console.error("Failed to fetch autocomplete suggestions from backend:", error);
            gameTitlesDatalist.innerHTML = '<option value="Suggestions unavailable"></option>';
        }
    }

    function populateAutocompleteDatalist(suggestionsArray) {
        gameTitlesDatalist.innerHTML = ''; // Clear previous options
        suggestionsArray.forEach(gameName => {
            const option = document.createElement('option');
            option.value = gameName;
            gameTitlesDatalist.appendChild(option);
        });
    }

    // --- Game Initialization & Flow ---
    async function fetchDailyGame() {
        try {
            const response = await fetch('/api/daily-game');
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: "Failed to fetch daily game data." })); // Catch if response isn't JSON
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
        if(loadingMessage) loadingMessage.classList.remove('hidden'); // Show loading message

        const gameLoaded = await fetchDailyGame();
        
        if(loadingMessage) loadingMessage.classList.add('hidden'); // Hide loading message

        if (!gameLoaded) {
            // Error message already displayed by fetchDailyGame
            return;
        }

        currentReviewIndex = 0;
        guessesLeft = 6;
        isGameOver = false;
        shareGrid = [];

        reviewsContainer.innerHTML = ''; // Clear any previous loading/error messages
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
        
        gameTitlesDatalist.innerHTML = ''; // Clear datalist initially
        
        displayNextReview();
        console.log("Frontend: Game initialized.");
    }

    function displayNextReview() {
        if (isGameOver || !currentGame || currentReviewIndex >= currentGame.reviews.length) {
            return; // Don't display if game over or no more reviews
        }

        const reviewImageUrl = currentGame.reviews[currentReviewIndex];
        console.log(`Frontend: Displaying review clue ${currentReviewIndex + 1}: ${reviewImageUrl}`);
        
        const reviewWrapper = document.createElement('div');
        reviewWrapper.classList.add('review-item-wrapper');

        const clueNumberSpan = document.createElement('span');
        clueNumberSpan.classList.add('clue-number');
        clueNumberSpan.textContent = `Clue ${currentReviewIndex + 1} of ${currentGame.reviews.length}:`;
        reviewWrapper.appendChild(clueNumberSpan);

        const img = document.createElement('img');
        img.src = reviewImageUrl; // This is the relative path like /images/reviews/image.png
        img.alt = `Steam Review Clue ${currentReviewIndex + 1}`;
        img.classList.add('review-screenshot');
        
        img.onload = () => {
            reviewWrapper.classList.add('loaded'); // Triggers fade-in/slide-in animation
        }
        img.onerror = () => {
            console.error(`Frontend: Failed to load review image: ${reviewImageUrl}`);
            img.alt = "Review image failed to load.";
            const errorText = document.createElement('p');
            errorText.textContent = "Sorry, this review image couldn't be loaded.";
            errorText.classList.add('review-image-error');
            reviewWrapper.appendChild(errorText); // Append error inside the wrapper instead of replacing image
            reviewWrapper.classList.add('loaded'); // Still show the wrapper
        }
        
        reviewWrapper.appendChild(img);
        reviewsContainer.appendChild(reviewWrapper);
        reviewsContainer.scrollTop = reviewsContainer.scrollHeight; // Auto-scroll to new review
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
            shareGrid.push('🟩');
            endGame(true);
        } else {
            console.log("[handleGuess] Incorrect guess.");
            shareGrid.push('🟥'); // Using red square for incorrect, like Wordle
            guessesLeft--;
            guessesRemainingSpan.textContent = guessesLeft;
            
            const li = document.createElement('li');
            li.textContent = guessedTitle; // Display the user's actual typed guess
            previousGuessesList.appendChild(li);
            
            currentReviewIndex++;
            if (guessesLeft <= 0) {
                console.log("[handleGuess] Out of guesses. Ending game as loss.");
                endGame(false);
            } else if (currentReviewIndex < currentGame.reviews.length) {
                console.log("[handleGuess] Displaying next review clue.");
                displayNextReview();
            } else {
                // This case (out of reviews but still guesses left) shouldn't happen if reviews.length is always 6
                console.warn("[handleGuess] Ran out of review clues but still have guesses. Ending game as loss.");
                endGame(false); 
            }
        }
        guessInput.value = ''; // Clear input after guess
        // gameTitlesDatalist.innerHTML = ''; // Optionally clear autocomplete suggestions
        guessInput.focus(); // Keep focus on input for next guess
    }

    function endGame(didWin) {
        console.log(`[endGame] Game ended. Player ${didWin ? 'WON' : 'LOST'}.`);
        isGameOver = true;
        guessInput.disabled = true;
        guessButton.disabled = true;

        gameOverMessageDiv.classList.remove('hidden');
        correctGameTitleSpan.textContent = currentGame.title;
        
        if (currentGame.appId) {
            steamLink.href = `https://store.steampowered.com/app/${currentGame.appId}/`;
            steamLink.classList.remove('hidden');
            // Game cover image from Steam CDN
            gameImage.src = `https://cdn.akamai.steamstatic.com/steam/apps/${currentGame.appId}/header.jpg`;
            gameImage.onload = () => gameImage.classList.remove('hidden');
            gameImage.onerror = () => {
                console.warn(`[endGame] Failed to load game cover for AppID ${currentGame.appId}`);
                gameImage.classList.add('hidden'); // Hide if image fails to load
            }
        } else {
            steamLink.classList.add('hidden');
            gameImage.classList.add('hidden');
        }

        if (didWin) {
            winLoseText.textContent = "Congratulations! You guessed it!";
            gameOverMessageDiv.classList.add('win');
            // Fill remaining share grid with grey if won early (optional Wordle style)
            // while(shareGrid.length < currentGame.reviews.length) shareGrid.push('⬜');
        } else {
            winLoseText.textContent = "Game Over! Better luck next time.";
            gameOverMessageDiv.classList.add('lose');
            // Reveal all review images if lost and not already shown
            reviewsContainer.innerHTML = ''; // Clear current for re-render
            currentGame.reviews.forEach((reviewImageUrl, index) => {
                 const reviewWrapper = document.createElement('div');
                 reviewWrapper.classList.add('review-item-wrapper', 'loaded'); // Mark as loaded immediately
                 const clueNumberSpan = document.createElement('span');
                 clueNumberSpan.classList.add('clue-number');
                 clueNumberSpan.textContent = `Clue ${index + 1}:`;
                 reviewWrapper.appendChild(clueNumberSpan);
                 const img = document.createElement('img');
                 img.src = reviewImageUrl;
                 img.alt = `Steam Review Clue ${index + 1} for ${currentGame.title}`;
                 img.classList.add('review-screenshot');
                 reviewWrapper.appendChild(img);
                 reviewsContainer.appendChild(reviewWrapper);
            });
        }
        shareButton.classList.remove('hidden');
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

    guessInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault(); // Prevent default form submission if it were in a form
            handleGuess();
        }
    });

    guessInput.addEventListener('input', () => {
        const searchTerm = guessInput.value;
        clearTimeout(autocompleteDebounceTimer);
        autocompleteDebounceTimer = setTimeout(() => {
            fetchAutocompleteSuggestions(searchTerm);
        }, 300); // Debounce API calls by 300ms
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