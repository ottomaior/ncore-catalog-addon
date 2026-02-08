/**
 * Hungarian Trailer Provider
 * Fallback: HU dubbed (TMDB → YouTube) → HU subtitled (TMDB → YouTube) → EN (TMDB → YouTube)
 */

require('dotenv').config({ path: './config/config.env' });
const fetch = require('node-fetch');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_KEY = process.env.TMDB_API_KEY;

// Hungarian keywords: dubbed vs subtitled
const HU_KEYWORDS = {
    dubbed: 'magyar szinkron előzetes',
    dubbedAlt: 'magyar szinkron trailer',
    dubbedShort: 'szinkronos előzetes',
    subtitled: 'magyar felirat előzetes',
    subtitledAlt: 'magyar felirat trailer',
    subtitledShort: 'feliratos előzetes',
    season: 'évad',
    official: 'hivatalos előzetes'
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
 * Normalize for comparison: remove punctuation, extra spaces, articles
 */
function normalizeForMatch(str) {
    return str
        .toLowerCase()
        .replace(/[^\w\sáéíóöőúüű]/g, ' ')
        .replace(/\s+(a|an|the|az|egy)\s+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Validate that a YouTube video title is about this content (strict).
 * Requires a meaningful overlap so we don't return random trailers.
 */
function validateTitle(videoTitle, contentName) {
    if (!videoTitle || !contentName) return false;
    const titleNorm = normalizeForMatch(videoTitle);
    const contentNorm = normalizeForMatch(contentName);
    if (titleNorm.length < 3 || contentNorm.length < 2) return false;

    const contentWords = contentNorm.split(/\s+/).filter(w => w.length > 1);
    if (contentWords.length === 0) return false;

    // Must contain at least the first significant word (often the title)
    const firstWord = contentWords[0];
    if (!titleNorm.includes(firstWord)) return false;

    // For single-word titles, require exact or very close match
    if (contentWords.length === 1) {
        return titleNorm.includes(firstWord) && titleNorm.length < 80;
    }

    // Require at least 2 words from content name, or full name if short
    let matchCount = 0;
    for (const w of contentWords) {
        if (w.length >= 2 && titleNorm.includes(w)) matchCount++;
    }
    const minRequired = Math.min(2, contentWords.length);
    return matchCount >= minRequired;
}

/**
 * Score a video title for relevance (higher = better). Used to pick best of multiple results.
 */
function scoreTitleMatch(videoTitle, contentName) {
    if (!validateTitle(videoTitle, contentName)) return -1;
    const titleNorm = normalizeForMatch(videoTitle);
    const contentNorm = normalizeForMatch(contentName);
    const contentWords = contentNorm.split(/\s+/).filter(w => w.length > 1);

    let score = 0;
    for (const w of contentWords) {
        if (titleNorm.includes(w)) score += 1;
    }
    // Prefer "előzetes" / "trailer" in title
    if (/\b(előzetes|trailer|teaser)\b/i.test(videoTitle)) score += 2;
    // Prefer "hivatalos" / "official"
    if (/\b(hivatalos|official)\b/i.test(videoTitle)) score += 1;
    // Penalize very long titles (often wrong or compilation)
    if (videoTitle.length > 80) score -= 1;
    return score;
}

/**
 * Unescape JSON string in YouTube HTML
 */
function unescapeYtTitle(s) {
    if (typeof s !== 'string') return '';
    return s
        .replace(/\\u0026/g, '&')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

/**
 * Extract multiple (videoId, title) from YouTube search HTML.
 * Tries ytInitialData first, then regex fallback for "videoId" + "text" pairs.
 */
function parseYouTubeSearchResults(html) {
    const results = [];
    const seenIds = new Set();

    // Method 1: ytInitialData JSON (most reliable)
    const ytStart = html.indexOf('var ytInitialData = ');
    if (ytStart !== -1) {
        const braceStart = html.indexOf('{', ytStart);
        if (braceStart !== -1) {
            let depth = 0;
            let end = braceStart;
            for (let i = braceStart; i < html.length; i++) {
                if (html[i] === '{') depth++;
                else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
            }
            const jsonStr = html.slice(braceStart, end);
            try {
                const data = JSON.parse(jsonStr);
                const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
                for (const section of contents) {
                    const items = section?.itemSectionRenderer?.contents || [];
                    for (const item of items) {
                        const vr = item?.videoRenderer;
                        if (!vr?.videoId) continue;
                        const title = vr?.title?.runs?.[0]?.text || vr?.title?.simpleText || '';
                        if (title && !seenIds.has(vr.videoId)) {
                            seenIds.add(vr.videoId);
                            results.push({ ytId: vr.videoId, title: unescapeYtTitle(title) });
                        }
                    }
                }
            } catch (e) {
                // ignore parse error, fall back to regex
            }
        }
    }

    // Method 2: regex for "videoId":"xxx" and nearby "text":"Title"
    if (results.length === 0) {
        const videoBlocks = html.split('"videoId":"');
        for (let i = 1; i < Math.min(videoBlocks.length, 15); i++) {
            const block = videoBlocks[i];
            const idMatch = block.match(/^([a-zA-Z0-9_-]{11})/);
            if (!idMatch) continue;
            const ytId = idMatch[1];
            if (seenIds.has(ytId)) continue;

            const textMatch = block.match(/"text":\s*"((?:[^"\\]|\\.)*)"/);
            const title = textMatch ? unescapeYtTitle(textMatch[1]) : '';
            if (title.length > 2 && title.length < 120) {
                seenIds.add(ytId);
                results.push({ ytId, title });
            }
        }
    }

    return results;
}

/**
 * Search YouTube and return multiple results, then pick best match by score.
 */
async function searchYouTube(query, contentNameForScore = null) {
    try {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://www.youtube.com/results?search_query=${encodedQuery}`;

        console.log(`[Trailers] YouTube: ${query}`);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8'
            }
        });

        if (!response.ok) return null;

        const html = await response.text();
        const candidates = parseYouTubeSearchResults(html);
        if (candidates.length === 0) return null;

        // If we have a content name, pick the best-scoring valid result
        if (contentNameForScore) {
            let best = null;
            let bestScore = -1;
            for (const c of candidates) {
                const score = scoreTitleMatch(c.title, contentNameForScore);
                if (score > bestScore) {
                    bestScore = score;
                    best = c;
                }
            }
            if (best && bestScore >= 0) {
                console.log(`[Trailers] Found: "${best.title}" (${best.ytId}) [score=${bestScore}]`);
                return { ytId: best.ytId, title: best.title };
            }
        }

        // Fallback: first result that validates (if content name provided) or just first
        if (contentNameForScore) {
            const firstValid = candidates.find(c => validateTitle(c.title, contentNameForScore));
            if (firstValid) {
                console.log(`[Trailers] Found: "${firstValid.title}" (${firstValid.ytId})`);
                return { ytId: firstValid.ytId, title: firstValid.title };
            }
            return null;
        }
        const first = candidates[0];
        console.log(`[Trailers] Found: "${first.title}" (${first.ytId})`);
        return { ytId: first.ytId, title: first.title };
    } catch (e) {
        console.error('[Trailers] YouTube error:', e.message);
        return null;
    }
}

