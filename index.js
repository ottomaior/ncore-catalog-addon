const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'config', 'config.env'), quiet: true });

const pkg = require('./package.json');
const data = require('./lib/catalog-data');

// TMDB API configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// HTTP cache hints (seconds) sent with responses; stremio-addon-sdk turns them into Cache-Control.
const CATALOG_CACHE_MAX_AGE = 60 * 60;          // 1 h – data files change every 3–6 h
const CATALOG_STALE_REVALIDATE = 6 * 60 * 60;   // serve stale for up to 6 h while revalidating
const CATALOG_STALE_ERROR = 24 * 60 * 60;       // serve stale for a day if the server errors
const META_CACHE_MAX_AGE = 6 * 60 * 60;         // 6 h
const SEARCH_CACHE_MAX_AGE = 15 * 60;           // 15 min

const CATALOG_PAGE_SIZE = 100;
const SEARCH_LIMIT = 50;

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
            // Drop the oldest entry (Map preserves insertion order).
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) this.map.delete(oldest);
        }
        this.map.set(key, { value, at: Date.now() });
    }
}

const BACKDROP_CACHE = new TtlCache(24 * 60 * 60 * 1000);       // imdbId:type -> url | null
const SERIES_VIDEOS_CACHE = new TtlCache(24 * 60 * 60 * 1000);  // imdbId -> videos[] | null

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
        // fall through with null (cached briefly below so a flaky TMDB doesn't hammer us)
    }
    BACKDROP_CACHE.set(cacheKey, url);
    return url;
}

