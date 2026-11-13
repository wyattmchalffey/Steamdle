const { utcDay } = require('./daily-puzzles');

// Only today's published puzzle can resolve artwork. The date also separates
// browser caches across the midnight rollover without changing puzzle snapshots.
function createArtworkHandler({ dailyPuzzles, artwork, now = () => new Date() }) {
    return async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const day = utcDay(now());
        if (req.query.date !== day) return res.status(404).end();
        try {
            const game = await dailyPuzzles.forDay(day);
            const image = game && await artwork.get(game.appId);
            if (!image) return res.set('Retry-After', '30').status(503).end();
            return res.set({
                'Content-Type': image.contentType,
                'Cache-Control': 'public, max-age=300',
                'X-Content-Type-Options': 'nosniff'
            }).send(image.body);
        } catch {
            return res.set('Retry-After', '30').status(503).end();
        }
    };
}

module.exports = { createArtworkHandler };
