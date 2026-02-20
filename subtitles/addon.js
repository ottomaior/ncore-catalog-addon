const { addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const { getIndex } = require('./upload-service');

const builder = new addonBuilder(manifest);

function getBaseUrl() {
    if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (domain) return `https://${domain}`;
    return `http://localhost:${process.env.PORT || 7000}`;
}

builder.defineSubtitlesHandler(async ({ type, id }) => {
    const imdbId = id.split(':')[0];
    if (!/^tt\d+$/i.test(imdbId)) {
        return { subtitles: [] };
    }
    const key = imdbId.toLowerCase();
    const entries = getIndex()[key];
    if (!entries || entries.length === 0) {
        return { subtitles: [] };
    }
    const baseUrl = getBaseUrl();
    const subtitles = entries.map((entry, i) => ({
        id: `ncore-${entry.lang}-${key}-${i + 1}`,
        url: `${baseUrl}/subtitles/files/${entry.filename}`,
        lang: entry.lang
    }));
    return { subtitles };
});

module.exports = builder.getInterface();
