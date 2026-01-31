/**
 * Hungarian Trailer Provider
 * Flow: TMDB hu-HU → YouTube HU → TMDB en-US → YouTube EN
 */

require('dotenv').config({ path: './config/config.env' });
const fetch = require('node-fetch');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_KEY = process.env.TMDB_API_KEY;

// Hungarian keywords for search
const HU_KEYWORDS = {
    trailer: 'magyar szinkron előzetes',
    trailerAlt: 'magyar előzetes',
    season: 'évad',
    officialTrailer: 'hivatalos előzetes'
};

/**
 * Convert IMDb to TMDB and get titles
 */
async function imdbToTmdb(imdbId, type) {
    if (!TMDB_KEY) return null;

    try {
        // Get Hungarian title
        let url = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=hu-HU`;
        let response = await fetch(url);
        let data = await response.json();

        const results = type === 'series' ? data.tv_results : data.movie_results;
        if (results && results.length > 0) {
            const item = results[0];
            const titleHu = item.title || item.name || '';
            const year = item.release_date?.split('-')[0] || item.first_air_date?.split('-')[0] || '';
            
            // Get English title
            url = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=en-US`;
            response = await fetch(url);
            data = await response.json();
            const resultsEn = type === 'series' ? data.tv_results : data.movie_results;
            const titleEn = resultsEn?.[0]?.title || resultsEn?.[0]?.name || '';

            return { id: item.id, titleHu, titleEn, year };
        }
    } catch (e) {
        console.error('[Trailers] Error converting IMDb:', e.message);
    }
    return null;
}

/**
 * Fetch TMDB videos
 */
async function fetchTMDBVideos(tmdbId, type, language, season) {
    if (!TMDB_KEY) return [];

    try {
        let url;
        if (type === 'series' && season !== undefined && season > 0) {
            url = `${TMDB_BASE}/tv/${tmdbId}/season/${season}/videos?api_key=${TMDB_KEY}&language=${language}`;
        } else {
            const mediaType = type === 'series' ? 'tv' : 'movie';
            url = `${TMDB_BASE}/${mediaType}/${tmdbId}/videos?api_key=${TMDB_KEY}&language=${language}`;
        }
        
        const response = await fetch(url);
        if (!response.ok) return [];
        
        const data = await response.json();
        return data.results || [];
    } catch (e) {
        console.error('[Trailers] Error fetching TMDB videos:', e.message);
        return [];
    }
}

/**
 * Select best trailer
 */
function selectBestTrailer(videos) {
    if (!videos || videos.length === 0) return null;

    const youtubeVideos = videos.filter(v => v.site === 'YouTube');
    if (youtubeVideos.length === 0) return null;

    const typePriority = ['Trailer', 'Teaser', 'Clip'];

    for (const type of typePriority) {
        const official = youtubeVideos.find(v => v.type === type && v.official);
        if (official) return official;
    }

    for (const type of typePriority) {
        const video = youtubeVideos.find(v => v.type === type);
        if (video) return video;
    }

    return youtubeVideos[0];
}

/**
 * Validate YouTube title
 */
function validateTitle(videoTitle, contentName) {
    const titleLower = videoTitle.toLowerCase();
    const contentLower = contentName.toLowerCase();
    const cleanContent = contentLower.replace(/\s+(the|a|an)\s+/gi, ' ').trim();
    return titleLower.includes(cleanContent) || cleanContent.includes(titleLower.split(' ')[0]);
}

/**
 * Search YouTube via scraping
 */
async function searchYouTube(query) {
    try {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://www.youtube.com/results?search_query=${encodedQuery}`;

        console.log(`[Trailers] YouTube: ${query}`);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8'
            }
        });

        if (!response.ok) return null;

        const html = await response.text();
        const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        if (!videoIdMatch) return null;

        const ytId = videoIdMatch[1];

        let videoTitle = '';
        const titleMatch = html.match(/"title":\s*{\s*"runs":\s*\[\s*{\s*"text":\s*"([^"]+)"/);
        if (titleMatch) {
            videoTitle = titleMatch[1];
        } else {
            const simpleTitleMatch = html.match(/"title":\s*"([^"]+)"/);
            if (simpleTitleMatch) videoTitle = simpleTitleMatch[1];
        }

        if (!videoTitle) return null;

        videoTitle = videoTitle
            .replace(/\\u0026/g, '&')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');

        console.log(`[Trailers] Found: "${videoTitle}" (${ytId})`);
        return { ytId, title: videoTitle };
    } catch (e) {
        console.error('[Trailers] YouTube error:', e.message);
        return null;
    }
}

/**
 * Search Hungarian trailer on YouTube
 */
async function searchHungarianTrailer(contentName, type, season, year) {
    let queries = [];
    
    if (type === 'series' && season !== undefined && season > 0) {
        queries.push(
            `${contentName} ${season}. ${HU_KEYWORDS.season} ${HU_KEYWORDS.trailer}`,
            `${contentName} ${season} évad ${HU_KEYWORDS.trailerAlt}`,
            `${contentName} season ${season} ${HU_KEYWORDS.trailer}`
        );
    } else {
        queries.push(
            `${contentName} ${year || ''} ${HU_KEYWORDS.trailer}`.trim(),
            `${contentName} ${year || ''} ${HU_KEYWORDS.trailerAlt}`.trim(),
            `${contentName} ${year || ''} ${HU_KEYWORDS.officialTrailer}`.trim()
        );
    }

    for (const query of queries) {
        const result = await searchYouTube(query);
        if (result && validateTitle(result.title, contentName)) {
            console.log(`[Trailers] ✓ HU YouTube: "${result.title}"`);
            return result;
        }
    }

    return null;
}

