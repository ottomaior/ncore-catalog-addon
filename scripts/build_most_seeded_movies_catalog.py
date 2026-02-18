"""
Build data/most_seeded_movies.json for the Stremio catalog (top seeded by genre).
Fetches HD-HUN movies from nCore, matches to TMDB only (no Trakt), gets genres, writes one JSON.
- If the file already exists: fetches only NCORE_PAGES_PER_RUN pages, merges by movie id,
  sorts by seed rank, trims to TARGET_COUNT (incremental, faster runs).
- If no file: full fetch until TARGET_COUNT or no more pages.

Usage: python scripts/build_most_seeded_movies_catalog.py
Output: data/most_seeded_movies.json
"""
import re
import time
import os
import json
from pathlib import Path
from dotenv import load_dotenv
import requests

try:
    from ncoreparser import Client, SearchParamType, ParamSort, ParamSeq
except ImportError:
    Client = None
    SearchParamType = ParamSort = ParamSeq = None

script_dir = Path(__file__).parent.resolve()
project_root = script_dir.parent
config_file = project_root / 'config' / 'config.env'
data_dir = project_root / 'data'
out_file = data_dir / 'most_seeded_movies.json'

if config_file.exists():
    load_dotenv(config_file)
else:
    load_dotenv()

TMDB_API_KEY = os.getenv('TMDB_API_KEY')
NCORE_USER = os.getenv('NCORE_USER', '').strip()
NCORE_PASS = os.getenv('NCORE_PASS', '').strip()

# Aim for this many torrents total; script paginates until TARGET_COUNT or no more pages.
TARGET_COUNT = int(os.getenv('NCORE_CATALOG_TARGET_MOVIES', '1000'))
# When extending existing file: fetch only this many nCore pages per run (faster incremental updates).
NCORE_PAGES_PER_RUN = int(os.getenv('NCORE_PAGES_PER_RUN', '15'))
TMDB_DELAY = 0.4  # Delay between TMDB API calls


def search_movie_on_tmdb(clean_title, year, tmdb_key):
    """
    Search for movie on TMDB and return full metadata including IMDB ID.
    Returns dict with all needed fields or None.
    """
    if not tmdb_key:
        return None
    
    # Try multiple title variations
    variations = [
        clean_title,
        clean_title.replace(' and ', ' & '),
        clean_title.replace(' & ', ' and '),
    ]
    
    for variation in variations:
        try:
            time.sleep(TMDB_DELAY)
            # Search for movie
            search_url = f'https://api.themoviedb.org/3/search/movie?api_key={tmdb_key}&query={variation}&language=hu-HU'
            if year:
                search_url += f'&year={year}'
            
            r = requests.get(search_url, timeout=10)
            if r.status_code != 200:
                continue
            
            results = r.json().get('results', [])
            if not results:
                continue
            
            # Get first result's full details
            tmdb_id = results[0]['id']
            
            time.sleep(TMDB_DELAY)
            details_url = f'https://api.themoviedb.org/3/movie/{tmdb_id}?api_key={tmdb_key}&language=hu-HU'
            r2 = requests.get(details_url, timeout=10)
            if r2.status_code != 200:
                continue
            
            movie_data = r2.json()
            imdb_id = movie_data.get('imdb_id')  # ← IMDB ID here!
            
            if not imdb_id:
                continue
            
            # Return all data in one go
            return {
                'imdb_id': imdb_id,
                'title': movie_data.get('title'),
                'poster_path': movie_data.get('poster_path'),
                'genres': [g['name'] for g in movie_data.get('genres', [])],
                'description': movie_data.get('overview', ''),
                'year': int(movie_data.get('release_date', '')[:4]) if movie_data.get('release_date') else None,
                'rating': movie_data.get('vote_average')
            }
        except Exception as e:
            continue
    
    return None


def parse_movie_title(title):
    year_match = re.search(r'\.(\d{4})\.', title)
    year = year_match.group(1) if year_match else None
    clean = title[:year_match.start()] if year_match else title
    clean = clean.replace('.', ' ').strip()
    clean = ' '.join(clean.split())
    return clean, year


