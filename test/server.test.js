const test = require('node:test');
const assert = require('node:assert/strict');

// TMDB calls are only made by /meta and /trailers; the routes exercised here never hit the network.
const app = require('../server');
const pkg = require('../package.json');
const catalog = require('../index');
const info = require('../info-addon');
const trailers = require('../trailers/addon');
const { encodeConfig } = require('../lib/addon-config');
const catalogOptions = require('../lib/catalog-data').getCatalogOptions();
const enc = (state) => encodeConfig(state, catalogOptions);

let server;
let base;

test.before(async () => {
    await new Promise(resolve => {
        server = app.listen(0, () => {
            base = `http://127.0.0.1:${server.address().port}`;
            resolve();
        });
    });
});

test.after(() => server && server.close());

async function getJson(p) {
    const res = await fetch(base + p);
    return { status: res.status, headers: res.headers, body: await res.json() };
}

test('GET /manifest.json advertises every catalog with the package version', async () => {
    const { status, body } = await getJson('/manifest.json');
    assert.equal(status, 200);
    assert.equal(body.version, pkg.version);
    assert.equal(body.id, 'com.ncore.hungarian.addon');
    assert.ok(body.catalogs.length >= 25);
    assert.ok(body.behaviorHints.configurable);
    assert.ok(JSON.stringify(body).length <= 8192, 'manifest must stay under the addon collection limit');
});

test('GET /manifest.json?catalogs= (legacy) keeps order and always includes search catalogs', async () => {
    const { body } = await getJson('/manifest.json?catalogs=ncore-trending-series,ncore-hd-movies');
    assert.deepEqual(body.catalogs.map(c => c.id), [
        'ncore-trending-series', 'ncore-hd-movies', 'ncore-search-movies', 'ncore-search-series'
    ]);
});

test('GET /c/<config>/manifest.json applies catalog subset and board visibility', async () => {
    const token = enc({ enabled: ['ncore-prime-movies', 'ncore-hd-movies'], home: ['ncore-prime-movies'] });
    const { status, body } = await getJson(`/c/${token}/manifest.json`);
    assert.equal(status, 200);
    assert.deepEqual(body.catalogs.map(c => c.id), ['ncore-prime-movies', 'ncore-hd-movies', 'ncore-search-movies', 'ncore-search-series']);
    assert.equal(body.catalogs[0].extra[1].isRequired, false, 'prime is on the board');
    assert.equal(body.catalogs[1].extra[1].isRequired, true, 'latest is discover-only in this config');

    const junk = await getJson('/c/zzz/manifest.json');
    assert.equal(junk.status, 200);
    assert.equal(junk.body.catalogs.length, catalog.manifest.catalogs.length, 'junk token falls back to defaults');
});

test('GET /api/catalog-options hides search catalogs and reports board defaults', async () => {
    const { body } = await getJson('/api/catalog-options');
    assert.ok(body.length >= 23);
    assert.ok(body.every(o => !o.id.startsWith('ncore-search')));
    assert.equal(body.find(o => o.id === 'ncore-hd-movies').board, true);
    assert.equal(body.find(o => o.id === 'ncore-prime-movies').board, false);
});

test('GET /catalog sends per-catalog cache headers and honours skip/genre', async () => {
    const all = await getJson('/catalog/movie/ncore-hd-movies.json');
    assert.equal(all.status, 200);
    assert.match(all.headers.get('cache-control') || '', /max-age=3600.*stale-while-revalidate=86400/);
    const top = await getJson('/catalog/movie/ncore-movies-top-seeded-all.json');
    assert.match(top.headers.get('cache-control') || '', /max-age=86400/);
    assert.ok(Array.isArray(all.body.metas));
    if (all.body.metas.length === 0) return; // no data files present

    const page2 = await getJson('/catalog/movie/ncore-hd-movies/skip=100.json');
    assert.notEqual(page2.body.metas[0] && page2.body.metas[0].id, all.body.metas[0].id);

    const hu = await getJson('/catalog/movie/ncore-hd-movies/genre=V%C3%ADgj%C3%A1t%C3%A9k.json');
    const en = await getJson('/catalog/movie/ncore-hd-movies/genre=Comedy.json');
    assert.equal(hu.body.metas.length, en.body.metas.length);
    assert.ok(hu.body.metas.every(m => m.genres.includes('Vígjáték')));
    assert.ok(all.body.metas.every(m => m.background));
    assert.ok(all.body.metas.every(m => m.latest_season === undefined && m.imdb_id === undefined), 'build-only fields are stripped');

    const year = await getJson('/catalog/movie/ncore-hd-movies-release-date/genre=2025.json');
    assert.ok(year.body.metas.every(m => parseInt(m.year, 10) === 2025));
});

