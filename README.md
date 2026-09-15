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
| **nCore Katalógus** | `/manifest.json` | 23 catalogs (Legfrissebb, Felkapott, Top Seed, Legtöbbet letöltött, Magyar, Megjelenés éve, Netflix / Disney+ / HBO Max / Prime, Klasszikusok) + search. Own Hungarian metadata, TMDB backdrops, episode lists, Discover deep links. Pick catalogs, order, Board visibility and RPDB posters at `/configure`. |
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
| Trending (Felkapott) | every 6 h | `build_trending_catalog.py` | `trending_*.json`, `trending_state.json` |
| Streaming | every 6 h | `split_catalogs_by_provider.py` | `netflix_*`, `disneyplus_*`, `hbomax_*`, `prime_*` |
| Top-seeded + Magyar | weekly (Sun 03:00) | `build_most_seeded_*` + `filter_hungarian_productions*` | `most_seeded_*.json` |
| Top downloaded | monthly (1st, 04:00) | `build_top_downloaded_1080_catalog.py` + filters | `top_downloaded_1080_*.json` |
| CI | on push / PR | `npm test`, `pytest`, `pyflakes` | – |

**Trending (Felkapott) ranking.** The pool is every 1080p upload of the last 30 days (cap 600 per category). Releases of the same title (WEB-DL, BluRay, x265...) are merged: seeds and leechers are summed and the age is taken from the earliest upload. Score = `(seeds + 2·leechers) / (age_days + 2)^0.7`, so an established 1000-seed title from last week stays above a 150-seed upload from this morning, while a genuinely hot new release still reaches the top. Movies need 40 seeds per title and a release year inside `NCORE_TRENDING_MIN_YEAR..MAX_YEAR`; series need 30 seeds per episode (when fewer than 30 titles reach a floor, the best of the rest fill the list), are ranked by their best episode (never summed across episodes) and must have aired within a year. Every run also stores peer samples per title in `data/trending_state.json`; set the repository variable `NCORE_TRENDING_MOMENTUM=1` to rank by peers gained over the last 48 h instead (titles without history fall back to the score).

Streaming catalogs are not built from nCore tags: they are derived from the latest catalogs through TMDB "where to watch"
(Netflix = US region, the others = HU). That data comes from **JustWatch** and must be attributed when shown.

**Server** (`server.js`): loads every `data/*.json` through `lib/catalog-data.js` (one registry of sources and catalogs,
TTL reload, id index, genre filter, search), mounts the four addon routers, serves the hub pages and `/health`.
Responses carry `Cache-Control` (catalogs 1 h + stale-while-revalidate, meta 6 h) and are gzip-compressed.
TMDB backdrops, episode lists and trailer lookups are cached in memory.

## Catalog design

Stremio renders a Board row as `{catalog name} - {Type}` and adds the type itself, so catalog names carry no
"filmek / sorozatok" suffix. Each catalog has a `board` default; a catalog that is not on the Board gets a required
`genre` extra, which Stremio treats as Discover-only. By default every catalog is on the Board; users turn rows off in the picker, which keeps them
available in Discover.

- **Genres** are normalized to one Hungarian vocabulary on load (TMDB English, adjective forms and TVDB combos such as
  "Action & Adventure" all map to the same labels), so the dropdown filter and the Discover sidebar agree.
  The dropdown also offers an *Idei* (current year) pseudo-filter.
  Small lists (streaming, Magyar, derived) offer only the pseudo-filters to keep the manifest under Stremio's 8 KB limit.
- **Klasszikusok** (pre-2000, IMDb ≥ 7) is computed from the union of all movie data files, no extra pipeline.
- **Series** names are served without the "(S03E02)" tag (it stays in the description and in the Episode Info addon);
  `releaseInfo` comes from TMDB ("2019-" / "2019-2023").
- **User config** lives in the install URL path: `/c/<token>/manifest.json`. The token is base64url JSON holding only
  the differences from the defaults (`x` excluded ids, `o` order, `hp`/`hm` Board changes, `rpdb` key), so it stays short.
  `/manifest.json?catalogs=…` from older installs still works. `/c/<token>/configure` reopens the picker prefilled.
- **RPDB**: with a RatingPosterDB key in the config, posters come from `api.ratingposterdb.com` (rating overlay).
- **Images baked at build time**: every build script fills `background` (textless TMDB backdrop) and `logo`
  (Hungarian, then English) on new titles, reusing values from the previous JSON, at most
  `TMDB_IMAGES_MAX_PER_RUN` (400) lookups per run. The meta handler only asks TMDB for entries built before this.
- **Output guard**: every data workflow runs `scripts/check_catalog_output.py` before committing and fails the run
  (GitHub emails you) if a catalog file is missing, invalid, empty, or lost more than half its items.

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
| `TMDB_IMAGES_MAX_PER_RUN` (default 400) | scripts; TMDB image lookups per build run |
| `NCORE_TRENDING_POOL_DAYS` (30), `NCORE_TRENDING_POOL_MAX` (600), `NCORE_TRENDING_MIN_SEEDERS` (40), `NCORE_TRENDING_MIN_SEEDERS_SERIES` (30), `NCORE_TRENDING_SERIES_MAX_AGE_DAYS` (365) | trending script |
| `NCORE_TRENDING_GRAVITY` (0.7), `NCORE_TRENDING_LEECH_WEIGHT` (2), `NCORE_TRENDING_MOMENTUM` (0) | trending ranking; see below |
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
npm test                 # Node: registry, genres, config tokens, HTTP routes (25 tests)
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
lib/catalog-data.js     Data registry: sources, catalogs, genres, derived lists, search, remote refresh
lib/addon-config.js     Install-URL config token (catalog subset/order, Board visibility, RPDB)
public/                 Hub pages (index, catalog picker, trailers, subtitles)
scripts/                Python build scripts; shared helpers in catalog_common.py; output guard check_catalog_output.py; tests in scripts/tests
data/                   Generated catalog JSON (committed, see data/README.md)
.github/workflows/      Scheduled data builds + CI
```

## Attribution

Metadata from [TMDB](https://www.themoviedb.org/) and [TheTVDB](https://thetvdb.com/); ratings from [OMDb](https://www.omdbapi.com/);
streaming availability from [JustWatch](https://www.justwatch.com/) via TMDB. This project is not affiliated with nCore, Stremio,
TMDB, TheTVDB or JustWatch.

## License

[MIT](LICENSE)
