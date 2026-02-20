require('dotenv').config({ path: require('path').join(__dirname, 'config', 'config.env') });
const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const path = require('path');
const { exec } = require('child_process');
const cron = require('node-cron');
const multer = require('multer');

// Import all addon builders
const catalogBuilder = require('./index.js');
const infoBuilder = require('./info-addon.js');
const trailerBuilder = require('./trailers/addon.js');
const subtitleBuilder = require('./subtitles/addon.js');
const subtitlesService = require('./subtitles/upload-service.js');

const app = express();

// CORS: allow Stremio (and any client) to fetch manifest and addon resources from another origin
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        return res.sendStatus(204);
    }
    next();
});

// Static assets (e.g. logo.png for addon manifest)
app.use(express.static(path.join(__dirname, 'public')));

// Subtitles: ensure data dir and load index (must run before subtitle routes).
// For persistence on Railway: add a Volume, mount it at /data, set env SUBTITLES_DATA_DIR=/data/subtitles.
subtitlesService.ensureDir();
subtitlesService.loadIndex();

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
const subtitleRouter = getRouter(subtitleBuilder);

// Health / status endpoint
app.get('/health', (req, res) => {
    const catalog = require('./index.js');
    const stats = catalog.getStats ? catalog.getStats() : {};
    res.json({
        status: 'ok',
        addons: { catalog: '3.2.2', info: '3.2.2', trailers: '3.2.2', subtitles: '3.2.2' },
        cron: isUnix ? 'active' : 'disabled',
        ...stats
    });
});

// Trailer configure page (before /trailers router)
app.get('/trailers/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'trailers', 'public', 'configure.html'));
});

// Homepage (hub)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Addon pages (clean URLs)
app.get('/catalog', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'catalog.html'));
});
app.get('/trailers', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'trailers.html'));
});
app.get('/subtitles', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'subtitles-addon.html'));
});

// Resolve movie title to IMDB ID (for subtitle upload page)
app.get('/api/subtitles/resolve-imdb', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const year = (req.query.year || '').trim() || undefined;
        if (!q) return res.status(400).json({ error: 'Missing q' });
        if (/^tt\d+$/i.test(q)) return res.json({ imdb_id: q.toLowerCase() });
        const { resolveImdbFromTitle } = require('./subtitles/tmdb-resolve.js');
        const result = await resolveImdbFromTitle(q, year);
        if (!result) return res.status(404).json({ error: 'Not found' });
        res.json(result);
    } catch (e) {
        console.error('[Subtitles] resolve-imdb error:', e);
        res.status(500).json({ error: e.message || 'Resolve failed' });
    }
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

// Subtitles: upload and file serving (before /subtitles addon router)
const uploadSub = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = (file.originalname || '').toLowerCase().slice(-4);
        if (ext === '.srt' || ext === '.vtt') return cb(null, true);
        cb(new Error('Only .srt and .vtt files are allowed'));
    }
});

app.post('/subtitles/upload', (req, res, next) => {
    uploadSub.single('subtitle')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 5 MB)' });
            if (err.message && err.message.includes('.srt')) return res.status(400).json({ error: 'Only .srt and .vtt files are allowed' });
            console.error('[Subtitles] Multer error:', err);
            return res.status(400).json({ error: err.message || 'Upload rejected' });
        }
        next();
    });
}, (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No subtitle file uploaded' });
        }
        const imdbId = (req.body && req.body.imdb_id) ? String(req.body.imdb_id).trim() : '';
        const lang = (req.body && req.body.lang) ? String(req.body.lang).trim().toLowerCase() : '';
        const note = (req.body && req.body.note) ? String(req.body.note).trim() : '';
        if (!imdbId) return res.status(400).json({ error: 'imdb_id is required' });
        if (!lang) return res.status(400).json({ error: 'lang is required' });
        if (!['hun', 'eng'].includes(lang)) return res.status(400).json({ error: 'lang must be hun or eng' });
        const ext = (req.file.originalname || '').toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt';
        const buffer = subtitlesService.normalizeToUtf8(req.file.buffer);
        const result = subtitlesService.addEntry(imdbId, lang, buffer, note, ext);
        if (result.error) return res.status(400).json({ error: result.error });
        if (result.duplicate) return res.status(200).json({ ok: true, duplicate: true, imdb_id: result.imdb_id });
        res.status(200).json({ ok: true, filename: result.filename, imdb_id: result.imdb_id, lang: result.lang });
    } catch (e) {
        console.error('[Subtitles] Upload error:', e);
        res.status(500).json({ error: e.message || 'Upload failed' });
    }
});

app.get('/subtitles/files/:filename', (req, res) => {
    const filePath = subtitlesService.getFilePath(req.params.filename);
    if (!filePath) return res.status(404).json({ error: 'Not found' });
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.vtt' ? 'text/vtt' : 'application/x-subrip';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(path.resolve(filePath));
});

app.use('/subtitles', subtitleRouter);

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
    console.log(`\n📍 Hub:        http://localhost:${PORT}/`);
    console.log(`📍 Catalog:    http://localhost:${PORT}/catalog`);
    console.log(`📍 Trailers:   http://localhost:${PORT}/trailers`);
    console.log(`📍 Subtitles:  http://localhost:${PORT}/subtitles`);
    console.log(`📍 Health:     http://localhost:${PORT}/health`);
    console.log(`📍 Catalog:    http://localhost:${PORT}/manifest.json`);
    console.log(`📍 Info:       http://localhost:${PORT}/info/manifest.json`);
    console.log(`📍 Trailers:   http://localhost:${PORT}/trailers/manifest.json`);
    console.log(`📍 Configure:  http://localhost:${PORT}/trailers/configure`);
    console.log(`📍 Subtitles:  http://localhost:${PORT}/subtitles/manifest.json`);
    console.log(`📍 Feliratok:  http://localhost:${PORT}/subtitles.html\n`);
    console.log(`${'='.repeat(60)}\n`);
});
