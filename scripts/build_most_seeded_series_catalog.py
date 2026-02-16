"""
Build data/most_seeded_series.json for the Stremio catalog (top seeded series by genre).
Fetches Sorozat HD/HU (HDSER_HUN) from nCore, matches to TMDB only (no Trakt), gets genres, writes one JSON.
- If the file already exists: fetches only NCORE_PAGES_PER_RUN pages, merges by series id,
  sorts by seed rank, trims to TARGET_COUNT (incremental, faster runs).
- If no file: full fetch until TARGET_COUNT or no more pages.

Usage: python scripts/build_most_seeded_series_catalog.py
Output: data/most_seeded_series.json
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
out_file = data_dir / 'most_seeded_series.json'

if config_file.exists():
    load_dotenv(config_file)
else:
    load_dotenv()

TMDB_API_KEY = os.getenv('TMDB_API_KEY')
NCORE_USER = os.getenv('NCORE_USER', '').strip()
NCORE_PASS = os.getenv('NCORE_PASS', '').strip()

TARGET_COUNT = int(os.getenv('NCORE_CATALOG_TARGET_SERIES', '2000'))
NCORE_PAGES_PER_RUN = int(os.getenv('NCORE_PAGES_PER_RUN', '15'))

NCORE_PAGE_DELAY = float(os.getenv('NCORE_PAGE_DELAY', '3.0'))
NCORE_PAGE_RETRIES = int(os.getenv('NCORE_PAGE_RETRIES', '4'))
NCORE_RETRY_WAIT = float(os.getenv('NCORE_RETRY_WAIT', '35.0'))
TMDB_DELAY = 0.4  # Delay between TMDB API calls


def search_show_on_tmdb(clean_title, year, tmdb_key):
    """
    Search for TV show on TMDB and return full metadata including IMDB ID.
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
            # Search for TV show
            search_url = f'https://api.themoviedb.org/3/search/tv?api_key={tmdb_key}&query={variation}&language=hu-HU'
            if year:
                search_url += f'&first_air_date_year={year}'
            
            r = requests.get(search_url, timeout=10)
            if r.status_code != 200:
                continue
            
            results = r.json().get('results', [])
            if not results:
                continue
            
            # Get first result's full details
            tmdb_id = results[0]['id']
            
            time.sleep(TMDB_DELAY)
            details_url = f'https://api.themoviedb.org/3/tv/{tmdb_id}?api_key={tmdb_key}&language=hu-HU'
            r2 = requests.get(details_url, timeout=10)
            if r2.status_code != 200:
                continue
            
            tv_data = r2.json()
            
            # Get IMDB ID from external_ids endpoint
            time.sleep(TMDB_DELAY)
            external_url = f'https://api.themoviedb.org/3/tv/{tmdb_id}/external_ids?api_key={tmdb_key}'
            r3 = requests.get(external_url, timeout=10)
            if r3.status_code != 200:
                continue
            
            external_data = r3.json()
            imdb_id = external_data.get('imdb_id')  # ← IMDB ID here!
            
            if not imdb_id:
                continue
            
            # Return all data in one go
            return {
                'imdb_id': imdb_id,
                'title': tv_data.get('name'),
                'poster_path': tv_data.get('poster_path'),
                'genres': [g['name'] for g in tv_data.get('genres', [])],
                'description': tv_data.get('overview', ''),
                'year': int(tv_data.get('first_air_date', '')[:4]) if tv_data.get('first_air_date') else None,
                'rating': tv_data.get('vote_average')
            }
        except Exception as e:
            continue
    
    return None


def parse_series_title(title):
    """Extract clean show name and optional year from nCore torrent title (e.g. Show.Name.S01E05.720p...)."""
    title = (title or '').strip()
    # Remove S01E05-style and quality/resolution
    t = re.sub(r'[.\s-]s\d{1,2}e\d{1,2}.*$', '', title, flags=re.IGNORECASE)
    t = re.sub(r'[.\s-]s\d{1,2}[\s.]*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\d{3,4}p|\d{3,4}x\d{3,4}|bluray|web-?dl|hdtv|hdrip', '', t, flags=re.IGNORECASE)
    year_match = re.search(r'\.(\d{4})\.', t)
    year = year_match.group(1) if year_match else None
    clean = t[:year_match.start()] if year_match else t
    clean = clean.replace('.', ' ').strip()
    clean = ' '.join(clean.split())
    if not clean:
        clean = t.replace('.', ' ').strip()
        clean = ' '.join(clean.split())
    return clean or t, year




def load_existing_metas():
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


def fetch_all_hd_hun_series(client, max_pages=None):
    """Fetch Sorozat HD/HU (HDSER_HUN) from nCore, sorted by seeders."""
    if not hasattr(SearchParamType, 'HDSER_HUN'):
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
                    type=SearchParamType.HDSER_HUN,
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
    print('nCore – Legnagyobb seed sorozatok katalógus (JSON)')
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

    print('Sorozat HD/HU lekérése (seed szerint)...')
    if incremental:
        print(f'  Növekményes frissítés: max {NCORE_PAGES_PER_RUN} oldal, majd egyesítés a meglévő {len(existing_list)} elemmel.')
    else:
        print(f'  Cél: {TARGET_COUNT} torrent, oldalak között {NCORE_PAGE_DELAY}s várakozás.')
    torrents = fetch_all_hd_hun_series(client, max_pages=max_pages)
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
                title = (t['title'] or '').strip()
        except Exception:
            title = ''
        if not title:
            continue
        clean, year = parse_series_title(title)
        
        # Search on TMDB (gets IMDB ID + all metadata in one go)
        metadata = search_show_on_tmdb(clean, year, TMDB_API_KEY)
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
        description = metadata['description'] or 'Magyar HD sorozat – nCore legnagyobb seed.'
        year_val = metadata['year']
        rating = metadata['rating']
        
        imdb_clean = imdb.replace('tt', '')
        seeders = _seeders_from_torrent(t)
        if seeders == 0:
            seeders = 1_000_000 - len(new_metas)

        meta = {
            'id': f'tt{imdb_clean}',
            'type': 'series',
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
            print(f'  Feldolgozva: {len(new_metas)} sorozat')

    for m in new_metas:
        existing_by_id[m['id']] = m
    for m in existing_list:
        m.setdefault('seeders', 0)

    merged = sorted(existing_by_id.values(), key=lambda m: m.get('seeders', 0), reverse=True)
    merged = merged[:TARGET_COUNT]

    out_file.parent.mkdir(parents=True, exist_ok=True)
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False, indent=0)
    print(f'\n✓ {len(merged)} sorozat mentve: {out_file}' + (f' (+{len(new_metas)} új/frissített)' if incremental else ''))
    print('Kész.')


if __name__ == '__main__':
    main()
