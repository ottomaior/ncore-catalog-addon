const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
require('dotenv').config({ path: './config/config.env' });
const fs = require('fs');
const path = require('path');

// Trakt API configuration
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_USERNAME = process.env.TRAKT_USERNAME;
const MOVIE_LIST_SLUG = process.env.TRAKT_LIST_SLUG;

// TMDB API configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Path to episode tracker
const EPISODE_TRACKER_PATH = path.join(__dirname, 'scripts', 'series_episodes_seen.json');
// Path to most-seeded movies catalog (built weekly; script extends existing file incrementally)
const MOST_SEEDED_MOVIES_DATA_PATH = path.join(__dirname, 'data', 'most_seeded_movies.json');
// Path to most-seeded Hungarian productions (movies made in Hungary)
const MOST_SEEDED_HUNGARIAN_PRODUCTIONS_PATH = path.join(__dirname, 'data', 'most_seeded_hungarian_productions_movies.json');
// Path to most-seeded series catalog (Sorozat HD/HU)
const MOST_SEEDED_SERIES_DATA_PATH = path.join(__dirname, 'data', 'most_seeded_series.json');
// Path to most-seeded Hungarian productions (series made in Hungary)
const MOST_SEEDED_HUNGARIAN_PRODUCTIONS_SERIES_PATH = path.join(__dirname, 'data', 'most_seeded_hungarian_productions_series.json');

// Genres that get their own "Top seeded" catalog (slug -> display label)
const TOP_SEEDED_GENRE_CATALOGS = [
    'comedy', 'action', 'war', 'drama', 'thriller', 'horror', 'romance',
    'science-fiction', 'animation', 'crime', 'documentary', 'adventure', 'fantasy', 'mystery'
];
// Hungarian display names for Top Seed catalogs
const GENRE_LABEL_HU = {
    'comedy': 'Vígjáték',
    'action': 'Akció',
    'war': 'Háború',
    'drama': 'Dráma',
    'thriller': 'Thriller',
    'horror': 'Horror',
    'romance': 'Romantika',
    'science-fiction': 'Sci-fi',
    'animation': 'Animáció',
    'crime': 'Bűnügy',
    'documentary': 'Dokumentumfilm',
    'adventure': 'Kaland',
    'fantasy': 'Fantasy',
    'mystery': 'Rejtély'
};
function topSeedGenreLabel(slug) {
    return GENRE_LABEL_HU[slug] || slug.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join(' ');
}

