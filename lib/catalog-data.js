/**
 * Catalog data layer: one registry describing every JSON data source and every
 * Stremio catalog, plus TTL-cached loading, meta lookup index, genre filtering
 * and free-text search. index.js, info-addon.js and /health all read from here.
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

// Order in which sources are consulted when resolving a meta request by id.
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
// Genres
// ---------------------------------------------------------------------------
// TMDB hu-HU sometimes returns adjective/alternate forms (huAliases); TVDB uses
// combined labels for series (seriesAliases). `series: false` = TVDB never
// returns this genre for series, so it is hidden from the series dropdowns.
const GENRES = [
    { slug: 'comedy', en: 'Comedy', hu: 'Vígjáték' },
    { slug: 'action', en: 'Action', hu: 'Akció', seriesAliases: ['Action & Adventure'] },
    { slug: 'war', en: 'War', hu: 'Háború', huAliases: ['Háborús'], seriesAliases: ['War & Politics'] },
    { slug: 'drama', en: 'Drama', hu: 'Dráma' },
    { slug: 'thriller', en: 'Thriller', hu: 'Thriller', series: false },
    { slug: 'horror', en: 'Horror', hu: 'Horror', series: false },
    { slug: 'romance', en: 'Romance', hu: 'Romantika', huAliases: ['Romantikus'], series: false },
    { slug: 'science-fiction', en: 'Science Fiction', hu: 'Sci-fi', seriesAliases: ['Sci-Fi & Fantasy'] },
    { slug: 'animation', en: 'Animation', hu: 'Animáció', huAliases: ['Animációs'] },
    { slug: 'crime', en: 'Crime', hu: 'Bűnügy', huAliases: ['Bűnügyi'] },
    { slug: 'documentary', en: 'Documentary', hu: 'Dokumentumfilm', huAliases: ['Dokumentum'] },
    { slug: 'adventure', en: 'Adventure', hu: 'Kaland', seriesAliases: ['Action & Adventure'] },
    { slug: 'fantasy', en: 'Fantasy', hu: 'Fantasy', seriesAliases: ['Sci-Fi & Fantasy'] },
    { slug: 'mystery', en: 'Mystery', hu: 'Rejtély' }
];

function normalizeGenreText(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Any spelling a client may send back (Hungarian label, English label, slug) -> slug
const GENRE_SLUG_BY_INPUT = new Map();
for (const g of GENRES) {
    const inputs = [g.slug, g.slug.replace(/-/g, ' '), g.en, g.hu].concat(g.huAliases || []);
    for (const i of inputs) GENRE_SLUG_BY_INPUT.set(normalizeGenreText(i), g.slug);
}

// slug -> set of normalized genre strings that count as a match in meta.genres
const GENRE_ACCEPTED_BY_SLUG = new Map();
for (const g of GENRES) {
    const accepted = [g.slug, g.slug.replace(/-/g, ' '), g.en, g.hu]
        .concat(g.huAliases || [])
        .concat(g.seriesAliases || [])
        .map(normalizeGenreText);
    GENRE_ACCEPTED_BY_SLUG.set(g.slug, new Set(accepted));
}

/** Genre dropdown options shown in Stremio (Hungarian labels). */
function genreOptions(type) {
    return GENRES.filter(g => type !== 'series' || g.series !== false).map(g => g.hu);
}

/** Resolve whatever the client sent (e.g. "Vígjáték", "Comedy", "science-fiction") to a slug. */
function resolveGenreSlug(value) {
    if (value == null || value === '') return null;
    const norm = normalizeGenreText(value);
    if (GENRE_SLUG_BY_INPUT.has(norm)) return GENRE_SLUG_BY_INPUT.get(norm);
    const asSlug = norm.replace(/\s+/g, '-');
    return GENRE_SLUG_BY_INPUT.has(asSlug) ? GENRE_SLUG_BY_INPUT.get(asSlug) : asSlug;
}

function genreToMatchString(g) {
    if (g == null) return '';
    if (typeof g === 'string') return g;
    if (typeof g === 'object' && typeof g.name === 'string') return g.name;
    return String(g);
}

