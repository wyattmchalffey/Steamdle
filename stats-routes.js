const express = require('express');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { renderLogin, renderStats } = require('./admin-stats');
const owner = require('./stats-owner.json');

const COOKIE = 'steamdle_stats_session';
const SESSION_MS = 7 * 86400000;
const sha256 = value => createHash('sha256').update(value).digest();

function sameSiteWrite(req, res, next) {
    const origin = req.get('Origin');
    try {
        if (req.get('Sec-Fetch-Site') === 'cross-site' ||
            (origin && new URL(origin).host !== req.get('Host'))) return res.sendStatus(403);
    } catch {
        return res.sendStatus(403);
    }
    next();
}

// A coarse, per-process ceiling bounds public write traffic without retaining addresses.
function writeLimit(max) {
    let until = 0;
    let count = 0;
    return (req, res, next) => {
        const now = Date.now();
        if (now >= until) {
            until = now + 60000;
            count = 0;
        }
        if (++count > max) return res.set('Retry-After', String(Math.ceil((until - now) / 1000))).sendStatus(429);
        next();
    };
}

function createStatsRoutes(analytics, env = process.env) {
    const router = express.Router();
    const sessions = new Map();
    // The repository holds only a verifier for the owner's random 256-bit key.
    // Other deployments must supply their own key. A Render environment key overrides it for rotation.
    let expected;
    if (env.STEAMDLE_STATS_KEY) {
        if (env.STEAMDLE_STATS_KEY.length >= 32) expected = sha256(env.STEAMDLE_STATS_KEY);
    } else if (env.RENDER_EXTERNAL_HOSTNAME === owner.renderHost) {
        expected = Buffer.from(owner.keySha256, 'hex');
    }
    const cookieOptions = {
        path: '/stats', httpOnly: true, secure: env.NODE_ENV === 'production' || env.RENDER === 'true', sameSite: 'strict'
    };

    function sessionId(req) {
        const pair = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
        return pair?.slice(COOKIE.length + 1);
    }

    function ownerSignedIn(req) {
        return sessions.get(sessionId(req)) > Date.now();
    }

    function reportDays(value) {
        const days = Number(value);
        return [1, 7, 30].includes(days) ? days : 7;
    }

    router.use('/stats', (req, res, next) => {
        res.set({
            'Cache-Control': 'private, no-store',
            'X-Robots-Tag': 'noindex, nofollow',
            'Referrer-Policy': 'same-origin',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff'
        });
        next();
    });

    router.get('/stats', async (req, res) => {
        if (!ownerSignedIn(req)) return res.send(renderLogin());
        const days = reportDays(req.query.days);
        try {
            const report = await analytics.summary(days);
            res.send(renderStats(report, req.query.campaign));
        } catch (err) {
            console.error('[ANALYTICS] Could not read report:', err.message);
            res.status(503).send('Player stats are temporarily unavailable. Please retry.');
        }
    });
    router.post('/stats/login', sameSiteWrite, writeLimit(120),
        express.urlencoded({ extended: false, limit: '2kb', parameterLimit: 1 }), (req, res) => {
            if (!expected) return res.status(503).send(renderLogin('Owner access is not configured on this deployment.'));
            const key = req.body?.key;
            if (typeof key !== 'string' || !timingSafeEqual(sha256(key), expected)) {
                return res.status(401).send(renderLogin('That key did not match. Please try again.'));
            }
            const now = Date.now();
            for (const [id, expiry] of sessions) if (expiry <= now) sessions.delete(id);
            if (sessions.size >= 16) sessions.delete(sessions.keys().next().value);
            const id = randomBytes(32).toString('hex');
            sessions.set(id, now + SESSION_MS);
            res.cookie(COOKIE, id, { ...cookieOptions, maxAge: SESSION_MS }).redirect(303, '/stats');
        });
    router.post('/stats/logout', sameSiteWrite, (req, res) => {
        sessions.delete(sessionId(req));
        res.clearCookie(COOKIE, cookieOptions).redirect(303, '/stats');
    });
    router.post('/stats/campaign', sameSiteWrite,
        (req, res, next) => ownerSignedIn(req) ? next() : res.status(401).send(renderLogin()),
        express.urlencoded({ extended: false, limit: '2kb', parameterLimit: 2 }), async (req, res) => {
            const campaign = req.body?.campaign;
            const days = reportDays(req.body?.days);
            try {
                if (await analytics.addCampaign(campaign)) {
                    return res.redirect(303, `/stats?days=${days}&campaign=${encodeURIComponent(campaign)}#outreach`);
                }
                const message = 'Use a name up to 40 characters with lowercase letters, numbers and single hyphens. Up to 64 names can be saved.';
                res.status(400).send(renderStats(await analytics.summary(days), '', message));
            } catch (err) {
                console.error('[ANALYTICS] Could not save campaign:', err.message);
                res.status(503).send('Could not save this campaign. Please retry.');
            }
        });

    router.post('/api/analytics', sameSiteWrite, writeLimit(6000), (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (req.get('DNT') === '1' || req.get('Sec-GPC') === '1') return res.sendStatus(204);
        if (!req.is('application/json')) return res.sendStatus(415);
        next();
    }, express.json({limit: '1kb'}), async (req, res) => {
        try {
            res.sendStatus(await analytics.record(req.body) ? 204 : 400);
        } catch (err) {
            console.error('[ANALYTICS] Could not save turn:', err.message);
            res.sendStatus(503);
        }
    });
    // Never echo or log a malformed request body (including an owner key).
    router.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        res.sendStatus(err.status === 413 ? 413 : 400);
    });
    return router;
}

module.exports = { createStatsRoutes };