/**
 * Search Hungarian DUBBED trailer on YouTube (magyar szinkron)
 */
async function searchHungarianDubbedTrailer(contentName, type, season, year) {
    const base = (y) => `${contentName} ${(y || '').toString().trim()}`.trim();
    let queries = [];

    if (type === 'series' && season !== undefined && season > 0) {
        queries = [
            `${contentName} ${season}. ${HU_KEYWORDS.season} ${HU_KEYWORDS.dubbed}`,
            `${contentName} ${season} évad ${HU_KEYWORDS.dubbedAlt}`,
            `${contentName} ${year || ''} ${HU_KEYWORDS.dubbed} ${season}. évad`.trim(),
            `${contentName} season ${season} ${HU_KEYWORDS.dubbed}`
        ];
    } else {
        queries = [
            base(year) + ' ' + HU_KEYWORDS.dubbed,
            base(year) + ' ' + HU_KEYWORDS.dubbedAlt,
            base(year) + ' ' + HU_KEYWORDS.dubbedShort,
            base(year) + ' ' + HU_KEYWORDS.official + ' magyar szinkron'
        ].map(q => q.trim()).filter(q => q.length > 3);
    }

    for (const query of queries) {
        const result = await searchYouTube(query, contentName);
        if (result) {
            console.log(`[Trailers] ✓ HU dubbed YouTube: "${result.title}"`);
            return result;
        }
    }
    return null;
}

/**
 * Search Hungarian SUBTITLED trailer on YouTube (magyar felirat)
 */
