"""
Split big catalogs into streaming-provider JSONs using TMDB watch providers (JustWatch data).
Reads: data/hd_movies.json, data/hd_series.json (from build_latest_catalog only – latest uploads).
Writes: netflix, disneyplus, hbomax, prime (each: _movies.json, _series.json).
Uses per-provider regions: Netflix = US (broad coverage), Disney+/HBO Max/Prime = HU (matches nCore HU catalog). Only includes items where TMDB reports that provider for that region. For Netflix series only: if TMDB watch providers have no data, TVDB network/company is used as fallback (Netflix as network). Streaming catalogs = latest items only, not most-seeded.

Usage: python scripts/split_catalogs_by_provider.py
Requires: TMDB_API_KEY in config. Run after build_latest_catalog.py.
Optional: TVDB_API_KEY (and TVDB_PIN) for Netflix series fallback when TMDB watch providers have no data.
"""
import json
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from tvdb_client import is_netflix_series_by_imdb
except ImportError:
    is_netflix_series_by_imdb = None

script_dir = Path(__file__).parent.resolve()
project_root = script_dir.parent
config_file = project_root / 'config' / 'config.env'
data_dir = project_root / 'data'

if config_file.exists():
    load_dotenv(config_file)
else:
    load_dotenv()

TMDB_API_KEY = os.getenv('TMDB_API_KEY', '').strip()
TVDB_API_KEY = os.getenv('TVDB_API_KEY', '').strip()
TVDB_PIN = os.getenv('TVDB_PIN', '').strip() or None
TMDB_BASE = 'https://api.themoviedb.org/3'
TMDB_DELAY = 0.35

# Per-provider watch region: Netflix uses US (broad), others use HU (matches nCore HU catalog)
PROVIDER_REGION = {
    'netflix': 'US',
    'disneyplus': 'HU',
    'hbomax': 'HU',
    'prime': 'HU',
}
REGIONS_NEEDED = ('US', 'HU')  # We fetch both from one API response

# TMDB watch provider IDs (flatrate / subscription)
PROVIDER_NETFLIX = 8
PROVIDER_DISNEY_PLUS = 337
PROVIDER_HBO_MAX = 1899
PROVIDER_PRIME = 119

OUTPUTS = {
    'netflix': (data_dir / 'netflix_movies.json', data_dir / 'netflix_series.json', PROVIDER_NETFLIX),
    'disneyplus': (data_dir / 'disneyplus_movies.json', data_dir / 'disneyplus_series.json', PROVIDER_DISNEY_PLUS),
    'hbomax': (data_dir / 'hbomax_movies.json', data_dir / 'hbomax_series.json', PROVIDER_HBO_MAX),
    'prime': (data_dir / 'prime_movies.json', data_dir / 'prime_series.json', PROVIDER_PRIME),
}


def load_json(path):
    if not path.exists():
        return []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f'  ⚠ {path.name} nem olvasható: {e}')
        return []


# Cache: imdb_id -> tmdb_id; tmdb_id -> { region: set(provider_id) } to avoid repeated TMDB calls
_movie_tmdb_cache = {}
_tv_tmdb_cache = {}
_movie_providers_cache = {}
_tv_providers_cache = {}


def get_tmdb_movie_id(imdb_id, api_key):
    if not api_key or not imdb_id:
        return None
    if imdb_id in _movie_tmdb_cache:
        return _movie_tmdb_cache[imdb_id]
    try:
        time.sleep(TMDB_DELAY)
        r = requests.get(
            f'{TMDB_BASE}/find/{imdb_id}',
            params={'api_key': api_key, 'external_source': 'imdb_id'},
            timeout=10,
        )
        if r.status_code != 200:
            _movie_tmdb_cache[imdb_id] = None
            return None
        results = r.json().get('movie_results') or []
        tid = results[0].get('id') if results else None
        _movie_tmdb_cache[imdb_id] = tid
        return tid
    except Exception:
        _movie_tmdb_cache[imdb_id] = None
        return None


