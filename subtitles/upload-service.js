const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iconv = require('iconv-lite');

// Use SUBTITLES_DATA_DIR when set (e.g. Railway volume at /data/subtitles); else default to data/subtitles
const DATA_DIR = process.env.SUBTITLES_DATA_DIR
    ? path.resolve(process.env.SUBTITLES_DATA_DIR)
    : path.join(__dirname, '..', 'data', 'subtitles');
const INDEX_FILE = path.join(DATA_DIR, 'subtitles_index.json');

let index = {};

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function loadIndex() {
    ensureDir();
    try {
        if (fs.existsSync(INDEX_FILE)) {
            const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
            index = JSON.parse(raw);
        } else {
            index = {};
        }
    } catch (e) {
        console.error('[Subtitles] Failed to load index:', e.message);
        index = {};
    }
    return index;
}

function saveIndex() {
    try {
        fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
    } catch (e) {
        console.error('[Subtitles] Failed to save index:', e.message);
        throw e;
    }
}

function getIndex() {
    return index;
}

function normalizeImdbId(imdbId) {
    if (!imdbId || typeof imdbId !== 'string') return null;
    const s = imdbId.trim();
    if (/^tt\d+$/i.test(s)) return s.toLowerCase();
    if (/^\d+$/.test(s)) return 'tt' + s;
    return null;
}

function normalizeToUtf8(buffer) {
    const asUtf8 = buffer.toString('utf-8');
    if (!/\uFFFD/.test(asUtf8)) return Buffer.from(asUtf8, 'utf-8');
    try {
        const decoded = iconv.decode(buffer, 'win1250');
        return Buffer.from(decoded, 'utf-8');
    } catch (_) {
        return buffer;
    }
}

function addEntry(imdbId, lang, fileBuffer, note, ext) {
    const normalized = normalizeImdbId(imdbId);
    if (!normalized) return { error: 'Invalid IMDB ID' };

    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const entries = index[normalized] || [];

    const duplicate = entries.some(e => e.hash === hash);
    if (duplicate) {
        return { duplicate: true, imdb_id: normalized };
    }

    const countForLang = entries.filter(e => e.lang === lang).length;
    const nextIndex = countForLang + 1;
    const filename = `${normalized}_${lang}_${nextIndex}.${ext}`;
    const filePath = path.join(DATA_DIR, filename);

    ensureDir();
    fs.writeFileSync(filePath, fileBuffer, 'utf-8');

    const entry = {
        lang,
        filename,
        note: note || '',
        uploaded_at: new Date().toISOString(),
        hash
    };
    index[normalized] = entries.concat(entry);
    saveIndex();

    return { ok: true, filename, imdb_id: normalized, lang };
}

function getFilePath(filename) {
    const base = path.basename(filename);
    if (base !== filename || /[<>:"|?*]/.test(base)) return null;
    const full = path.join(DATA_DIR, base);
    if (!full.startsWith(path.resolve(DATA_DIR))) return null;
    return full;
}

module.exports = {
    ensureDir,
    loadIndex,
    getIndex,
    addEntry,
    getFilePath,
    normalizeImdbId,
    normalizeToUtf8,
    DATA_DIR,
    INDEX_FILE
};
