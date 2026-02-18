"""
Build trending catalogs: top seeded HD 1080p items from the most recent uploads.
- Fetches the last TORRENT_POOL (200) torrents per category, sorted by upload (newest first).
- Filters to HD_HUN (movies) / HDSER_HUN (series), pattern .1080 (1080p).
- Sorts that pool by seeders descending, dedupes by IMDB id, takes top TRENDING_COUNT (30) in order.
Output: data/trending_movies.json, data/trending_series.json (proper order = by seeders).

Usage: python scripts/build_trending_catalog.py
"""
import re
import sys
import time
import os
import json
from pathlib import Path
from dotenv import load_dotenv
import requests

script_dir = Path(__file__).parent.resolve()
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))
from tvdb_client import search_show_on_tvdb

try:
    from ncoreparser import Client, SearchParamType, ParamSort, ParamSeq
except ImportError:
    Client = None
    SearchParamType = ParamSort = ParamSeq = None

project_root = script_dir.parent
config_file = project_root / 'config' / 'config.env'
data_dir = project_root / 'data'
out_file_movies = data_dir / 'trending_movies.json'
out_file_series = data_dir / 'trending_series.json'

if config_file.exists():
    load_dotenv(config_file)
else:
    load_dotenv()

TMDB_API_KEY = os.getenv('TMDB_API_KEY')
TVDB_API_KEY = os.getenv('TVDB_API_KEY')
TVDB_PIN = os.getenv('TVDB_PIN', '').strip() or None
NCORE_USER = os.getenv('NCORE_USER', '').strip()
NCORE_PASS = os.getenv('NCORE_PASS', '').strip()

# Pool = only consider this many most recent uploads; then take top TRENDING_COUNT by seeders
TORRENT_POOL = int(os.getenv('NCORE_TRENDING_POOL', '200'))
TRENDING_COUNT = int(os.getenv('NCORE_TRENDING_COUNT', '30'))
NCORE_PAGE_DELAY = float(os.getenv('NCORE_PAGE_DELAY', '2.0'))
NCORE_PAGE_RETRIES = int(os.getenv('NCORE_PAGE_RETRIES', '3'))
NCORE_RETRY_WAIT = float(os.getenv('NCORE_RETRY_WAIT', '10.0'))
TMDB_DELAY = 0.4

# 1080p pattern (same as build_latest)
PATTERN_1080 = '.1080'


def search_movie_on_tmdb(clean_title, year, tmdb_key):
    if not tmdb_key:
        return None
    variations = [
        clean_title,
        clean_title.replace(' and ', ' & '),
        clean_title.replace(' & ', ' and '),
    ]
    for variation in variations:
        try:
            time.sleep(TMDB_DELAY)
            search_url = f'https://api.themoviedb.org/3/search/movie?api_key={tmdb_key}&query={variation}&language=hu-HU'
            if year:
                search_url += f'&year={year}'
            r = requests.get(search_url, timeout=10)
            if r.status_code != 200:
                continue
            results = r.json().get('results', [])
            if not results:
                continue
            tmdb_id = results[0]['id']
            time.sleep(TMDB_DELAY)
            details_url = f'https://api.themoviedb.org/3/movie/{tmdb_id}?api_key={tmdb_key}&language=hu-HU'
            r2 = requests.get(details_url, timeout=10)
            if r2.status_code != 200:
                continue
            movie_data = r2.json()
            imdb_id = movie_data.get('imdb_id')
            if not imdb_id:
                continue
            return {
                'imdb_id': imdb_id,
                'title': movie_data.get('title'),
                'poster_path': movie_data.get('poster_path'),
                'genres': [g['name'] for g in movie_data.get('genres', [])],
                'description': movie_data.get('overview', ''),
                'year': int(movie_data.get('release_date', '')[:4]) if movie_data.get('release_date') else None,
                'rating': movie_data.get('vote_average'),
            }
        except Exception:
            continue
    return None


def parse_movie_title(title):
    year_match = re.search(r'\.(\d{4})\.', title)
    year = year_match.group(1) if year_match else None
    clean = title[:year_match.start()] if year_match else title
    clean = clean.replace('.', ' ').strip()
    clean = ' '.join(clean.split())
    return clean, year


def parse_series_title(title):
    year_match = re.search(r'\.(\d{4})\.', title)
    year = year_match.group(1) if year_match else None
    if year_match:
        clean = title[:year_match.start()]
    else:
        cut_pattern = re.search(
            r'[\s.](S\d+|E\d+|\d{3,4}[pi]|WEB-?DL|HDTV|BluRay|BRRip|DVDRip|PROPER|REPACK|AAC|DD\+?|DV|HDR|H\.26[45])',
            title,
            re.IGNORECASE,
        )
        clean = title[:cut_pattern.start()] if cut_pattern else title
    clean = clean.replace('.', ' ').strip()
    clean = ' '.join(clean.split())
    return clean, year


