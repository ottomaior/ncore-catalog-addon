const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
require('dotenv').config({ path: './config/config.env' });
const fs = require('fs');
const path = require('path');

// Trakt API configuration
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_USERNAME = process.env.TRAKT_USERNAME;
const MOVIE_LIST_SLUG = process.env.TRAKT_LIST_SLUG;

// Path to episode tracker
const EPISODE_TRACKER_PATH = path.join(__dirname, 'scripts', 'series_episodes_seen.json');

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
            id: "ncore-hd-movies",
            type: "movie",
            name: "nCore – Utoljára feltöltött",
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
            name: "nCore – Utoljára feltöltött",
            extra: [
                {
                    name: "skip",
                    isRequired: false
                }
            ]
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
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

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

        const movies = response.data
            .filter(item => item.movie.ids.imdb)
            .map(item => {
                const movie = item.movie;
                let imdbId = movie.ids.imdb.toString();
                imdbId = imdbId.replace(/^tt/, '');

                return {
                    id: `tt${imdbId}`,
                    type: 'movie',
                    name: movie.title,
                    poster: `https://images.metahub.space/poster/small/tt${imdbId}/img`,
                    posterShape: 'poster',
                    year: movie.year,
                    description: movie.overview || 'Magyar HD feltöltés az nCore trackerről',
                    imdbRating: movie.rating ? movie.rating.toFixed(1) : null,
                    releaseInfo: movie.year ? movie.year.toString() : null,
                    genres: movie.genres || []
                };
            });

        movieCache = movies;
        lastMovieUpdate = Date.now();
        console.log(`✓ ${movies.length} film gyorsítótárazva`);

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

        const series = response.data
            .filter(item => item.show.ids.imdb)
            .map(item => {
                const show = item.show;
                let imdbId = show.ids.imdb.toString();
                imdbId = imdbId.replace(/^tt/, '');

                 // Get episode info from tracker
                const traktId = show.ids.trakt;
                const episodeInfo = getEpisodeInfo(traktId);
                const displayName = episodeInfo ? `${show.title} (${episodeInfo} HUN)` : show.title;


                return {
                    id: `tt${imdbId}`,
                    type: 'series',
                    name: displayName,
                    poster: `https://images.metahub.space/poster/small/tt${imdbId}/img`,
                    posterShape: 'poster',
                    year: show.year,
                    description: show.overview || 'Magyar HD sorozat az nCore trackerről',
                    imdbRating: show.rating ? show.rating.toFixed(1) : null,
                    releaseInfo: show.year ? show.year.toString() : null,
                    genres: show.genres || []
                };
            });

        seriesCache = series;
        lastSeriesUpdate = Date.now();
        console.log(`✓ ${series.length} sorozat gyorsítótárazva`);

        const totalItems = response.data.length;
        const filtered = totalItems - series.length;
        if (filtered > 0) {
            console.log(`⚠ ${filtered} sorozat kiszűrve (nincs IMDB ID)`);
        }

        return series;

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

    return Promise.resolve({ metas: [] });
});

// Meta handler for both movies and series
builder.defineMetaHandler(async (args) => {
    console.log(`Meta kérés: ${args.type}/${args.id}`);

    if (args.type === 'movie') {
        const movie = movieCache.find(m => m.id === args.id);
        if (movie) {
            return Promise.resolve({ meta: movie });
        }
    }

    if (args.type === 'series') {
        const series = seriesCache.find(s => s.id === args.id);
        if (series) {
            return Promise.resolve({ meta: series });
        }
    }

    return Promise.resolve({ meta: null });
});

// Initialize both caches on startup
fetchTraktList();
fetchTraktSeriesList();

// Auto-refresh every 3 hours
setInterval(() => {
    fetchTraktList();
    fetchTraktSeriesList();
}, CACHE_TTL);

// Start server
const PORT = process.env.ADDON_PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });

// Start server
const PORT = process.env.ADDON_PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });

console.log(`\n${'='.repeat(60)}`);
console.log(`🎬 nCore Stremio Addon Fut`);
console.log(`${'='.repeat(60)}`);
console.log(`\n📍 Helyi: http://localhost:${PORT}/manifest.json`);
console.log(`🌐 Telepítés: http://localhost:${PORT}/manifest.json`);
console.log(`📋 Filmek: http://localhost:${PORT}/catalog/movie/ncore-hd-movies.json`);
console.log(`📺 Sorozatok: http://localhost:${PORT}/catalog/series/ncore-hd-series.json\n`);
console.log(`${'='.repeat(60)}\n`);

// ===== ADD THIS SECTION BELOW =====

// Start cron scheduler
const { exec } = require('child_process');
const cron = require('node-cron');

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
    exec('cd scripts && python sync_series_rss_to_trakt.py', (error, stdout, stderr) => {
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

console.log(`\n${'='.repeat(60)}`);
console.log(`🎬 nCore Stremio Addon Fut`);
console.log(`${'='.repeat(60)}`);
console.log(`\n📍 Helyi: http://localhost:${PORT}/manifest.json`);
console.log(`🌐 Telepítés: http://localhost:${PORT}/manifest.json`);
console.log(`📋 Filmek: http://localhost:${PORT}/catalog/movie/ncore-hd-movies.json`);
console.log(`📺 Sorozatok: http://localhost:${PORT}/catalog/series/ncore-hd-series.json\n`);
console.log(`${'='.repeat(60)}\n`);