// Load episode information from tracker
function loadEpisodeTracker() {
    try {
        if (fs.existsSync(EPISODE_TRACKER_PATH)) {
            const data = fs.readFileSync(EPISODE_TRACKER_PATH, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Hiba az epizód tracker betöltésekor:', error.message);
    }
    return {};
}

// Get episode info for a Trakt ID
function getEpisodeInfo(traktId) {
    const tracker = loadEpisodeTracker();
    const info = tracker[traktId.toString()];

    if (info && info.latest_season && info.latest_episode) {
        return `S${String(info.latest_season).padStart(2, '0')}E${String(info.latest_episode).padStart(2, '0')}`;
    }
    return null;
}

// Fetch Hungarian title and poster from TMDB
async function getHungarianMetadata(imdbId, type = 'movie') {
    try {
        const tmdbType = type === 'series' ? 'tv' : 'movie';

        // First, find the TMDB ID using IMDB ID
        const findResponse = await axios.get(
            `${TMDB_BASE_URL}/find/${imdbId}`,
            {
                params: {
                    api_key: TMDB_API_KEY,
                    external_source: 'imdb_id',
                    language: 'hu-HU'
                }
            }
        );

        const results = tmdbType === 'tv' ? findResponse.data.tv_results : findResponse.data.movie_results;

        if (results && results.length > 0) {
            const item = results[0];
            const tmdbId = item.id;
            const title = tmdbType === 'tv' ? item.name : item.title;
            const originalTitle = tmdbType === 'tv' ? item.original_name : item.original_title;
            const defaultPoster = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;

            // Try to get Hungarian poster
            let hungarianPoster = defaultPoster;
            try {
                const imagesResponse = await axios.get(
                    `${TMDB_BASE_URL}/${tmdbType}/${tmdbId}/images`,
                    {
                        params: {
                            api_key: TMDB_API_KEY,
                            include_image_language: 'hu,null'  // Get Hungarian and original posters
                        }
                    }
                );

                // Look for Hungarian poster first
                const posters = imagesResponse.data.posters || [];
                const hungarianPosterObj = posters.find(p => p.iso_639_1 === 'hu');

                if (hungarianPosterObj) {
                    hungarianPoster = `https://image.tmdb.org/t/p/w500${hungarianPosterObj.file_path}`;
                    console.log(`✓ Magyar poszter találva: ${title}`);
                }
            } catch (err) {
                console.log(`⚠ Nincs magyar poszter: ${title}`);
            }

            return {
                title: title || originalTitle,
                poster: hungarianPoster || defaultPoster
            };
        }

        return null;
    } catch (error) {
        console.error(`TMDB hiba (${imdbId}):`, error.message);
        return null;
    }
}

// Addon manifest
const manifest = {
    id: 'com.ncore.hungarian.addon',
    version: '1.2.0',
    name: 'nCore – Legfrissebb Feltöltések (HU)',
    description: 'Utoljára feltöltött magyar nyelvű filmek és sorozatok az nCore trackerről',
    resources: ['catalog', 'meta'],
    types: ["movie", "series"],
    catalogs: [
        {
            id: "ncore-movies-top-seeded-all",
            type: "movie",
            name: "nCore – Top Seed – Filmek",
            extra: [
                { name: "skip", isRequired: false },
                { name: "genre", isRequired: false, options: ["Comedy", "Action", "War", "Drama", "Thriller", "Horror", "Romance", "Science Fiction", "Animation", "Crime", "Documentary", "Adventure", "Fantasy", "Mystery"] }
            ]
        },
        {
            id: "ncore-series-top-seeded-all",
            type: "series",
            name: "nCore – Top Seed – Sorozatok",
            extra: [
                { name: "skip", isRequired: false },
                { name: "genre", isRequired: false, options: ["Comedy", "Action", "War", "Drama", "Thriller", "Horror", "Romance", "Science Fiction", "Animation", "Crime", "Documentary", "Adventure", "Fantasy", "Mystery"] }
            ]
        },
        {
            id: "ncore-hd-movies",
            type: "movie",
            name: "nCore – Utoljára feltöltött (filmek)",
            extra: [
                {
                    name: "skip",
                    isRequired: false
                }
            ]
        },
        {
            id: "ncore-hd-series",
            type: "series",
            name: "nCore – Utoljára feltöltött (sorozatok)",
            extra: [
                {
                    name: "skip",
                    isRequired: false
                }
            ]
        },
        {
            id: "ncore-movies-top-seeded-magyar-filmek",
            type: "movie",
            name: "nCore – Top Seed – Magyar filmek",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-series-top-seeded-magyar-sorozatok",
            type: "series",
            name: "nCore – Top Seed – Magyar sorozatok",
            extra: [{ name: "skip", isRequired: false }]
        }
    ],
    idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// Cache for catalog data
let movieCache = [];
let seriesCache = [];
let lastMovieUpdate = null;
let lastSeriesUpdate = null;
// Top-seeded-by-genre catalog: loaded from data/most_seeded_movies.json (built every 3 days)
let topSeededByGenreList = [];
let topSeededByGenreLoadedAt = null;
let topSeededHungarianProductionsList = [];
let topSeededHungarianProductionsLoadedAt = null;
let topSeededSeriesList = [];
let topSeededSeriesLoadedAt = null;
let topSeededHungarianProductionsSeriesList = [];
let topSeededHungarianProductionsSeriesLoadedAt = null;
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours
const TOP_SEEDED_CATALOG_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days

function loadTopSeededMoviesFromFile() {
    try {
        if (!fs.existsSync(MOST_SEEDED_MOVIES_DATA_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(MOST_SEEDED_MOVIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a most_seeded_movies.json betöltésekor:', err.message);
        return topSeededByGenreList;
    }
}

function getTopSeededMoviesList() {
    if (!topSeededByGenreLoadedAt || (Date.now() - topSeededByGenreLoadedAt > TOP_SEEDED_CATALOG_TTL)) {
        topSeededByGenreList = loadTopSeededMoviesFromFile();
        topSeededByGenreLoadedAt = Date.now();
        if (topSeededByGenreList.length) {
            console.log(`✓ ${topSeededByGenreList.length} legnagyobb seed film (kategóriák) betöltve`);
        }
    }
    return topSeededByGenreList;
}

function filterTopSeededByGenre(genreSlug) {
    const list = getTopSeededMoviesList();
    if (!genreSlug) return list;
    const match = genreSlug.toLowerCase().replace(/-/g, ' ');
    return list.filter(meta => {
        const genres = meta.genres || [];
        return genres.some(g => String(g).toLowerCase().replace(/\s+/g, ' ') === match);
    });
}

function loadTopSeededHungarianProductionsFromFile() {
    try {
        if (!fs.existsSync(MOST_SEEDED_HUNGARIAN_PRODUCTIONS_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(MOST_SEEDED_HUNGARIAN_PRODUCTIONS_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a most_seeded_hungarian_productions_movies.json betöltésekor:', err.message);
        return topSeededHungarianProductionsList;
    }
}

function getTopSeededHungarianProductionsList() {
    if (!topSeededHungarianProductionsLoadedAt || (Date.now() - topSeededHungarianProductionsLoadedAt > TOP_SEEDED_CATALOG_TTL)) {
        topSeededHungarianProductionsList = loadTopSeededHungarianProductionsFromFile();
        topSeededHungarianProductionsLoadedAt = Date.now();
        if (topSeededHungarianProductionsList.length) {
            console.log(`✓ ${topSeededHungarianProductionsList.length} magyar film (Magyarországon készült) betöltve`);
        }
    }
    return topSeededHungarianProductionsList;
}

function loadTopSeededSeriesFromFile() {
    try {
        if (!fs.existsSync(MOST_SEEDED_SERIES_DATA_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(MOST_SEEDED_SERIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a most_seeded_series.json betöltésekor:', err.message);
        return topSeededSeriesList;
    }
}

function getTopSeededSeriesList() {
    if (!topSeededSeriesLoadedAt || (Date.now() - topSeededSeriesLoadedAt > TOP_SEEDED_CATALOG_TTL)) {
        topSeededSeriesList = loadTopSeededSeriesFromFile();
        topSeededSeriesLoadedAt = Date.now();
        if (topSeededSeriesList.length) {
            console.log(`✓ ${topSeededSeriesList.length} legnagyobb seed sorozat betöltve`);
        }
    }
    return topSeededSeriesList;
}

function filterTopSeededSeriesByGenre(genreSlug) {
    const list = getTopSeededSeriesList();
    if (!genreSlug) return list;
    const match = genreSlug.toLowerCase().replace(/-/g, ' ');
    return list.filter(meta => {
        const genres = meta.genres || [];
        return genres.some(g => String(g).toLowerCase().replace(/\s+/g, ' ') === match);
    });
}

function loadTopSeededHungarianProductionsSeriesFromFile() {
    try {
        if (!fs.existsSync(MOST_SEEDED_HUNGARIAN_PRODUCTIONS_SERIES_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(MOST_SEEDED_HUNGARIAN_PRODUCTIONS_SERIES_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a most_seeded_hungarian_productions_series.json betöltésekor:', err.message);
        return topSeededHungarianProductionsSeriesList;
    }
}

function getTopSeededHungarianProductionsSeriesList() {
    if (!topSeededHungarianProductionsSeriesLoadedAt || (Date.now() - topSeededHungarianProductionsSeriesLoadedAt > TOP_SEEDED_CATALOG_TTL)) {
        topSeededHungarianProductionsSeriesList = loadTopSeededHungarianProductionsSeriesFromFile();
        topSeededHungarianProductionsSeriesLoadedAt = Date.now();
        if (topSeededHungarianProductionsSeriesList.length) {
            console.log(`✓ ${topSeededHungarianProductionsSeriesList.length} magyar sorozat (Magyarországon készült) betöltve`);
        }
    }
    return topSeededHungarianProductionsSeriesList;
}

// Fetch movies from Trakt list
async function fetchTraktList() {
    try {
        console.log('Filmek betöltése a Trakt listáról...');
        const response = await axios.get(
            `https://api.trakt.tv/users/${TRAKT_USERNAME}/lists/${MOVIE_LIST_SLUG}/items/movies`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'trakt-api-version': '2',
                    'trakt-api-key': TRAKT_CLIENT_ID
                },
                params: {
                    extended: 'full'
                }
            }
        );

        // Process movies with Hungarian titles and posters
        const movies = await Promise.all(
            response.data
                .filter(item => item.movie.ids.imdb)
                .map(async item => {
                    const movie = item.movie;
                    let imdbId = movie.ids.imdb.toString();

                    // Get Hungarian metadata (title + poster) from TMDB
                    const metadata = await getHungarianMetadata(imdbId, 'movie');

                    const displayTitle = metadata?.title || movie.title;
                    const displayPoster = metadata?.poster || `https://images.metahub.space/poster/small/tt${imdbId.replace(/^tt/, '')}/img`;

                    imdbId = imdbId.replace(/^tt/, '');

                    return {
                        id: `tt${imdbId}`,
                        type: 'movie',
                        name: displayTitle,
                        poster: displayPoster,  // Use Hungarian poster
                        posterShape: 'poster',
                        year: movie.year,
                        description: movie.overview || 'Magyar HD feltöltés az nCore trackerről',
                        imdbRating: movie.rating ? movie.rating.toFixed(1) : null,
                        releaseInfo: movie.year ? movie.year.toString() : null,
                        genres: movie.genres || []
                    };
                })
        );

        movieCache = movies;
        lastMovieUpdate = Date.now();
        console.log(`✓ ${movies.length} film gyorsítótárazva (magyar címekkel és poszterekkel)`);

        const totalItems = response.data.length;
        const filtered = totalItems - movies.length;
        if (filtered > 0) {
            console.log(`⚠ ${filtered} film kiszűrve (nincs IMDB ID)`);
        }

        return movies;

    } catch (error) {
        console.error('Hiba a Trakt filmlista lekérésekor:', error.message);
        if (error.response) {
            console.error('Válasz státusz:', error.response.status);
            console.error('Válasz adat:', error.response.data);
        }
        return movieCache;
    }
}

// Fetch series from Trakt list
async function fetchTraktSeriesList() {
    try {
        console.log('Sorozatok betöltése a Trakt listáról...');
        const SERIES_LIST_SLUG = process.env.TRAKT_SERIES_LIST_SLUG || 'legujabb-sorozatok-ncore';

        const response = await axios.get(
            `https://api.trakt.tv/users/${TRAKT_USERNAME}/lists/${SERIES_LIST_SLUG}/items/shows`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'trakt-api-version': '2',
                    'trakt-api-key': TRAKT_CLIENT_ID
                },
                params: {
                    extended: 'full'
                }
            }
        );

        // Process series with Hungarian titles and posters
        const series = await Promise.all(
            response.data
                .filter(item => item.show.ids.imdb)
                .map(async item => {
                    const show = item.show;
                    let imdbId = show.ids.imdb.toString();

                    // Get Hungarian metadata (title + poster) from TMDB
                    const metadata = await getHungarianMetadata(imdbId, 'series');

                    const baseTitle = metadata?.title || show.title;
                    const displayPoster = metadata?.poster || `https://images.metahub.space/poster/small/tt${imdbId.replace(/^tt/, '')}/img`;

                    imdbId = imdbId.replace(/^tt/, '');

                    // Get episode info from tracker
                    const traktId = show.ids.trakt;
                    const episodeInfo = getEpisodeInfo(traktId);

                    // Keep episode info in title for catalog browsing
                    const displayName = episodeInfo ? `${baseTitle} (${episodeInfo})` : baseTitle;

                    // Also add to description and releaseInfo
                    const baseDescription = show.overview || 'Magyar HD sorozat az nCore trackerről';
                    const displayDescription = episodeInfo
                        ? `🇭🇺 Legújabb magyar epizód: ${episodeInfo}\n\n${baseDescription}`
                        : baseDescription;

                    const displayReleaseInfo = episodeInfo
                        ? `${show.year || ''} • Magyar: ${episodeInfo}`.trim()
                        : (show.year ? show.year.toString() : null);

                    return {
                        id: `tt${imdbId}`,
                        type: 'series',
                        name: displayName,  // Episode info in title for catalog
                        poster: displayPoster,
                        posterShape: 'poster',
                        year: show.year,
                        description: displayDescription,
                        imdbRating: show.rating ? show.rating.toFixed(1) : null,
                        releaseInfo: displayReleaseInfo,
                        genres: show.genres || []
                    };

                })
        );

        const reversedSeries = series.reverse();
        seriesCache = reversedSeries;
        lastSeriesUpdate = Date.now();
        console.log(`✓ ${series.length} sorozat gyorsítótárazva (magyar címekkel és poszterekkel)`);

        const totalItems = response.data.length;
        const filtered = totalItems - series.length;
        if (filtered > 0) {
            console.log(`⚠ ${filtered} sorozat kiszűrve (nincs IMDB ID)`);
        }

        return reversedSeries;

    } catch (error) {
        console.error('Hiba a Trakt sorozatlista lekérésekor:', error.message);
        if (error.response) {
            console.error('Válasz státusz:', error.response.status);
            console.error('Válasz adat:', error.response.data);
        }
        return seriesCache;
    }
}

// Catalog handler for both movies and series
builder.defineCatalogHandler(async (args) => {
    console.log(`Katalógus kérés: ${args.type}/${args.id}`);

    // Handle movie catalog
    if (args.type === 'movie' && args.id === 'ncore-hd-movies') {
        if (!lastMovieUpdate || (Date.now() - lastMovieUpdate > CACHE_TTL)) {
            await fetchTraktList();
        }

        const skip = parseInt(args.extra?.skip) || 0;
        const metas = movieCache.slice(skip, skip + 100);

        return Promise.resolve({ metas });
    }

    // Handle series catalog
    if (args.type === 'series' && args.id === 'ncore-hd-series') {
        if (!lastSeriesUpdate || (Date.now() - lastSeriesUpdate > CACHE_TTL)) {
            await fetchTraktSeriesList();
        }

        const skip = parseInt(args.extra?.skip) || 0;
        const metas = seriesCache.slice(skip, skip + 100);

        return Promise.resolve({ metas });
    }

    // Top seeded series from JSON – filter by genre if extra provided
    if (args.type === 'series' && args.id === 'ncore-series-top-seeded-all') {
        let list = getTopSeededSeriesList();
        if (args.extra?.genre) {
            const genreSlug = args.extra.genre.toLowerCase().replace(/\s+/g, '-');
            list = filterTopSeededSeriesByGenre(genreSlug);
        }
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Top seeded Hungarian productions (series made in Hungary)
    if (args.type === 'series' && args.id === 'ncore-series-top-seeded-magyar-sorozatok') {
        const list = getTopSeededHungarianProductionsSeriesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Top seeded movies from JSON – filter by genre if extra provided
    if (args.type === 'movie' && args.id === 'ncore-movies-top-seeded-all') {
        let list = getTopSeededMoviesList();
        if (args.extra?.genre) {
            const genreSlug = args.extra.genre.toLowerCase().replace(/\s+/g, '-');
            list = filterTopSeededByGenre(genreSlug);
        }
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Top seeded Hungarian productions (movies made in Hungary)
    if (args.type === 'movie' && args.id === 'ncore-movies-top-seeded-magyar-filmek') {
        const list = getTopSeededHungarianProductionsList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    return Promise.resolve({ metas: [] });
});

// Meta handler for both movies and series (includes most-seeded caches)
builder.defineMetaHandler(async (args) => {
    console.log(`Meta kérés: ${args.type}/${args.id}`);

    if (args.type === 'movie') {
        const movie = movieCache.find(m => m.id === args.id)
            || getTopSeededMoviesList().find(m => m.id === args.id)
            || getTopSeededHungarianProductionsList().find(m => m.id === args.id);
        if (movie) {
            return Promise.resolve({ meta: movie });
        }
    }

    if (args.type === 'series') {
        const series = seriesCache.find(s => s.id === args.id)
            || getTopSeededSeriesList().find(s => s.id === args.id)
            || getTopSeededHungarianProductionsSeriesList().find(s => s.id === args.id);
        if (series) {
            return Promise.resolve({ meta: series });
        }
    }

    return Promise.resolve({ meta: null });
});

// Cache is filled on first catalog request (see defineCatalogHandler). No startup fetch
// so the server can listen immediately and avoid 502 on Railway (proxy timeout).

// Auto-refresh every 3 hours
setInterval(() => {
    fetchTraktList();
    fetchTraktSeriesList();
}, CACHE_TTL);

// Export the builder and stats for health endpoint
builder.getStats = () => ({
    lastMovieUpdate: lastMovieUpdate ? new Date(lastMovieUpdate).toISOString() : null,
    lastSeriesUpdate: lastSeriesUpdate ? new Date(lastSeriesUpdate).toISOString() : null,
    movieCount: movieCache.length,
    seriesCount: seriesCache.length,
    topSeededByGenreCount: getTopSeededMoviesList().length,
    topSeededHungarianProductionsCount: getTopSeededHungarianProductionsList().length,
    topSeededSeriesCount: getTopSeededSeriesList().length,
    topSeededHungarianProductionsSeriesCount: getTopSeededHungarianProductionsSeriesList().length
});
/**
 * Return manifest with only the given catalog ids (for configure-before-install).
 * @param {string[]} enabledIds - Catalog ids to include. If empty/null, returns full manifest.
 */
function getManifestForCatalogs(enabledIds) {
    if (!enabledIds || !Array.isArray(enabledIds) || enabledIds.length === 0) {
        return manifest;
    }
    // Preserve the order from enabledIds
    const catalogMap = new Map(manifest.catalogs.map(c => [c.id, c]));
    const catalogs = enabledIds
        .map(id => String(id).trim())
        .filter(Boolean)
        .map(id => catalogMap.get(id))
        .filter(Boolean);
    return { ...manifest, catalogs };
}

/** Return list of { id, name, type } for each catalog (for configure UI). */
function getCatalogOptions() {
    return manifest.catalogs.map(c => ({ id: c.id, name: c.name, type: c.type }));
}

module.exports = builder;
module.exports.getManifestForCatalogs = getManifestForCatalogs;
module.exports.getCatalogOptions = getCatalogOptions;
module.exports.manifest = manifest;

// Only start standalone server if run directly (for local testing)
if (require.main === module) {
    const { serveHTTP } = require('stremio-addon-sdk');
    const { exec } = require('child_process');
    const cron = require('node-cron');
    
    const PORT = process.env.PORT || 7000;
    serveHTTP(builder.getInterface(), { port: PORT });
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎬 nCore Stremio Addon Fut`);
    console.log(`${'='.repeat(60)}`);
    console.log(`\n📍 Helyi: http://localhost:${PORT}/manifest.json`);
    console.log(`🌐 Telepítés: http://localhost:${PORT}/manifest.json`);
    console.log(`📋 Filmek: http://localhost:${PORT}/catalog/movie/ncore-hd-movies.json`);
    console.log(`📺 Sorozatok: http://localhost:${PORT}/catalog/series/ncore-hd-series.json\n`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Start cron scheduler
    console.log('🕐 Cron scheduler started!');
    
    // Run movie scraper every 3 hours
    cron.schedule('0 */3 * * *', () => {
        console.log('⏰ Running movie scraper...');
        exec('. /opt/venv/bin/activate && cd scripts && python sync_rss_to_trakt.py', (error, stdout, stderr) => {
            if (error) {
                console.error(`Movie scraper error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(`Movie scraper stderr: ${stderr}`);
            }
            console.log(`Movie scraper output: ${stdout}`);
            console.log('✅ Movie scraper completed!');
        });
    });
    
    // Run series scraper every 3 hours (offset by 30 minutes)
    cron.schedule('30 */3 * * *', () => {
        console.log('⏰ Running series scraper...');
        exec('. /opt/venv/bin/activate && cd scripts && python sync_series_rss_to_trakt.py', (error, stdout, stderr) => {
            if (error) {
                console.error(`Series scraper error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(`Series scraper stderr: ${stderr}`);
            }
            console.log(`Series scraper output: ${stdout}`);
            console.log('✅ Series scraper completed!');
        });
    });
    
    console.log('📋 Scheduled tasks:');
    console.log('  - Movies: Every 3 hours (00:00, 03:00, 06:00, ...)');
    console.log('  - Series: Every 3 hours (00:30, 03:30, 06:30, ...)\n');
}
