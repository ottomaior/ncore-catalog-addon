const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
require('dotenv').config({ path: './config/config.env' });
const fs = require('fs');
const path = require('path');

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
// Path to Netflix movies catalog
const NETFLIX_MOVIES_DATA_PATH = path.join(__dirname, 'data', 'netflix_movies.json');
// Path to Netflix series catalog
const NETFLIX_SERIES_DATA_PATH = path.join(__dirname, 'data', 'netflix_series.json');
// Path to HBO Max movies catalog
const HBOMAX_MOVIES_DATA_PATH = path.join(__dirname, 'data', 'hbomax_movies.json');
// Path to HBO Max series catalog
const HBOMAX_SERIES_DATA_PATH = path.join(__dirname, 'data', 'hbomax_series.json');
// Path to Prime Video movies catalog
const PRIMEVIDEO_MOVIES_DATA_PATH = path.join(__dirname, 'data', 'primevideo_movies.json');
// Path to Prime Video series catalog
const PRIMEVIDEO_SERIES_DATA_PATH = path.join(__dirname, 'data', 'primevideo_series.json');
// Path to latest HD movies catalog
const HD_MOVIES_DATA_PATH = path.join(__dirname, 'data', 'hd_movies.json');
// Path to latest HD series catalog
const HD_SERIES_DATA_PATH = path.join(__dirname, 'data', 'hd_series.json');

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
    resources: ['catalog', 'meta'],
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
            id: "ncore-hbomax-movies",
            type: "movie",
            name: "⏰ HBO Max filmek",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-hbomax-series",
            type: "series",
            name: "⏰ HBO Max sorozatok",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-primevideo-movies",
            type: "movie",
            name: "⏰ Prime Video filmek",
            extra: [{ name: "skip", isRequired: false }]
        },
        {
            id: "ncore-primevideo-series",
            type: "series",
            name: "⏰ Prime Video sorozatok",
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
let hbomaxMoviesList = [];
let hbomaxMoviesLoadedAt = null;
let hbomaxSeriesList = [];
let hbomaxSeriesLoadedAt = null;
let primevideoMoviesList = [];
let primevideoMoviesLoadedAt = null;
let primevideoSeriesList = [];
let primevideoSeriesLoadedAt = null;
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours
const TOP_SEEDED_CATALOG_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
const NETFLIX_CATALOG_TTL = 6 * 60 * 60 * 1000; // 6 hours
const HBOMAX_CATALOG_TTL = 6 * 60 * 60 * 1000; // 6 hours
const PRIMEVIDEO_CATALOG_TTL = 6 * 60 * 60 * 1000; // 6 hours

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

function loadHBOMaxMoviesFromFile() {
    try {
        if (!fs.existsSync(HBOMAX_MOVIES_DATA_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(HBOMAX_MOVIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a hbomax_movies.json betöltésekor:', err.message);
        return hbomaxMoviesList;
    }
}

function getHBOMaxMoviesList() {
    if (!hbomaxMoviesLoadedAt || (Date.now() - hbomaxMoviesLoadedAt > HBOMAX_CATALOG_TTL)) {
        hbomaxMoviesList = loadHBOMaxMoviesFromFile();
        hbomaxMoviesLoadedAt = Date.now();
        if (hbomaxMoviesList.length) {
            console.log(`✓ ${hbomaxMoviesList.length} HBO Max film betöltve`);
        }
    }
    return hbomaxMoviesList;
}

function loadHBOMaxSeriesFromFile() {
    try {
        if (!fs.existsSync(HBOMAX_SERIES_DATA_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(HBOMAX_SERIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a hbomax_series.json betöltésekor:', err.message);
        return hbomaxSeriesList;
    }
}

function getHBOMaxSeriesList() {
    if (!hbomaxSeriesLoadedAt || (Date.now() - hbomaxSeriesLoadedAt > HBOMAX_CATALOG_TTL)) {
        hbomaxSeriesList = loadHBOMaxSeriesFromFile();
        hbomaxSeriesLoadedAt = Date.now();
        if (hbomaxSeriesList.length) {
            console.log(`✓ ${hbomaxSeriesList.length} HBO Max sorozat betöltve`);
        }
    }
    return hbomaxSeriesList;
}

function loadPrimeVideoMoviesFromFile() {
    try {
        if (!fs.existsSync(PRIMEVIDEO_MOVIES_DATA_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(PRIMEVIDEO_MOVIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a primevideo_movies.json betöltésekor:', err.message);
        return primevideoMoviesList;
    }
}

function getPrimeVideoMoviesList() {
    if (!primevideoMoviesLoadedAt || (Date.now() - primevideoMoviesLoadedAt > PRIMEVIDEO_CATALOG_TTL)) {
        primevideoMoviesList = loadPrimeVideoMoviesFromFile();
        primevideoMoviesLoadedAt = Date.now();
        if (primevideoMoviesList.length) {
            console.log(`✓ ${primevideoMoviesList.length} Prime Video film betöltve`);
        }
    }
    return primevideoMoviesList;
}

function loadPrimeVideoSeriesFromFile() {
    try {
        if (!fs.existsSync(PRIMEVIDEO_SERIES_DATA_PATH)) {
            return [];
        }
        const raw = fs.readFileSync(PRIMEVIDEO_SERIES_DATA_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('Hiba a primevideo_series.json betöltésekor:', err.message);
        return primevideoSeriesList;
    }
}

function getPrimeVideoSeriesList() {
    if (!primevideoSeriesLoadedAt || (Date.now() - primevideoSeriesLoadedAt > PRIMEVIDEO_CATALOG_TTL)) {
        primevideoSeriesList = loadPrimeVideoSeriesFromFile();
        primevideoSeriesLoadedAt = Date.now();
        if (primevideoSeriesList.length) {
            console.log(`✓ ${primevideoSeriesList.length} Prime Video sorozat betöltve`);
        }
    }
    return primevideoSeriesList;
}

// Catalog handler for both movies and series
builder.defineCatalogHandler(async (args) => {
    console.log(`Katalógus kérés: ${args.type}/${args.id}`);

    // Handle movie catalog - Latest HD movies
    if (args.type === 'movie' && args.id === 'ncore-hd-movies') {
        const list = getHDMoviesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Handle series catalog - Latest HD series
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

    // HBO Max movies
    if (args.type === 'movie' && args.id === 'ncore-hbomax-movies') {
        const list = getHBOMaxMoviesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // HBO Max series
    if (args.type === 'series' && args.id === 'ncore-hbomax-series') {
        const list = getHBOMaxSeriesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Prime Video movies
    if (args.type === 'movie' && args.id === 'ncore-primevideo-movies') {
        const list = getPrimeVideoMoviesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    // Prime Video series
    if (args.type === 'series' && args.id === 'ncore-primevideo-series') {
        const list = getPrimeVideoSeriesList();
        const skip = parseInt(args.extra?.skip) || 0;
        return Promise.resolve({ metas: list.slice(skip, skip + 100) });
    }

    return Promise.resolve({ metas: [] });
});

// Meta handler for both movies and series (includes most-seeded caches)
builder.defineMetaHandler(async (args) => {
    console.log(`Meta kérés: ${args.type}/${args.id}`);

    if (args.type === 'movie') {
        const movie = getHDMoviesList().find(m => m.id === args.id)
            || getTopSeededMoviesList().find(m => m.id === args.id)
            || getTopSeededHungarianProductionsList().find(m => m.id === args.id)
            || getNetflixMoviesList().find(m => m.id === args.id);
        if (movie) {
            return Promise.resolve({ meta: movie });
        }
    }

    if (args.type === 'series') {
        const series = getHDSeriesList().find(s => s.id === args.id)
            || getTopSeededSeriesList().find(s => s.id === args.id)
            || getTopSeededHungarianProductionsSeriesList().find(s => s.id === args.id)
            || getNetflixSeriesList().find(s => s.id === args.id);
        if (series) {
            return Promise.resolve({ meta: series });
        }
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
    hbomaxMoviesCount: getHBOMaxMoviesList().length,
    hbomaxSeriesCount: getHBOMaxSeriesList().length,
    primevideoMoviesCount: getPrimeVideoMoviesList().length,
    primevideoSeriesCount: getPrimeVideoSeriesList().length
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
