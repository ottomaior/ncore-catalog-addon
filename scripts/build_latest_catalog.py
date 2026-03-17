"""
Build latest HD catalogs: data/hd_movies.json and data/hd_series.json
Fetches latest HD releases from nCore, matches to TMDB only (no Trakt).
- Movies: Only 2025/2026 releases
- Series: All HD series uploads (no year filtering)

Usage: python scripts/build_latest_catalog.py
Output: data/hd_movies.json, data/hd_series.json
"""
import re
import sys
import time
import os
import json
from pathlib import Path
from dotenv import load_dotenv
import requests

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

script_dir = Path(__file__).parent.resolve()
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))
from tvdb_client import search_show_on_tvdb
from omdb_client import OMDbClient

try:
    from ncoreparser import Client, SearchParamType, ParamSort, ParamSeq
except ImportError:
    Client = None
    SearchParamType = ParamSort = ParamSeq = None

project_root = script_dir.parent
config_file = project_root / 'config' / 'config.env'
data_dir = project_root / 'data'
out_file_movies = data_dir / 'hd_movies.json'
out_file_series = data_dir / 'hd_series.json'

if config_file.exists():
    load_dotenv(config_file)
else:
    load_dotenv()

TMDB_API_KEY = os.getenv('TMDB_API_KEY')
OMDB_API_KEY = os.getenv('OMDB_API_KEY')
TVDB_API_KEY = os.getenv('TVDB_API_KEY')
TVDB_PIN = os.getenv('TVDB_PIN', '').strip() or None
NCORE_USER = os.getenv('NCORE_USER', '').strip()
NCORE_PASS = os.getenv('NCORE_PASS', '').strip()

omdb = OMDbClient(OMDB_API_KEY)


def _fmt_rating(x):
    return '?' if x is None else f'{x:.1f}'

# Big catalog size (Legfrissebb); streaming catalogs are split from this via split_catalogs_by_provider.py
TARGET_COUNT = int(os.getenv('NCORE_CATALOG_TARGET_LATEST', '2000'))
NCORE_PAGE_DELAY = 2.0
NCORE_RETRY_WAIT = 10.0
NCORE_PAGE_RETRIES = 3
TMDB_DELAY = 0.4  # Delay between TMDB API calls

# Incremental mode: only fetch this many new torrents when catalog already exists (faster updates)
INCREMENTAL_TORRENT_COUNT = int(os.getenv('NCORE_INCREMENTAL_TORRENT_COUNT', '100'))


def load_existing_movies():
    """Load existing hd_movies.json if present."""
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
    """Load existing hd_series.json if present."""
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
    """
    Parse movie title, extracting clean name and year.
    Removes everything after year.
    """
    year_match = re.search(r'\.(\d{4})\.', title)
    year = year_match.group(1) if year_match else None
    clean = title[:year_match.start()] if year_match else title
    clean = clean.replace('.', ' ').strip()
    clean = ' '.join(clean.split())
    return clean, year


def is_sports_content(title):
    """
    Check if the title appears to be sports-related content.
    Returns True if it matches common sports patterns.
    """
    title_lower = title.lower()
    
    # Common sports keywords (English and Hungarian)
    sports_keywords = [
        'football', 'soccer', 'nfl', 'nba', 'nhl', 'mlb', 'ufc', 'wwe', 'f1', 'formula',
        'cycling', 'tour de france', 'giro', 'vuelta', 'motogp', 'motorsport',
        'tennis', 'wimbledon', 'us open', 'australian open', 'french open',
        'olympics', 'olimpia', 'world cup', 'euro ', 'uefa', 'champions league',
        'boxing', 'wrestling', 'hockey', 'basketball', 'baseball', 'rugby',
        'golf', 'racing', 'rally', 'superbike', 'moto2', 'moto3',
        'liverpool', 'manchester', 'barcelona', 'real madrid', 'bayern', 'juventus',
        'futball', 'labdarúgás', 'kerékpár', 'boksz', 'forma-1', 'forma1'
    ]
    
    # Check if any sports keyword is in the title
    for keyword in sports_keywords:
        if keyword in title_lower:
            return True
    
    return False