def get_tmdb_tv_id(imdb_id, api_key):
    if not api_key or not imdb_id:
        return None
    if imdb_id in _tv_tmdb_cache:
        return _tv_tmdb_cache[imdb_id]
    try:
        time.sleep(TMDB_DELAY)
        r = requests.get(
            f'{TMDB_BASE}/find/{imdb_id}',
            params={'api_key': api_key, 'external_source': 'imdb_id'},
            timeout=10,
        )
        if r.status_code != 200:
            _tv_tmdb_cache[imdb_id] = None
            return None
        results = r.json().get('tv_results') or []
        tid = results[0].get('id') if results else None
        _tv_tmdb_cache[imdb_id] = tid
        return tid
    except Exception:
        _tv_tmdb_cache[imdb_id] = None
        return None


def get_movie_provider_ids(tmdb_id, api_key):
    """Return dict region -> set(provider_id) for US and HU (one API call)."""
    if not api_key or not tmdb_id:
        return {r: set() for r in REGIONS_NEEDED}
    if tmdb_id in _movie_providers_cache:
        return _movie_providers_cache[tmdb_id]
    try:
        time.sleep(TMDB_DELAY)
        r = requests.get(
            f'{TMDB_BASE}/movie/{tmdb_id}/watch/providers',
            params={'api_key': api_key},
            timeout=10,
        )
        if r.status_code != 200:
            empty = {region: set() for region in REGIONS_NEEDED}
            _movie_providers_cache[tmdb_id] = empty
            return empty
        results = r.json().get('results') or {}
        by_region = {}
        for region in REGIONS_NEEDED:
            region_data = results.get(region) or {}
            flat = region_data.get('flatrate') or []
            by_region[region] = {p.get('provider_id') for p in flat if p.get('provider_id')}
        _movie_providers_cache[tmdb_id] = by_region
        return by_region
    except Exception:
        empty = {region: set() for region in REGIONS_NEEDED}
        _movie_providers_cache[tmdb_id] = empty
        return empty


def get_tv_provider_ids(tmdb_id, api_key):
    """Return dict region -> set(provider_id) for US and HU (one API call)."""
    if not api_key or not tmdb_id:
        return {r: set() for r in REGIONS_NEEDED}
    if tmdb_id in _tv_providers_cache:
        return _tv_providers_cache[tmdb_id]
    try:
        time.sleep(TMDB_DELAY)
        r = requests.get(
            f'{TMDB_BASE}/tv/{tmdb_id}/watch/providers',
            params={'api_key': api_key},
            timeout=10,
        )
        if r.status_code != 200:
            empty = {region: set() for region in REGIONS_NEEDED}
            _tv_providers_cache[tmdb_id] = empty
            return empty
        results = r.json().get('results') or {}
        by_region = {}
        for region in REGIONS_NEEDED:
            region_data = results.get(region) or {}
            flat = region_data.get('flatrate') or []
            by_region[region] = {p.get('provider_id') for p in flat if p.get('provider_id')}
        _tv_providers_cache[tmdb_id] = by_region
        return by_region
    except Exception:
        empty = {region: set() for region in REGIONS_NEEDED}
        _tv_providers_cache[tmdb_id] = empty
        return empty


def merge_dedup_by_id(*lists):
    seen = set()
    out = []
    for lst in lists:
        for item in lst:
            if not item or not isinstance(item, dict):
                continue
            mid = item.get('id')
            if not mid or mid in seen:
                continue
            seen.add(mid)
            out.append(item)
    return out


def _series_episode_key(item):
    """Sort key for series: (season, episode); higher = newer."""
    s = item.get('latest_season')
    e = item.get('latest_episode')
    return (s if s is not None else 0, e if e is not None else 0)


