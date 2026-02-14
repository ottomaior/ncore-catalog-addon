# Catalog data (generated)

This folder holds JSON files built **weekly** (Sunday 03:00).

1. **`most_seeded_movies.json`** – Built by `build_most_seeded_movies_catalog.py`. Used for **nCore – Top Seed – Összes** and **Top Seed – [genre]** catalogs (Hungarian HD movies by seed).

2. **`most_seeded_hungarian_productions_movies.json`** – Built by `filter_hungarian_productions.py`, which reads `most_seeded_movies.json`, checks TMDB production country for each movie, and keeps only movies produced in Hungary. Used for **nCore – Legtöbb seed – Magyar filmek**.

Run manually:

```bash
python scripts/build_most_seeded_movies_catalog.py
python scripts/filter_hungarian_productions.py
```

Files are not committed (see `.gitignore`). On first run or after deploy, run both scripts once or wait for the weekly cron.