/** Episode list (videos) for a series from TMDB so Stremio shows the season/episode picker. */
async function getSeriesVideosFromTMDB(imdbId) {
    if (!TMDB_API_KEY || !imdbId) return null;
    const idNorm = String(imdbId).trim();
    const cached = SERIES_VIDEOS_CACHE.get(idNorm);
    if (cached !== undefined) return cached;
    let videos = null;
    try {
        const tmdbId = await findTmdbId(idNorm, 'tv');
        if (tmdbId) {
            const tv = await tmdbGet(`/tv/${tmdbId}`, { language: 'hu-HU' });
            const numSeasons = Math.max(0, parseInt(tv.number_of_seasons, 10) || 0);
            videos = [];
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
        }
    } catch (err) {
        videos = null;
    }
    SERIES_VIDEOS_CACHE.set(idNorm, videos);
    return videos;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const manifest = {
    id: 'com.ncore.hungarian.addon',
    version: pkg.version,
    name: 'nCore Katalógus',
    description: 'Magyar nyelvű filmek és sorozatok nCore-ról – katalógusok: Top Seed, Top letöltés, Trending, Legfrissebb, Streaming, keresés.',
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

function catalogMetas(list, skip = 0, limit = CATALOG_PAGE_SIZE) {
    return list.slice(skip, skip + limit).map(m => ensureBackground(withCoercedImdbRating(m)));
}

// ---------------------------------------------------------------------------
// Catalog handler
// ---------------------------------------------------------------------------
builder.defineCatalogHandler(async (args) => {
    console.log(`Katalógus kérés: ${args.type}/${args.id}`);
    const def = data.getCatalogDef(args.id);
    if (!def || def.type !== args.type) return { metas: [] };

    if (def.search) {
        const query = args.extra && args.extra.search;
        const metas = catalogMetas(data.searchMetas(def.type, query, SEARCH_LIMIT), 0, SEARCH_LIMIT);
        return { metas, cacheMaxAge: SEARCH_CACHE_MAX_AGE };
    }

    let list = data.getCatalogList(def);
    if (def.genre && args.extra && args.extra.genre) list = data.filterMetasByGenre(list, args.extra.genre);
    const skip = parseInt(args.extra && args.extra.skip, 10) || 0;
    return {
        metas: catalogMetas(list, skip, CATALOG_PAGE_SIZE),
        cacheMaxAge: CATALOG_CACHE_MAX_AGE,
        staleRevalidate: CATALOG_STALE_REVALIDATE,
        staleError: CATALOG_STALE_ERROR
    };
});

// ---------------------------------------------------------------------------
// Meta handler (all catalogs, so the detail view keeps our Hungarian metadata)
// ---------------------------------------------------------------------------
builder.defineMetaHandler(async (args) => {
    const requestId = args.id && String(args.id).trim();
    console.log(`Meta kérés: ${args.type}/${requestId}`);
    if (!requestId) return { meta: null };

    try {
        // Ids can be tt12345 or tt12345:1:1; look up by the series/movie part.
        const idForLookup = requestId.split(':')[0];
        const found = data.findMetaById(args.type, idForLookup);
        if (!found) {
            console.log(`Meta nem található katalógusban: ${args.type}/${requestId}`);
            return { meta: null, cacheMaxAge: 60 * 60 };
        }

        if (args.type === 'movie') {
            let meta = withCoercedImdbRating({ ...found, id: requestId });
            const tmdbBackdrop = await getBackdropFromTMDB(idForLookup, 'movie');
            meta = tmdbBackdrop ? { ...meta, background: tmdbBackdrop } : ensureBackground(meta);
            return { meta, cacheMaxAge: META_CACHE_MAX_AGE };
        }

        const sid = found.id || found.imdb_id;
        if (!sid) {
            console.log(`Series meta: nincs id, kihagyva: ${requestId}`);
            return { meta: null };
        }
        const [tmdbBackdrop, tmdbVideos] = await Promise.all([
            getBackdropFromTMDB(idForLookup, 'series'),
            (found.videos && found.videos.length) ? Promise.resolve(found.videos) : getSeriesVideosFromTMDB(sid)
        ]);
        const meta = {
            id: requestId,
            type: 'series',
            name: found.name || '',
            poster: found.poster || '',
            posterShape: found.posterShape || 'poster',
            year: found.year,
            description: found.description || '',
            imdbRating: coerceImdbRatingValue(found.imdbRating),
            releaseInfo: found.releaseInfo,
            genres: Array.isArray(found.genres) ? found.genres : [],
            background: tmdbBackdrop || ensureBackground(found).background || '',
            videos: Array.isArray(tmdbVideos) && tmdbVideos.length > 0 ? tmdbVideos : []
        };
        console.log(`Series meta küldve: ${meta.name} (${requestId})`);
        return { meta, cacheMaxAge: META_CACHE_MAX_AGE };
    } catch (err) {
        console.error('Meta handler hiba:', err.message);
    }
    return { meta: null };
});

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

/**
 * Manifest with only the given catalog ids, in the given order (configure-before-install).
 * Search catalogs are always kept so Stremio search keeps working.
 */
function getManifestForCatalogs(enabledIds) {
    if (!enabledIds || !Array.isArray(enabledIds) || enabledIds.length === 0) return manifest;
    const catalogMap = new Map(manifest.catalogs.map(c => [c.id, c]));
    const ids = enabledIds.map(id => String(id).trim()).filter(Boolean);
    const catalogs = ids.map(id => catalogMap.get(id)).filter(Boolean);
    const chosen = new Set(catalogs.map(c => c.id));
    for (const c of manifest.catalogs) {
        const def = data.getCatalogDef(c.id);
        if (def && def.search && !chosen.has(c.id)) catalogs.push(c);
    }
    return { ...manifest, catalogs };
}

/** { id, name, type } for each board catalog (configure UI). Search catalogs are implicit. */
function getCatalogOptions() {
    return manifest.catalogs
        .filter(c => !(data.getCatalogDef(c.id) || {}).search)
        .map(c => ({ id: c.id, name: c.name, type: c.type }));
}

module.exports = builder;
module.exports.getManifestForCatalogs = getManifestForCatalogs;
module.exports.getCatalogOptions = getCatalogOptions;
module.exports.manifest = manifest;

// Standalone mode for local testing: `node index.js` serves only the catalog addon.
if (require.main === module) {
    const { serveHTTP } = require('stremio-addon-sdk');
    const PORT = process.env.PORT || 7000;
    serveHTTP(builder.getInterface(), { port: PORT });
    console.log(`nCore Katalógus (standalone): http://localhost:${PORT}/manifest.json`);
}
