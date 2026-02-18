const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const path = require('path');
const { exec } = require('child_process');
const cron = require('node-cron');

// Import all three addon builders
const catalogBuilder = require('./index.js');
const infoBuilder = require('./info-addon.js');
const trailerBuilder = require('./trailers/addon.js');

const app = express();

// CORS: allow Stremio (and any client) to fetch manifest and addon resources from another origin
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        return res.sendStatus(204);
    }
    next();
});

// Cron: run Python sync scripts every 3 hours (production)
const isUnix = process.platform !== 'win32';
const runScript = (scriptName, label, onDone) => {
    const scriptPath = path.join(__dirname, 'scripts', scriptName);
    const cmd = isUnix
        ? `. /opt/venv/bin/activate && python "${scriptPath}"`
        : `python "${scriptPath}"`;
    const opts = { cwd: __dirname, env: { ...process.env } };
    exec(cmd, opts, (error, stdout, stderr) => {
        if (error) console.error(`[Cron] ${label} error:`, error.message);
        if (stderr) console.error(`[Cron] ${label} stderr:`, stderr);
        if (stdout) console.log(`[Cron] ${label} output:`, stdout.slice(0, 500));
        if (typeof onDone === 'function') onDone();
    });
};
// Disabled: catalog builds run only via GitHub Actions. Uncomment to run schedules from this server.
// if (isUnix) {
//     cron.schedule('0 */3 * * *', () => {
//         console.log('[Cron] Building latest movie/series catalogs...');
//         runScript('build_latest_catalog.py', 'LatestCatalog', () => {
//             console.log('[Cron] Splitting streaming catalogs by TMDB watch providers...');
//             runScript('split_catalogs_by_provider.py', 'SplitByProvider');
//         });
//     });
//     cron.schedule('0 3 * * 0', () => {
//         console.log('[Cron] Building top-seeded movies catalog...');
//         runScript('build_most_seeded_movies_catalog.py', 'TopSeededMovies', () => {
//             console.log('[Cron] Filtering Hungarian productions (movies)...');
//             runScript('filter_hungarian_productions.py', 'HungarianProductionsMovies', () => {
//                 console.log('[Cron] Building top-seeded series catalog...');
//                 runScript('build_most_seeded_series_catalog.py', 'TopSeededSeries', () => {
//                     console.log('[Cron] Filtering Hungarian productions (series)...');
//                     runScript('filter_hungarian_productions_series.py', 'HungarianProductionsSeries', () => {
//                         console.log('[Cron] Splitting streaming catalogs by TMDB watch providers...');
//                         runScript('split_catalogs_by_provider.py', 'SplitByProvider');
//                     });
//                 });
//             });
//         });
//     });
//     cron.schedule('0 */6 * * *', () => {
//         console.log('[Cron] Building trending catalogs (HD 1080p, top seeded in last N pages)...');
//         runScript('build_trending_catalog.py', 'TrendingCatalog');
//     });
//     console.log('[Cron] Scheduler – latest + split: every 3h; trending: every 6h; top-seeded + Magyar + split: weekly Sunday 03:00');
// }

// Get routers from all addons
const catalogRouter = getRouter(catalogBuilder.getInterface());
const infoRouter = getRouter(infoBuilder.getInterface());
const trailerRouter = getRouter(trailerBuilder);

// Health / status endpoint
app.get('/health', (req, res) => {
    const catalog = require('./index.js');
    const stats = catalog.getStats ? catalog.getStats() : {};
    res.json({
        status: 'ok',
        addons: { catalog: '1.2.0', info: '1.0.5', trailers: '1.1.0' },
        cron: isUnix ? 'active' : 'disabled',
        ...stats
    });
});

// Trailer configure page (before /trailers router)
app.get('/trailers/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'trailers', 'public', 'configure.html'));
});

// Homepage (static HTML with dynamic baseUrl via client JS)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catalog options for configure UI (which catalogs to enable before install)
app.get('/api/catalog-options', (req, res) => {
    try {
        const options = catalogBuilder.getCatalogOptions ? catalogBuilder.getCatalogOptions() : [];
        res.json(options);
    } catch (e) {
        res.status(500).json({ error: String(e.message) });
    }
});

// Dynamic manifest: ?catalogs=id1,id2,... returns manifest with only those catalogs
app.get('/manifest.json', (req, res, next) => {
    const catalogsParam = req.query.catalogs;
    if (catalogsParam && typeof catalogsParam === 'string') {
        const ids = catalogsParam.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length > 0 && catalogBuilder.getManifestForCatalogs) {
            const manifest = catalogBuilder.getManifestForCatalogs(ids);
            return res.json(manifest);
        }
    }
    next();
});

// Secured cron webhook: POST /cron/build with Authorization: Bearer <CRON_SECRET>
// Used by external schedulers to trigger catalog build scripts.
app.post('/cron/build', (req, res) => {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers.authorization;
    const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!secret || token !== secret) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
    }
    res.status(202).json({ ok: true, message: 'Catalog build started' });
    console.log('[Cron] Webhook: building catalogs (latest → split by provider, then trending)');
    runScript('build_latest_catalog.py', 'LatestCatalog', () => {
        runScript('split_catalogs_by_provider.py', 'SplitByProvider', () => {
            runScript('build_trending_catalog.py', 'TrendingCatalog');
        });
    });
});

// Serve trailer addon at /trailers
app.use('/trailers', trailerRouter);

// Serve info addon at /info
app.use('/info', infoRouter);

// Serve catalog addon at root (handles /manifest.json, /catalog/*, /meta/*)
app.use('/', catalogRouter);

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🇭🇺 nCore Stremio Addons Server`);
    console.log(`${'='.repeat(60)}`);
    console.log(`\n📍 Homepage:   http://localhost:${PORT}`);
    console.log(`📍 Health:     http://localhost:${PORT}/health`);
    console.log(`📍 Catalog:    http://localhost:${PORT}/manifest.json`);
    console.log(`📍 Info:       http://localhost:${PORT}/info/manifest.json`);
    console.log(`📍 Trailers:   http://localhost:${PORT}/trailers/manifest.json`);
    console.log(`📍 Configure:  http://localhost:${PORT}/trailers/configure\n`);
    console.log(`${'='.repeat(60)}\n`);
});
