/**
 * Catalog data layer: one registry describing every JSON data source and every
 * Stremio catalog, plus TTL-cached loading, meta lookup index, genre handling,
 * derived catalogs and free-text search. index.js, info-addon.js and /health all
 * read from here.
 *
 * Data is read from data/*.json on disk. Optionally, when DATA_REMOTE_BASE_URL is
 * set (e.g. https://raw.githubusercontent.com/<owner>/<repo>/main/data), the
 * lists are refreshed from that URL in the background, so the server no longer
 * has to be redeployed every time a GitHub Action commits fresh JSON.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, '..', 'data');

const HOUR = 60 * 60 * 1000;
const TTL = {
    latest: 3 * HOUR,
    streaming: 6 * HOUR,
    trending: 6 * HOUR,
    topSeeded: 3 * 24 * HOUR
};

// HTTP cache profiles (seconds) per catalog family: max-age / stale-while-revalidate / stale-if-error
const CACHE_PROFILES = {
    latest: { cacheMaxAge: 60 * 60, staleRevalidate: 24 * 60 * 60, staleError: 7 * 24 * 60 * 60 },
    trending: { cacheMaxAge: 3 * 60 * 60, staleRevalidate: 24 * 60 * 60, staleError: 7 * 24 * 60 * 60 },
    topSeeded: { cacheMaxAge: 24 * 60 * 60, staleRevalidate: 24 * 60 * 60, staleError: 7 * 24 * 60 * 60 },
    derived: { cacheMaxAge: 6 * 60 * 60, staleRevalidate: 24 * 60 * 60, staleError: 7 * 24 * 60 * 60 },
    search: { cacheMaxAge: 15 * 60 }
};

// ---------------------------------------------------------------------------
// Data sources (one per JSON file)
// ---------------------------------------------------------------------------
const SOURCE_DEFS = [
    { key: 'hd_movies', type: 'movie', ttl: TTL.latest, label: 'legfrissebb HD film' },
    { key: 'hd_series', type: 'series', ttl: TTL.latest, label: 'legfrissebb HD sorozat' },
    { key: 'trending_movies', type: 'movie', ttl: TTL.trending, label: 'trendi film' },
    { key: 'trending_series', type: 'series', ttl: TTL.trending, label: 'trendi sorozat' },
    { key: 'most_seeded_movies', type: 'movie', ttl: TTL.topSeeded, label: 'legnagyobb seed film' },
    { key: 'most_seeded_series', type: 'series', ttl: TTL.topSeeded, label: 'legnagyobb seed sorozat' },
    { key: 'most_seeded_hungarian_productions_movies', type: 'movie', ttl: TTL.topSeeded, label: 'magyar film (Top Seed)' },
    { key: 'most_seeded_hungarian_productions_series', type: 'series', ttl: TTL.topSeeded, label: 'magyar sorozat (Top Seed)' },
    { key: 'top_downloaded_1080_movies', type: 'movie', ttl: TTL.topSeeded, label: 'top letöltött 1080p film' },
    { key: 'top_downloaded_1080_series', type: 'series', ttl: TTL.topSeeded, label: 'top letöltött 1080p sorozat' },
    { key: 'top_downloaded_1080_hungarian_productions_movies', type: 'movie', ttl: TTL.topSeeded, label: 'magyar film (Top letöltés)' },
    { key: 'top_downloaded_1080_hungarian_productions_series', type: 'series', ttl: TTL.topSeeded, label: 'magyar sorozat (Top letöltés)' },
    { key: 'netflix_movies', type: 'movie', ttl: TTL.streaming, label: 'Netflix film' },
    { key: 'netflix_series', type: 'series', ttl: TTL.streaming, label: 'Netflix sorozat' },
    { key: 'disneyplus_movies', type: 'movie', ttl: TTL.streaming, label: 'Disney+ film' },
    { key: 'disneyplus_series', type: 'series', ttl: TTL.streaming, label: 'Disney+ sorozat' },
    { key: 'hbomax_movies', type: 'movie', ttl: TTL.streaming, label: 'HBO Max film' },
    { key: 'hbomax_series', type: 'series', ttl: TTL.streaming, label: 'HBO Max sorozat' },
    { key: 'prime_movies', type: 'movie', ttl: TTL.streaming, label: 'Prime Video film' },
    { key: 'prime_series', type: 'series', ttl: TTL.streaming, label: 'Prime Video sorozat' }
];

// Order in which sources are consulted when resolving a meta request by id (and for search /
// derived catalogs). Larger, better-curated lists first.
const META_LOOKUP_ORDER = {
    movie: [
        'trending_movies', 'hd_movies', 'most_seeded_movies', 'top_downloaded_1080_movies',
        'top_downloaded_1080_hungarian_productions_movies', 'most_seeded_hungarian_productions_movies',
        'netflix_movies', 'disneyplus_movies', 'hbomax_movies', 'prime_movies'
    ],
    series: [
        'trending_series', 'hd_series', 'most_seeded_series', 'top_downloaded_1080_series',
        'top_downloaded_1080_hungarian_productions_series', 'most_seeded_hungarian_productions_series',
        'netflix_series', 'disneyplus_series', 'hbomax_series', 'prime_series'
    ]
};

// ---------------------------------------------------------------------------
// Genres: one Hungarian vocabulary. Data files mix TMDB hu-HU labels, TMDB English,
// adjective forms and TVDB combined labels; everything is normalized to `hu` on load.
// `series: false` = TVDB never returns this genre for series (hidden from series dropdowns).
// `option: false` = normalized but not offered as a filter.
// ---------------------------------------------------------------------------
const GENRES = [
    { slug: 'comedy', en: 'Comedy', hu: 'Vígjáték' },
    { slug: 'action', en: 'Action', hu: 'Akció' },
    { slug: 'war', en: 'War', hu: 'Háború', huAliases: ['Háborús'] },
    { slug: 'drama', en: 'Drama', hu: 'Dráma' },
    { slug: 'thriller', en: 'Thriller', hu: 'Thriller', series: false },
    { slug: 'horror', en: 'Horror', hu: 'Horror', series: false },
    { slug: 'romance', en: 'Romance', hu: 'Romantika', huAliases: ['Romantikus'], series: false },
    { slug: 'science-fiction', en: 'Science Fiction', hu: 'Sci-fi', enAliases: ['Sci-Fi'] },
    { slug: 'animation', en: 'Animation', hu: 'Animáció', huAliases: ['Animációs'] },
    { slug: 'crime', en: 'Crime', hu: 'Bűnügy', huAliases: ['Bűnügyi'] },
    { slug: 'documentary', en: 'Documentary', hu: 'Dokumentumfilm', huAliases: ['Dokumentum'] },
    { slug: 'adventure', en: 'Adventure', hu: 'Kaland' },
    { slug: 'fantasy', en: 'Fantasy', hu: 'Fantasy', huAliases: ['Fantasztikus'] },
    { slug: 'mystery', en: 'Mystery', hu: 'Rejtély', huAliases: ['Misztikus'] },
    { slug: 'family', en: 'Family', hu: 'Családi', huAliases: ['Család'], option: false },
    { slug: 'history', en: 'History', hu: 'Történelmi', huAliases: ['Történelem'], option: false },
    { slug: 'western', en: 'Western', hu: 'Western', option: false },
    { slug: 'music', en: 'Music', hu: 'Zene', huAliases: ['Zenés'], option: false },
    { slug: 'tv-movie', en: 'TV Movie', hu: 'Tévéfilm', option: false },
    { slug: 'reality', en: 'Reality', hu: 'Reality', option: false },
    { slug: 'talk', en: 'Talk', hu: 'Talk show', option: false },
    { slug: 'kids', en: 'Kids', hu: 'Gyerek', option: false },
    { slug: 'soap', en: 'Soap', hu: 'Szappanopera', option: false },
    { slug: 'news', en: 'News', hu: 'Hírek', option: false },
    { slug: 'politics', en: 'Politics', hu: 'Politika', option: false }
];

// TVDB / TMDB-tv combined labels → several canonical genres
const COMBINED_GENRES = {
    'action & adventure': ['action', 'adventure'],
    'sci-fi & fantasy': ['science-fiction', 'fantasy'],
    'war & politics': ['war', 'politics']
};

// Pseudo-options in the genre dropdown that sort/filter instead of matching a genre.
const CURRENT_YEAR = new Date().getFullYear();
const PSEUDO_FILTERS = [
    { key: 'top-rated', label: 'Legjobbra értékelt' },
    { key: 'this-year', label: `Idei (${CURRENT_YEAR})` }
];
const MIN_TOP_RATED = 7.5;
// The data carries no vote counts; ratings at or above this are low-vote artifacts (IMDb's all-time
// top sits at 9.3–9.5), so "top rated" lists ignore them.
const MAX_CREDIBLE_RATING = 9.6;

/** Rating usable for ranking: known, ≥ MIN_TOP_RATED and below the credibility cap. */
function credibleTopRating(meta) {
    const r = ratingOf(meta);
    return r !== null && r >= MIN_TOP_RATED && r < MAX_CREDIBLE_RATING ? r : null;
}

