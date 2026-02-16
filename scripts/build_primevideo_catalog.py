"""
Build Prime Video catalogs: data/primevideo_movies.json and data/primevideo_series.json
Fetches latest 100 Prime Video releases (.amzn.1080) from nCore, matches to TMDB only (no Trakt).

Usage: python scripts/build_primevideo_catalog.py
Output: data/primevideo_movies.json, data/primevideo_series.json
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
out_file_movies = data_dir / 'primevideo_movies.json'
out_file_series = data_dir / 'primevideo_series.json'

if config_file.exists():
    load_dotenv(config_file)
else:
    load_dotenv()

TMDB_API_KEY = os.getenv('TMDB_API_KEY')
NCORE_USER = os.getenv('NCORE_USER', '').strip()
NCORE_PASS = os.getenv('NCORE_PASS', '').strip()

# Fetch 100 latest Prime Video items
TARGET_COUNT = 100
NCORE_PAGE_DELAY = 2.0
NCORE_RETRY_WAIT = 10.0
NCORE_PAGE_RETRIES = 3
TMDB_DELAY = 0.4  # Delay between TMDB API calls

# Incremental mode: only fetch this many new torrents when catalog already exists (faster updates)
INCREMENTAL_TORRENT_COUNT = 50


def load_existing_movies():
    """Load existing primevideo_movies.json if present."""
    if not out_file_movies.exists():
        return []
    try:
        with open(out_file_movies, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f'  ⚠ Meglévő film fájl nem olvasható: {e}')
        return []


def load_existing_series():
    """Load existing primevideo_series.json if present."""
    if not out_file_series.exists():
        return []
    try:
        with open(out_file_series, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f'  ⚠ Meglévő sorozat fájl nem olvasható: {e}')
        return []


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
            imdb_id = movie_data.get('imdb_id')  # ← IMDB ID itt van!
            
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
            imdb_id = external_data.get('imdb_id')  # ← IMDB ID itt van!
            
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


def parse_movie_title(title):
    """Extract clean title and year from nCore movie torrent title (simpler, more reliable)."""
    year_match = re.search(r'\.(\d{4})\.', title)
    year = year_match.group(1) if year_match else None
    clean = title[:year_match.start()] if year_match else title
    clean = clean.replace('.', ' ').strip()
    clean = ' '.join(clean.split())
    return clean, year


def parse_series_title(title):
    """
    Extract clean show name and year from nCore series torrent title.
    Cuts at: year, season (S01), episode (E01), resolution (1080p), or release type (WEB-DL, etc.)
    """
    # First, try to find year
    year_match = re.search(r'\.(\d{4})\.', title)
    year = year_match.group(1) if year_match else None
    
    # If year found, cut there
    if year_match:
        clean = title[:year_match.start()]
    else:
        # Otherwise, cut at first occurrence of season/episode/quality markers
        # Pattern matches: S01, S02, E01, 1080p, 720p, WEB-DL, HDTV, BluRay, etc.
        cut_pattern = re.search(
            r'[\s.](S\d+|E\d+|\d{3,4}[pi]|WEB-?DL|HDTV|BluRay|BRRip|DVDRip|PROPER|REPACK|AAC|DD\+?|DV|HDR|H\.26[45])',
            title,
            re.IGNORECASE
        )
        if cut_pattern:
            clean = title[:cut_pattern.start()]
        else:
            clean = title
    
    clean = clean.replace('.', ' ').strip()
    clean = ' '.join(clean.split())
    return clean, year




def fetch_primevideo_movies(client, max_count=None):
    """
    Fetch latest Prime Video movies from nCore (.amzn.1080 pattern, HD_HUN category).
    If max_count is set (incremental mode), stop after that many torrents.
    """
    if not hasattr(SearchParamType, 'HD_HUN'):
        return []
    target = max_count if max_count is not None else TARGET_COUNT
    all_torrents = []
    page = 1
    print(f"🎬 Fetching Prime Video movies (.amzn.1080) from nCore (max {target})...")
    while len(all_torrents) < target:
        torrents = None
        for attempt in range(1, NCORE_PAGE_RETRIES + 1):
            try:
                result = client.search(
                    pattern='.amzn.1080',
                    type=SearchParamType.HD_HUN,
                    sort_by=ParamSort.UPLOAD,
                    sort_order=ParamSeq.DECREASING,
                    page=page,
                )
                torrents = getattr(result, 'torrents', []) or []
                break
            except Exception as e:
                if attempt < NCORE_PAGE_RETRIES:
                    print(f"  Oldal {page} hiba (próbálkozás {attempt}/{NCORE_PAGE_RETRIES}), várok {NCORE_RETRY_WAIT}s...")
                    time.sleep(NCORE_RETRY_WAIT)
                else:
                    print(f"  nCore search error (oldal {page}): {e}")
                    return all_torrents
        if not torrents:
            print(f"  Nincs több torrent, leállás.")
            break
        all_torrents.extend(torrents)
        print(f"  Oldal {page}: {len(torrents)} torrent (összesen: {len(all_torrents)})")
        if len(all_torrents) >= target or len(torrents) == 0:
            break
        page += 1
        time.sleep(NCORE_PAGE_DELAY)
    return all_torrents[:target]


def fetch_primevideo_series(client, max_count=None):
    """
    Fetch latest Prime Video series from nCore (.amzn.1080 pattern, HDSER_HUN category).
    If max_count is set (incremental mode), stop after that many torrents.
    """
    if not hasattr(SearchParamType, 'HDSER_HUN'):
        return []
    target = max_count if max_count is not None else TARGET_COUNT
    all_torrents = []
    page = 1
    print(f"📺 Fetching Prime Video series (.amzn.1080) from nCore (max {target})...")
    while len(all_torrents) < target:
        torrents = None
        for attempt in range(1, NCORE_PAGE_RETRIES + 1):
            try:
                result = client.search(
                    pattern='.amzn.1080',
                    type=SearchParamType.HDSER_HUN,
                    sort_by=ParamSort.UPLOAD,
                    sort_order=ParamSeq.DECREASING,
                    page=page,
                )
                torrents = getattr(result, 'torrents', []) or []
                break
            except Exception as e:
                if attempt < NCORE_PAGE_RETRIES:
                    print(f"  Oldal {page} hiba (próbálkozás {attempt}/{NCORE_PAGE_RETRIES}), várok {NCORE_RETRY_WAIT}s...")
                    time.sleep(NCORE_RETRY_WAIT)
                else:
                    print(f"  nCore search error (oldal {page}): {e}")
                    return all_torrents
        if not torrents:
            print(f"  Nincs több torrent, leállás.")
            break
        all_torrents.extend(torrents)
        print(f"  Oldal {page}: {len(torrents)} torrent (összesen: {len(all_torrents)})")
        if len(all_torrents) >= target or len(torrents) == 0:
            break
        page += 1
        time.sleep(NCORE_PAGE_DELAY)
    return all_torrents[:target]


def main():
    if not Client or not SearchParamType:
        print("❌ ncoreparser nem elérhető. Telepítsd: pip install ncoreparser")
        return
    if not NCORE_USER or not NCORE_PASS:
        print("❌ NCORE_USER és NCORE_PASS változók hiányoznak.")
        return
    if not TMDB_API_KEY:
        print("❌ TMDB_API_KEY hiányzik.")
        return

    data_dir.mkdir(parents=True, exist_ok=True)

    # Login to nCore
    print("🔑 Bejelentkezés nCore-ra...")
    client = Client()
    try:
        cookies = client.login(NCORE_USER, NCORE_PASS)
        if not cookies:
            print("❌ nCore bejelentkezés sikertelen.")
            return
        print("✓ nCore bejelentkezés sikeres")
    except Exception as e:
        print(f"❌ nCore login hiba: {e}")
        return

    # ========== MOVIES ==========
    print("\n" + "=" * 60)
    print("🎬 PRIME VIDEO FILMEK")
    print("=" * 60)
    
    # Load existing movies catalog
    existing_movies = load_existing_movies()
    existing_movie_ids = {m['id'] for m in existing_movies}
    incremental_movies = len(existing_movies) > 0
    
    if incremental_movies:
        print(f"  📦 Meglévő katalógus betöltve: {len(existing_movies)} film")
        print(f"  🔄 Növekményes mód: csak {INCREMENTAL_TORRENT_COUNT} legfrissebb torrent lekérése\n")
        max_count = INCREMENTAL_TORRENT_COUNT
    else:
        print(f"  🆕 Teljes katalógus építés: {TARGET_COUNT} torrent lekérése\n")
        max_count = None
    
    movie_torrents = fetch_primevideo_movies(client, max_count=max_count)
    print(f"\n✓ {len(movie_torrents)} Prime Video film torrent letöltve nCore-ról")

    new_movie_metas = []
    for idx, t in enumerate(movie_torrents, 1):
        # Access torrent data using bracket notation (dict-like)
        try:
            title = (t['title'] or '').strip()
        except:
            title = ''
        
        print(f"\n[{idx}/{len(movie_torrents)}] {title}")
        
        # Parse title to extract clean name and year
        clean_title, year = parse_movie_title(title)
        print(f"  → Clean: {clean_title}, Year: {year}")
        
        # Search on TMDB (gets IMDB ID + all metadata in one go)
        metadata = search_movie_on_tmdb(clean_title, year, TMDB_API_KEY)
        if not metadata:
            print("  ⚠ Nincs TMDB találat, kihagyva")
            continue
        
        imdb_id = metadata['imdb_id']
        
        # Skip if already in existing catalog (incremental mode)
        if imdb_id in existing_movie_ids:
            print(f"  ↻ Már létezik a katalógusban: {imdb_id}")
            continue
        
        display_title = metadata['title'] or clean_title
        poster_path = metadata['poster_path']
        display_poster = f'https://image.tmdb.org/t/p/w500{poster_path}' if poster_path else f"https://images.metahub.space/poster/small/{imdb_id}/img"
        genres_list = metadata['genres']
        description = metadata['description'] or 'Prime Video film – nCore legfrissebb feltöltés.'
        year = metadata['year']
        rating = metadata['rating']
        
        print(f"  ✓ TMDB: {display_title} ({year}) - {imdb_id}")

        new_movie_metas.append({
            'id': imdb_id,
            'type': 'movie',
            'name': display_title,
            'poster': display_poster,
            'posterShape': 'poster',
            'year': year,
            'description': description,
            'imdbRating': round(rating, 1) if rating else None,
            'releaseInfo': str(year) if year else None,
            'genres': genres_list,
        })
        print(f"  ✓ Hozzáadva: {display_title} ({year})")
        existing_movie_ids.add(imdb_id)

    # Merge: new items first (newest uploads), then existing, trim to TARGET_COUNT
    merged_movies = (new_movie_metas + existing_movies)[:TARGET_COUNT]

    # Write movies JSON
    with open(out_file_movies, 'w', encoding='utf-8') as f:
        json.dump(merged_movies, f, ensure_ascii=False, indent=2)
    
    if incremental_movies:
        print(f"\n✓ {len(merged_movies)} Prime Video film katalógus frissítve: {out_file_movies} (+{len(new_movie_metas)} új)")
    else:
        print(f"\n✓ {len(merged_movies)} Prime Video film katalógus írva: {out_file_movies}")

    # ========== SERIES ==========
    print("\n" + "=" * 60)
    print("📺 PRIME VIDEO SOROZATOK")
    print("=" * 60)
    
    # Load existing series catalog
    existing_series = load_existing_series()
    existing_series_ids = {s['id'] for s in existing_series}
    incremental_series = len(existing_series) > 0
    
    if incremental_series:
        print(f"  📦 Meglévő katalógus betöltve: {len(existing_series)} sorozat")
        print(f"  🔄 Növekményes mód: csak {INCREMENTAL_TORRENT_COUNT} legfrissebb torrent lekérése\n")
        max_count = INCREMENTAL_TORRENT_COUNT
    else:
        print(f"  🆕 Teljes katalógus építés: {TARGET_COUNT} torrent lekérése\n")
        max_count = None
    
    series_torrents = fetch_primevideo_series(client, max_count=max_count)
    print(f"\n✓ {len(series_torrents)} Prime Video sorozat torrent letöltve nCore-ról")

    new_series_metas = []
    for idx, t in enumerate(series_torrents, 1):
        # Access torrent data using bracket notation (dict-like)
        try:
            title = (t['title'] or '').strip()
        except:
            title = ''
        
        print(f"\n[{idx}/{len(series_torrents)}] {title}")
        
        # Parse title to extract clean name and year
        clean_title, year = parse_series_title(title)
        print(f"  → Clean: {clean_title}, Year: {year}")
        
        # Search on TMDB (gets IMDB ID + all metadata in one go)
        metadata = search_show_on_tmdb(clean_title, year, TMDB_API_KEY)
        if not metadata:
            print("  ⚠ Nincs TMDB találat, kihagyva")
            continue
        
        imdb_id = metadata['imdb_id']
        
        # Skip if already in existing catalog (incremental mode)
        if imdb_id in existing_series_ids:
            print(f"  ↻ Már létezik a katalógusban: {imdb_id}")
            continue
        
        display_title = metadata['title'] or clean_title
        poster_path = metadata['poster_path']
        display_poster = f'https://image.tmdb.org/t/p/w500{poster_path}' if poster_path else f"https://images.metahub.space/poster/small/{imdb_id}/img"
        genres_list = metadata['genres']
        description = metadata['description'] or 'Prime Video sorozat – nCore legfrissebb feltöltés.'
        year = metadata['year']
        rating = metadata['rating']
        
        print(f"  ✓ TMDB: {display_title} ({year}) - {imdb_id}")

        new_series_metas.append({
            'id': imdb_id,
            'type': 'series',
            'name': display_title,
            'poster': display_poster,
            'posterShape': 'poster',
            'year': year,
            'description': description,
            'imdbRating': round(rating, 1) if rating else None,
            'releaseInfo': str(year) if year else None,
            'genres': genres_list,
        })
        print(f"  ✓ Hozzáadva: {display_title} ({year})")
        existing_series_ids.add(imdb_id)

    # Merge: new items first (newest uploads), then existing, trim to TARGET_COUNT
    merged_series = (new_series_metas + existing_series)[:TARGET_COUNT]

    # Write series JSON
    with open(out_file_series, 'w', encoding='utf-8') as f:
        json.dump(merged_series, f, ensure_ascii=False, indent=2)
    
    if incremental_series:
        print(f"\n✓ {len(merged_series)} Prime Video sorozat katalógus frissítve: {out_file_series} (+{len(new_series_metas)} új)")
    else:
        print(f"\n✓ {len(merged_series)} Prime Video sorozat katalógus írva: {out_file_series}")

    print("\n" + "=" * 60)
    print("✅ Prime Video katalógusok sikeresen elkészültek!")
    print("=" * 60)


if __name__ == '__main__':
    main()
