/**
 * User configuration for the catalog addon, encoded in the install URL path:
 *   /c/<token>/manifest.json   (token = base64url of a small JSON object)
 *
 * The token stores only the differences from the registry defaults, with the
 * "ncore-" prefix stripped from ids, so typical URLs stay short:
 *   { x: [ids],            // excluded catalogs
 *     o: [ids],            // full order, only when the user reordered
 *     hp: [ids], hm: [ids],// shown on / hidden from the Board, relative to defaults
 *     rpdb: 'api-key' }    // optional RatingPosterDB key for rated posters
 * Legacy tokens with { c: [ids], home: [ids] } are still understood.
 *
 * Path encoding (instead of ?catalogs=) survives clients that strip query strings on
 * install and gives `behaviorHints.configurable` a stable target.
 */
const MAX_TOKEN_LENGTH = 4096;
const ID_PREFIX = 'ncore-';

const shortId = (id) => (id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id);
const longId = (id) => (id.startsWith(ID_PREFIX) ? id : ID_PREFIX + id);

function idList(v) {
    return Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean).map(longId) : null;
}

/**
 * Build a token from the resolved state.
 * @param {object} state   { enabled: [ids in order], home: [ids], rpdb }
 * @param {object[]} options registry defaults: [{ id, board }]
 */
function encodeConfig(state, options) {
    const defaultsOrder = options.map(o => o.id);
    const defaultHome = new Set(options.filter(o => o.board).map(o => o.id));
    const enabled = state.enabled || defaultsOrder;
    const enabledSet = new Set(enabled);
    const raw = {};
    const excluded = defaultsOrder.filter(id => !enabledSet.has(id));
    if (excluded.length) raw.x = excluded.map(shortId);
    const defaultEnabledOrder = defaultsOrder.filter(id => enabledSet.has(id));
    if (enabled.join(',') !== defaultEnabledOrder.join(',')) raw.o = enabled.map(shortId);
    if (state.home) {
        const home = new Set(state.home);
        const hp = enabled.filter(id => home.has(id) && !defaultHome.has(id));
        const hm = enabled.filter(id => !home.has(id) && defaultHome.has(id));
        if (hp.length) raw.hp = hp.map(shortId);
        if (hm.length) raw.hm = hm.map(shortId);
    }
    if (state.rpdb) raw.rpdb = String(state.rpdb);
    return Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url');
}

/** Decode a token to its raw fields; {} for anything malformed so a bad URL degrades to defaults. */
function decodeConfig(token) {
    if (!token || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return {};
    try {
        const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const raw = {};
        for (const key of ['x', 'o', 'hp', 'hm', 'c', 'home']) {
            const list = idList(parsed[key]);
            if (list && (list.length || key === 'home')) raw[key] = list;
        }
        if (typeof parsed.rpdb === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(parsed.rpdb)) raw.rpdb = parsed.rpdb;
        return raw;
    } catch (err) {
        return {};
    }
}

/**
 * Resolve raw token fields against the registry defaults.
 * @returns {{ enabled: string[], home: Set<string>, rpdb: string|null, isDefault: boolean }}
 */
function resolveConfig(raw, options) {
    const defaultsOrder = options.map(o => o.id);
    const known = new Set(defaultsOrder);
    const defaultHome = new Set(options.filter(o => o.board).map(o => o.id));
    raw = raw || {};

    let enabled;
    if (raw.c) {
        enabled = raw.c.filter(id => known.has(id));
    } else {
        const excluded = new Set(raw.x || []);
        enabled = (raw.o ? raw.o.filter(id => known.has(id)) : defaultsOrder).filter(id => !excluded.has(id));
        if (raw.o) for (const id of defaultsOrder) if (!excluded.has(id) && !enabled.includes(id)) enabled.push(id);
    }
    if (enabled.length === 0) enabled = defaultsOrder.slice();

    let home;
    if (raw.home) {
        home = new Set(raw.home.filter(id => known.has(id)));
    } else {
        home = new Set(defaultHome);
        for (const id of raw.hp || []) home.add(id);
        for (const id of raw.hm || []) home.delete(id);
    }

    const rpdb = raw.rpdb || null;
    const homeChanged = enabled.some(id => home.has(id) !== defaultHome.has(id));
    const isDefault = !rpdb && !homeChanged && enabled.join(',') === defaultsOrder.join(',');
    return { enabled, home, rpdb, isDefault };
}

/** Legacy ?catalogs=a,b,c query → raw config. */
function configFromCatalogsParam(param) {
    if (!param || typeof param !== 'string') return {};
    const c = param.split(',').map(s => s.trim()).filter(Boolean);
    return c.length ? { c } : {};
}

/** RatingPosterDB poster URL for an IMDb id, or null without a key. */
function rpdbPosterUrl(rpdbKey, imdbId) {
    if (!rpdbKey || !imdbId) return null;
    const id = String(imdbId).split(':')[0];
    if (!/^tt\d+$/.test(id)) return null;
    return `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${id}.jpg?fallback=true`;
}

module.exports = { encodeConfig, decodeConfig, resolveConfig, configFromCatalogsParam, rpdbPosterUrl, shortId, longId };
