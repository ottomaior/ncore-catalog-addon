const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: './config/config.env' });

const EPISODE_TRACKER_PATH = path.join(__dirname, 'scripts', 'series_episodes_seen.json');

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

function createImdbToTraktMap() {
    const tracker = loadEpisodeTracker();
    const map = {};

    Object.entries(tracker).forEach(([traktId, info]) => {
        if (info.imdb_id) {
            const imdbId = info.imdb_id.replace('tt', '');
            map[imdbId] = { traktId, info };
            map['tt' + imdbId] = { traktId, info };
        }
    });

    return map;
}

const manifest = {
    id: 'com.ncore.episode.info',
    version: '1.0.5',
    name: '🇭🇺 nCore Episode Info',
    description: 'Megmutatja a legutóbb feltöltött magyar epizódot az nCore trackerről',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
    console.log(`📢 Info addon stream kérés: ${args.type}/${args.id}`);

    if (args.type === 'series') {
        const baseId = args.id.split(':')[0].replace('tt', '');
        const imdbMap = createImdbToTraktMap();
        const seriesData = imdbMap[baseId];

        if (seriesData && seriesData.info.latest_season && seriesData.info.latest_episode) {
            const info = seriesData.info;
            const episodeStr = `S${String(info.latest_season).padStart(2, '0')}E${String(info.latest_episode).padStart(2, '0')}`;

            // Format date if available
            let nameWithDate = `🇭🇺 ${episodeStr}`;
            if (info.added_at) {
                try {
                    const date = new Date(info.added_at);
                    const formattedDate = date.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' });
                    nameWithDate = `🇭🇺 ${episodeStr} • ${formattedDate}`;
                } catch (e) {
                    console.log(`⚠️ Dátum formázási hiba: ${e.message}`);
                }
            }

            console.log(`✅ Returning info for ${info.show_name}: ${episodeStr}`);

            return Promise.resolve({
                streams: [
                    {
                        name: nameWithDate,
                        description: `Utolsó feltöltött epizód.\n\n⚠️ NE NYISD MEG!`,
                        url: 'https://www.ncore.pro',
                        externalUrl: 'https://www.ncore.pro',
                        behaviorHints: { notWebReady: true }
                    }
                ]
            });
        }
    }

    return Promise.resolve({ streams: [] });
});

const PORT = process.env.INFO_ADDON_PORT || 7001;
serveHTTP(builder.getInterface(), { port: PORT });

console.log(`\n${'='.repeat(60)}`);
console.log(`🇭🇺 nCore Episode Info Addon`);
console.log(`${'='.repeat(60)}`);
console.log(`\n📍 Install: http://localhost:${PORT}/manifest.json\n`);
console.log(`${'='.repeat(60)}\n`);