async function searchHungarianSubtitledTrailer(contentName, type, season, year) {
    const base = (y) => `${contentName} ${(y || '').toString().trim()}`.trim();
    let queries = [];

    if (type === 'series' && season !== undefined && season > 0) {
        queries = [
            `${contentName} ${season}. ${HU_KEYWORDS.season} ${HU_KEYWORDS.subtitled}`,
            `${contentName} ${season} évad ${HU_KEYWORDS.subtitledAlt}`,
            `${contentName} season ${season} ${HU_KEYWORDS.subtitled}`
        ];
    } else {
        queries = [
            base(year) + ' ' + HU_KEYWORDS.subtitled,
            base(year) + ' ' + HU_KEYWORDS.subtitledAlt,
            base(year) + ' ' + HU_KEYWORDS.subtitledShort
        ].map(q => q.trim()).filter(q => q.length > 3);
    }

    for (const query of queries) {
        const result = await searchYouTube(query, contentName);
        if (result) {
            console.log(`[Trailers] ✓ HU subtitled YouTube: "${result.title}"`);
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

    const result = await searchYouTube(query, contentName);
    if (result) {
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

        const trailerResults = [];
        const seenYtIds = new Set();
        const contentNameHu = titleHu || titleEn;
        const contentNameEn = titleEn || titleHu;

        function addTrailer(entry) {
            if (!entry || seenYtIds.has(entry.ytId)) return;
            seenYtIds.add(entry.ytId);
            trailerResults.push(entry);
        }

        // --- Tier 1: Hungarian DUBBED (TMDB then YouTube) ---
        console.log('[Trailers] Step 1: TMDB hu-HU (dubbed)');
        let videos = await fetchTMDBVideos(tmdbIdNum, type, 'hu-HU', season);
        if (type === 'series' && (!videos || videos.length === 0)) {
            videos = await fetchTMDBVideos(tmdbIdNum, type, 'hu-HU');
        }
        const tmdbHu = selectBestTrailer(videos);
        if (tmdbHu) {
            console.log(`[Trailers] ✓ TMDB hu-HU: ${tmdbHu.name}`);
            addTrailer({ ytId: tmdbHu.key, title: contentNameHu, source: 'tmdb-hu', streamName: 'Előzetes (magyar, TMDB)' });
        }

        console.log('[Trailers] Step 2: YouTube HU dubbed (magyar szinkron)');
        if (contentNameHu) {
            const ytHuDub = await searchHungarianDubbedTrailer(contentNameHu, type, season, year);
            if (ytHuDub) addTrailer({ ytId: ytHuDub.ytId, title: ytHuDub.title, source: 'youtube-hu-dubbed', streamName: 'Előzetes (magyar szinkron)' });
        }

        // --- Tier 2: Hungarian SUBTITLED ---
        console.log('[Trailers] Step 3: YouTube HU subtitled (magyar felirat)');
        if (contentNameHu) {
            const ytHuSub = await searchHungarianSubtitledTrailer(contentNameHu, type, season, year);
            if (ytHuSub) addTrailer({ ytId: ytHuSub.ytId, title: ytHuSub.title, source: 'youtube-hu-subtitled', streamName: 'Előzetes (magyar felirat)' });
        }

        // --- Tier 3: EN (TMDB then YouTube) ---
        console.log('[Trailers] Step 4: TMDB en-US');
        let enVideos = await fetchTMDBVideos(tmdbIdNum, type, 'en-US', season);
        if (type === 'series' && (!enVideos || enVideos.length === 0)) {
            enVideos = await fetchTMDBVideos(tmdbIdNum, type, 'en-US');
        }
        const tmdbEn = selectBestTrailer(enVideos);
        if (tmdbEn) {
            console.log(`[Trailers] ✓ TMDB en-US: ${tmdbEn.name}`);
            addTrailer({ ytId: tmdbEn.key, title: contentNameEn, source: 'tmdb-en', streamName: 'Előzetes (angol, TMDB)' });
        }

        console.log('[Trailers] Step 5: YouTube EN');
        if (contentNameEn) {
            const ytEn = await searchEnglishTrailer(contentNameEn, type, season, year);
            if (ytEn) addTrailer({ ytId: ytEn.ytId, title: ytEn.title, source: 'youtube-en', streamName: 'Előzetes (angol, YouTube)' });
        }

        if (trailerResults.length === 0) {
            console.log('[Trailers] ✗ No trailer found');
            return [];
        }

        console.log(`[Trailers] Returning ${trailerResults.length} stream(s): ${trailerResults.map(t => t.source).join(', ')}`);

        return trailerResults.map((tr) => ({
            name: tr.streamName,
            title: tr.title,
            ytId: tr.ytId,
            behaviorHints: { notWebReady: true, bingeGroup: 'trailer-hu' }
        }));

    } catch (e) {
        console.error('[Trailers] Error:', e.message);
        return [];
    }
}

function isProviderAvailable() {
    return !!TMDB_KEY;
}

module.exports = { getHungarianTrailerStreams, isProviderAvailable };
