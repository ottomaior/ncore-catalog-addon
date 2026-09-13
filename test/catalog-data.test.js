const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../lib/catalog-data');

test('registry: every catalog points at a known source and ids are unique', () => {
    const sourceKeys = new Set(data.SOURCE_DEFS.map(s => s.key));
    const ids = new Set();
    for (const def of data.CATALOG_DEFS) {
        assert.ok(!ids.has(def.id), `duplicate catalog id ${def.id}`);
        ids.add(def.id);
        if (def.search) continue;
        assert.ok(sourceKeys.has(def.source), `${def.id} references unknown source ${def.source}`);
        const src = data.SOURCE_DEFS.find(s => s.key === def.source);
        assert.equal(src.type, def.type, `${def.id} type mismatch with its source`);
    }
    for (const type of ['movie', 'series']) {
        for (const key of data.META_LOOKUP_ORDER[type]) assert.ok(sourceKeys.has(key));
    }
});

test('manifest catalogs: skip on every board catalog, Hungarian genre labels, search required', () => {
    const catalogs = data.buildManifestCatalogs();
    assert.equal(catalogs.length, data.CATALOG_DEFS.length);
    for (const c of catalogs) {
        const def = data.getCatalogDef(c.id);
        if (def.search) {
            assert.deepEqual(c.extra, [{ name: 'search', isRequired: true }]);
            continue;
        }
        assert.equal(c.extra[0].name, 'skip');
        if (def.genre) {
            const genre = c.extra.find(e => e.name === 'genre');
            assert.ok(genre.options.includes('Vígjáték'));
            if (c.type === 'series') assert.ok(!genre.options.includes('Horror'));
            else assert.ok(genre.options.includes('Horror'));
        }
    }
});

test('resolveGenreSlug accepts Hungarian labels, English labels and slugs', () => {
    assert.equal(data.resolveGenreSlug('Vígjáték'), 'comedy');
    assert.equal(data.resolveGenreSlug('Comedy'), 'comedy');
    assert.equal(data.resolveGenreSlug('comedy'), 'comedy');
    assert.equal(data.resolveGenreSlug('Science Fiction'), 'science-fiction');
    assert.equal(data.resolveGenreSlug('Sci-fi'), 'science-fiction');
    assert.equal(data.resolveGenreSlug('science-fiction'), 'science-fiction');
    assert.equal(data.resolveGenreSlug('Bűnügyi'), 'crime');
    assert.equal(data.resolveGenreSlug(''), null);
});

test('filterMetasByGenre matches TMDB Hungarian, English, aliases and TVDB combined labels', () => {
    const list = [
        { id: 'tt1', genres: ['Vígjáték'] },
        { id: 'tt2', genres: ['Comedy'] },
        { id: 'tt3', genres: [{ name: 'Háborús' }] },
        { id: 'tt4', genres: ['Action & Adventure'] },
        { id: 'tt5', genres: ['Sci-Fi & Fantasy'] },
        { id: 'tt6' }
    ];
    const ids = (genre) => data.filterMetasByGenre(list, genre).map(m => m.id);
    assert.deepEqual(ids('Vígjáték'), ['tt1', 'tt2']);
    assert.deepEqual(ids('Comedy'), ['tt1', 'tt2']);
    assert.deepEqual(ids('Háború'), ['tt3']);
    assert.deepEqual(ids('Akció'), ['tt4']);
    assert.deepEqual(ids('Kaland'), ['tt4']);
    assert.deepEqual(ids('Sci-fi'), ['tt5']);
    assert.deepEqual(ids('Fantasy'), ['tt5']);
    assert.deepEqual(ids('Horror'), []);
    assert.equal(data.filterMetasByGenre(list, '').length, 6);
});

test('normalizeId pads to 7 digits and tolerates missing tt prefix', () => {
    assert.equal(data.normalizeId('tt175058'), 'tt0175058');
    assert.equal(data.normalizeId('175058'), 'tt0175058');
    assert.equal(data.normalizeId(' tt12345678 '), 'tt12345678');
    assert.equal(data.normalizeId(''), '');
    assert.equal(data.normalizeId(null), '');
});

test('sortMetasByReleaseYearDesc is stable and puts unknown years last', () => {
    const sorted = data.sortMetasByReleaseYearDesc([
        { id: 'a', year: 2020 }, { id: 'b' }, { id: 'c', year: '2024' }, { id: 'd', year: 2024 }, { id: 'e', year: 'x' }
    ]);
    assert.deepEqual(sorted.map(m => m.id), ['c', 'd', 'a', 'b', 'e']);
});

test('normalizeSearchText strips accents and punctuation', () => {
    assert.equal(data.normalizeSearchText('Árvíztűrő Tükörfúrógép: 2. rész!'), 'arvizturo tukorfurogep 2 resz');
});

test('data sources load from disk and meta lookup index resolves ids', () => {
    const hdSeries = data.getSource('hd_series').get();
    assert.ok(Array.isArray(hdSeries));
    if (hdSeries.length === 0) return; // data files absent (fresh clone) – nothing more to assert
    const first = hdSeries[0];
    const found = data.findMetaById('series', first.id);
    assert.ok(found, 'first hd_series item must be findable');
    assert.equal(data.normalizeId(found.id), data.normalizeId(first.id));
    assert.equal(data.findMetaById('series', 'tt0000000'), null);

    const hits = data.searchMetas('series', first.name.split(' ')[0]);
    assert.ok(hits.some(m => data.normalizeId(m.id) === data.normalizeId(first.id)));
    assert.deepEqual(data.searchMetas('series', ''), []);
});