def merge_dedup_series_keep_newest(series_list):
    """Dedupe series by id; keep the entry with newest latest_season/latest_episode. Order by first occurrence."""
    by_id = {}
    for s in series_list:
        if not s or not isinstance(s, dict):
            continue
        sid = s.get('id')
        if not sid:
            continue
        if sid not in by_id or _series_episode_key(s) > _series_episode_key(by_id[sid]):
            by_id[sid] = s
    seen = set()
    out = []
    for s in series_list:
        sid = s.get('id') if isinstance(s, dict) else None
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append(by_id[sid])
    return out


def main():
    if not TMDB_API_KEY:
        print('❌ TMDB_API_KEY hiányzik (config/config.env).')
        return 1

    data_dir.mkdir(parents=True, exist_ok=True)

    # Use only latest catalogs (build_latest_catalog) – streaming = latest uploads, not most-seeded
    hd_movies = load_json(data_dir / 'hd_movies.json')
    hd_series = load_json(data_dir / 'hd_series.json')
    all_movies = merge_dedup_by_id(hd_movies)
    all_series = merge_dedup_series_keep_newest(hd_series)

    print(f'📦 Betöltve (csak legfrissebb): {len(all_movies)} film, {len(all_series)} sorozat')
    if not all_movies and not all_series:
        print('⚠ Nincs film vagy sorozat. Futtasd előbb: build_latest_catalog.py')
        return 0

    # Collect provider lists: name -> (movies_list, series_list)
    provider_movies = {name: [] for name in OUTPUTS}
    provider_series = {name: [] for name in OUTPUTS}

    for i, item in enumerate(all_movies):
        imdb_id = item.get('id')
        if not imdb_id:
            continue
        tmdb_id = get_tmdb_movie_id(imdb_id, TMDB_API_KEY)
        if not tmdb_id:
            continue
        by_region = get_movie_provider_ids(tmdb_id, TMDB_API_KEY)
        for name, (_, _, provider_id) in OUTPUTS.items():
            region = PROVIDER_REGION[name]
            ids = by_region.get(region) or set()
            if provider_id in ids:
                provider_movies[name].append(item)
        if (i + 1) % 100 == 0 or i + 1 == len(all_movies):
            print(f'  Filmek: {i + 1}/{len(all_movies)}')

    for i, item in enumerate(all_series):
        imdb_id = item.get('id')
        if not imdb_id:
            continue
        tmdb_id = get_tmdb_tv_id(imdb_id, TMDB_API_KEY)
        if not tmdb_id:
            if is_netflix_series_by_imdb and TVDB_API_KEY and is_netflix_series_by_imdb(imdb_id, TVDB_API_KEY, TVDB_PIN):
                provider_series['netflix'].append(item)
            continue
        by_region = get_tv_provider_ids(tmdb_id, TMDB_API_KEY)
        for name, (_, _, provider_id) in OUTPUTS.items():
            region = PROVIDER_REGION[name]
            ids = by_region.get(region) or set()
            if provider_id in ids:
                provider_series[name].append(item)
            elif name == 'netflix' and is_netflix_series_by_imdb and TVDB_API_KEY:
                if is_netflix_series_by_imdb(imdb_id, TVDB_API_KEY, TVDB_PIN):
                    provider_series['netflix'].append(item)
        if (i + 1) % 100 == 0 or i + 1 == len(all_series):
            print(f'  Sorozatok: {i + 1}/{len(all_series)}')

    for name, (out_movies_path, out_series_path, _) in OUTPUTS.items():
        with open(out_movies_path, 'w', encoding='utf-8') as f:
            json.dump(provider_movies[name], f, ensure_ascii=False, indent=2)
        with open(out_series_path, 'w', encoding='utf-8') as f:
            json.dump(provider_series[name], f, ensure_ascii=False, indent=2)
        print(f'✓ {name}: {len(provider_movies[name])} film, {len(provider_series[name])} sorozat → {out_movies_path.name}, {out_series_path.name}')

    print('\n✅ Streaming katalógusok frissítve (Netflix=US, Disney+/HBO Max/Prime=HU). Adatforrás: JustWatch.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
