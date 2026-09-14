require('dotenv').config({ path: require('path').join(__dirname, 'config', 'config.env'), quiet: true });
const express = require('express');
const compression = require('compression');
const { getRouter } = require('stremio-addon-sdk');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const multer = require('multer');

const pkg = require('./package.json');
const catalogData = require('./lib/catalog-data');

// Import all addon builders
const catalogBuilder = require('./index.js');
const infoBuilder = require('./info-addon.js');
const trailerBuilder = require('./trailers/addon.js');
const subtitleBuilder = require('./subtitles/addon.js');
const subtitlesService = require('./subtitles/upload-service.js');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway sits behind a proxy; needed for correct client IPs

// gzip/brotli-less compression of JSON responses (catalog pages are 100 metas each)
app.use(compression());

// CORS: allow Stremio (and any client) to fetch manifest and addon resources from another origin
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.sendStatus(204);
    }
    next();
});

// Static assets (e.g. logo.png for addon manifest)
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        // Pages and styles change with deploys; images can be cached for a day.
        const cacheable = /\.(png|jpg|jpeg|svg|ico|webp|woff2?)$/i.test(filePath);
        res.setHeader('Cache-Control', cacheable ? 'public, max-age=86400' : 'no-cache');
    }
}));

// Subtitles: ensure data dir and load index (must run before subtitle routes).
// For persistence on Railway: add a Volume, mount it at /data, set env SUBTITLES_DATA_DIR=/data/subtitles.
subtitlesService.ensureDir();
subtitlesService.loadIndex();

// Optional: refresh catalog JSON from a remote URL (e.g. raw GitHub) instead of redeploying.
catalogData.startRemoteRefresh();

// Python build scripts (used only by the /cron/build webhook; scheduled builds run in GitHub Actions)
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

// Get routers from all addons
const catalogRouter = getRouter(catalogBuilder.getInterface());
const infoRouter = getRouter(infoBuilder.getInterface());
const trailerRouter = getRouter(trailerBuilder);
const subtitleRouter = getRouter(subtitleBuilder);

const startedAt = new Date();

// Health / status endpoint: counts per catalog + data freshness per source
app.get('/health', (req, res) => {
    const stats = catalogBuilder.getStats ? catalogBuilder.getStats() : {};
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        status: 'ok',
        version: pkg.version,
        addons: { catalog: pkg.version, info: pkg.version, trailers: pkg.version, subtitles: pkg.version },
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: startedAt.toISOString(),
        builds: 'github-actions',
        ...stats
    });
});

// The old trailer settings page produced URLs the addon never served; the addon has no options.
app.get('/trailers/configure', (req, res) => res.redirect(301, '/trailers'));

// Homepage (hub)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// Addon pages (clean URLs). /configure is what Stremio opens for `behaviorHints.configurable`.
const catalogPage = (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalog.html'));
app.get('/catalog', catalogPage);
app.get('/configure', catalogPage);
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

// Legacy dynamic manifest: ?catalogs=id1,id2,... (new installs use /c/<config>/manifest.json)
app.get('/manifest.json', (req, res, next) => {
    const catalogsParam = req.query.catalogs;
    if (catalogsParam && typeof catalogsParam === 'string') {
        const ids = catalogsParam.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length > 0) {
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.json(catalogBuilder.getManifestForCatalogs(ids));
        }
    }
    next();
});

// Config in the URL path: /c/<base64url json>/manifest.json, /c/<cfg>/catalog/..., /c/<cfg>/meta/...
app.use('/c/:config', catalogBuilder.createConfigRouter());
app.get('/c/:config/configure', catalogPage);

// Secured cron webhook: POST /cron/build with Authorization: Bearer <CRON_SECRET>
// Used by external schedulers to trigger catalog build scripts (requires Python on the host).
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

// ---------------------------------------------------------------------------
// Subtitles: upload (rate limited) and file serving (before /subtitles addon router)
// ---------------------------------------------------------------------------
const UPLOAD_RATE_LIMIT = parseInt(process.env.SUBTITLE_UPLOAD_RATE_LIMIT || '10', 10); // uploads
const UPLOAD_RATE_WINDOW_MS = 10 * 60 * 1000;                                            // per 10 min per IP
const uploadHits = new Map(); // ip -> timestamps[]

function uploadRateLimiter(req, res, next) {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const recent = (uploadHits.get(ip) || []).filter(t => now - t < UPLOAD_RATE_WINDOW_MS);
    if (recent.length >= UPLOAD_RATE_LIMIT) {
        res.setHeader('Retry-After', Math.ceil((UPLOAD_RATE_WINDOW_MS - (now - recent[0])) / 1000));
        return res.status(429).json({ error: 'Túl sok feltöltés, próbáld később (max 10 / 10 perc).' });
    }
    recent.push(now);
    uploadHits.set(ip, recent);
    if (uploadHits.size > 10000) {
        for (const [k, v] of uploadHits) if (!v.some(t => now - t < UPLOAD_RATE_WINDOW_MS)) uploadHits.delete(k);
    }
    next();
}

const uploadSub = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        const ext = (file.originalname || '').toLowerCase().slice(-4);
        if (ext === '.srt' || ext === '.vtt') return cb(null, true);
        cb(new Error('Only .srt and .vtt files are allowed'));
    }
});

app.post('/subtitles/upload', uploadRateLimiter, (req, res, next) => {
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
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.vtt' ? 'text/vtt' : 'application/x-subrip';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=86400');
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
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🇭🇺 nCore Stremio Addons Server v${pkg.version}`);
        console.log(`${'='.repeat(60)}`);
        console.log(`\n📍 Hub:        http://localhost:${PORT}/`);
        console.log(`📍 Catalog:    http://localhost:${PORT}/catalog`);
        console.log(`📍 Trailers:   http://localhost:${PORT}/trailers`);
        console.log(`📍 Subtitles:  http://localhost:${PORT}/subtitles`);
        console.log(`📍 Health:     http://localhost:${PORT}/health`);
        console.log(`📍 Catalog:    http://localhost:${PORT}/manifest.json`);
        console.log(`📍 Info:       http://localhost:${PORT}/info/manifest.json`);
        console.log(`📍 Trailers:   http://localhost:${PORT}/trailers/manifest.json`);
        console.log(`📍 Subtitles:  http://localhost:${PORT}/subtitles/manifest.json`);
        console.log(`📍 Feliratok:  http://localhost:${PORT}/subtitles.html\n`);
        console.log(`${'='.repeat(60)}\n`);
    });
}

module.exports = app;