/** Shared genre filter for any catalog (movies or series). */
function filterMetasByGenre(list, genreValue) {
    if (!list || !genreValue) return list || [];
    const slug = resolveGenreSlug(genreValue);
    const accepted = GENRE_ACCEPTED_BY_SLUG.get(slug) || new Set([slug, slug.replace(/-/g, ' ')]);
    return list.filter(meta => {
        const genres = meta.genres || [];
        return genres.some(g => accepted.has(normalizeGenreText(genreToMatchString(g))));
    });
}

// ---------------------------------------------------------------------------
// Catalog registry (what the manifest advertises)
// ---------------------------------------------------------------------------
const CATALOG_DEFS = [
    { id: 'ncore-movies-top-seeded-all', type: 'movie', name: '🏆 Filmek', source: 'most_seeded_movies', genre: true },
    { id: 'ncore-series-top-seeded-all', type: 'series', name: '🏆 Sorozatok', source: 'most_seeded_series', genre: true },
    { id: 'ncore-movies-top-seeded-magyar-filmek', type: 'movie', name: '🏆🇭🇺 Top Seed filmek', source: 'most_seeded_hungarian_productions_movies', genre: false },
    { id: 'ncore-series-top-seeded-magyar-sorozatok', type: 'series', name: '🏆🇭🇺 Top Seed sorozatok', source: 'most_seeded_hungarian_productions_series', genre: false },
    { id: 'ncore-top-downloaded-1080-movies', type: 'movie', name: '📥 Filmek', source: 'top_downloaded_1080_movies', genre: true },
    { id: 'ncore-top-downloaded-1080-series', type: 'series', name: '📥 Sorozatok', source: 'top_downloaded_1080_series', genre: true },
    { id: 'ncore-top-downloaded-1080-magyar-filmek', type: 'movie', name: '🏆🇭🇺 Top letöltés filmek', source: 'top_downloaded_1080_hungarian_productions_movies', genre: true },
    { id: 'ncore-top-downloaded-1080-magyar-sorozatok', type: 'series', name: '🏆🇭🇺 Top letöltés sorozatok', source: 'top_downloaded_1080_hungarian_productions_series', genre: true },
    { id: 'ncore-trending-movies', type: 'movie', name: '🔥 Filmek', source: 'trending_movies', genre: true },
    { id: 'ncore-trending-series', type: 'series', name: '🔥 Sorozatok', source: 'trending_series', genre: true },
    { id: 'ncore-hd-movies', type: 'movie', name: '⏰ Filmek', source: 'hd_movies', genre: true },
    { id: 'ncore-hd-movies-release-date', type: 'movie', name: '🗓️ Filmek (Megjelenés éve szerint)', source: 'hd_movies', genre: true, sort: 'releaseYearDesc' },
    { id: 'ncore-hd-series', type: 'series', name: '⏰ Sorozatok', source: 'hd_series', genre: true },
    { id: 'ncore-hd-series-release-date', type: 'series', name: '🗓️ Sorozatok (Megjelenés éve szerint)', source: 'hd_series', genre: true, sort: 'releaseYearDesc' },
    { id: 'ncore-netflix-movies', type: 'movie', name: '⏰ Netflix filmek', source: 'netflix_movies', genre: true },
    { id: 'ncore-netflix-series', type: 'series', name: '⏰ Netflix sorozatok', source: 'netflix_series', genre: true },
    { id: 'ncore-disneyplus-movies', type: 'movie', name: '⏰ Disney+ filmek', source: 'disneyplus_movies', genre: true },
    { id: 'ncore-disneyplus-series', type: 'series', name: '⏰ Disney+ sorozatok', source: 'disneyplus_series', genre: true },
    { id: 'ncore-hbomax-movies', type: 'movie', name: '⏰ HBO Max filmek', source: 'hbomax_movies', genre: true },
    { id: 'ncore-hbomax-series', type: 'series', name: '⏰ HBO Max sorozatok', source: 'hbomax_series', genre: true },
    { id: 'ncore-prime-movies', type: 'movie', name: '⏰ Prime Video filmek', source: 'prime_movies', genre: true },
    { id: 'ncore-prime-series', type: 'series', name: '⏰ Prime Video sorozatok', source: 'prime_series', genre: true },
    // Search catalogs: only used by Stremio's search screen (search is required), never shown on the board.
    { id: 'ncore-search-movies', type: 'movie', name: '🔍 nCore filmek', search: true },
    { id: 'ncore-search-series', type: 'series', name: '🔍 nCore sorozatok', search: true }
];

