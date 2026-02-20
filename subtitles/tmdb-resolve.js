const axios = require('axios');

const TMDB_BASE = 'https://api.themoviedb.org/3';

async function resolveImdbFromTitle(query, year) {
    const key = process.env.TMDB_API_KEY;
    if (!key) return null;
    const q = (query || '').trim();
    if (!q) return null;
    const variations = [
        q,
        q.replace(/\s+and\s+/gi, ' & '),
        q.replace(/\s*&\s*/g, ' and ')
    ];
    for (const variation of variations) {
        try {
            let url = `${TMDB_BASE}/search/movie?api_key=${key}&query=${encodeURIComponent(variation)}&language=hu-HU`;
            if (year) url += `&year=${year}`;
            const searchRes = await axios.get(url, { timeout: 10000 });
            const results = searchRes.data?.results || [];
            if (results.length === 0) continue;
            const tmdbId = results[0].id;
            const detailsRes = await axios.get(`${TMDB_BASE}/movie/${tmdbId}?api_key=${key}&language=hu-HU`, { timeout: 10000 });
            const imdbId = detailsRes.data?.imdb_id;
            if (!imdbId) continue;
            return {
                imdb_id: imdbId,
                title: detailsRes.data.title,
                year: detailsRes.data.release_date ? parseInt(detailsRes.data.release_date.slice(0, 4), 10) : null
            };
        } catch (_) {
            continue;
        }
    }
    return null;
}

module.exports = { resolveImdbFromTitle };
