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
if (isUnix) {
    cron.schedule('0 */3 * * *', () => { console.log('[Cron] Running movie sync...'); runScript('sync_rss_to_trakt.py', 'Movies'); });
    cron.schedule('30 */3 * * *', () => { console.log('[Cron] Running series sync...'); runScript('sync_series_rss_to_trakt.py', 'Series'); });
    cron.schedule('0 3 * * 0', () => {
        console.log('[Cron] Building top-seeded-by-genre catalog...');
        runScript('build_most_seeded_movies_catalog.py', 'TopSeededCatalog', () => {
            console.log('[Cron] Filtering Hungarian productions...');
            runScript('filter_hungarian_productions.py', 'HungarianProductions');
        });
    });
    console.log('[Cron] Scheduler – movies/series: every 3h; top-seeded + Magyar filmek: weekly Sunday 03:00');
}

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

// Secured cron webhook: POST /cron/sync with Authorization: Bearer <CRON_SECRET>
// Used by GitHub Actions (or any external scheduler) to trigger RSS→Trakt sync every 3h.
app.post('/cron/sync', (req, res) => {
    const secret = process.env.CRON_SECRET;
    const auth = req.headers.authorization;
    const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!secret || token !== secret) {
        res.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
    }
    res.status(202).json({ ok: true, message: 'Sync started' });
    console.log('[Cron] Webhook: running movie then series sync');
    runScript('sync_rss_to_trakt.py', 'Movies');
    runScript('sync_series_rss_to_trakt.py', 'Series');
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
