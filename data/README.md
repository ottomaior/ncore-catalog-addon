# Catalog data (generated)

This folder holds JSON files built **weekly** (Sunday 03:00).

**Movies**
- **`most_seeded_movies.json`** – Built by `build_most_seeded_movies_catalog.py`. Used for **nCore – Top Seed – Összes**, **Top Seed – [genre]**, and **Magyar filmek** (after filter).
- **`most_seeded_hungarian_productions_movies.json`** – Built by `filter_hungarian_productions.py` (filters movies produced in Hungary).

**Series (Sorozat HD/HU)**
- **`most_seeded_series.json`** – Built by `build_most_seeded_series_catalog.py`. Used for **nCore – Top Seed – Sorozatok – Összes**, **Top Seed – Sorozatok – [genre]**, and **Magyar sorozatok** (after filter).
- **`most_seeded_hungarian_productions_series.json`** – Built by `filter_hungarian_productions_series.py` (filters series produced in Hungary).

Run manually:

```bash
python scripts/build_most_seeded_movies_catalog.py
python scripts/filter_hungarian_productions.py
python scripts/build_most_seeded_series_catalog.py
python scripts/filter_hungarian_productions_series.py
```

Files are not committed (see `.gitignore`). On first run or after deploy, run the scripts once or wait for the weekly cron.
