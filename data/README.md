# Catalog data (generated)

This folder holds JSON files built by scheduled scripts. All scripts use **TMDB** for metadata (no Trakt).

**Movies**
- **`hd_movies.json`** – Built **every 3 hours** by `build_latest_catalog.py`. Latest HD movies from nCore, **only 2025/2026 releases** (incremental updates).
- **`most_seeded_movies.json`** – Built **weekly** (Sunday 03:00) by `build_most_seeded_movies_catalog.py`. Top-seeded HD movies with genre filtering.
- **`most_seeded_hungarian_productions_movies.json`** – Built **weekly** by `filter_hungarian_productions.py` (filters movies produced in Hungary).
- **`netflix_movies.json`** – Built **every 6 hours** by `build_netflix_catalog.py`. Latest 100 Netflix movies (.nf.1080) from nCore (incremental updates).
- **`hbomax_movies.json`** – Built **every 6 hours** by `build_hbomax_catalog.py`. Latest 100 HBO Max movies (.hmax.1080) from nCore (incremental updates).
- **`primevideo_movies.json`** – Built **every 6 hours** by `build_primevideo_catalog.py`. Latest 100 Prime Video movies (.amzn.1080) from nCore (incremental updates).

**Series**
- **`hd_series.json`** – Built **every 3 hours** by `build_latest_catalog.py`. Latest HD series from nCore, all uploads (incremental updates).
- **`most_seeded_series.json`** – Built **weekly** (Sunday 03:00) by `build_most_seeded_series_catalog.py`. Top-seeded HD series with genre filtering.
- **`most_seeded_hungarian_productions_series.json`** – Built **weekly** by `filter_hungarian_productions_series.py` (filters series produced in Hungary).
- **`netflix_series.json`** – Built **every 6 hours** by `build_netflix_catalog.py`. Latest 100 Netflix series (.nf.1080) from nCore (incremental updates).
- **`hbomax_series.json`** – Built **every 6 hours** by `build_hbomax_catalog.py`. Latest 100 HBO Max series (.hmax.1080) from nCore (incremental updates).
- **`primevideo_series.json`** – Built **every 6 hours** by `build_primevideo_catalog.py`. Latest 100 Prime Video series (.amzn.1080) from nCore (incremental updates).

Run manually:

```bash
# Latest HD catalogs (every 3 hours)
python scripts/build_latest_catalog.py

# Top seeded catalogs (weekly)
python scripts/build_most_seeded_movies_catalog.py
python scripts/filter_hungarian_productions.py
python scripts/build_most_seeded_series_catalog.py
python scripts/filter_hungarian_productions_series.py

# Streaming provider catalogs (every 6 hours)
python scripts/build_netflix_catalog.py
python scripts/build_hbomax_catalog.py
python scripts/build_primevideo_catalog.py
```

Files are not committed (see `.gitignore`). On first run or after deploy, run the scripts once or wait for the scheduled cron.
