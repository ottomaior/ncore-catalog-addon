const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../lib/catalog-data');
const cfgLib = require('../lib/addon-config');

test('registry: every catalog points at a known source or derivation and ids are unique', () => {
    const sourceKeys = new Set(data.SOURCE_DEFS.map(s => s.key));
    const ids = new Set();
    for (const def of data.CATALOG_DEFS) {
        assert.ok(!ids.has(def.id), `duplicate catalog id ${def.id}`);
        ids.add(def.id);
        if (def.search) continue;
        assert.ok(def.cache in data.CACHE_PROFILES, `${def.id} has unknown cache profile ${def.cache}`);
        if (def.derive) {
            assert.ok(Array.isArray(data.getCatalogList(def)), `${def.id} derivation must return a list`);
            continue;
        }
        assert.ok(sourceKeys.has(def.source), `${def.id} references unknown source ${def.source}`);
        const src = data.SOURCE_DEFS.find(s => s.key === def.source);
        assert.equal(src.type, def.type, `${def.id} type mismatch with its source`);
    }
    for (const type of ['movie', 'series']) {
        for (const key of data.META_LOOKUP_ORDER[type]) assert.ok(sourceKeys.has(key));
    }
});

test('manifest catalogs: names carry no type word, board flag drives isRequired, size under 8 KB', () => {
    const catalogs = data.buildManifestCatalogs();
    assert.equal(catalogs.length, data.CATALOG_DEFS.length);
    assert.ok(JSON.stringify(catalogs).length < 7500, 'catalog list must leave room for the manifest header');
    for (const c of catalogs) {
        const def = data.getCatalogDef(c.id);
        assert.ok(!/\b(filmek|sorozatok)\b/i.test(c.name) || def.search, `${c.id}: Stremio appends the type itself`);
        if (def.search) {
            assert.deepEqual(c.extra, [{ name: 'search', isRequired: true }]);
            continue;
        }
        assert.equal(c.extra[0].name, 'skip');
        const genre = c.extra.find(e => e.name === 'genre');
        assert.ok(genre, `${c.id} needs a genre extra so it can be hidden from the board`);
        assert.equal(genre.isRequired, def.board === false, `${c.id} isRequired must mirror board:false`);
        if (def.filter === 'year') {
            assert.ok(genre.options.every(o => /^\d{4}$/.test(o)));
        } else if (def.compact) {
            assert.deepEqual(genre.options, data.PSEUDO_FILTERS.map(p => p.label));
        } else {
            assert.ok(genre.options.includes('Vígjáték'));
            assert.ok(genre.options.includes('Legjobbra értékelt'));
            if (c.type === 'series') assert.ok(!genre.options.includes('Horror'));
            else assert.ok(genre.options.includes('Horror'));
        }
    }
});

test('buildManifestCatalogs honours an explicit home set', () => {
    const catalogs = data.buildManifestCatalogs(new Set(['ncore-prime-movies']));
    const prime = catalogs.find(c => c.id === 'ncore-prime-movies');
    const latest = catalogs.find(c => c.id === 'ncore-hd-movies');
    assert.equal(prime.extra[1].isRequired, false);
    assert.equal(latest.extra[1].isRequired, true);
});

test('normalizeGenres maps every spelling to one Hungarian vocabulary', () => {
    assert.deepEqual(
        data.normalizeGenres(['Comedy', 'Vígjáték', { name: 'Háborús' }, 'Action & Adventure', 'Sci-Fi & Fantasy', 'Weird', '']),
        ['Vígjáték', 'Háború', 'Akció', 'Kaland', 'Sci-fi', 'Fantasy', 'Weird']
    );
    assert.deepEqual(data.normalizeGenres(null), []);
});

