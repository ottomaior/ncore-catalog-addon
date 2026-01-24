const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
require('dotenv').config({ path: '../config/config.env' });

// Trakt API configuration
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_USERNAME = process.env.TRAKT_USERNAME;
const MOVIE_LIST_SLUG = process.env.TRAKT_LIST_SLUG;

// Addon manifest
const manifest = {
    id: 'com.ncore.hungarian.addon',
    version: '1.0.0',
    name: 'nCore Hungarian HD',
    description: 'Hungarian HD Movies from nCore tracker synced via Trakt',
    resources: ['catalog', 'meta'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'ncore-hun-movies',
            name: 'nCore HUN Movies',
            extra: [{ name: 'skip', isRequired: false }]
        }
    ],
    idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// Cache for catalog data
let movieCache = [];
let lastUpdate = null;
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

// Fetch movies from Trakt list
async function fetchTraktList() {
    try {
        console.log('Fetching Trakt list...');
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
                // Remove 'tt' prefix if it exists, then add it back once
                imdbId = imdbId.replace(/^tt/, '');
                
                return {
                    id: `tt${imdbId}`,
                    type: 'movie',
                    name: movie.title,
                    poster: `https://images.metahub.space/poster/small/tt${imdbId}/img`,
                    posterShape: 'poster',
                    year: movie.year,
                    description: movie.overview || 'Hungarian HD release from nCore',
                    imdbRating: movie.rating ? movie.rating.toFixed(1) : null,
                    releaseInfo: movie.year ? movie.year.toString() : null,
                    genres: movie.genres || []
                };
            });

        movieCache = movies;
        lastUpdate = Date.now();
        console.log(`✓ Cached ${movies.length} movies from Trakt list (with valid IMDB IDs)`);
        
        const totalItems = response.data.length;
        const filtered = totalItems - movies.length;
        if (filtered > 0) {
            console.log(`⚠ Filtered out ${filtered} movies without IMDB IDs`);
        }
        
        return movies;

    } catch (error) {
        console.error('Error fetching Trakt list:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        return movieCache;
    }
}

// Catalog handler
builder.defineCatalogHandler(async (args) => {
    console.log(`Catalog request: ${args.type}/${args.id}`);

    // Check if cache needs refresh
    if (!lastUpdate || (Date.now() - lastUpdate > CACHE_TTL)) {
        await fetchTraktList();
    }

    // Apply pagination
    const skip = parseInt(args.extra?.skip) || 0;
    const metas = movieCache.slice(skip, skip + 100);

    return Promise.resolve({ metas });
});

// Meta handler (for individual movie details)
builder.defineMetaHandler(async (args) => {
    console.log(`Meta request: ${args.type}/${args.id}`);

    const movie = movieCache.find(m => m.id === args.id);
    
    if (movie) {
        return Promise.resolve({ meta: movie });
    }

    return Promise.resolve({ meta: null });
});

// Initialize cache on startup
fetchTraktList();

// Auto-refresh every 3 hours
setInterval(fetchTraktList, CACHE_TTL);

// Start server
const PORT = process.env.ADDON_PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });

console.log(`\n${'='.repeat(60)}`);
console.log(`🎬 nCore Stremio Addon Running`);
console.log(`${'='.repeat(60)}`);
console.log(`\n📍 Local: http://localhost:${PORT}/manifest.json`);
console.log(`🌐 Install: http://localhost:${PORT}/manifest.json`);
console.log(`📋 Catalog: http://localhost:${PORT}/catalog/movie/ncore-hun-movies.json\n`);
console.log(`${'='.repeat(60)}\n`);