test('GET /c/<config>/catalog applies RPDB posters', async () => {
    const token = enc({ rpdb: 't0-free-rpdb' });
    const { status, headers, body } = await getJson(`/c/${token}/catalog/movie/ncore-hd-movies.json`);
    assert.equal(status, 200);
    assert.match(headers.get('cache-control') || '', /max-age=3600/);
    if (body.metas.length === 0) return;
    assert.ok(body.metas.every(m => m.poster.startsWith('https://api.ratingposterdb.com/t0-free-rpdb/imdb/poster-default/')));
});

test('GET /catalog with unknown id or wrong type returns empty metas', async () => {
    assert.deepEqual((await getJson('/catalog/movie/nope.json')).body.metas, []);
    assert.deepEqual((await getJson('/catalog/series/ncore-hd-movies.json')).body.metas, []);
});

test('GET /health reports version and per-source freshness', async () => {
    const { status, body } = await getJson('/health');
    assert.equal(status, 200);
    assert.equal(body.version, pkg.version);
    assert.ok(body.data && body.data.sources && body.data.sources.hd_movies);
    assert.equal(typeof body.data.sources.hd_movies.count, 'number');
});

test('addon manifests share the package version', async () => {
    for (const p of ['/info/manifest.json', '/trailers/manifest.json', '/subtitles/manifest.json']) {
        const { body } = await getJson(p);
        assert.equal(body.version, pkg.version, p);
    }
});

test('POST /subtitles/upload without a file is rejected', async () => {
    const res = await fetch(base + '/subtitles/upload', { method: 'POST' });
    assert.equal(res.status, 400);
});

test('seriesReleaseInfo follows Stremio conventions', () => {
    assert.equal(catalog.seriesReleaseInfo({ first_air_date: '2019-03-01', status: 'Returning Series' }), '2019-');
    assert.equal(catalog.seriesReleaseInfo({ first_air_date: '2019-03-01', last_air_date: '2023-05-05', status: 'Ended' }), '2019-2023');
    assert.equal(catalog.seriesReleaseInfo({ first_air_date: '2019-03-01', last_air_date: '2019-12-05', status: 'Canceled' }), '2019');
    assert.equal(catalog.seriesReleaseInfo({}), undefined);
});

test('info addon: latestEpisodeOf prefers explicit fields, falls back to the name', () => {
    assert.deepEqual(info.latestEpisodeOf({ latest_season: 3, latest_episode: 2, name: 'X (S01E01)' }), { season: 3, episode: 2 });
    assert.deepEqual(info.latestEpisodeOf({ name: 'Veronika (S03E02)' }), { season: 3, episode: 2 });
    assert.equal(info.latestEpisodeOf({ name: 'Veronika' }), null);
    assert.equal(info.latestEpisodeOf(null), null);
    assert.equal(info.formatEpisode({ season: 1, episode: 12 }), 'S01E12');
});

test('trailer addon: parseId handles imdb, tmdb and bare numeric ids', () => {
    assert.deepEqual(trailers.parseId('tt123:2:5'), { imdbId: 'tt123', tmdbId: null, season: 2, episode: 5 });
    assert.deepEqual(trailers.parseId('tmdb:99:1'), { imdbId: null, tmdbId: 99, season: 1, episode: undefined });
    assert.deepEqual(trailers.parseId('99'), { imdbId: null, tmdbId: 99, season: undefined, episode: undefined });
    assert.equal(trailers.parseId('foo'), null);
});
