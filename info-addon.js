/**
 * nCore Episode Info addon: a "stream" whose only job is to show which episode of a
 * series was uploaded to nCore most recently. Data comes from the same catalog JSON
 * files the catalog addon serves (hd_series.json carries latest_season/latest_episode;
 * older builds only encode it in the name as "Title (S03E02)").
 */
const { addonBuilder } = require('stremio-addon-sdk');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'config', 'config.env'), quiet: true });

const pkg = require('./package.json');
const data = require('./lib/catalog-data');

const manifest = {
    id: 'com.ncore.episode.info',
    version: pkg.version,
    name: '🇭🇺 nCore Episode Info',
    description: 'Megmutatja a legutóbb feltöltött magyar epizódot az nCore trackerről',
    logo: 'https://ncore-catalog-addon-production.up.railway.app/logo.png',
    resources: ['stream'],
    types: ['series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);

/** { season, episode } for a series meta, or null when unknown. */
function latestEpisodeOf(meta) {
    if (!meta) return null;
    const s = parseInt(meta.latest_season, 10);
    const e = parseInt(meta.latest_episode, 10);
    if (Number.isFinite(s) && Number.isFinite(e)) return { season: s, episode: e };
    const m = /S(\d{1,2})E(\d{1,3})/i.exec(String(meta.name || ''));
    if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
    return null;
}

function formatEpisode({ season, episode }) {
    return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

builder.defineStreamHandler(async (args) => {
    console.log(`📢 Info addon stream kérés: ${args.type}/${args.id}`);
    if (args.type !== 'series' || !args.id) return { streams: [] };

    const seriesId = String(args.id).split(':')[0];
    const meta = data.findMetaById('series', seriesId);
    const latest = latestEpisodeOf(meta);
    if (!latest) return { streams: [], cacheMaxAge: 60 * 60 };

    const episodeStr = formatEpisode(latest);
    console.log(`✅ Info: ${meta.name} → ${episodeStr}`);
    return {
        streams: [{
            name: `🇭🇺 ${episodeStr}`,
            description: `Utolsó nCore-ra feltöltött magyar epizód: ${episodeStr}\n\n⚠️ NE NYISD MEG – csak információ!`,
            externalUrl: 'https://www.ncore.pro',
            behaviorHints: { notWebReady: true }
        }],
        cacheMaxAge: 60 * 60
    };
});

module.exports = builder;
module.exports.latestEpisodeOf = latestEpisodeOf;
module.exports.formatEpisode = formatEpisode;

if (require.main === module) {
    const { serveHTTP } = require('stremio-addon-sdk');
    const PORT = process.env.INFO_ADDON_PORT || 7001;
    serveHTTP(builder.getInterface(), { port: PORT });
    console.log(`nCore Episode Info (standalone): http://localhost:${PORT}/manifest.json`);
}