def is_likely_series(title):
    if not title:
        return False
    return bool(re.search(r's\d{1,2}(?:e\d{1,2})?', title, re.IGNORECASE))




# Delay between nCore page requests (seconds) – gentler pacing for 4000+ items
NCORE_PAGE_DELAY = float(os.getenv('NCORE_PAGE_DELAY', '3.0'))
# Retries per page on timeout/error
NCORE_PAGE_RETRIES = int(os.getenv('NCORE_PAGE_RETRIES', '4'))
# Wait (seconds) before retry, and before moving on to next page after failure
NCORE_RETRY_WAIT = float(os.getenv('NCORE_RETRY_WAIT', '35.0'))


def load_existing_metas():
    """Load existing most_seeded_movies.json if present; ensure each meta has 'seeders' for sorting."""
    if not out_file.exists():
        return []
    try:
        with open(out_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f'  Figyelmeztetés: meglévő fájl nem olvasható: {e}')
        return []
    if not isinstance(data, list):
        return []
    for m in data:
        m.setdefault('seeders', 0)
    return data


def fetch_all_hd_hun_movies(client, max_pages=None):
    """Fetch HD-HUN movie torrents with pagination; retry on timeout.
    If max_pages is set (incremental run), stop after that many pages; else stop at TARGET_COUNT or no more pages."""
    if not hasattr(SearchParamType, 'HD_HUN'):
        return []
    all_torrents = []
    page = 1
    consecutive_failures = 0
    while len(all_torrents) < TARGET_COUNT:
        if max_pages is not None and page > max_pages:
            break
        torrents = None
        for attempt in range(1, NCORE_PAGE_RETRIES + 1):
            try:
                result = client.search(
                    pattern='',
                    type=SearchParamType.HD_HUN,
                    sort_by=ParamSort.SEEDERS,
                    sort_order=ParamSeq.DECREASING,
                    page=page,
                )
                torrents = getattr(result, 'torrents', []) or []
                consecutive_failures = 0
                break
            except TypeError:
                return all_torrents
            except Exception as e:
                if attempt < NCORE_PAGE_RETRIES:
                    print(f"  Oldal {page} timeout/hiba (próbálkozás {attempt}/{NCORE_PAGE_RETRIES}), várok {NCORE_RETRY_WAIT}s...")
                    time.sleep(NCORE_RETRY_WAIT)
                else:
                    print(f"  nCore search error (oldal {page}): {e}")
                    consecutive_failures += 1
                    if consecutive_failures >= 2:
                        print("  Két oldal egymás után sikertelen, leállás.")
                        return all_torrents
                    break
        if torrents is None:
            print(f"  Várok {NCORE_RETRY_WAIT}s, majd következő oldal...")
            time.sleep(NCORE_RETRY_WAIT)
            page += 1
            time.sleep(NCORE_PAGE_DELAY)
            continue
        if not torrents:
            break
        all_torrents.extend(torrents)
        print(f"  Oldal {page}: +{len(torrents)} (összesen {len(all_torrents)})")
        if len(torrents) < 25:
            break
        page += 1
        time.sleep(NCORE_PAGE_DELAY)
    return all_torrents


