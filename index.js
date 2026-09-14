const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const path = require('path');
const querystring = require('querystring');
require('dotenv').config({ path: path.join(__dirname, 'config', 'config.env'), quiet: true });

const pkg = require('./package.json');
const data = require('./lib/catalog-data');
const addonConfig = require('./lib/addon-config');

// TMDB API configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const META_CACHE = { cacheMaxAge: 6 * 60 * 60, staleRevalidate: 24 * 60 * 60, staleError: 7 * 24 * 60 * 60 };
const CATALOG_PAGE_SIZE = 100;
const SEARCH_LIMIT = 50;

/** Public base URL of this deployment (for Discover deep links). */
function getBaseUrl() {
    if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
    if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    return `http://localhost:${process.env.PORT || 7000}`;
}

// ---------------------------------------------------------------------------
// Small in-memory TTL cache (used for TMDB lookups)
// ---------------------------------------------------------------------------
class TtlCache {
    constructor(ttlMs, maxEntries = 5000) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.map = new Map();
    }
    get(key) {
        const hit = this.map.get(key);
        if (!hit) return undefined;
        if (Date.now() - hit.at > this.ttlMs) {
            this.map.delete(key);
            return undefined;
        }
        return hit.value;
    }
    set(key, value) {
        if (this.map.size >= this.maxEntries) {
            const oldest = this.map.keys().next().value; // Map preserves insertion order
            if (oldest !== undefined) this.map.delete(oldest);
        }
        this.map.set(key, { value, at: Date.now() });
    }
}

const BACKDROP_CACHE = new TtlCache(24 * 60 * 60 * 1000);      // imdbId:type -> url | null
const SERIES_TMDB_CACHE = new TtlCache(24 * 60 * 60 * 1000);   // imdbId -> { videos, releaseInfo } | null

// ---------------------------------------------------------------------------
// TMDB helpers
// ---------------------------------------------------------------------------
async function tmdbGet(url, params) {
    const res = await axios.get(`${TMDB_BASE_URL}${url}`, {
        params: { api_key: TMDB_API_KEY, ...params },
        timeout: 10000
    });
    return res.data;
}

/** TMDB id for an IMDb id (movie or tv), or null. */
async function findTmdbId(imdbId, tmdbType) {
    const found = await tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
    const results = tmdbType === 'tv' ? found.tv_results : found.movie_results;
    return results && results.length ? results[0].id : null;
}

/** Best-voted widescreen backdrop from TMDB for meta.background (cached, negative results too). */
async function getBackdropFromTMDB(imdbId, type = 'movie') {
    if (!TMDB_API_KEY || !imdbId) return null;
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const cacheKey = `${imdbId}:${tmdbType}`;
    const cached = BACKDROP_CACHE.get(cacheKey);
    if (cached !== undefined) return cached;
    let url = null;
    try {
        const tmdbId = await findTmdbId(imdbId, tmdbType);
        if (tmdbId) {
            const images = await tmdbGet(`/${tmdbType}/${tmdbId}/images`, {});
            const backdrops = images.backdrops || [];
            const best = backdrops.length
                ? backdrops.slice().sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0]
                : null;
            if (best && best.file_path) url = `https://image.tmdb.org/t/p/w1280${best.file_path}`;
        }
    } catch (err) {
        // cache the miss too, so a flaky TMDB doesn't get hammered
    }
    BACKDROP_CACHE.set(cacheKey, url);
    return url;
}

/** "2019-" for a running show, "2019-2023" for an ended one (Stremio's releaseInfo convention). */
function seriesReleaseInfo(tv) {
    const first = (tv.first_air_date || '').slice(0, 4);
    if (!/^\d{4}$/.test(first)) return undefined;
    const ended = /ended|canceled|cancelled/i.test(tv.status || '');
    const last = (tv.last_air_date || '').slice(0, 4);
    if (ended && /^\d{4}$/.test(last)) return last === first ? first : `${first}-${last}`;
    return `${first}-`;
}

