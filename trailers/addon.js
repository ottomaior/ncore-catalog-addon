const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { getHungarianTrailerStreams, isProviderAvailable } = require('./trailer-provider');

const builder = new addonBuilder(manifest);

// Each lookup costs several TMDB calls and YouTube HTML scrapes, so results are cached in memory.
const TRAILER_CACHE_TTL_MS = 12 * 60 * 60 * 1000;   // found trailers
const TRAILER_EMPTY_TTL_MS = 60 * 60 * 1000;        // "nothing found" (retry sooner)
const TRAILER_CACHE_MAX = 2000;
const trailerCache = new Map();                      // key -> { streams, at }
const inFlight = new Map();                          // key -> Promise (dedupe concurrent requests)

function cacheGet(key) {
    const hit = trailerCache.get(key);
    if (!hit) return null;
    const ttl = hit.streams.length ? TRAILER_CACHE_TTL_MS : TRAILER_EMPTY_TTL_MS;
    if (Date.now() - hit.at > ttl) {
        trailerCache.delete(key);
        return null;
    }
    return hit.streams;
}

function cacheSet(key, streams) {
    if (trailerCache.size >= TRAILER_CACHE_MAX) {
        const oldest = trailerCache.keys().next().value;
        if (oldest !== undefined) trailerCache.delete(oldest);
    }
    trailerCache.set(key, { streams, at: Date.now() });
}

/** Parse a Stremio id into { imdbId, tmdbId, season, episode } or null. */
function parseId(id) {
    const parts = String(id).split(':');
    const num = (s) => (s === undefined ? undefined : parseInt(s, 10));
    if (id.startsWith('tmdb:')) {
        return { imdbId: null, tmdbId: num(parts[1]), season: num(parts[2]), episode: num(parts[3]) };
    }
    if (id.startsWith('tt')) {
        return { imdbId: parts[0], tmdbId: null, season: num(parts[1]), episode: num(parts[2]) };
    }
    if (/^\d+/.test(id)) {
        return { imdbId: null, tmdbId: num(parts[0]), season: num(parts[1]), episode: num(parts[2]) };
    }
    return null;
}

builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`[Magyar Előzetesek] Request: ${type} - ${id}`);

    if (!isProviderAvailable()) {
        console.warn('[Magyar Előzetesek] TMDB not configured');
        return { streams: [] };
    }

    const parsed = parseId(id || '');
    if (!parsed) return { streams: [] };

    const kind = type === 'series' ? 'series' : 'movie';
    // Trailers are per title (and per season for series), not per episode.
    const cacheKey = `${kind}:${parsed.imdbId || `tmdb${parsed.tmdbId}`}:${kind === 'series' && parsed.season ? parsed.season : ''}`;

    const cached = cacheGet(cacheKey);
    if (cached) {
        console.log(`[Magyar Előzetesek] Cache hit: ${cached.length} stream(s)`);
        return { streams: cached, cacheMaxAge: 6 * 60 * 60 };
    }

    if (!inFlight.has(cacheKey)) {
        const p = getHungarianTrailerStreams(kind, parsed.imdbId, parsed.season, parsed.tmdbId)
            .then((streams) => {
                cacheSet(cacheKey, streams);
                return streams;
            })
            .finally(() => inFlight.delete(cacheKey));
        inFlight.set(cacheKey, p);
    }

    try {
        const streams = await inFlight.get(cacheKey);
        console.log(`[Magyar Előzetesek] Returning ${streams.length} stream(s)`);
        return { streams, cacheMaxAge: 6 * 60 * 60 };
    } catch (error) {
        console.error('[Magyar Előzetesek] Error:', error);
        return { streams: [] };
    }
});

module.exports = builder.getInterface();
module.exports.parseId = parseId;
