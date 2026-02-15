"""
Build data/most_seeded_hungarian_productions_series.json from data/most_seeded_series.json.
Reads the existing catalog, checks TMDB origin_country for each TV show, keeps only
series produced in Hungary, keeps order by seeders. Run after build_most_seeded_series_catalog.py.

Usage: python scripts/filter_hungarian_productions_series.py
Output: data/most_seeded_hungarian_productions_series.json
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
source_file = data_dir / 'most_seeded_series.json'
out_file = data_dir / 'most_seeded_hungarian_productions_series.json'

if config_file.exists():
    load_dotenv(config_file)
else:
    load_dotenv()

TMDB_API_KEY = os.getenv('TMDB_API_KEY')
TMDB_DELAY = float(os.getenv('TMDB_FILTER_DELAY', '0.35'))


def is_hungarian_production(imdb_id, tmdb_key):
    """Return True if TMDB lists Hungary in origin_country for this TV show."""
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
        results = data.get('tv_results') or []
        if not results:
            return False
        tmdb_id = results[0].get('id')
        if not tmdb_id:
            return False
        time.sleep(TMDB_DELAY)
        r2 = requests.get(
            f'https://api.themoviedb.org/3/tv/{tmdb_id}',
            params={'api_key': tmdb_key},
            timeout=10,
        )
        if r2.status_code != 200:
            return False
        # TV shows use origin_country (array of ISO codes like "HU")
        countries = (r2.json().get('origin_country') or [])
        return 'HU' in countries or 'Hungary' in [str(c) for c in countries]
    except Exception:
        return False


def main():
    print('=' * 60)
    print('Magyar sorozatok szűrése (TMDB origin_country = Hungary)')
    print('=' * 60)

    if not TMDB_API_KEY:
        print('\n✗ TMDB_API_KEY hiányzik a config.env-ból.')
        exit(1)

    if not source_file.exists():
        print(f'\n✗ Forrás fájl hiányzik: {source_file}')
        print('  Futtasd előbb: python scripts/build_most_seeded_series_catalog.py')
        exit(1)

    with open(source_file, 'r', encoding='utf-8') as f:
        all_metas = json.load(f)
    if not isinstance(all_metas, list):
        print('\n✗ A forrás fájl nem meta listát tartalmaz.')
        exit(1)

    print(f'\n{len(all_metas)} sorozat a forrásban. TMDB origin_country ellenőrzés...')
    hungarian = []
    for i, meta in enumerate(all_metas):
        mid = meta.get('id')
        if not mid:
            continue
        if is_hungarian_production(mid, TMDB_API_KEY):
            hungarian.append(meta)
        if (i + 1) % 100 == 0:
            print(f'  Ellenőrizve: {i + 1}/{len(all_metas)}, magyar: {len(hungarian)}')

    out_file.parent.mkdir(parents=True, exist_ok=True)
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(hungarian, f, ensure_ascii=False, indent=0)
    print(f'\n✓ {len(hungarian)} magyar sorozat mentve: {out_file}')
    print('Kész.')


if __name__ == '__main__':
    main()