function normalizeGenreText(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

const GENRE_BY_SLUG = new Map(GENRES.map(g => [g.slug, g]));

// Any spelling → slug
const GENRE_SLUG_BY_INPUT = new Map();
for (const g of GENRES) {
    const inputs = [g.slug, g.slug.replace(/-/g, ' '), g.en, g.hu].concat(g.huAliases || []).concat(g.enAliases || []);
    for (const i of inputs) GENRE_SLUG_BY_INPUT.set(normalizeGenreText(i), g.slug);
}

// Pseudo-filter label / key → key
const PSEUDO_BY_INPUT = new Map();
for (const p of PSEUDO_FILTERS) {
    PSEUDO_BY_INPUT.set(normalizeGenreText(p.label), p.key);
    PSEUDO_BY_INPUT.set(p.key, p.key);
}
PSEUDO_BY_INPUT.set('legjobbra ertekelt', 'top-rated');
PSEUDO_BY_INPUT.set('top', 'top-rated');
PSEUDO_BY_INPUT.set('idei', 'this-year');

function genreToMatchString(g) {
    if (g == null) return '';
    if (typeof g === 'string') return g;
    if (typeof g === 'object' && typeof g.name === 'string') return g.name;
    return String(g);
}

/** Canonical Hungarian labels for a raw genres array (unknown labels are kept as-is). */
function normalizeGenres(genres) {
    if (!Array.isArray(genres)) return [];
    const out = [];
    for (const raw of genres) {
        const text = genreToMatchString(raw);
        const norm = normalizeGenreText(text);
        if (!norm) continue;
        const slugs = COMBINED_GENRES[norm] || (GENRE_SLUG_BY_INPUT.has(norm) ? [GENRE_SLUG_BY_INPUT.get(norm)] : null);
        const labels = slugs ? slugs.map(s => GENRE_BY_SLUG.get(s).hu) : [text.trim()];
        for (const l of labels) if (!out.includes(l)) out.push(l);
    }
    return out;
}

/**
 * Genre dropdown options shown in Stremio: pseudo-filters first, then Hungarian genre labels.
 * `compact` = pseudo-filters only (small or already genre-specific lists) – keeps the manifest
 * under the 8 KB limit of Stremio's addon collection API.
 */
function genreOptions(type, compact = false) {
    const pseudo = PSEUDO_FILTERS.map(p => p.label);
    if (compact) return pseudo;
    const genres = GENRES
        .filter(g => g.option !== false && (type !== 'series' || g.series !== false))
        .map(g => g.hu);
    return pseudo.concat(genres);
}

/**
 * Interpret the `genre` extra the client sent back:
 *   { pseudo: 'top-rated' | 'this-year' }  or  { slug: 'comedy' }  or  null
 */
function resolveGenreFilter(value) {
    if (value == null || value === '') return null;
    const norm = normalizeGenreText(value);
    if (PSEUDO_BY_INPUT.has(norm)) return { pseudo: PSEUDO_BY_INPUT.get(norm) };
    if (GENRE_SLUG_BY_INPUT.has(norm)) return { slug: GENRE_SLUG_BY_INPUT.get(norm) };
    const asSlug = norm.replace(/\s+/g, '-');
    if (GENRE_SLUG_BY_INPUT.has(asSlug)) return { slug: GENRE_SLUG_BY_INPUT.get(asSlug) };
    return { slug: asSlug };
}

/** Slug for whatever the client sent ("Vígjáték", "Comedy", "science-fiction"); null for pseudo-filters. */
function resolveGenreSlug(value) {
    const f = resolveGenreFilter(value);
    return f && f.slug ? f.slug : null;
}

function ratingOf(meta) {
    const r = meta && meta.imdbRating;
    const n = typeof r === 'number' ? r : parseFloat(r);
    return Number.isFinite(n) ? n : null;
}

function yearOf(meta) {
    const raw = meta && meta.year;
    const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}

/** Shared genre / pseudo-filter for any catalog (movies or series). */
function filterMetasByGenre(list, genreValue) {
    if (!list || !genreValue) return list || [];
    const f = resolveGenreFilter(genreValue);
    if (!f) return list;
    if (f.pseudo === 'top-rated') {
        return list
            .filter(m => credibleTopRating(m) !== null)
            .sort((a, b) => credibleTopRating(b) - credibleTopRating(a));
    }
    if (f.pseudo === 'this-year') return list.filter(m => yearOf(m) === CURRENT_YEAR);
    const genre = GENRE_BY_SLUG.get(f.slug);
    const wanted = genre ? genre.hu : f.slug;
    return list.filter(meta => Array.isArray(meta.genres) && meta.genres.includes(wanted));
}

/** Year filter for the "Megjelenés éve" catalog (genre options are years). */
function filterMetasByYear(list, yearValue) {
    const y = parseInt(yearValue, 10);
    if (!Number.isFinite(y)) return list || [];
    return (list || []).filter(m => yearOf(m) === y);
}

// ---------------------------------------------------------------------------
// Catalog registry (what the manifest advertises). Ids are stable: existing installs keep working.
//   board:   shown on Stremio's Board by default (false = Discover-only via a required genre extra)
//   filter:  'genre' (default), 'year' (options = years present in the data), none for search
//   compact: genre dropdown offers only the pseudo-filters (keeps the manifest under 8 KB)
//   cache:   CACHE_PROFILES key
//   derive:  DERIVED key – list computed from several sources instead of one file
// ---------------------------------------------------------------------------
const CATALOG_DEFS = [
    { id: 'ncore-hd-movies', type: 'movie', name: 'Legfrissebb', source: 'hd_movies', board: true, cache: 'latest' },
    { id: 'ncore-hd-series', type: 'series', name: 'Legfrissebb', source: 'hd_series', board: true, cache: 'latest' },
    { id: 'ncore-trending-movies', type: 'movie', name: 'Felkapott', source: 'trending_movies', board: true, cache: 'trending' },
    { id: 'ncore-trending-series', type: 'series', name: 'Felkapott', source: 'trending_series', board: true, cache: 'trending' },
    { id: 'ncore-movies-top-seeded-all', type: 'movie', name: 'Top Seed', source: 'most_seeded_movies', board: true, cache: 'topSeeded' },
    { id: 'ncore-series-top-seeded-all', type: 'series', name: 'Top Seed', source: 'most_seeded_series', board: true, cache: 'topSeeded' },
    { id: 'ncore-top-rated-movies', type: 'movie', name: 'Legjobbra értékelt', derive: 'topRated', board: true, cache: 'derived' },
    { id: 'ncore-top-rated-series', type: 'series', name: 'Legjobbra értékelt', derive: 'topRated', board: true, cache: 'derived' },
    { id: 'ncore-netflix-movies', type: 'movie', name: 'Netflix', source: 'netflix_movies', board: true, cache: 'latest', compact: true },
    { id: 'ncore-netflix-series', type: 'series', name: 'Netflix', source: 'netflix_series', board: true, cache: 'latest', compact: true },
    { id: 'ncore-hbomax-movies', type: 'movie', name: 'HBO Max', source: 'hbomax_movies', board: true, cache: 'latest', compact: true },
    { id: 'ncore-hbomax-series', type: 'series', name: 'HBO Max', source: 'hbomax_series', board: true, cache: 'latest', compact: true },
    { id: 'ncore-disneyplus-movies', type: 'movie', name: 'Disney+', source: 'disneyplus_movies', board: false, cache: 'latest', compact: true },
    { id: 'ncore-disneyplus-series', type: 'series', name: 'Disney+', source: 'disneyplus_series', board: false, cache: 'latest', compact: true },
    { id: 'ncore-prime-movies', type: 'movie', name: 'Prime Video', source: 'prime_movies', board: false, cache: 'latest', compact: true },
    { id: 'ncore-prime-series', type: 'series', name: 'Prime Video', source: 'prime_series', board: false, cache: 'latest', compact: true },
    { id: 'ncore-movies-top-seeded-magyar-filmek', type: 'movie', name: 'Top Seed · Magyar', source: 'most_seeded_hungarian_productions_movies', board: false, cache: 'topSeeded', compact: true },
    { id: 'ncore-series-top-seeded-magyar-sorozatok', type: 'series', name: 'Top Seed · Magyar', source: 'most_seeded_hungarian_productions_series', board: false, cache: 'topSeeded', compact: true },
    { id: 'ncore-top-downloaded-1080-movies', type: 'movie', name: 'Legtöbbet letöltött', source: 'top_downloaded_1080_movies', board: false, cache: 'topSeeded' },
    { id: 'ncore-top-downloaded-1080-series', type: 'series', name: 'Legtöbbet letöltött', source: 'top_downloaded_1080_series', board: false, cache: 'topSeeded' },
    { id: 'ncore-top-downloaded-1080-magyar-filmek', type: 'movie', name: 'Legtöbbet letöltött · Magyar', source: 'top_downloaded_1080_hungarian_productions_movies', board: false, cache: 'topSeeded', compact: true },
    { id: 'ncore-top-downloaded-1080-magyar-sorozatok', type: 'series', name: 'Legtöbbet letöltött · Magyar', source: 'top_downloaded_1080_hungarian_productions_series', board: false, cache: 'topSeeded', compact: true },
    { id: 'ncore-hd-movies-release-date', type: 'movie', name: 'Megjelenés éve', source: 'hd_movies', board: false, cache: 'latest', filter: 'year', sort: 'releaseYearDesc' },
    { id: 'ncore-hd-series-release-date', type: 'series', name: 'Megjelenés éve', source: 'hd_series', board: false, cache: 'latest', filter: 'year', sort: 'releaseYearDesc' },
    { id: 'ncore-documentaries-movies', type: 'movie', name: 'Dokumentumfilmek', derive: 'documentaries', board: false, cache: 'derived', compact: true },
    { id: 'ncore-classics-movies', type: 'movie', name: 'Klasszikusok', derive: 'classics', board: false, cache: 'derived', compact: true },
    { id: 'ncore-family-movies', type: 'movie', name: 'Családi', derive: 'family', board: false, cache: 'derived', compact: true },
    { id: 'ncore-family-series', type: 'series', name: 'Családi', derive: 'family', board: false, cache: 'derived', compact: true },
    // Search catalogs: only used by Stremio's search screen (search is required), never shown on the board.
    { id: 'ncore-search-movies', type: 'movie', name: 'nCore filmek', search: true, cache: 'search' },
    { id: 'ncore-search-series', type: 'series', name: 'nCore sorozatok', search: true, cache: 'search' }
];

// ---------------------------------------------------------------------------
// Loading + caching
// ---------------------------------------------------------------------------
function readJsonArray(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
}

const EPISODE_TAG = /\s*\(S(\d{1,2})E(\d{1,3})\)\s*$/i;

/**
 * Shape a raw meta on load: canonical Hungarian genres; series names without the
 * "(S03E02)" suffix (kept in latest_season / latest_episode; the description already
 * carries "Legújabb epizód: …").
 */
function normalizeMeta(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    const out = { ...meta, genres: normalizeGenres(meta.genres) };
    if (typeof out.name === 'string') {
        const m = EPISODE_TAG.exec(out.name);
        if (m) {
            out.name = out.name.replace(EPISODE_TAG, '').trim();
            if (out.latest_season == null) out.latest_season = parseInt(m[1], 10);
            if (out.latest_episode == null) out.latest_episode = parseInt(m[2], 10);
        }
    }
    return out;
}

/** Stable sort by year desc; items without a year go last in original order. */
function sortMetasByReleaseYearDesc(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map((item, idx) => ({ item, idx, year: yearOf(item) }))
        .sort((a, b) => {
            const af = a.year !== null;
            const bf = b.year !== null;
            if (af && bf && b.year !== a.year) return b.year - a.year;
            if (af && !bf) return -1;
            if (!af && bf) return 1;
            return a.idx - b.idx;
        })
        .map(x => x.item);
}

const SORTERS = { releaseYearDesc: sortMetasByReleaseYearDesc };

let dataVersion = 0; // bumped whenever any source's list changes (invalidates derived caches)

class DataSource {
    constructor(def) {
        this.key = def.key;
        this.type = def.type;
        this.ttl = def.ttl;
        this.label = def.label;
        this.file = path.join(DATA_DIR, `${def.key}.json`);
        this.list = [];
        this.loadedAt = null;     // last successful (re)load from disk or remote
        this.fileMtime = null;    // mtime of local file at last disk load
        this.origin = 'none';     // 'file' | 'remote' | 'none'
        this.etag = null;
        this.sorted = new Map();  // sortName -> { version, list }
    }

    /** Current list; reloads from disk when the TTL has expired. */
    get() {
        if (!this.loadedAt || Date.now() - this.loadedAt > this.ttl) this.loadFromFile();
        return this.list;
    }

    getSorted(sortName) {
        const list = this.get();
        const sorter = SORTERS[sortName];
        if (!sorter) return list;
        const cached = this.sorted.get(sortName);
        if (cached && cached.version === dataVersion) return cached.list;
        const sortedList = sorter(list);
        this.sorted.set(sortName, { version: dataVersion, list: sortedList });
        return sortedList;
    }

    setList(list, origin) {
        this.list = list.map(normalizeMeta);
        this.loadedAt = Date.now();
        this.origin = origin;
        dataVersion += 1;
        if (list.length) console.log(`✓ ${list.length} ${this.label} betöltve (${origin})`);
    }

    loadFromFile() {
        try {
            if (!fs.existsSync(this.file)) {
                this.loadedAt = Date.now();
                return;
            }
            const mtime = fs.statSync(this.file).mtimeMs;
            if (this.origin === 'remote' || (this.fileMtime === mtime && this.list.length)) {
                this.loadedAt = Date.now();
                return;
            }
            this.fileMtime = mtime;
            this.setList(readJsonArray(this.file), 'file');
        } catch (err) {
            console.error(`Hiba a ${path.basename(this.file)} betöltésekor:`, err.message);
            this.loadedAt = Date.now();
        }
    }

    /** Fetch the JSON from DATA_REMOTE_BASE_URL; uses ETag so unchanged files cost a 304. */
    async refreshFromRemote(baseUrl) {
        const url = `${baseUrl.replace(/\/$/, '')}/${this.key}.json`;
        const headers = this.etag ? { 'If-None-Match': this.etag } : {};
        const res = await axios.get(url, {
            headers,
            timeout: 30000,
            validateStatus: s => s === 200 || s === 304,
            maxContentLength: 50 * 1024 * 1024
        });
        if (res.status === 304) return false;
        if (!Array.isArray(res.data)) throw new Error('remote payload is not a JSON array');
        this.etag = res.headers && res.headers.etag ? res.headers.etag : null;
        this.setList(res.data, 'remote');
        return true;
    }

    info() {
        return {
            count: this.get().length,
            origin: this.origin,
            loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null,
            fileModifiedAt: this.fileMtime ? new Date(this.fileMtime).toISOString() : null
        };
    }
}

const SOURCES = new Map(SOURCE_DEFS.map(def => [def.key, new DataSource(def)]));
const CATALOGS = new Map(CATALOG_DEFS.map(def => [def.id, def]));

function getSource(key) {
    const src = SOURCES.get(key);
    if (!src) throw new Error(`Unknown data source: ${key}`);
    return src;
}

function getCatalogDef(id) {
    return CATALOGS.get(id) || null;
}

// ---------------------------------------------------------------------------
// Meta lookup index
// ---------------------------------------------------------------------------
/** Canonical IMDb id: tt + at least 7 digits, so tt175058 === tt0175058. */
function normalizeId(id) {
    if (!id || typeof id !== 'string') return '';
    const digits = String(id).trim().replace(/^tt/i, '').replace(/\D/g, '') || '0';
    return 'tt' + digits.padStart(7, '0');
}

function touchSources(type) {
    for (const key of META_LOOKUP_ORDER[type]) getSource(key).get();
}

/** All metas of a type across every source, deduplicated by id (lookup order = priority). */
const allMetasCache = { movie: { version: -1, list: [], map: new Map() }, series: { version: -1, list: [], map: new Map() } };

function allMetas(type) {
    const t = type === 'series' ? 'series' : 'movie';
    touchSources(t);
    const entry = allMetasCache[t];
    if (entry.version === dataVersion) return entry;
    const map = new Map();
    for (const key of META_LOOKUP_ORDER[t]) {
        for (const meta of getSource(key).get()) {
            const id = normalizeId(meta && (meta.id || meta.imdb_id) || '');
            if (id && !map.has(id)) map.set(id, meta);
        }
    }
    entry.map = map;
    entry.list = Array.from(map.values());
    entry.version = dataVersion;
    return entry;
}

/** Find a meta by IMDb id across all sources of a type (first source in lookup order wins). */
function findMetaById(type, id) {
    return allMetas(type).map.get(normalizeId(id)) || null;
}

// ---------------------------------------------------------------------------
// Derived catalogs (computed from the union of all sources of a type)
// ---------------------------------------------------------------------------
// Animation without any of these still counts as family-friendly (adult anime is filtered out).
const FAMILY_EXCLUDED = ['Horror', 'Thriller', 'Bűnügy', 'Háború', 'Dráma', 'Romantika'];

const DERIVED = {
    topRated: (list) => list
        .filter(m => credibleTopRating(m) !== null)
        .sort((a, b) => credibleTopRating(b) - credibleTopRating(a)),
    documentaries: (list) => list.filter(m => m.genres.includes('Dokumentumfilm')),
    classics: (list) => list
        .filter(m => yearOf(m) !== null && yearOf(m) < 2000 && (ratingOf(m) || 0) >= 7)
        .sort((a, b) => (ratingOf(b) || 0) - (ratingOf(a) || 0)),
    family: (list) => list.filter(m =>
        m.genres.includes('Családi')
        || (m.genres.includes('Animáció') && !FAMILY_EXCLUDED.some(g => m.genres.includes(g))))
};

const derivedCache = new Map(); // catalogId -> { version, list }

function getDerivedList(def) {
    const all = allMetas(def.type);
    const cached = derivedCache.get(def.id);
    if (cached && cached.version === all.version) return cached.list;
    const list = DERIVED[def.derive](all.list);
    derivedCache.set(def.id, { version: all.version, list });
    return list;
}

/** Items of a catalog (already sorted the way the catalog wants), before genre/skip. */
function getCatalogList(def) {
    if (def.derive) return getDerivedList(def);
    const src = getSource(def.source);
    return def.sort ? src.getSorted(def.sort) : src.get();
}

/** Distinct years present in a catalog's data, newest first (for filter: 'year' options). */
function yearOptions(def) {
    const years = new Set();
    for (const m of getCatalogList(def)) {
        const y = yearOf(m);
        if (y) years.add(y);
    }
    return Array.from(years).sort((a, b) => b - a).map(String);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
/**
 * Manifest `catalogs` array. `homeIds` (Set) overrides the registry's board defaults;
 * catalogs not on the Board get `isRequired: true` on their genre extra (Discover-only).
 */
function buildManifestCatalogs(homeIds = null) {
    return CATALOG_DEFS.map(def => {
        if (def.search) {
            return { id: def.id, type: def.type, name: def.name, extra: [{ name: 'search', isRequired: true }] };
        }
        const onBoard = homeIds ? homeIds.has(def.id) : def.board !== false;
        const extra = [{ name: 'skip', isRequired: false }];
        const options = def.filter === 'year' ? yearOptions(def) : genreOptions(def.type, !!def.compact);
        extra.push({ name: 'genre', isRequired: !onBoard, options });
        return { id: def.id, type: def.type, name: def.name, extra };
    });
}

/** Board/discover catalogs for the configure UI (search catalogs are implicit). */
function getCatalogOptions() {
    return CATALOG_DEFS.filter(d => !d.search).map(d => ({ id: d.id, name: d.name, type: d.type, board: d.board !== false }));
}

/** Catalog id to deep-link a genre of a type into (largest curated list). */
function genreLinkCatalogId(type) {
    return type === 'series' ? 'ncore-series-top-seeded-all' : 'ncore-movies-top-seeded-all';
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function normalizeSearchText(s) {
    return String(s == null ? '' : s)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Free-text search over every source of a type; all query words must appear in the name. */
function searchMetas(type, query, limit = 50) {
    const words = normalizeSearchText(query).split(' ').filter(Boolean);
    if (words.length === 0) return [];
    const results = [];
    for (const meta of allMetas(type).list) {
        if (!meta || !meta.name) continue;
        const hay = normalizeSearchText(meta.name);
        if (words.every(w => hay.includes(w))) {
            results.push(meta);
            if (results.length >= limit) break;
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// Remote refresh (optional)
// ---------------------------------------------------------------------------
let remoteTimer = null;

/**
 * Start background refresh of every source from DATA_REMOTE_BASE_URL.
 * No-op when the env var is unset. Returns true when started.
 */
function startRemoteRefresh({ baseUrl = process.env.DATA_REMOTE_BASE_URL, intervalMinutes } = {}) {
    if (!baseUrl) return false;
    const minutes = Number(intervalMinutes || process.env.DATA_REMOTE_REFRESH_MINUTES || 30);
    const intervalMs = Math.max(5, minutes) * 60 * 1000;
    const tick = async () => {
        for (const src of SOURCES.values()) {
            try {
                await src.refreshFromRemote(baseUrl);
            } catch (err) {
                console.error(`[Data] távoli frissítés sikertelen (${src.key}):`, err.message);
            }
        }
    };
    tick();
    remoteTimer = setInterval(tick, intervalMs);
    if (remoteTimer.unref) remoteTimer.unref();
    console.log(`[Data] Távoli adatfrissítés bekapcsolva: ${baseUrl} (${minutes} percenként)`);
    return true;
}

function stopRemoteRefresh() {
    if (remoteTimer) clearInterval(remoteTimer);
    remoteTimer = null;
}

/** Per-source stats for /health. */
function getDataStatus() {
    const sources = {};
    for (const src of SOURCES.values()) sources[src.key] = src.info();
    return {
        remote: process.env.DATA_REMOTE_BASE_URL || null,
        sources
    };
}

module.exports = {
    TTL,
    CACHE_PROFILES,
    GENRES,
    PSEUDO_FILTERS,
    SOURCE_DEFS,
    CATALOG_DEFS,
    META_LOOKUP_ORDER,
    normalizeGenres,
    normalizeMeta,
    genreOptions,
    resolveGenreFilter,
    resolveGenreSlug,
    filterMetasByGenre,
    credibleTopRating,
    filterMetasByYear,
    buildManifestCatalogs,
    getCatalogOptions,
    genreLinkCatalogId,
    sortMetasByReleaseYearDesc,
    getSource,
    getCatalogDef,
    getCatalogList,
    yearOptions,
    normalizeId,
    findMetaById,
    allMetas,
    normalizeSearchText,
    searchMetas,
    startRemoteRefresh,
    stopRemoteRefresh,
    getDataStatus
};