def extract_episode_info(title):
    """
    Extract season and episode number from title (e.g., S02E03).
    Returns tuple: (season, episode, episode_string) or (None, None, None)
    """
    # Pattern: S##E## (e.g., S02E03, S1E5)
    episode_match = re.search(r'S(\d{1,2})E(\d{1,2})', title, re.IGNORECASE)
    if episode_match:
        season = int(episode_match.group(1))
        episode = int(episode_match.group(2))
        episode_string = f"S{season:02d}E{episode:02d}"
        return season, episode, episode_string
    return None, None, None


def is_newer_episode(new_season, new_episode, old_season, old_episode):
    """
    Compare two episodes to determine if the new one is actually newer.
    Returns True if new episode is later than old episode.
    """
    if new_season is None or new_episode is None:
        return False
    if old_season is None or old_episode is None:
        return True
    
    # Compare: first by season, then by episode
    if new_season > old_season:
        return True
    if new_season == old_season and new_episode > old_episode:
        return True
    
    return False


def _episode_sort_key(entry):
    """Key for comparing series entries: (season, episode); higher = newer."""
    s = entry.get('latest_season')
    e = entry.get('latest_episode')
    return (s if s is not None else 0, e if e is not None else 0)


def dedupe_series_keep_newest(series_list):
    """Keep one entry per series id (id); keep the one with newest latest_season/latest_episode. Order preserved by first occurrence of each id."""
    by_id = {}
    for s in series_list:
        if not s or not isinstance(s, dict):
            continue
        sid = s.get('id')
        if not sid:
            continue
        if sid not in by_id or _episode_sort_key(s) > _episode_sort_key(by_id[sid]):
            by_id[sid] = s
    # Preserve order: first occurrence of each id in original list
    seen = set()
    out = []
    for s in series_list:
        sid = s.get('id') if isinstance(s, dict) else None
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.append(by_id[sid])
    return out


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
        # Accepts both space and dot as separator: [\s.]
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