def extract_episode_info(title):
    episode_match = re.search(r'S(\d{1,2})E(\d{1,2})', title, re.IGNORECASE)
    if episode_match:
        season = int(episode_match.group(1))
        episode = int(episode_match.group(2))
        return season, episode, f"S{season:02d}E{episode:02d}"
    return None, None, None


def is_likely_series(title):
    if not title:
        return False
    return bool(re.search(r's\d{1,2}(?:e\d{1,2})?', title, re.IGNORECASE))


def _seeders_from_torrent(t):
    """ncoreparser Torrent exposes seed count via t['seed'] (no .seed attribute)."""
    try:
        if isinstance(t, dict):
            return int(t.get('seeders') or t.get('seed_count') or t.get('seed') or 0)
        if hasattr(t, '__getitem__'):
            return int(t['seed'] or 0)
        return int(
            getattr(t, 'seeders', None)
            or getattr(t, 'seed_count', None)
            or getattr(t, 'seed', None)
            or 0
        )
    except (TypeError, ValueError, KeyError):
        return 0


def fetch_trending_movies(client):
    """Fetch the last TORRENT_POOL (200) HD_HUN 1080p movies by upload (newest first)."""
    if not hasattr(SearchParamType, 'HD_HUN'):
        return []
    all_torrents = []
    page = 1
    print(f"  Filmek: legutóbbi {TORRENT_POOL} torrent (1080p, feltöltés szerint)...")
    while len(all_torrents) < TORRENT_POOL:
        torrents = None
        for attempt in range(1, NCORE_PAGE_RETRIES + 1):
            try:
                result = client.search(
                    pattern=PATTERN_1080,
                    type=SearchParamType.HD_HUN,
                    sort_by=ParamSort.UPLOAD,
                    sort_order=ParamSeq.DECREASING,
                    page=page,
                )
                torrents = getattr(result, 'torrents', []) or []
                break
            except Exception as e:
                if attempt < NCORE_PAGE_RETRIES:
                    time.sleep(NCORE_RETRY_WAIT)
                else:
                    print(f"  nCore film oldal {page} hiba: {e}")
                    return all_torrents
        if not torrents:
            break
        all_torrents.extend(torrents)
        if len(all_torrents) >= TORRENT_POOL:
            all_torrents = all_torrents[:TORRENT_POOL]
            break
        if len(torrents) < 25:
            break
        page += 1
        time.sleep(NCORE_PAGE_DELAY)
    return all_torrents


def fetch_trending_series(client):
    """Fetch the last TORRENT_POOL (200) HDSER_HUN 1080p series by upload (newest first)."""
    if not hasattr(SearchParamType, 'HDSER_HUN'):
        return []
    all_torrents = []
    page = 1
    print(f"  Sorozatok: legutóbbi {TORRENT_POOL} torrent (1080p, feltöltés szerint)...")
    while len(all_torrents) < TORRENT_POOL:
        torrents = None
        for attempt in range(1, NCORE_PAGE_RETRIES + 1):
            try:
                result = client.search(
                    pattern=PATTERN_1080,
                    type=SearchParamType.HDSER_HUN,
                    sort_by=ParamSort.UPLOAD,
                    sort_order=ParamSeq.DECREASING,
                    page=page,
                )
                torrents = getattr(result, 'torrents', []) or []
                break
            except Exception as e:
                if attempt < NCORE_PAGE_RETRIES:
                    time.sleep(NCORE_RETRY_WAIT)
                else:
                    print(f"  nCore sorozat oldal {page} hiba: {e}")
                    return all_torrents
        if not torrents:
            break
        all_torrents.extend(torrents)
        if len(all_torrents) >= TORRENT_POOL:
            all_torrents = all_torrents[:TORRENT_POOL]
            break
        if len(torrents) < 25:
            break
        page += 1
        time.sleep(NCORE_PAGE_DELAY)
    return all_torrents