/** Manifest `catalogs` array built from the registry. */
function buildManifestCatalogs() {
    return CATALOG_DEFS.map(def => {
        if (def.search) {
            return { id: def.id, type: def.type, name: def.name, extra: [{ name: 'search', isRequired: true }] };
        }
        const extra = [{ name: 'skip', isRequired: false }];
        if (def.genre) extra.push({ name: 'genre', isRequired: false, options: genreOptions(def.type) });
        return { id: def.id, type: def.type, name: def.name, extra };
    });
}

// ---------------------------------------------------------------------------
// Loading + caching
// ---------------------------------------------------------------------------
function readJsonArray(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
}

function toYearNumber(rawYear) {
    if (rawYear === null || rawYear === undefined || rawYear === '') return NaN;
    const n = typeof rawYear === 'number' ? rawYear : parseInt(rawYear, 10);
    return Number.isFinite(n) ? n : NaN;
}

/** Stable sort by year desc; items without a year go last in original order. */
function sortMetasByReleaseYearDesc(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map((item, idx) => ({ item, idx, year: toYearNumber(item && item.year) }))
        .sort((a, b) => {
            const af = Number.isFinite(a.year);
            const bf = Number.isFinite(b.year);
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
        this.list = list;
        this.loadedAt = Date.now();
        this.origin = origin;
        dataVersion += 1;
        if (list.length) console.log(`✓ ${list.length} ${this.label} betöltve (${origin})`);
    }

    loadFromFile() {
        try {
            if (!fs.existsSync(this.file)) {
                // Keep whatever we already have (e.g. from remote); just re-arm the TTL.
                this.loadedAt = Date.now();
                return;
            }
            const stat = fs.statSync(this.file);
            const mtime = stat.mtimeMs;
            if (this.origin === 'remote' || (this.fileMtime === mtime && this.list.length)) {
                // Remote data is fresher than disk (or the file is unchanged): nothing to do.
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

/** Items of a catalog (already sorted the way the catalog wants), before genre/skip. */
function getCatalogList(def) {
    const src = getSource(def.source);
    return def.sort ? src.getSorted(def.sort) : src.get();
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

const metaIndex = { movie: { version: -1, map: new Map() }, series: { version: -1, map: new Map() } };

function buildMetaIndex(type) {
    const map = new Map();
    for (const key of META_LOOKUP_ORDER[type]) {
        for (const meta of getSource(key).get()) {
            const id = normalizeId(meta && (meta.id || meta.imdb_id) || '');
            if (id && !map.has(id)) map.set(id, meta);
        }
    }
    return map;
}

/** Find a meta by IMDb id across all sources of a type (first source in lookup order wins). */
function findMetaById(type, id) {
    const t = type === 'series' ? 'series' : 'movie';
    // Touch every source so TTL reloads happen (they bump dataVersion).
    for (const key of META_LOOKUP_ORDER[t]) getSource(key).get();
    const entry = metaIndex[t];
    if (entry.version !== dataVersion) {
        entry.map = buildMetaIndex(t);
        entry.version = dataVersion;
    }
    return entry.map.get(normalizeId(id)) || null;
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
    const t = type === 'series' ? 'series' : 'movie';
    const seen = new Set();
    const results = [];
    for (const key of META_LOOKUP_ORDER[t]) {
        for (const meta of getSource(key).get()) {
            if (!meta || !meta.name) continue;
            const id = normalizeId(meta.id || meta.imdb_id || '');
            if (!id || seen.has(id)) continue;
            const hay = normalizeSearchText(meta.name);
            if (words.every(w => hay.includes(w))) {
                seen.add(id);
                results.push(meta);
                if (results.length >= limit) return results;
            }
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
    GENRES,
    SOURCE_DEFS,
    CATALOG_DEFS,
    META_LOOKUP_ORDER,
    genreOptions,
    resolveGenreSlug,
    filterMetasByGenre,
    buildManifestCatalogs,
    sortMetasByReleaseYearDesc,
    getSource,
    getCatalogDef,
    getCatalogList,
    normalizeId,
    findMetaById,
    normalizeSearchText,
    searchMetas,
    startRemoteRefresh,
    stopRemoteRefresh,
    getDataStatus
};