def main():
    print('=' * 60)
    print('nCore – Legnagyobb seed filmek katalógus (JSON)')
    print('=' * 60)

    if not NCORE_USER or not NCORE_PASS:
        print('\n✗ NCORE_USER / NCORE_PASS hiányzik a config.env-ból.')
        exit(1)
    if not TMDB_API_KEY:
        print('\n✗ TMDB_API_KEY hiányzik.')
        exit(1)
    if not Client or not SearchParamType:
        print('\n✗ pip install ncoreparser')
        exit(1)

    data_dir.mkdir(parents=True, exist_ok=True)

    client = Client()
    try:
        cookies = client.login(NCORE_USER, NCORE_PASS)
        if not cookies:
            print('\n✗ nCore bejelentkezés sikertelen.')
            exit(1)
        print('\n✓ nCore bejelentkezés OK')
    except Exception as e:
        print(f'\n✗ nCore: {e}')
        exit(1)

    existing_list = load_existing_metas()
    existing_by_id = {m['id']: m for m in existing_list}
    incremental = len(existing_list) > 0
    max_pages = NCORE_PAGES_PER_RUN if incremental else None

    print('HD-HUN filmek lekérése (seed szerint)...')
    if incremental:
        print(f'  Növekményes frissítés: max {NCORE_PAGES_PER_RUN} oldal, majd egyesítés a meglévő {len(existing_list)} elemmel.')
    else:
        print(f'  Cél: {TARGET_COUNT} torrent, oldalak között {NCORE_PAGE_DELAY}s várakozás, max {NCORE_PAGE_RETRIES} újrapróbálás/oldal.')
    torrents = fetch_all_hd_hun_movies(client, max_pages=max_pages)
    client.logout()
    print(f'  {len(torrents)} torrent')

    def _seeders_from_torrent(t):
        try:
            if isinstance(t, dict):
                return int(t.get('seeders') or t.get('seed_count') or 0)
            return int(getattr(t, 'seeders', None) or getattr(t, 'seed_count', None) or 0)
        except (TypeError, ValueError):
            return 0

    new_metas = []
    seen_imdb = set()
    for i, t in enumerate(torrents):
        try:
            if isinstance(t, dict):
                title = (t.get('title') or '').strip()
            else:
                title = (t['title'] or '').strip()  # ncoreparser Torrent: bracket notation
        except Exception:
            title = ''
        if not title or is_likely_series(title):
            continue
        clean, year = parse_movie_title(title)
        
        # Search on TMDB (gets IMDB ID + all metadata in one go)
        metadata = search_movie_on_tmdb(clean, year, TMDB_API_KEY)
        if not metadata:
            continue
        
        imdb = metadata['imdb_id']
        if not imdb:
            continue
        imdb = imdb if str(imdb).startswith('tt') else 'tt' + str(imdb)
        if imdb in seen_imdb:
            continue
        seen_imdb.add(imdb)
        
        # Get data from TMDB metadata
        name = metadata['title'] or clean
        poster_path = metadata['poster_path']
        poster = f'https://image.tmdb.org/t/p/w500{poster_path}' if poster_path else f'https://images.metahub.space/poster/small/{imdb}/img'
        genres = metadata['genres']
        description = metadata['description'] or 'Magyar HD – nCore legnagyobb seed.'
        year_val = metadata['year']
        rating = metadata['rating']
        
        imdb_clean = imdb.replace('tt', '')
        seeders = _seeders_from_torrent(t)
        # If nCore didn't expose seeders, use descending rank by fetch order so top-seeded order is preserved
        if seeders == 0:
            seeders = 1_000_000 - len(new_metas)

        meta = {
            'id': f'tt{imdb_clean}',
            'type': 'movie',
            'name': name,
            'poster': poster,
            'posterShape': 'poster',
            'year': year_val,
            'description': description,
            'imdbRating': str(round(rating, 1)) if isinstance(rating, (int, float)) else None,
            'releaseInfo': str(year_val) if year_val else None,
            'genres': genres,
            'seeders': seeders,
        }
        new_metas.append(meta)
        if (len(new_metas)) % 50 == 0:
            print(f'  Feldolgozva: {len(new_metas)} film')

    # Merge: add/update by id (new overwrites existing so seed rank is refreshed), keep seeders for sorting
    for m in new_metas:
        existing_by_id[m['id']] = m
    for m in existing_list:
        m.setdefault('seeders', 0)

    merged = sorted(existing_by_id.values(), key=lambda m: m.get('seeders', 0), reverse=True)
    merged = merged[:TARGET_COUNT]

    out_file.parent.mkdir(parents=True, exist_ok=True)
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False, indent=0)
    print(f'\n✓ {len(merged)} film mentve: {out_file}' + (f' (+{len(new_metas)} új/frissített)' if incremental else ''))
    print('Kész.')


if __name__ == '__main__':
    main()
