"""
Build data/most_seeded_hungarian_productions_movies.json from data/most_seeded_movies.json.
Reads the existing catalog, checks TMDB production_countries for each movie, keeps only
movies produced in Hungary, keeps order by seeders. Run after build_most_seeded_movies_catalog.py.

Usage: python scripts/filter_hungarian_productions.py
Output: data/most_seeded_hungarian_productions_movies.json
"""
import time
import os
import json
from pathlib import Path
from dotenv import load_dotenv
import requests

script_dir = Path(__file__).parent.resolve()
project_root = script_dir.parent
config_file = project_root / 'config' / 'config.env'
data_dir = project_root / 'data'
source_file = data_dir / 'most_seeded_movies.json'
out_file = data_dir / 'most_seeded_hungarian_productions_movies.json'

if config_file.exists():
    load_dotenv(config_file)
else:
    load_dotenv()

TMDB_API_KEY = os.getenv('TMDB_API_KEY')
TMDB_DELAY = float(os.getenv('TMDB_FILTER_DELAY', '0.35'))


def is_hungarian_production(imdb_id, tmdb_key):
    """Return True if TMDB lists Hungary as a production country for this movie."""
    if not tmdb_key or not imdb_id:
        return False
    imdb_id = str(imdb_id).replace('tt', '').strip()
    if not imdb_id:
        return False
    try:
        r = requests.get(
            'https://api.themoviedb.org/3/find/tt' + imdb_id,
            params={'api_key': tmdb_key, 'external_source': 'imdb_id'},
            timeout=10,
        )
        if r.status_code != 200:
            return False
        data = r.json()
        results = data.get('movie_results') or []
        if not results:
            return False
        tmdb_id = results[0].get('id')
        if not tmdb_id:
            return False
        time.sleep(TMDB_DELAY)
        r2 = requests.get(
            f'https://api.themoviedb.org/3/movie/{tmdb_id}',
            params={'api_key': tmdb_key},
            timeout=10,
        )
        if r2.status_code != 200:
            return False
        countries = (r2.json().get('production_countries') or [])
        return any(
            c.get('iso_3166_1') == 'HU' or (c.get('name') or '').lower() == 'hungary'
            for c in countries
        )
    except Exception:
        return False


def main():
    print('=' * 60)
    print('Magyar filmek szűrése (TMDB production country = Hungary)')
    print('=' * 60)

    if not TMDB_API_KEY:
        print('\n✗ TMDB_API_KEY hiányzik a config.env-ból.')
        exit(1)

    if not source_file.exists():
        print(f'\n✗ Forrás fájl hiányzik: {source_file}')
        print('  Futtasd előbb: python scripts/build_most_seeded_movies_catalog.py')
        exit(1)

    with open(source_file, 'r', encoding='utf-8') as f:
        all_metas = json.load(f)
    if not isinstance(all_metas, list):
        print('\n✗ A forrás fájl nem meta listát tartalmaz.')
        exit(1)

    print(f'\n{len(all_metas)} film a forrásban. TMDB production country ellenőrzés...')
    hungarian = []
    for i, meta in enumerate(all_metas):
        mid = meta.get('id')
        if not mid:
            continue
        if is_hungarian_production(mid, TMDB_API_KEY):
            hungarian.append(meta)
        if (i + 1) % 100 == 0:
            print(f'  Ellenőrizve: {i + 1}/{len(all_metas)}, magyar: {len(hungarian)}')

    # Preserve order (already by seeders in source)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(hungarian, f, ensure_ascii=False, indent=0)
    print(f'\n✓ {len(hungarian)} magyar film mentve: {out_file}')
    print('Kész.')


if __name__ == '__main__':
    main()