test('normalizeMeta strips the (SxxEyy) suffix into latest_season/latest_episode', () => {
    const m = data.normalizeMeta({ name: 'Veronika (S03E02)', genres: ['Drama'] });
    assert.equal(m.name, 'Veronika');
    assert.equal(m.latest_season, 3);
    assert.equal(m.latest_episode, 2);
    assert.deepEqual(m.genres, ['Dráma']);
    const keep = data.normalizeMeta({ name: 'Plain', latest_season: 1, latest_episode: 5 });
    assert.equal(keep.name, 'Plain');
    assert.equal(keep.latest_episode, 5);
});

test('resolveGenreFilter accepts Hungarian labels, English labels, slugs and pseudo-filters', () => {
    assert.equal(data.resolveGenreSlug('Vígjáték'), 'comedy');
    assert.equal(data.resolveGenreSlug('Comedy'), 'comedy');
    assert.equal(data.resolveGenreSlug('Science Fiction'), 'science-fiction');
    assert.equal(data.resolveGenreSlug('Sci-fi'), 'science-fiction');
    assert.equal(data.resolveGenreSlug('Bűnügyi'), 'crime');
    assert.equal(data.resolveGenreSlug(''), null);
    assert.deepEqual(data.resolveGenreFilter('Legjobbra értékelt'), { pseudo: 'top-rated' });
    assert.deepEqual(data.resolveGenreFilter(`Idei (${new Date().getFullYear()})`), { pseudo: 'this-year' });
});