def main():
    if not Client or not SearchParamType:
        print("❌ ncoreparser hiányzik. pip install ncoreparser")
        return 1
    if not NCORE_USER or not NCORE_PASS:
        print("❌ NCORE_USER / NCORE_PASS hiányzik.")
        return 1
    if not TMDB_API_KEY:
        print("❌ TMDB_API_KEY hiányzik.")
        return 1

    data_dir.mkdir(parents=True, exist_ok=True)

    print("🔑 nCore bejelentkezés...")
    client = Client()
    try:
        cookies = client.login(NCORE_USER, NCORE_PASS)
        if not cookies:
            print("❌ nCore bejelentkezés sikertelen.")
            return 1
        print("✓ Bejelentkezés OK\n")
    except Exception as e:
        print(f"❌ nCore login: {e}")
        return 1

    # ---------- MOVIES ----------
    print("🎬 Trendi filmek (HD_HUN 1080p, legtöbb seed az utolsó feltöltésekből)")
    movie_torrents = fetch_trending_movies(client)
    print(f"  Összesen {len(movie_torrents)} torrent")
    # Sort by seeders desc; ncoreparser may use 'seed' or 'seeders'
    movie_torrents.sort(key=lambda t: _seeders_from_torrent(t), reverse=True)

    seen_imdb = set()
    movie_metas = []
    for t in movie_torrents:
        if len(movie_metas) >= TRENDING_COUNT:
            break
        try:
            title = (t['title'] or '').strip()
        except Exception:
            title = ''
        if not title or is_likely_series(title):
            continue
        clean, year = parse_movie_title(title)
        metadata = search_movie_on_tmdb(clean, year, TMDB_API_KEY)
        if not metadata or not metadata.get('imdb_id'):
            continue
        imdb_id = metadata['imdb_id']
        imdb_id = imdb_id if str(imdb_id).startswith('tt') else 'tt' + str(imdb_id)
        if imdb_id in seen_imdb:
            continue
        seen_imdb.add(imdb_id)
        seeders = _seeders_from_torrent(t)
        name = metadata['title'] or clean
        poster_path = metadata.get('poster_path')
        poster = (
            f'https://image.tmdb.org/t/p/w500{poster_path}' if poster_path
            else f'https://images.metahub.space/poster/small/{imdb_id}/img'
        )
        movie_metas.append({
            'id': imdb_id,
            'type': 'movie',
            'name': name,
            'poster': poster,
            'posterShape': 'poster',
            'year': metadata.get('year'),
            'description': metadata.get('description') or 'Trendi magyar HD 1080p – nCore.',
            'imdbRating': round(metadata['rating'], 1) if metadata.get('rating') else None,
            'releaseInfo': str(metadata['year']) if metadata.get('year') else None,
            'genres': metadata.get('genres') or [],
            'seeders': seeders,
        })
        if len(movie_metas) % 10 == 0:
            print(f"  Film: {len(movie_metas)}/{TRENDING_COUNT}")

    with open(out_file_movies, 'w', encoding='utf-8') as f:
        json.dump(movie_metas, f, ensure_ascii=False, indent=2)
    print(f"✓ {len(movie_metas)} trendi film → {out_file_movies.name}\n")

    # ---------- SERIES ----------
    print("📺 Trendi sorozatok (HDSER_HUN 1080p, legtöbb seed az utolsó feltöltésekből)")
    series_torrents = fetch_trending_series(client)
    print(f"  Összesen {len(series_torrents)} torrent")
    series_torrents.sort(key=lambda t: _seeders_from_torrent(t), reverse=True)

    seen_imdb_series = set()
    series_metas = []
    for t in series_torrents:
        if len(series_metas) >= TRENDING_COUNT:
            break
        try:
            title = (t['title'] or '').strip()
        except Exception:
            title = ''
        if not title:
            continue
        clean_title, year = parse_series_title(title)
        new_season, new_episode, episode_string = extract_episode_info(title)
        metadata = search_show_on_tvdb(clean_title, year, TVDB_API_KEY, TVDB_PIN, TMDB_API_KEY)
        if not metadata or not metadata.get('imdb_id'):
            continue
        imdb_id = metadata['imdb_id']
        if imdb_id in seen_imdb_series:
            continue
        seen_imdb_series.add(imdb_id)
        seeders = _seeders_from_torrent(t)
        display_title = metadata['title'] or clean_title
        if episode_string:
            display_title = f"{display_title} ({episode_string})"
        poster_path = metadata.get('poster_path')
        if poster_path and poster_path.startswith('http'):
            display_poster = poster_path
        else:
            display_poster = (
                f'https://image.tmdb.org/t/p/w500{poster_path}' if poster_path
                else f"https://images.metahub.space/poster/small/{imdb_id}/img"
            )
        description = metadata.get('description') or 'Trendi magyar HD 1080p sorozat – nCore.'
        if episode_string:
            description = f"🆕 Legújabb epizód: {episode_string}\n\n{description}"
        series_metas.append({
            'id': imdb_id,
            'type': 'series',
            'name': display_title,
            'poster': display_poster,
            'posterShape': 'poster',
            'year': metadata.get('year'),
            'description': description,
            'imdbRating': round(metadata['rating'], 1) if metadata.get('rating') else None,
            'releaseInfo': str(metadata['year']) if metadata.get('year') else None,
            'genres': metadata.get('genres') or [],
            'latest_season': new_season,
            'latest_episode': new_episode,
            'seeders': seeders,
        })
        if len(series_metas) % 10 == 0:
            print(f"  Sorozat: {len(series_metas)}/{TRENDING_COUNT}")

    with open(out_file_series, 'w', encoding='utf-8') as f:
        json.dump(series_metas, f, ensure_ascii=False, indent=2)
    print(f"✓ {len(series_metas)} trendi sorozat → {out_file_series.name}")

    client.logout()
    print("\n✅ Trendi katalógusok kész.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
