const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
require('dotenv').config({ path: './config/config.env' });
const fs = require('fs');
const path = require('path');

// TMDB API configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Delay (ms) before answering series meta so our response can arrive after Cinemeta (best effort)
const SERIES_META_DELAY_MS = 2500;

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
// Path to Netflix movies catalog
const NETFLIX_MOVIES_DATA_PATH = path.join(__dirname, 'data', 'netflix_movies.json');
// Path to Netflix series catalog
const NETFLIX_SERIES_DATA_PATH = path.join(__dirname, 'data', 'netflix_series.json');
// Path to Max movies/series (split by provider; TMDB provider "Max" 387)
const MAX_MOVIES_DATA_PATH = path.join(__dirname, 'data', 'max_movies.json');
const MAX_SERIES_DATA_PATH = path.join(__dirname, 'data', 'max_series.json');
// Path to Disney+ movies/series (split by provider)
const DISNEYPLUS_MOVIES_DATA_PATH = path.join(__dirname, 'data', 'disneyplus_movies.json');
const DISNEYPLUS_SERIES_DATA_PATH = path.join(__dirname, 'data', 'disneyplus_series.json');
// Path to latest HD movies catalog
const HD_MOVIES_DATA_PATH = path.join(__dirname, 'data', 'hd_movies.json');
// Path to latest HD series catalog
const HD_SERIES_DATA_PATH = path.join(__dirname, 'data', 'hd_series.json');
// Path to trending movies (most seeded in last N pages, 1080p HD_HUN)
const TRENDING_MOVIES_DATA_PATH = path.join(__dirname, 'data', 'trending_movies.json');
// Path to trending series (most seeded in last N pages, 1080p HDSER_HUN)
const TRENDING_SERIES_DATA_PATH = path.join(__dirname, 'data', 'trending_series.json');

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
    resources: [
        'catalog',
        { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }
    ],
    types: ["movie", "series"],
    catalogs: [
        {
            id: "ncore-movies-top-seeded-all",
            type: "movie",
            name: "🏆 Filmek",
            extra: [
                { name: "skip", isRequired: false },
                { name: "genre", isRequired: false, options: ["Comedy", "Action", "War", "Drama", "Thriller", "Horror", "Romance", "Science Fiction", "Animation", "Crime", "Documentary", "Adventure", "Fantasy", "Mystery"] }
            ]
        },
        {
            id: "ncore-series-top-seeded-all",
            type: "series",
            name: "🏆 Sorozatok",
            extra: [
                { name: "skip", isRequired: false },
                { name: "genre", isRequired: false, options: ["Comedy", "Action", "War", "Drama", "Thriller", "Horror", "Romance", "Science Fiction", "Animation", "Crime", "Documentary", "Adventure", "Fantasy", "Mystery"] }
            ]
        },
        {
            id: "ncore-trending-movies",
            type: "movie",
            name: "🔥 Filmek",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-trending-series",
            type: "series",
            name: "🔥 Sorozatok",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-hd-movies",
            type: "movie",
            name: "⏰ Filmek",
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
            name: "⏰ Sorozatok",
            extra: [
                {
                    name: "skip",
                    isRequired: false
                }
            ]
        },
        {
            id: "ncore-netflix-movies",
            type: "movie",
            name: "⏰ Netflix filmek",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-netflix-series",
            type: "series",
            name: "⏰ Netflix sorozatok",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-max-movies",
            type: "movie",
            name: "⏰ Max filmek",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-max-series",
            type: "series",
            name: "⏰ Max sorozatok",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-disneyplus-movies",
            type: "movie",
            name: "⏰ Disney+ filmek",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-disneyplus-series",
            type: "series",
            name: "⏰ Disney+ sorozatok",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-movies-top-seeded-magyar-filmek",
            type: "movie",
            name: "🏆 Magyar filmek",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-series-top-seeded-magyar-sorozatok",
            type: "series",
            name: "🏆 Magyar sorozatok",
            extra: [{ name: "skip", isRequired: false }]
        }
    ],
    idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// Cache for catalog data