/** Episode list (videos) + releaseInfo for a series from TMDB (cached). */
async function getSeriesFromTMDB(imdbId) {
    if (!TMDB_API_KEY || !imdbId) return null;
    const idNorm = String(imdbId).trim();
    const cached = SERIES_TMDB_CACHE.get(idNorm);
    if (cached !== undefined) return cached;
    let result = null;
    try {
        const tmdbId = await findTmdbId(idNorm, 'tv');
        if (tmdbId) {
            const tv = await tmdbGet(`/tv/${tmdbId}`, { language: 'hu-HU' });
            const numSeasons = Math.max(0, parseInt(tv.number_of_seasons, 10) || 0);
            const videos = [];
            for (let s = 1; s <= numSeasons; s++) {
                const season = await tmdbGet(`/tv/${tmdbId}/season/${s}`, { language: 'hu-HU' });
                for (const ep of season.episodes || []) {
                    const epNum = parseInt(ep.episode_number, 10);
                    if (!Number.isFinite(epNum)) continue;
                    videos.push({
                        id: `${idNorm}:${s}:${epNum}`,
                        title: ep.name || `Episode ${epNum}`,
                        season: s,
                        episode: epNum,
                        released: ep.air_date || undefined
                    });
                }
            }
            result = { videos, releaseInfo: seriesReleaseInfo(tv) };
        }
    } catch (err) {
        result = null;
    }
    SERIES_TMDB_CACHE.set(idNorm, result);
    return result;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const manifest = {
    id: 'com.ncore.hungarian.addon',
    version: pkg.version,
    name: 'nCore Katalógus',
    description: 'Magyar filmek és sorozatok nCore-ról: Legfrissebb, Felkapott, Top Seed, streaming, keresés.',
    logo: 'https://ncore-catalog-addon-production.up.railway.app/logo.png',
    resources: [
        'catalog',
        { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }
    ],
    types: ['movie', 'series'],
    catalogs: data.buildManifestCatalogs(),
    idPrefixes: ['tt'],
    behaviorHints: { configurable: true }
};

/** Resolve raw token fields (or a legacy ?catalogs= list) against the registry defaults. */
function resolveConfig(raw) {
    return addonConfig.resolveConfig(raw, data.getCatalogOptions());
}

/** Manifest for a resolved user config (catalog subset/order, board visibility). */
function manifestForConfig(cfg) {
    if (!cfg || cfg.isDefault) return manifest;
    const catalogs = data.buildManifestCatalogs(cfg.home);
    const byId = new Map(catalogs.map(c => [c.id, c]));
    const chosen = cfg.enabled.map(id => byId.get(id)).filter(Boolean);
    // Search catalogs are always kept so Stremio search keeps working.
    for (const c of catalogs) {
        const def = data.getCatalogDef(c.id);
        if (def && def.search) chosen.push(c);
    }
    return { ...manifest, catalogs: chosen };
}

/** Legacy: manifest with only the given catalog ids (?catalogs=a,b,c). */
function getManifestForCatalogs(enabledIds) {
    return manifestForConfig(resolveConfig(addonConfig.configFromCatalogsParam((enabledIds || []).join(','))));
}

const builder = new addonBuilder(manifest);

// ---------------------------------------------------------------------------
// Meta shaping helpers
// ---------------------------------------------------------------------------
// OMDb / some JSON builds store imdbRating as a string; strict clients expect a number.
function coerceImdbRatingValue(r) {
    if (r == null || r === '') return undefined;
    if (typeof r === 'number' && Number.isFinite(r)) return r;
    if (typeof r === 'string') {
        const n = parseFloat(r);
        if (Number.isFinite(n)) return n;
    }
    return undefined;
}

function withCoercedImdbRating(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    const n = coerceImdbRatingValue(meta.imdbRating);
    if (n === undefined && (meta.imdbRating === undefined || meta.imdbRating === null || meta.imdbRating === '')) {
        return meta;
    }
    if (n === undefined) {
        const { imdbRating: _drop, ...rest } = meta;
        return rest;
    }
    return { ...meta, imdbRating: n };
}

// Ensure meta has a background URL for the Stremio detail page / board hover preview.
function ensureBackground(meta) {
    if (!meta || meta.background) return meta;
    const id = meta.id && String(meta.id).trim();
    if (!id) return meta;
    return { ...meta, background: `https://images.metahub.space/background/medium/${id}/img` };
}

/** Strip build-time-only fields Stremio has no use for. */
function publicMeta(meta) {
    const { latest_season: _s, latest_episode: _e, imdb_id: _i, downloads: _d, ...rest } = meta;
    return rest;
}

function applyPoster(meta, cfg) {
    const url = cfg && cfg.rpdb ? addonConfig.rpdbPosterUrl(cfg.rpdb, meta.id) : null;
    return url ? { ...meta, poster: url } : meta;
}

function catalogMetas(list, skip, limit, cfg) {
    return list.slice(skip, skip + limit).map(m => applyPoster(ensureBackground(withCoercedImdbRating(publicMeta(m))), cfg));
}

/** Discover deep links (genres) + IMDb link, as the TMDB addon does. */
function buildLinks(meta, type) {
    const links = [];
    const manifestUrl = encodeURIComponent(`${getBaseUrl()}/manifest.json`);
    const catalogId = data.genreLinkCatalogId(type);
    for (const g of meta.genres || []) {
        links.push({ name: g, category: 'Genres', url: `stremio:///discover/${manifestUrl}/${type}/${catalogId}?genre=${encodeURIComponent(g)}` });
    }
    const id = String(meta.id || '').split(':')[0];
    if (/^tt\d+$/.test(id)) {
        const rating = coerceImdbRatingValue(meta.imdbRating);
        links.push({ name: rating != null ? String(rating) : 'IMDb', category: 'imdb', url: `https://imdb.com/title/${id}` });
    }
    return links;
}

// ---------------------------------------------------------------------------
// Catalog + meta logic (shared by the SDK handlers and the /c/:config routes)
// ---------------------------------------------------------------------------
function buildCatalogResponse(type, id, extra = {}, cfg = null) {
    const def = data.getCatalogDef(id);
    if (!def || def.type !== type) return { metas: [] };
    const cache = data.CACHE_PROFILES[def.cache] || data.CACHE_PROFILES.derived;

    if (def.search) {
        const metas = catalogMetas(data.searchMetas(def.type, extra.search, SEARCH_LIMIT), 0, SEARCH_LIMIT, cfg);
        return { metas, ...cache };
    }

    let list = data.getCatalogList(def);
    if (extra.genre) {
        list = def.filter === 'year' ? data.filterMetasByYear(list, extra.genre) : data.filterMetasByGenre(list, extra.genre);
    }
    const skip = parseInt(extra.skip, 10) || 0;
    return { metas: catalogMetas(list, skip, CATALOG_PAGE_SIZE, cfg), ...cache };
}

async function buildMetaResponse(type, requestId, cfg = null) {
    requestId = requestId && String(requestId).trim();
    if (!requestId) return { meta: null };
    try {
        const idForLookup = requestId.split(':')[0]; // tt12345 or tt12345:1:1
        const found = data.findMetaById(type, idForLookup);
        if (!found) {
            console.log(`Meta nem található katalógusban: ${type}/${requestId}`);
            return { meta: null, cacheMaxAge: 60 * 60 };
        }

        if (type === 'movie') {
            let meta = withCoercedImdbRating({ ...publicMeta(found), id: requestId });
            const tmdbBackdrop = await getBackdropFromTMDB(idForLookup, 'movie');
            meta = tmdbBackdrop ? { ...meta, background: tmdbBackdrop } : ensureBackground(meta);
            meta.links = buildLinks(meta, 'movie');
            return { meta: applyPoster(meta, cfg), ...META_CACHE };
        }

        const sid = found.id || found.imdb_id;
        if (!sid) return { meta: null };
        const [tmdbBackdrop, tmdb] = await Promise.all([
            getBackdropFromTMDB(idForLookup, 'series'),
            getSeriesFromTMDB(sid)
        ]);
        const ownVideos = Array.isArray(found.videos) && found.videos.length ? found.videos : null;
        const videos = ownVideos || (tmdb && tmdb.videos) || [];
        const meta = {
            id: requestId,
            type: 'series',
            name: found.name || '',
            poster: found.poster || '',
            posterShape: found.posterShape || 'poster',
            year: found.year,
            description: found.description || '',
            imdbRating: coerceImdbRatingValue(found.imdbRating),
            releaseInfo: (tmdb && tmdb.releaseInfo) || found.releaseInfo,
            genres: Array.isArray(found.genres) ? found.genres : [],
            background: tmdbBackdrop || ensureBackground(found).background || '',
            videos
        };
        meta.links = buildLinks(meta, 'series');
        console.log(`Series meta küldve: ${meta.name} (${requestId})`);
        return { meta: applyPoster(meta, cfg), ...META_CACHE };
    } catch (err) {
        console.error('Meta handler hiba:', err.message);
    }
    return { meta: null };
}

builder.defineCatalogHandler(async (args) => {
    console.log(`Katalógus kérés: ${args.type}/${args.id}`);
    return buildCatalogResponse(args.type, args.id, args.extra || {});
});

builder.defineMetaHandler(async (args) => {
    console.log(`Meta kérés: ${args.type}/${args.id}`);
    return buildMetaResponse(args.type, args.id);
});

// ---------------------------------------------------------------------------
// Config-aware routes: /c/:config/{manifest.json | catalog/... | meta/...}
// Same handlers as above, but with the user's config (catalog subset, board
// visibility, RPDB posters) taken from the URL path.
// ---------------------------------------------------------------------------
function sendWithCache(res, payload) {
    const { cacheMaxAge, staleRevalidate, staleError, ...body } = payload;
    if (cacheMaxAge) {
        const parts = [`max-age=${cacheMaxAge}`];
        if (staleRevalidate) parts.push(`stale-while-revalidate=${staleRevalidate}`);
        if (staleError) parts.push(`stale-if-error=${staleError}`);
        parts.push('public');
        res.setHeader('Cache-Control', parts.join(', '));
    }
    res.json(body);
}

function createConfigRouter() {
    const router = express.Router({ mergeParams: true });
    const parseExtra = (raw) => (raw ? querystring.parse(raw) : {});

    router.get('/manifest.json', (req, res) => {
        const cfg = resolveConfig(addonConfig.decodeConfig(req.params.config));
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.json(manifestForConfig(cfg));
    });
    router.get(['/catalog/:type/:id.json', '/catalog/:type/:id/:extra.json'], (req, res) => {
        const cfg = resolveConfig(addonConfig.decodeConfig(req.params.config));
        console.log(`Katalógus kérés (config): ${req.params.type}/${req.params.id}`);
        sendWithCache(res, buildCatalogResponse(req.params.type, req.params.id, parseExtra(req.params.extra), cfg));
    });
    router.get('/meta/:type/:id.json', async (req, res) => {
        const cfg = resolveConfig(addonConfig.decodeConfig(req.params.config));
        console.log(`Meta kérés (config): ${req.params.type}/${req.params.id}`);
        sendWithCache(res, await buildMetaResponse(req.params.type, req.params.id, cfg));
    });
    return router;
}

// ---------------------------------------------------------------------------
// Exports (server.js)
// ---------------------------------------------------------------------------
/** Item counts per source, keyed the way public/index.html expects, plus data freshness. */
builder.getStats = () => {
    const counts = {
        hdMoviesCount: data.getSource('hd_movies').get().length,
        hdSeriesCount: data.getSource('hd_series').get().length,
        topSeededByGenreCount: data.getSource('most_seeded_movies').get().length,
        topSeededHungarianProductionsCount: data.getSource('most_seeded_hungarian_productions_movies').get().length,
        topSeededSeriesCount: data.getSource('most_seeded_series').get().length,
        topDownloaded1080MoviesCount: data.getSource('top_downloaded_1080_movies').get().length,
        topDownloaded1080SeriesCount: data.getSource('top_downloaded_1080_series').get().length,
        topSeededHungarianProductionsSeriesCount: data.getSource('most_seeded_hungarian_productions_series').get().length,
        netflixMoviesCount: data.getSource('netflix_movies').get().length,
        netflixSeriesCount: data.getSource('netflix_series').get().length,
        disneyplusMoviesCount: data.getSource('disneyplus_movies').get().length,
        disneyplusSeriesCount: data.getSource('disneyplus_series').get().length,
        hbomaxMoviesCount: data.getSource('hbomax_movies').get().length,
        hbomaxSeriesCount: data.getSource('hbomax_series').get().length,
        primeMoviesCount: data.getSource('prime_movies').get().length,
        primeSeriesCount: data.getSource('prime_series').get().length,
        trendingMoviesCount: data.getSource('trending_movies').get().length,
        trendingSeriesCount: data.getSource('trending_series').get().length
    };
    return { ...counts, data: data.getDataStatus() };
};

module.exports = builder;
module.exports.manifest = manifest;
module.exports.manifestForConfig = manifestForConfig;
module.exports.resolveConfig = resolveConfig;
module.exports.getManifestForCatalogs = getManifestForCatalogs;
module.exports.getCatalogOptions = data.getCatalogOptions;
module.exports.createConfigRouter = createConfigRouter;
module.exports.buildCatalogResponse = buildCatalogResponse;
module.exports.buildMetaResponse = buildMetaResponse;
module.exports.seriesReleaseInfo = seriesReleaseInfo;

// Standalone mode for local testing: `node index.js` serves only the catalog addon.
if (require.main === module) {
    const { serveHTTP } = require('stremio-addon-sdk');
    const PORT = process.env.PORT || 7000;
    serveHTTP(builder.getInterface(), { port: PORT });
    console.log(`nCore Katalógus (standalone): http://localhost:${PORT}/manifest.json`);
}
