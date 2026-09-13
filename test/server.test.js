const test = require('node:test');
const assert = require('node:assert/strict');

// TMDB calls are only made by /meta and /trailers; the routes exercised here never hit the network.
const app = require('../server');
const pkg = require('../package.json');
const info = require('../info-addon');
const trailers = require('../trailers/addon');

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
    assert.ok(body.catalogs.length >= 24);
    assert.ok(body.behaviorHints.configurable);
});

test('GET /manifest.json?catalogs= keeps order and always includes search catalogs', async () => {
    const { body } = await getJson('/manifest.json?catalogs=ncore-trending-series,ncore-hd-movies');
    assert.deepEqual(body.catalogs.map(c => c.id), [
        'ncore-trending-series', 'ncore-hd-movies', 'ncore-search-movies', 'ncore-search-series'
    ]);
});

test('GET /api/catalog-options hides search catalogs', async () => {
    const { body } = await getJson('/api/catalog-options');
    assert.ok(body.length >= 22);
    assert.ok(body.every(o => !o.id.startsWith('ncore-search')));
});

test('GET /catalog sends cache headers and honours skip/genre', async () => {
    const all = await getJson('/catalog/movie/ncore-hd-movies.json');
    assert.equal(all.status, 200);
    assert.match(all.headers.get('cache-control') || '', /max-age=3600/);
    assert.ok(Array.isArray(all.body.metas));
    if (all.body.metas.length === 0) return; // no data files present

    const page2 = await getJson('/catalog/movie/ncore-hd-movies/skip=100.json');
    assert.notEqual(page2.body.metas[0] && page2.body.metas[0].id, all.body.metas[0].id);

    const hu = await getJson('/catalog/movie/ncore-hd-movies/genre=V%C3%ADgj%C3%A1t%C3%A9k.json');
    const en = await getJson('/catalog/movie/ncore-hd-movies/genre=Comedy.json');
    assert.equal(hu.body.metas.length, en.body.metas.length);
    assert.ok(all.body.metas.every(m => m.background));
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