test('filterMetasByGenre works on normalized metas and supports pseudo-filters', () => {
    const list = [
        { id: 'tt1', genres: ['Vígjáték'], imdbRating: 8.1, year: 2020 },
        { id: 'tt2', genres: ['Comedy'], imdbRating: '7.9', year: new Date().getFullYear() },
        { id: 'tt3', genres: [{ name: 'Háborús' }], imdbRating: 6 },
        { id: 'tt4', genres: ['Action & Adventure'] },
        { id: 'tt5', genres: ['Sci-Fi & Fantasy'] },
        { id: 'tt6' },
        { id: 'tt7', genres: ['Dráma'], imdbRating: 10, year: 2021 } // low-vote artifact, never "top rated"
    ].map(data.normalizeMeta);
    const ids = (genre) => data.filterMetasByGenre(list, genre).map(m => m.id);
    assert.deepEqual(ids('Vígjáték'), ['tt1', 'tt2']);
    assert.deepEqual(ids('Comedy'), ['tt1', 'tt2']);
    assert.deepEqual(ids('Háború'), ['tt3']);
    assert.deepEqual(ids('Akció'), ['tt4']);
    assert.deepEqual(ids('Kaland'), ['tt4']);
    assert.deepEqual(ids('Sci-fi'), ['tt5']);
    assert.deepEqual(ids('Fantasy'), ['tt5']);
    assert.deepEqual(ids('Horror'), []);
    assert.deepEqual(ids('Legjobbra értékelt'), ['tt1', 'tt2']);
    assert.deepEqual(ids('Idei'), ['tt2']);
    assert.equal(data.filterMetasByGenre(list, '').length, 7);
    assert.equal(data.credibleTopRating({ imdbRating: 9.5 }), 9.5);
    assert.equal(data.credibleTopRating({ imdbRating: '9.8' }), null);
    assert.equal(data.credibleTopRating({ imdbRating: 7.4 }), null);
    assert.deepEqual(data.filterMetasByYear(list, '2020').map(m => m.id), ['tt1']);
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

test('addon config: delta token round-trips, short ids, junk degrades to defaults', () => {
    const options = [
        { id: 'ncore-a', board: true }, { id: 'ncore-b', board: true }, { id: 'ncore-c', board: false }, { id: 'ncore-d', board: false }
    ];
    const defaults = cfgLib.resolveConfig({}, options);
    assert.deepEqual(defaults.enabled, ['ncore-a', 'ncore-b', 'ncore-c', 'ncore-d']);
    assert.deepEqual([...defaults.home], ['ncore-a', 'ncore-b']);
    assert.equal(defaults.isDefault, true);
    assert.equal(cfgLib.encodeConfig({ enabled: defaults.enabled, home: [...defaults.home] }, options), Buffer.from('{}').toString('base64url'));

    const state = { enabled: ['ncore-d', 'ncore-a', 'ncore-b'], home: ['ncore-a', 'ncore-d'], rpdb: 't0-free-rpdb' };
    const token = cfgLib.encodeConfig(state, options);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    const raw = cfgLib.decodeConfig(token);
    assert.deepEqual(raw, { x: ['ncore-c'], o: ['ncore-d', 'ncore-a', 'ncore-b'], hp: ['ncore-d'], hm: ['ncore-b'], rpdb: 't0-free-rpdb' });
    const resolved = cfgLib.resolveConfig(raw, options);
    assert.deepEqual(resolved.enabled, state.enabled);
    assert.deepEqual([...resolved.home].sort(), ['ncore-a', 'ncore-d']);
    assert.equal(resolved.rpdb, 't0-free-rpdb');
    assert.equal(resolved.isDefault, false);

    // exclusion only -> tiny token
    const small = cfgLib.encodeConfig({ enabled: ['ncore-a', 'ncore-b', 'ncore-d'] }, options);
    assert.deepEqual(cfgLib.decodeConfig(small), { x: ['ncore-c'] });
    assert.ok(small.length < 20);

    // legacy fields still resolve
    assert.deepEqual(cfgLib.resolveConfig({ c: ['ncore-b', 'ncore-zzz'], home: ['ncore-b'] }, options).enabled, ['ncore-b']);
    assert.deepEqual(cfgLib.decodeConfig('not base64 json'), {});
    assert.deepEqual(cfgLib.decodeConfig(''), {});
    assert.deepEqual(cfgLib.decodeConfig(Buffer.from('{"rpdb":"bad key!!"}').toString('base64url')), {});
    assert.deepEqual(cfgLib.configFromCatalogsParam('a, b,,c'), { c: ['a', 'b', 'c'] });
    assert.equal(cfgLib.rpdbPosterUrl('k', 'tt0111161:1:2'), 'https://api.ratingposterdb.com/k/imdb/poster-default/tt0111161.jpg?fallback=true');
    assert.equal(cfgLib.rpdbPosterUrl('k', 'tmdb:1'), null);
});

test('data sources load from disk, meta index resolves ids, derived catalogs are consistent', () => {
    const hdSeries = data.getSource('hd_series').get();
    assert.ok(Array.isArray(hdSeries));
    if (hdSeries.length === 0) return; // data files absent (fresh clone)
    const first = hdSeries[0];
    assert.ok(!/\(S\d+E\d+\)/.test(first.name), 'episode tag must be stripped from names');
    const found = data.findMetaById('series', first.id);
    assert.ok(found, 'first hd_series item must be findable');
    assert.equal(data.findMetaById('series', 'tt0000000'), null);
    assert.ok(data.searchMetas('series', first.name.split(' ')[0]).some(m => data.normalizeId(m.id) === data.normalizeId(first.id)));
    assert.deepEqual(data.searchMetas('series', ''), []);

    const topRated = data.getCatalogList(data.getCatalogDef('ncore-top-rated-movies'));
    for (let i = 1; i < topRated.length; i++) assert.ok(parseFloat(topRated[i - 1].imdbRating) >= parseFloat(topRated[i].imdbRating));
    assert.ok(topRated.every(m => parseFloat(m.imdbRating) >= 7.5 && parseFloat(m.imdbRating) < 9.6));
    const classics = data.getCatalogList(data.getCatalogDef('ncore-classics-movies'));
    assert.ok(classics.every(m => parseInt(m.year, 10) < 2000));
    const docs = data.getCatalogList(data.getCatalogDef('ncore-documentaries-movies'));
    assert.ok(docs.every(m => m.genres.includes('Dokumentumfilm')));
    const years = data.yearOptions(data.getCatalogDef('ncore-hd-movies-release-date'));
    assert.ok(years.length > 0 && years.every(y => /^\d{4}$/.test(y)));
});