let hdMoviesList = [];
let hdMoviesLoadedAt = null;
let hdSeriesList = [];
let hdSeriesLoadedAt = null;
// Top-seeded-by-genre catalog: loaded from data/most_seeded_movies.json (built every 3 days)
let topSeededByGenreList = [];
let topSeededByGenreLoadedAt = null;
let topSeededHungarianProductionsList = [];
let topSeededHungarianProductionsLoadedAt = null;
let topSeededSeriesList = [];
let topSeededSeriesLoadedAt = null;
let topSeededHungarianProductionsSeriesList = [];
let topSeededHungarianProductionsSeriesLoadedAt = null;
let netflixMoviesList = [];
let netflixMoviesLoadedAt = null;
let netflixSeriesList = [];
let netflixSeriesLoadedAt = null;
let maxMoviesList = [];
let maxMoviesLoadedAt = null;
let maxSeriesList = [];
let maxSeriesLoadedAt = null;
let disneyplusMoviesList = [];
let disneyplusMoviesLoadedAt = null;
let disneyplusSeriesList = [];
let disneyplusSeriesLoadedAt = null;
let trendingMoviesList = [];
let trendingMoviesLoadedAt = null;
let trendingSeriesList = [];
let trendingSeriesLoadedAt = null;
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours
const TOP_SEEDED_CATALOG_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
const NETFLIX_CATALOG_TTL = 6 * 60 * 60 * 1000; // 6 hours
const MAX_CATALOG_TTL = 6 * 60 * 60 * 1000; // 6 hours
const STREAMING_CATALOG_TTL = 6 * 60 * 60 * 1000; // 6 hours (Disney+)