/**
 * Search English trailer on YouTube
 */
async function searchEnglishTrailer(contentName, type, season, year) {
    let query;
    if (type === 'series' && season !== undefined && season > 0) {
        query = `${contentName} season ${season} official trailer`;
    } else {
        query = `${contentName} ${year || ''} official trailer`.trim();
    }

    const result = await searchYouTube(query);
    if (result && validateTitle(result.title, contentName)) {
        console.log(`[Trailers] ✓ EN YouTube: "${result.title}"`);
        return result;
    }

    return null;
}

/**
 * Main: Get Hungarian trailer streams
 */
async function getHungarianTrailerStreams(type, imdbId, season, tmdbId) {
    if (!TMDB_KEY) {
        console.warn('[Trailers] TMDB_KEY not configured');
        return [];
    }

    try {
        let tmdbIdNum = tmdbId;
        let titleHu = '';
        let titleEn = '';
        let year = '';

        if (!tmdbIdNum && imdbId) {
            const tmdbResult = await imdbToTmdb(imdbId, type);
            if (!tmdbResult) return [];
            tmdbIdNum = tmdbResult.id;
            titleHu = tmdbResult.titleHu;
            titleEn = tmdbResult.titleEn;
            year = tmdbResult.year;
        } else if (tmdbIdNum) {
            const mediaType = type === 'series' ? 'tv' : 'movie';
            try {
                let url = `${TMDB_BASE}/${mediaType}/${tmdbIdNum}?api_key=${TMDB_KEY}&language=hu-HU`;
                let response = await fetch(url);
                let data = await response.json();
                titleHu = data.title || data.name || '';
                year = data.release_date?.split('-')[0] || data.first_air_date?.split('-')[0] || '';

                url = `${TMDB_BASE}/${mediaType}/${tmdbIdNum}?api_key=${TMDB_KEY}&language=en-US`;
                response = await fetch(url);
                data = await response.json();
                titleEn = data.title || data.name || '';
            } catch (e) {
                console.log('[Trailers] Could not fetch titles');
            }
        }

        console.log(`[Trailers] HU="${titleHu}" EN="${titleEn}" (${year})`);

        let trailerResult = null;

        // Step 1: TMDB hu-HU
        console.log('[Trailers] Step 1: TMDB hu-HU');
        let videos = await fetchTMDBVideos(tmdbIdNum, type, 'hu-HU', season);
        if (type === 'series' && (!videos || videos.length === 0)) {
            videos = await fetchTMDBVideos(tmdbIdNum, type, 'hu-HU');
        }

        const tmdbHu = selectBestTrailer(videos);
        if (tmdbHu) {
            console.log(`[Trailers] ✓ TMDB hu-HU: ${tmdbHu.name}`);
            trailerResult = { ytId: tmdbHu.key, title: titleHu || titleEn, source: 'tmdb-hu', emoji: '🎬🇭🇺' };
        }

        // Step 2: YouTube HU
        if (!trailerResult && titleHu) {
            console.log('[Trailers] Step 2: YouTube HU');
            const ytHu = await searchHungarianTrailer(titleHu, type, season, year);
            if (ytHu) {
                trailerResult = { ytId: ytHu.ytId, title: ytHu.title, source: 'youtube-hu', emoji: '🎬▶️🇭🇺' };
            }
        }

        // Step 3: TMDB en-US
        if (!trailerResult) {
            console.log('[Trailers] Step 3: TMDB en-US');
            let enVideos = await fetchTMDBVideos(tmdbIdNum, type, 'en-US', season);
            if (type === 'series' && (!enVideos || enVideos.length === 0)) {
                enVideos = await fetchTMDBVideos(tmdbIdNum, type, 'en-US');
            }

            const tmdbEn = selectBestTrailer(enVideos);
            if (tmdbEn) {
                console.log(`[Trailers] ✓ TMDB en-US: ${tmdbEn.name}`);
                trailerResult = { ytId: tmdbEn.key, title: titleEn || titleHu, source: 'tmdb-en', emoji: '🎬🇬🇧' };
            }
        }

        // Step 4: YouTube EN
        if (!trailerResult && titleEn) {
            console.log('[Trailers] Step 4: YouTube EN');
            const ytEn = await searchEnglishTrailer(titleEn, type, season, year);
            if (ytEn) {
                trailerResult = { ytId: ytEn.ytId, title: ytEn.title, source: 'youtube-en', emoji: '🎬▶️🇬🇧' };
            }
        }

        if (!trailerResult) {
            console.log('[Trailers] ✗ No trailer found');
            return [];
        }

                let streamName = `${trailerResult.emoji} Előzetes`;

        console.log(`[Trailers] ${streamName} | ${trailerResult.title} (${trailerResult.source})`);

        // ALWAYS use external link to avoid embedding restrictions
        const stream = {
            name: streamName,
            title: trailerResult.title,
            ytId: trailerResult.ytId,
            behaviorHints: { notWebReady: true, bingeGroup: 'trailer-hu' }
        };

        return [stream];

    } catch (e) {
        console.error('[Trailers] Error:', e.message);
        return [];
    }
}

function isProviderAvailable() {
    return !!TMDB_KEY;
}

module.exports = { getHungarianTrailerStreams, isProviderAvailable };
