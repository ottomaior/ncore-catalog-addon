const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { getHungarianTrailerStreams, isProviderAvailable } = require('./trailer-provider');

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`[Magyar Előzetesek] Request: ${type} - ${id}`);

    if (!isProviderAvailable()) {
        console.warn('[Magyar Előzetesek] TMDB not configured');
        return { streams: [] };
    }

    // Parse ID
    let imdbId = null;
    let tmdbId = null;
    let season = undefined;
    let episode = undefined;

    if (id.startsWith('tmdb:')) {
        const parts = id.split(':');
        tmdbId = parseInt(parts[1], 10);
        if (parts.length >= 3) season = parseInt(parts[2], 10);
        if (parts.length >= 4) episode = parseInt(parts[3], 10);
    } else if (id.startsWith('tt')) {
        const parts = id.split(':');
        imdbId = parts[0];
        if (parts.length >= 2) season = parseInt(parts[1], 10);
        if (parts.length >= 3) episode = parseInt(parts[2], 10);
    } else if (/^\d+/.test(id)) {
        const parts = id.split(':');
        tmdbId = parseInt(parts[0], 10);
        if (parts.length >= 2) season = parseInt(parts[1], 10);
        if (parts.length >= 3) episode = parseInt(parts[2], 10);
    } else {
        return { streams: [] };
    }

    // For series: Show trailers for ALL episodes
    if (type === 'series') {
        console.log(`[Magyar Előzetesek] Series S${season}E${episode}`);
    }

    try {
        const streams = await getHungarianTrailerStreams(
            type === 'series' ? 'series' : 'movie',
            imdbId,
            season,
            tmdbId
        );

        console.log(`[Magyar Előzetesek] Returning ${streams.length} stream(s)`);
        return { streams };
    } catch (error) {
        console.error('[Magyar Előzetesek] Error:', error);
        return { streams: [] };
    }
});

module.exports = builder.getInterface();