// Cache for series episode list (videos) from TMDB – so Stremio shows season/episode picker
const SERIES_VIDEOS_CACHE = new Map();
const SERIES_VIDEOS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getSeriesVideosFromTMDB(imdbId) {
    if (!TMDB_API_KEY || !imdbId) return null;
    const idNorm = String(imdbId).trim();
    const cached = SERIES_VIDEOS_CACHE.get(idNorm);
    if (cached && Date.now() - cached.at < SERIES_VIDEOS_CACHE_TTL) return cached.videos;
    try {
        const findRes = await axios.get(`${TMDB_BASE_URL}/find/${idNorm}`, {
            params: { api_key: TMDB_API_KEY, external_source: 'imdb_id' },
            timeout: 10000
        });
        const tvResults = findRes.data.tv_results || [];
        if (tvResults.length === 0) return null;
        const tmdbId = tvResults[0].id;
        const tvRes = await axios.get(`${TMDB_BASE_URL}/tv/${tmdbId}`, {
            params: { api_key: TMDB_API_KEY, language: 'hu-HU' },
            timeout: 10000
        });
        const numSeasons = Math.max(0, parseInt(tvRes.data.number_of_seasons, 10) || 0);
        const videos = [];
        for (let s = 1; s <= numSeasons; s++) {
            const seasonRes = await axios.get(`${TMDB_BASE_URL}/tv/${tmdbId}/season/${s}`, {
                params: { api_key: TMDB_API_KEY, language: 'hu-HU' },
                timeout: 10000
            });
            const episodes = seasonRes.data.episodes || [];
            for (const ep of episodes) {
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
        SERIES_VIDEOS_CACHE.set(idNorm, { videos, at: Date.now() });
        return videos;
    } catch (err) {
        return null;
    }
}

function loadHDMoviesFromFile() {
    try {
        if (!fs.existsSync(HD_MOVIES_DATA_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(HD_MOVIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a hd_movies.json betöltésekor:', err.message);
        return hdMoviesList;
    }
}

function getHDMoviesList() {
    if (!hdMoviesLoadedAt || (Date.now() - hdMoviesLoadedAt > CACHE_TTL)) {
        hdMoviesList = loadHDMoviesFromFile();
        hdMoviesLoadedAt = Date.now();
        if (hdMoviesList.length) {
            console.log(`✓ ${hdMoviesList.length} legfrissebb HD film betöltve`);
        }
    }
    return hdMoviesList;
}

function loadHDSeriesFromFile() {
    try {
        if (!fs.existsSync(HD_SERIES_DATA_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(HD_SERIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a hd_series.json betöltésekor:', err.message);
        return hdSeriesList;
    }
}

function getHDSeriesList() {
    if (!hdSeriesLoadedAt || (Date.now() - hdSeriesLoadedAt > CACHE_TTL)) {
        hdSeriesList = loadHDSeriesFromFile();
        hdSeriesLoadedAt = Date.now();
        if (hdSeriesList.length) {
            console.log(`✓ ${hdSeriesList.length} legfrissebb HD sorozat betöltve`);
        }
    }
    return hdSeriesList;
}

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

function loadNetflixMoviesFromFile() {
    try {
        if (!fs.existsSync(NETFLIX_MOVIES_DATA_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(NETFLIX_MOVIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a netflix_movies.json betöltésekor:', err.message);
        return netflixMoviesList;
    }
}

function getNetflixMoviesList() {
    if (!netflixMoviesLoadedAt || (Date.now() - netflixMoviesLoadedAt > NETFLIX_CATALOG_TTL)) {
        netflixMoviesList = loadNetflixMoviesFromFile();
        netflixMoviesLoadedAt = Date.now();
        if (netflixMoviesList.length) {
            console.log(`✓ ${netflixMoviesList.length} Netflix film betöltve`);
        }
    }
    return netflixMoviesList;
}

function loadNetflixSeriesFromFile() {
    try {
        if (!fs.existsSync(NETFLIX_SERIES_DATA_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(NETFLIX_SERIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a netflix_series.json betöltésekor:', err.message);
        return netflixSeriesList;
    }
}

function getNetflixSeriesList() {
    if (!netflixSeriesLoadedAt || (Date.now() - netflixSeriesLoadedAt > NETFLIX_CATALOG_TTL)) {
        netflixSeriesList = loadNetflixSeriesFromFile();
        netflixSeriesLoadedAt = Date.now();
        if (netflixSeriesList.length) {
            console.log(`✓ ${netflixSeriesList.length} Netflix sorozat betöltve`);
        }
    }
    return netflixSeriesList;
}

function loadMaxMoviesFromFile() {
    try {
        if (!fs.existsSync(MAX_MOVIES_DATA_PATH)) return [];
        const raw = fs.readFileSync(MAX_MOVIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a max_movies.json betöltésekor:', err.message);
        return maxMoviesList;
    }
}

function getMaxMoviesList() {
    if (!maxMoviesLoadedAt || (Date.now() - maxMoviesLoadedAt > MAX_CATALOG_TTL)) {
        maxMoviesList = loadMaxMoviesFromFile();
        maxMoviesLoadedAt = Date.now();
        if (maxMoviesList.length) console.log(`✓ ${maxMoviesList.length} Max film betöltve`);
    }
    return maxMoviesList;
}

function loadMaxSeriesFromFile() {
    try {
        if (!fs.existsSync(MAX_SERIES_DATA_PATH)) return [];
        const raw = fs.readFileSync(MAX_SERIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a max_series.json betöltésekor:', err.message);
        return maxSeriesList;
    }
}

function getMaxSeriesList() {
    if (!maxSeriesLoadedAt || (Date.now() - maxSeriesLoadedAt > MAX_CATALOG_TTL)) {
        maxSeriesList = loadMaxSeriesFromFile();
        maxSeriesLoadedAt = Date.now();
        if (maxSeriesList.length) console.log(`✓ ${maxSeriesList.length} Max sorozat betöltve`);
    }
    return maxSeriesList;
}

function loadDisneyPlusMoviesFromFile() {
    try {
        if (!fs.existsSync(DISNEYPLUS_MOVIES_DATA_PATH)) return [];
        const raw = fs.readFileSync(DISNEYPLUS_MOVIES_DATA_PATH, 'utf-8');
        return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
    } catch (err) {
        console.error('Hiba a disneyplus_movies.json betöltésekor:', err.message);
        return disneyplusMoviesList;
    }
}
function getDisneyPlusMoviesList() {
    if (!disneyplusMoviesLoadedAt || (Date.now() - disneyplusMoviesLoadedAt > STREAMING_CATALOG_TTL)) {
        disneyplusMoviesList = loadDisneyPlusMoviesFromFile();
        disneyplusMoviesLoadedAt = Date.now();
        if (disneyplusMoviesList.length) console.log(`✓ ${disneyplusMoviesList.length} Disney+ film betöltve`);
    }
    return disneyplusMoviesList;
}
function loadDisneyPlusSeriesFromFile() {
    try {
        if (!fs.existsSync(DISNEYPLUS_SERIES_DATA_PATH)) return [];
        const raw = fs.readFileSync(DISNEYPLUS_SERIES_DATA_PATH, 'utf-8');
        return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
    } catch (err) {
        console.error('Hiba a disneyplus_series.json betöltésekor:', err.message);
        return disneyplusSeriesList;
    }
}
function getDisneyPlusSeriesList() {
    if (!disneyplusSeriesLoadedAt || (Date.now() - disneyplusSeriesLoadedAt > STREAMING_CATALOG_TTL)) {
        disneyplusSeriesList = loadDisneyPlusSeriesFromFile();
        disneyplusSeriesLoadedAt = Date.now();
        if (disneyplusSeriesList.length) console.log(`✓ ${disneyplusSeriesList.length} Disney+ sorozat betöltve`);
    }
    return disneyplusSeriesList;
}
const TRENDING_CATALOG_TTL = 6 * 60 * 60 * 1000; // 6 hours
function loadTrendingMoviesFromFile() {
    try {
        if (!fs.existsSync(TRENDING_MOVIES_DATA_PATH)) return [];
        const raw = fs.readFileSync(TRENDING_MOVIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a trending_movies.json betöltésekor:', err.message);
        return trendingMoviesList;
    }
}
function getTrendingMoviesList() {
    if (!trendingMoviesLoadedAt || (Date.now() - trendingMoviesLoadedAt > TRENDING_CATALOG_TTL)) {
        trendingMoviesList = loadTrendingMoviesFromFile();
        trendingMoviesLoadedAt = Date.now();
        if (trendingMoviesList.length) console.log(`✓ ${trendingMoviesList.length} trendi film betöltve`);
    }
    return trendingMoviesList;
}
function loadTrendingSeriesFromFile() {
    try {
        if (!fs.existsSync(TRENDING_SERIES_DATA_PATH)) return [];
        const raw = fs.readFileSync(TRENDING_SERIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a trending_series.json betöltésekor:', err.message);
        return trendingSeriesList;
    }
}
function getTrendingSeriesList() {
    if (!trendingSeriesLoadedAt || (Date.now() - trendingSeriesLoadedAt > TRENDING_CATALOG_TTL)) {
        trendingSeriesList = loadTrendingSeriesFromFile();
        trendingSeriesLoadedAt = Date.now();
        if (trendingSeriesList.length) console.log(`✓ ${trendingSeriesList.length} trendi sorozat betöltve`);
    }
    return trendingSeriesList;
}

// Catalog handler for both movies and series
builder.defineCatalogHandler(async (args) => {
    console.log(`Katalógus kérés: ${args.type}/${args.id}`);

    // Trending movies (most seeded in last N pages, 1080p HD_HUN)
    if (args.type === 'movie' && args.id === 'ncore-trending-movies') {
        const list = getTrendingMoviesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }
    // Trending series (most seeded in last N pages, 1080p HDSER_HUN)
    if (args.type === 'series' && args.id === 'ncore-trending-series') {
        const list = getTrendingSeriesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Handle movie catalog - Latest HD movies
    if (args.type === 'movie' && args.id === 'ncore-hd-movies') {
        const list = getHDMoviesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Handle series catalog – plain tt ids so Stremio displays our meta (response id must match request)
    if (args.type === 'series' && args.id === 'ncore-hd-series') {
        const list = getHDSeriesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
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

    // Netflix movies
    if (args.type === 'movie' && args.id === 'ncore-netflix-movies') {
        const list = getNetflixMoviesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Netflix series
    if (args.type === 'series' && args.id === 'ncore-netflix-series') {
        const list = getNetflixSeriesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Max movies / series
    if (args.type === 'movie' && args.id === 'ncore-max-movies') {
        const list = getMaxMoviesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }
    if (args.type === 'series' && args.id === 'ncore-max-series') {
        const list = getMaxSeriesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Disney+ movies / series
    if (args.type === 'movie' && args.id === 'ncore-disneyplus-movies') {
        const list = getDisneyPlusMoviesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }
    if (args.type === 'series' && args.id === 'ncore-disneyplus-series') {
        const list = getDisneyPlusSeriesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    return Promise.resolve({ metas: [] });
});

// Normalize IMDB id for comparison (tt123 vs 123); canonical form tt + 7 digits so tt175058 === tt0175058
function normalizeId(id) {
    if (!id || typeof id !== 'string') return '';
    const s = String(id).trim();
    const withTt = s.startsWith('tt') ? s : 'tt' + s;
    const num = withTt.replace(/^tt/, '');
    const digits = num.replace(/\D/g, '') || '0';
    const padded = digits.padStart(7, '0');
    return 'tt' + padded;
}

// Ensure meta has a background URL for the Stremio detail page (all catalogs)
function ensureBackground(meta) {
    if (!meta || meta.background) return meta;
    const id = meta.id && String(meta.id).trim();
    if (!id) return meta;
    const metaOut = { ...meta };
    metaOut.background = `https://images.metahub.space/background/medium/${id}/img`;
    return metaOut;
}

// Meta handler for both movies and series (all catalogs so detail view keeps our metadata)
builder.defineMetaHandler(async (args) => {
    const requestId = args.id && String(args.id).trim();
    console.log(`Meta kérés: ${args.type}/${requestId}`);
    if (!requestId) return Promise.resolve({ meta: null });

    try {
        // Series can be tt12345 or tt12345:1:1; extract series id for lookup
        let idForLookup = requestId;
        if (args.type === 'series' && requestId.indexOf(':') >= 0) {
            idForLookup = requestId.split(':')[0];
        } else if (args.type === 'movie' && requestId.indexOf(':') >= 0) {
            idForLookup = requestId.split(':')[0];
        }
        const idNorm = normalizeId(idForLookup);

        if (args.type === 'movie') {
            const matchId = (m) => normalizeId(m.id) === idNorm;
            const movie = getTrendingMoviesList().find(matchId)
                || getHDMoviesList().find(matchId)
                || getTopSeededMoviesList().find(matchId)
                || getTopSeededHungarianProductionsList().find(matchId)
                || getNetflixMoviesList().find(matchId)
                || getMaxMoviesList().find(matchId)
                || getDisneyPlusMoviesList().find(matchId);
            if (movie) {
                const meta = ensureBackground({ ...movie, id: requestId });
                return Promise.resolve({ meta });
            }
        }

        if (args.type === 'series') {
            if (SERIES_META_DELAY_MS > 0) {
                await new Promise((r) => setTimeout(r, SERIES_META_DELAY_MS));
            }
            const seriesId = (s) => normalizeId(s.id || s.imdb_id || '') === idNorm;
            const trending = getTrendingSeriesList().find(seriesId);
            const hd = getHDSeriesList().find(seriesId);
            const top = getTopSeededSeriesList().find(seriesId);
            const topHu = getTopSeededHungarianProductionsSeriesList().find(seriesId);
            const netflix = getNetflixSeriesList().find(seriesId);
            const max = getMaxSeriesList().find(seriesId);
            const disneyplus = getDisneyPlusSeriesList().find(seriesId);
            const series = trending || hd || top || topHu || netflix || max || disneyplus;
            if (series) {
                const sid = series.id || series.imdb_id;
                if (!sid) {
                    console.log(`Series meta: nincs id, kihagyva: ${requestId}`);
                    return Promise.resolve({ meta: null });
                }
                const withBackground = ensureBackground(series);
                let videos = (series.videos && series.videos.length) ? series.videos : null;
                if (!videos || videos.length === 0) {
                    try {
                        videos = await getSeriesVideosFromTMDB(sid);
                    } catch (err) {
                        console.error('getSeriesVideosFromTMDB hiba:', err.message);
                    }
                }
                const metaOut = {
                    id: requestId,
                    type: 'series',
                    name: series.name || '',
                    poster: series.poster || '',
                    posterShape: series.posterShape || 'poster',
                    year: series.year,
                    description: series.description || '',
                    imdbRating: series.imdbRating,
                    releaseInfo: series.releaseInfo,
                    genres: Array.isArray(series.genres) ? series.genres : [],
                    background: withBackground.background || '',
                    videos: Array.isArray(videos) && videos.length > 0 ? videos : []
                };
                console.log(`Series meta küldve: ${metaOut.name} (${requestId})`);
                return Promise.resolve({ meta: metaOut });
            }
            console.log(`Series nem található katalógusban: idNorm=${idNorm}, requestId=${requestId}`);
        }
    } catch (err) {
        console.error('Meta handler hiba:', err.message);
    }
    return Promise.resolve({ meta: null });
});

// Export the builder and stats for health endpoint
builder.getStats = () => ({
    hdMoviesCount: getHDMoviesList().length,
    hdSeriesCount: getHDSeriesList().length,
    topSeededByGenreCount: getTopSeededMoviesList().length,
    topSeededHungarianProductionsCount: getTopSeededHungarianProductionsList().length,
    topSeededSeriesCount: getTopSeededSeriesList().length,
    topSeededHungarianProductionsSeriesCount: getTopSeededHungarianProductionsSeriesList().length,
    netflixMoviesCount: getNetflixMoviesList().length,
    netflixSeriesCount: getNetflixSeriesList().length,
    maxMoviesCount: getMaxMoviesList().length,
    maxSeriesCount: getMaxSeriesList().length,
    disneyplusMoviesCount: getDisneyPlusMoviesList().length,
    disneyplusSeriesCount: getDisneyPlusSeriesList().length,
    trendingMoviesCount: getTrendingMoviesList().length,
    trendingSeriesCount: getTrendingSeriesList().length
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
