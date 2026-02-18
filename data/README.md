# Catalog data (generated)

This folder holds JSON files built by scheduled scripts. **Series** use **TVDB** for metadata; **movies** and Hungarian filter use **TMDB**. **Streaming** catalogs (Netflix, HBO Max, Prime Video) are split from the big catalogs using **TMDB watch providers** (JustWatch data, Hungary).

**Structure (matches Stremio catalog types)**

**🏆 Top Seed**
- **`most_seeded_movies.json`** – Built weekly by `build_most_seeded_movies_catalog.py`. Top-seeded HD movies (genre filter).
- **`most_seeded_series.json`** – Built weekly by `build_most_seeded_series_catalog.py`. Top-seeded HD/HU 1080p series (HDSER_HUN, search 1080p in title, sort by seeders).
- **`most_seeded_hungarian_productions_movies.json`** – Built weekly by `filter_hungarian_productions.py` (Hungarian-produced movies).
- **`most_seeded_hungarian_productions_series.json`** – Built weekly by `filter_hungarian_productions_series.py` (Hungarian-produced series).

**🔥 Trendi (top seeded from last 200 uploads, 1080p)**
- **`trending_movies.json`** – Built every 6 hours by `build_trending_catalog.py`. Last 200 HD_HUN 1080p by upload, then top 30 by seeders (proper order).
- **`trending_series.json`** – Same, HDSER_HUN 1080p, top 30 series.

**⏰ Legfrissebb**
- **`hd_movies.json`** – Built every 3 hours by `build_latest_catalog.py`. Latest HD movies (2025/2026), big catalog (~2000).
- **`hd_series.json`** – Built every 3 hours by `build_latest_catalog.py`. Latest HD series, big catalog (~2000).

**⏰ STREAMING (split by TMDB watch providers, HU; only latest uploads)**
- **`netflix_movies.json`**, **`netflix_series.json`** – Filled by `split_catalogs_by_provider.py` from `hd_movies.json` + `hd_series.json` (only items where TMDB says Netflix in Hungary).
- **`max_movies.json`**, **`max_series.json`** – Same, TMDB Max (provider 387) in HU.
- **`disneyplus_movies.json`**, **`disneyplus_series.json`** – Same, TMDB Disney+ in HU.

Run manually (regenerate all):

```bash
# 1. Big catalogs (Legfrissebb + Top Seed sources)
python scripts/build_trending_catalog.py   # optional: trending (50 movies + 50 series)
python scripts/build_latest_catalog.py
python scripts/build_most_seeded_movies_catalog.py
python scripts/filter_hungarian_productions.py
python scripts/build_most_seeded_series_catalog.py
python scripts/filter_hungarian_productions_series.py

# 2. Split into streaming provider JSONs (TMDB watch providers)
python scripts/split_catalogs_by_provider.py
```

Files are not committed (see `.gitignore`). On first run or after deploy, run the scripts in order or wait for cron.
