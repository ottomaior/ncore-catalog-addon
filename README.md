# 🇭🇺 nCore Stremio Addons

Hungarian movie and series catalogs for [Stremio](https://www.stremio.com/), built from the nCore tracker.
One Node/Express server hosts **four addons**; Python scripts run by GitHub Actions keep the catalog data fresh.

![Python](https://img.shields.io/badge/python-3.11-blue.svg)
![Node.js](https://img.shields.io/badge/node.js-18+-green.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
[![Live](https://img.shields.io/badge/Live-stremioaddonok.hu-blueviolet)](https://www.stremioaddonok.hu/)

## The four addons

| Addon | Install URL | What it does |
|---|---|---|
| **nCore Katalógus** | `/manifest.json` | 22 catalogs (🏆 Top Seed, 📥 Top letöltés, 🔥 Trendi, ⏰ Legfrissebb, 🗓️ év szerint, Netflix / Disney+ / HBO Max / Prime) + search. Own Hungarian metadata, TMDB backdrops, episode lists. Pick and reorder catalogs at `/configure` before installing. |
| **nCore Episode Info** | `/info/manifest.json` | Shows the latest Hungarian episode uploaded to nCore for a series (as a pseudo-stream). |
| **Magyar Előzetesek** | `/trailers/manifest.json` | Trailers with Hungarian-first fallback: TMDB hu → YouTube HU dubbed → YouTube HU subtitled → TMDB en → YouTube EN. |
| **Magyar feliratok** | `/subtitles/manifest.json` | Community `.srt`/`.vtt` upload by IMDb id, served back into Stremio. |

Live: **[https://www.stremioaddonok.hu/](https://www.stremioaddonok.hu/)**

## How it works

```
GitHub Actions (cron) ─► scripts/*.py ─► data/*.json (committed) ─► Railway deploy ─► server.js
   nCore (ncoreparser) ─► title parsing ─► TMDB (movies) / TVDB (series) / OMDb (ratings)
```

**Schedules** (`.github/workflows/`):

| Workflow | Cadence | Script(s) | Output |
|---|---|---|---|
| Latest | every 3 h | `build_latest_catalog.py` | `hd_movies.json`, `hd_series.json` |
| Trending | every 6 h | `build_trending_catalog.py` | `trending_*.json` |
| Streaming | every 6 h | `split_catalogs_by_provider.py` | `netflix_*`, `disneyplus_*`, `hbomax_*`, `prime_*` |
| Top-seeded + Magyar | weekly (Sun 03:00) | `build_most_seeded_*` + `filter_hungarian_productions*` | `most_seeded_*.json` |
| Top downloaded | monthly (1st, 04:00) | `build_top_downloaded_1080_catalog.py` + filters | `top_downloaded_1080_*.json` |
| CI | on push / PR | `npm test`, `pytest`, `pyflakes` | – |

Streaming catalogs are not built from nCore tags: they are derived from the latest catalogs through TMDB "where to watch"
(Netflix = US region, the others = HU). That data comes from **JustWatch** and must be attributed when shown.

**Server** (`server.js`): loads every `data/*.json` through `lib/catalog-data.js` (one registry of sources and catalogs,
TTL reload, id index, genre filter, search), mounts the four addon routers, serves the hub pages and `/health`.
Responses carry `Cache-Control` (catalogs 1 h + stale-while-revalidate, meta 6 h) and are gzip-compressed.
TMDB backdrops, episode lists and trailer lookups are cached in memory.

## Running locally

Requirements: Node 18+, Python 3.11 (only for the build scripts), an nCore account, a TMDB API key, a TVDB API key
(optional OMDb key for IMDb ratings).

```bash
git clone https://github.com/ottomaior/ncore-catalog-addon.git
cd ncore-catalog-addon
npm install
cp config/config.example.env config/config.env   # fill in the keys below
npm start                                         # http://localhost:7000
```

`config/config.env` (never commit it):

| Variable | Used by |
|---|---|
| `TMDB_API_KEY` | server (backdrops, episodes, trailers, subtitle resolver) and scripts |
| `NCORE_USER`, `NCORE_PASS` | scripts |
| `TVDB_API_KEY`, `TVDB_PIN` (optional) | series scripts |
| `OMDB_API_KEY` (optional) | scripts, IMDb ratings |
| `PORT` (default 7000), `BASE_URL` | server |
| `SUBTITLES_DATA_DIR` | server; point it at a Railway volume to persist uploads |
| `SUBTITLE_UPLOAD_RATE_LIMIT` (default 10 per 10 min per IP) | server |
| `DATA_REMOTE_BASE_URL`, `DATA_REMOTE_REFRESH_MINUTES` | server; see below |
| `CRON_SECRET` | server; enables `POST /cron/build` |

Rebuild the data yourself (same order as the workflows):

```bash
pip install -r requirements.txt
python scripts/build_latest_catalog.py
python scripts/split_catalogs_by_provider.py
python scripts/build_trending_catalog.py
python scripts/build_most_seeded_movies_catalog.py && python scripts/filter_hungarian_productions.py
python scripts/build_most_seeded_series_catalog.py && python scripts/filter_hungarian_productions_series.py
python scripts/build_top_downloaded_1080_catalog.py --force
```

Tests:

```bash
npm test                 # Node: registry, genres, search, HTTP routes (18 tests)
npm run test:py          # Python: title parsing, episode detection, TMDB match scoring
```

## Serving data without redeploys

By default every data commit from GitHub Actions triggers a Railway deploy (roughly every 3 hours). To avoid that:

1. Set `DATA_REMOTE_BASE_URL=https://raw.githubusercontent.com/ottomaior/ncore-catalog-addon/main/data` on Railway.
   The server then re-fetches each JSON every `DATA_REMOTE_REFRESH_MINUTES` (default 30) using ETags, and falls back
   to the files baked into the image until the first fetch succeeds.
2. Uncomment `watchPatterns` in `railway.toml` (or set Watch Paths in the Railway service settings) so commits that
   only touch `data/` no longer deploy.

Do step 1 before step 2, otherwise production data goes stale.

## Layout

```
server.js               Express host: routers, hub pages, /health, subtitle upload, /cron/build
index.js                Catalog addon (manifest, catalog + meta handlers, TMDB caches)
info-addon.js           Episode Info addon (reads latest episode from hd_series.json)
trailers/               Trailer addon + provider (TMDB / YouTube scraping) with TTL cache
subtitles/              Subtitle addon + upload service
lib/catalog-data.js     Data registry: sources, catalogs, genres, search, remote refresh
public/                 Hub pages (index, catalog picker, trailers, subtitles)
scripts/                Python build scripts; shared helpers in catalog_common.py; tests in scripts/tests
data/                   Generated catalog JSON (committed, see data/README.md)
.github/workflows/      Scheduled data builds + CI
```

## Attribution

Metadata from [TMDB](https://www.themoviedb.org/) and [TheTVDB](https://thetvdb.com/); ratings from [OMDb](https://www.omdbapi.com/);
streaming availability from [JustWatch](https://www.justwatch.com/) via TMDB. This project is not affiliated with nCore, Stremio,
TMDB, TheTVDB or JustWatch.

## License

[MIT](LICENSE)