def fetch_latest_movies(client, max_count=None):
    """
    Fetch latest HD movies from nCore (HD_HUN category).
    If max_count is set (incremental mode), stop after that many torrents.
    """
    if not hasattr(SearchParamType, 'HD_HUN'):
        return []
    target = max_count if max_count is not None else TARGET_COUNT
    all_torrents = []
    page = 1
    print(f"🎬 Fetching latest HD movies from nCore (max {target})...")
    while len(all_torrents) < target:
        torrents = None
        for attempt in range(1, NCORE_PAGE_RETRIES + 1):
            try:
                result = client.search(
                    pattern='.1080',
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


def fetch_latest_series(client, max_count=None):
    """
    Fetch latest HD series from nCore (HDSER_HUN category).
    If max_count is set (incremental mode), stop after that many torrents.
    """
    if not hasattr(SearchParamType, 'HDSER_HUN'):
        return []
    target = max_count if max_count is not None else TARGET_COUNT
    all_torrents = []
    page = 1
    print(f"📺 Fetching latest HD series from nCore (max {target})...")
    while len(all_torrents) < target:
        torrents = None
        for attempt in range(1, NCORE_PAGE_RETRIES + 1):
            try:
                result = client.search(
                    pattern='.1080',
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
        print("ERROR: ncoreparser missing. Install: pip install ncoreparser")
        return
    if not NCORE_USER or not NCORE_PASS:
        print("ERROR: NCORE_USER and NCORE_PASS missing.")
        return
    if not TMDB_API_KEY:
        print("ERROR: TMDB_API_KEY missing.")
        return

    data_dir.mkdir(parents=True, exist_ok=True)

    # Login to nCore
    print("nCore login...")
    client = Client()
    try:
        cookies = client.login(NCORE_USER, NCORE_PASS)
        if not cookies:
            print("ERROR: nCore login failed.")
            return
        print("nCore login OK")
    except Exception as e:
        print(f"❌ nCore login hiba: {e}")
        return

    # ========== MOVIES ==========
    print("\n" + "=" * 60)
    print("LATEST HD MOVIES")
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
    
    movie_torrents = fetch_latest_movies(client, max_count=max_count)
    print(f"\n✓ {len(movie_torrents)} HD film torrent letöltve nCore-ról")

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
            print("  WARN: no TMDB match, skipping")
            continue
        
        imdb_id = metadata['imdb_id']
        year = metadata['year']
        
        # Only include 2025/2026 movies
        if not year or year not in [2025, 2026]:
            print(f"  ⊘ Nem 2025/2026-os film, kihagyva (év: {year})")
            continue
        
        # If already in catalog (from file or already added this run), move to top but do not duplicate
        if imdb_id in existing_movie_ids:
            # Already added this run (duplicate torrent for same movie) → skip
            if any(m['id'] == imdb_id for m in new_movie_metas):
                print(f"  ⊘ Duplikátum torrent ugyanarra a filmre, kihagyva: {imdb_id}")
                continue
            print(f"  ↻ Már létezik, áthelyezés a tetejére: {imdb_id}")
            existing_movies = [m for m in existing_movies if m['id'] != imdb_id]
        
        display_title = metadata['title'] or clean_title
        poster_path = metadata['poster_path']
        display_poster = f'https://image.tmdb.org/t/p/w500{poster_path}' if poster_path else f"https://images.metahub.space/poster/small/{imdb_id}/img"
        genres_list = metadata['genres']
        description = metadata['description'] or 'Magyar HD film – nCore legfrissebb feltöltés (összes).'
        tmdb_rating = round(metadata['rating'], 1) if metadata.get('rating') else None
        imdb_rating = omdb.get_imdb_rating(imdb_id)
        
        print(f"  ✓ TMDB: {display_title} ({year}) - {imdb_id}")

        new_movie_metas.append({
            'id': imdb_id,
            'type': 'movie',
            'name': display_title,
            'poster': display_poster,
            'posterShape': 'poster',
            'year': year,
            'description': description,
            'imdbRating': imdb_rating if imdb_rating is not None else tmdb_rating,
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
        print(f"\n✓ {len(merged_movies)} HD film katalógus frissítve: {out_file_movies} (+{len(new_movie_metas)} új)")
    else:
        print(f"\n✓ {len(merged_movies)} HD film katalógus írva: {out_file_movies}")

    # ========== SERIES ==========
    print("\n" + "=" * 60)
    print("LATEST HD SERIES")
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
    
    series_torrents = fetch_latest_series(client, max_count=max_count)
    print(f"\n✓ {len(series_torrents)} HD sorozat torrent letöltve nCore-ról")

    new_series_metas = []
    for idx, t in enumerate(series_torrents, 1):
        # Access torrent data using bracket notation (dict-like)
        try:
            title = (t['title'] or '').strip()
        except:
            title = ''
        
        print(f"\n[{idx}/{len(series_torrents)}] {title}")
        
        # Skip sports content
        if is_sports_content(title):
            print("  ⚽ Sport tartalom, kihagyva")
            continue
        
        # Parse title to extract clean name and year
        clean_title, year = parse_series_title(title)
        
        # Extract episode info (S##E##)
        new_season, new_episode, episode_string = extract_episode_info(title)
        print(f"  → Clean: {clean_title}, Episode: {episode_string or 'N/A'}, Year: {year}")
        
        # Search on TVDB for series (gets IMDB ID + all metadata)
        metadata = search_show_on_tvdb(clean_title, year, TVDB_API_KEY, TVDB_PIN, TMDB_API_KEY)
        if not metadata:
            print("  WARN: no TVDB match, skipping")
            continue
        
        imdb_id = metadata['imdb_id']
        
        # Check if already exists (in this run or in loaded file) and compare episodes – keep only newest
        should_update = False
        if imdb_id in existing_series_ids:
            # Prefer entry from this run (new_series_metas), then from loaded file (existing_series)
            existing_entry = next((s for s in new_series_metas if s['id'] == imdb_id), None)
            if existing_entry is None:
                existing_entry = next((s for s in existing_series if s['id'] == imdb_id), None)
            if existing_entry:
                old_season = existing_entry.get('latest_season')
                old_episode = existing_entry.get('latest_episode')
                
                # Only update if new episode is actually newer
                if is_newer_episode(new_season, new_episode, old_season, old_episode):
                    if old_season is not None and old_episode is not None:
                        print(f"  ⬆ Újabb epizód! Régi: S{old_season:02d}E{old_episode:02d} → Új: {episode_string}")
                    else:
                        print(f"  ⬆ Epizód info hozzáadva: {episode_string}")
                    # Remove old from whichever list it's in
                    new_series_metas = [s for s in new_series_metas if s['id'] != imdb_id]
                    existing_series = [s for s in existing_series if s['id'] != imdb_id]
                    should_update = True
                else:
                    if old_season is not None and old_episode is not None:
                        print(f"  ↻ Már létezik ugyanezzel vagy újabb epizóddal (S{old_season:02d}E{old_episode:02d}), kihagyva")
                    else:
                        print(f"  ↻ Már létezik a katalógusban, kihagyva")
                    continue
            else:
                should_update = True
        else:
            should_update = True
        
        if not should_update:
            continue
        
        display_title = metadata['title'] or clean_title
        
        # Add episode info to title if available
        if episode_string:
            display_title = f"{display_title} ({episode_string})"
        
        poster_path = metadata['poster_path']
        if poster_path and poster_path.startswith('http'):
            display_poster = poster_path
        else:
            display_poster = f'https://image.tmdb.org/t/p/w500{poster_path}' if poster_path else f"https://images.metahub.space/poster/small/{imdb_id}/img"
        genres_list = metadata['genres']
        description = metadata['description'] or 'Magyar HD sorozat – nCore legfrissebb feltöltés.'
        
        # Add episode info to description
        if episode_string:
            description = f"🆕 Legújabb epizód: {episode_string}\n\n{description}"
        
        year_val = metadata['year']
        tmdb_rating = round(metadata['rating'], 1) if metadata.get('rating') else None
        imdb_rating = omdb.get_imdb_rating(imdb_id)
        
        print(f"  ✓ TVDB: {display_title} ({year_val}) - {imdb_id}")

        new_series_metas.append({
            'id': imdb_id,
            'type': 'series',
            'name': display_title,
            'poster': display_poster,
            'posterShape': 'poster',
            'year': year_val,
            'description': description,
            'imdbRating': imdb_rating if imdb_rating is not None else tmdb_rating,
            'releaseInfo': str(year_val) if year_val else None,
            'genres': genres_list,
            'latest_season': new_season,
            'latest_episode': new_episode,
        })
        print(f"  ✓ Hozzáadva: {display_title} ({year_val})")
        existing_series_ids.add(imdb_id)

    # Merge: new items first (newest uploads), then existing; dedupe by id (keep newest episode), then trim
    merged_series = dedupe_series_keep_newest(new_series_metas + existing_series)[:TARGET_COUNT]

    # Write series JSON
    with open(out_file_series, 'w', encoding='utf-8') as f:
        json.dump(merged_series, f, ensure_ascii=False, indent=2)
    
    if incremental_series:
        print(f"\n✓ {len(merged_series)} HD sorozat katalógus frissítve: {out_file_series} (+{len(new_series_metas)} új)")
    else:
        print(f"\n✓ {len(merged_series)} HD sorozat katalógus írva: {out_file_series}")

    print("\n" + "=" * 60)
    print("✅ Legfrissebb HD katalógusok sikeresen elkészültek!")
    print("=" * 60)


if __name__ == '__main__':
    main()
