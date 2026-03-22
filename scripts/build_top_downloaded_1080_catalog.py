"""
Build top-downloaded HD-HU 1080p catalogs (nCore sort: times_completed DESC — “Letöltve”):
  data/top_downloaded_1080_movies.json
  data/top_downloaded_1080_series.json

Movies: HD_HUN + pattern .1080, unique IMDB via TMDB.
Series: HDSER_HUN + .1080, same logic as build_most_seeded_series_catalog (TVDB).

Uses ParamSort.TIMES_COMPLETED (not SEEDERS). List HTML does not expose raw counts; each meta
gets a `downloads` rank derived from result order (higher = more downloaded on nCore).

By default skips if last successful run was less than NCORE_TOP_DOWNLOADED_MIN_DAYS ago.
Override: --force or NCORE_TOP_DOWNLOADED_FORCE=1

Usage: python scripts/build_top_downloaded_1080_catalog.py [--force]
"""
import argparse
import re
import sys
import time
import os
import json
from datetime import datetime, timezone
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
out_movies = data_dir / 'top_downloaded_1080_movies.json'
out_series = data_dir / 'top_downloaded_1080_series.json'
state_file = data_dir / '.top_downloaded_1080_last_run'

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

TARGET_MOVIES = int(os.getenv('NCORE_TOP_DOWNLOADED_MOVIES', '300'))
TARGET_SERIES = int(os.getenv('NCORE_TOP_DOWNLOADED_SERIES', '300'))
MIN_DAYS_BETWEEN_RUNS = int(os.getenv('NCORE_TOP_DOWNLOADED_MIN_DAYS', '60'))

PATTERN_1080 = '.1080'
TMDB_DELAY = 0.4

NCORE_PAGE_DELAY = float(os.getenv('NCORE_PAGE_DELAY', '3.0'))
NCORE_PAGE_RETRIES = int(os.getenv('NCORE_PAGE_RETRIES', '4'))
NCORE_RETRY_WAIT = float(os.getenv('NCORE_RETRY_WAIT', '35.0'))
# ncoreparser.Client default timeout=1s is too low; pass explicit seconds (httpx).
NCORE_HTTP_TIMEOUT = float(os.getenv('NCORE_HTTP_TIMEOUT', '120'))

# Synthetic rank for JSON (list API does not return times_completed per row)
DOWNLOAD_RANK_BASE = 1_000_000

omdb = OMDbClient(OMDB_API_KEY)


def _force_from_env():
    v = os.getenv('NCORE_TOP_DOWNLOADED_FORCE', '').strip().lower()
    return v in ('1', 'true', 'yes')


def should_skip_run(force):
    if force or _force_from_env():
        return False
    if not state_file.exists():
        return False
    try:
        raw = state_file.read_text(encoding='utf-8').strip()
        last = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        delta_days = (now - last).total_seconds() / 86400.0
        if delta_days < MIN_DAYS_BETWEEN_RUNS:
            print(
                f'Last run was {delta_days:.1f} days ago; minimum is {MIN_DAYS_BETWEEN_RUNS} days. '
                f'Skip (use --force or NCORE_TOP_DOWNLOADED_FORCE=1 to rebuild).'
            )
            return True
    except Exception as e:
        print(f'Warning: could not read state file ({e}), continuing with build.')
    return False


def write_state():
    data_dir.mkdir(parents=True, exist_ok=True)
    state_file.write_text(datetime.now(timezone.utc).isoformat(), encoding='utf-8')


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
            params = {'api_key': tmdb_key, 'query': variation, 'language': 'hu-HU'}
            if year:
                params['year'] = year
            r = requests.get('https://api.themoviedb.org/3/search/movie', params=params, timeout=15)
            if r.status_code != 200:
                continue
            results = r.json().get('results', [])
            if not results:
                continue
            tmdb_id = results[0]['id']
            time.sleep(TMDB_DELAY)
            r2 = requests.get(
                f'https://api.themoviedb.org/3/movie/{tmdb_id}',
                params={'api_key': tmdb_key, 'language': 'hu-HU'},
                timeout=15,
            )
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


def is_likely_series(title):
    if not title:
        return False
    return bool(re.search(r's\d{1,2}(?:e\d{1,2})?', title, re.IGNORECASE))


def torrent_title(t):
    """ncoreparser.Torrent exposes fields via __getitem__ only, not .title attribute."""
    if isinstance(t, dict):
        return (t.get('title') or '').strip()
    try:
        return (t['title'] or '').strip()
    except Exception:
        return (getattr(t, 'title', None) or '').strip()


def _seeders_from_torrent(t):
    """Read seed count; ncoreparser list items use key 'seed' (string)."""
    try:
        if isinstance(t, dict):
            v = t.get('seeders') or t.get('seed_count') or t.get('seed') or 0
        else:
            v = (
                getattr(t, 'seeders', None)
                or getattr(t, 'seed_count', None)
                or getattr(t, 'seed', None)
            )
            if v is None:
                try:
                    v = t['seed']
                except (KeyError, TypeError):
                    v = 0
        return int(v)
    except (TypeError, ValueError):
        return 0


def _search_one_page_movies(client, page):
    result = client.search(
        pattern=PATTERN_1080,
        type=SearchParamType.HD_HUN,
        sort_by=ParamSort.TIMES_COMPLETED,
        sort_order=ParamSeq.DECREASING,
        page=page,
    )
    return getattr(result, 'torrents', []) or []


def build_movie_metas(client, target):
    metas = []
    seen_imdb = set()
    torrent_global_order = 0
    page = 1
    consecutive_failures = 0
    while len(metas) < target:
        torrents = None
        for attempt in range(1, NCORE_PAGE_RETRIES + 1):
            try:
                torrents = _search_one_page_movies(client, page)
                consecutive_failures = 0
                break
            except TypeError:
                return metas
            except Exception as e:
                if attempt < NCORE_PAGE_RETRIES:
                    print(f'  Movies page {page} retry {attempt}/{NCORE_PAGE_RETRIES}, wait {NCORE_RETRY_WAIT}s...')
                    time.sleep(NCORE_RETRY_WAIT)
                else:
                    print(f'  nCore movies page {page}: {e}')
                    consecutive_failures += 1
                    if consecutive_failures >= 2:
                        return metas
                    break
        if torrents is None:
            time.sleep(NCORE_RETRY_WAIT)
            page += 1
            time.sleep(NCORE_PAGE_DELAY)
            continue
        if not torrents:
            break
        print(f'  Movies page {page}: +{len(torrents)} torrents (unique films so far: {len(metas)}/{target})')
        for t in torrents:
            if len(metas) >= target:
                break
            torrent_global_order += 1
            title = torrent_title(t)
            if not title or is_likely_series(title):
                continue
            clean, year = parse_movie_title(title)
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
            name = metadata['title'] or clean
            poster_path = metadata['poster_path']
            poster = f'https://image.tmdb.org/t/p/w500{poster_path}' if poster_path else f'https://images.metahub.space/poster/small/{imdb}/img'
            genres = metadata['genres']
            description = metadata['description'] or 'Magyar HD 1080p – nCore legtöbb letöltés (sorrend).'
            year_val = metadata['year']
            rating = metadata['rating']
            tmdb_rating = round(rating, 1) if isinstance(rating, (int, float)) else None
            imdb_rating = omdb.get_imdb_rating(imdb)
            imdb_clean = imdb.replace('tt', '')
            seeders = _seeders_from_torrent(t)
            downloads_rank = DOWNLOAD_RANK_BASE + 1 - torrent_global_order
            meta = {
                'id': f'tt{imdb_clean}',
                'type': 'movie',
                'name': name,
                'poster': poster,
                'posterShape': 'poster',
                'year': year_val,
                'description': description,
                'imdbRating': imdb_rating if imdb_rating is not None else tmdb_rating,
                'releaseInfo': str(year_val) if year_val else None,
                'genres': genres,
                'downloads': downloads_rank,
                'seeders': seeders,
            }
            metas.append(meta)
        if len(torrents) < 25:
            break
        page += 1
        time.sleep(NCORE_PAGE_DELAY)
    return metas[:target]


def parse_series_title(title):
    title = (title or '').strip()
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
    return clean or title, year


def extract_episode_info(title):
    ep = re.search(r'S(\d{1,2})E(\d{1,2})', (title or ''), re.IGNORECASE)
    if ep:
        s, e = int(ep.group(1)), int(ep.group(2))
        return s, e, f'S{s:02d}E{e:02d}'
    return None, None, None


def is_newer_episode(new_s, new_e, old_s, old_e):
    if new_s is None or new_e is None:
        return False
    if old_s is None or old_e is None:
        return True
    if new_s > old_s:
        return True
    if new_s == old_s and new_e > old_e:
        return True
    return False


def _search_one_page_series(client, page):
    result = client.search(
        pattern=PATTERN_1080,
        type=SearchParamType.HDSER_HUN,
        sort_by=ParamSort.TIMES_COMPLETED,
        sort_order=ParamSeq.DECREASING,
        page=page,
    )
    return getattr(result, 'torrents', []) or []


def build_series_metas(client, target):
    new_by_id = {}
    tvdb_cache = {}
    torrent_global_order = 0
    page = 1
    consecutive_failures = 0
    while len(new_by_id) < target:
        torrents = None
        for attempt in range(1, NCORE_PAGE_RETRIES + 1):
            try:
                torrents = _search_one_page_series(client, page)
                consecutive_failures = 0
                break
            except TypeError:
                return _finalize_series_metas(new_by_id, target)
            except Exception as e:
                if attempt < NCORE_PAGE_RETRIES:
                    print(f'  Series page {page} retry {attempt}/{NCORE_PAGE_RETRIES}, wait {NCORE_RETRY_WAIT}s...')
                    time.sleep(NCORE_RETRY_WAIT)
                else:
                    print(f'  nCore series page {page}: {e}')
                    consecutive_failures += 1
                    if consecutive_failures >= 2:
                        return _finalize_series_metas(new_by_id, target)
                    break
        if torrents is None:
            time.sleep(NCORE_RETRY_WAIT)
            page += 1
            time.sleep(NCORE_PAGE_DELAY)
            continue
        if not torrents:
            break
        print(f'  Series page {page}: +{len(torrents)} torrents (unique series: {len(new_by_id)}/{target})')
        for t in torrents:
            if len(new_by_id) >= target:
                break
            torrent_global_order += 1
            title = torrent_title(t)
            if not title:
                continue
            clean, year = parse_series_title(title)
            new_season, new_episode, episode_string = extract_episode_info(title)
            cache_key = (clean.strip().lower(), year)
            if cache_key in tvdb_cache:
                metadata = tvdb_cache[cache_key]
            else:
                metadata = search_show_on_tvdb(clean, year, TVDB_API_KEY, TVDB_PIN, TMDB_API_KEY)
                tvdb_cache[cache_key] = metadata
            if not metadata:
                continue
            imdb = metadata['imdb_id']
            if not imdb:
                continue
            imdb = imdb if str(imdb).startswith('tt') else 'tt' + str(imdb)
            seeders_new = _seeders_from_torrent(t)
            downloads_rank = DOWNLOAD_RANK_BASE + 1 - torrent_global_order
            if imdb in new_by_id:
                old = new_by_id[imdb]
                if not is_newer_episode(new_season, new_episode, old.get('latest_season'), old.get('latest_episode')):
                    continue
            name = metadata.get('title') or clean
            if episode_string:
                name = f'{name} ({episode_string})'
            poster_path = metadata.get('poster_path')
            if poster_path and str(poster_path).startswith('http'):
                poster = poster_path
            else:
                poster = f'https://image.tmdb.org/t/p/w500{poster_path}' if poster_path else f'https://images.metahub.space/poster/small/{imdb}/img'
            genres = metadata.get('genres') or []
            description = metadata.get('description') or 'Magyar HD 1080p sorozat – nCore legtöbb letöltés (sorrend).'
            if episode_string:
                description = f'Legújabb epizód: {episode_string}\n\n{description}'
            year_val = metadata.get('year')
            rating = metadata.get('rating')
            tmdb_rating = round(rating, 1) if isinstance(rating, (int, float)) else None
            imdb_rating = omdb.get_imdb_rating(imdb)
            imdb_clean = imdb.replace('tt', '')
            meta = {
                'id': f'tt{imdb_clean}',
                'type': 'series',
                'name': name,
                'poster': poster,
                'posterShape': 'poster',
                'year': year_val,
                'description': description,
                'imdbRating': imdb_rating if imdb_rating is not None else tmdb_rating,
                'releaseInfo': str(year_val) if year_val else None,
                'genres': genres,
                'downloads': downloads_rank,
                'seeders': seeders_new,
                'latest_season': new_season,
                'latest_episode': new_episode,
            }
            new_by_id[imdb] = meta
        if len(new_by_id) >= target:
            break
        if len(torrents) < 25:
            break
        page += 1
        time.sleep(NCORE_PAGE_DELAY)
    return _finalize_series_metas(new_by_id, target)


def _finalize_series_metas(new_by_id, target):
    merged = sorted(new_by_id.values(), key=lambda m: m.get('downloads', 0), reverse=True)
    return merged[:target]


def main():
    parser = argparse.ArgumentParser(
        description='Build HD-HU 1080p top-downloaded (times_completed) catalogs (movies + series).'
    )
    parser.add_argument('--force', action='store_true', help='Ignore 60-day cooldown')
    args = parser.parse_args()
    force = args.force

    print('=' * 60)
    print('nCore – Top downloaded 1080p (HD-HU) – filmek + sorozatok')
    print('=' * 60)

    if should_skip_run(force):
        sys.exit(0)

    if not NCORE_USER or not NCORE_PASS:
        print('ERROR: NCORE_USER / NCORE_PASS missing in config.')
        sys.exit(1)
    if not TMDB_API_KEY:
        print('ERROR: TMDB_API_KEY missing.')
        sys.exit(1)
    if not TVDB_API_KEY:
        print('ERROR: TVDB_API_KEY missing (required for series).')
        sys.exit(1)
    if not Client or not SearchParamType:
        print('ERROR: pip install ncoreparser')
        sys.exit(1)

    if not hasattr(SearchParamType, 'HD_HUN') or not hasattr(SearchParamType, 'HDSER_HUN'):
        print('ERROR: ncoreparser SearchParamType missing HD_HUN / HDSER_HUN')
        sys.exit(1)

    data_dir.mkdir(parents=True, exist_ok=True)

    client = Client(timeout=NCORE_HTTP_TIMEOUT)
    try:
        cookies = client.login(NCORE_USER, NCORE_PASS)
        if not cookies:
            print('ERROR: nCore login failed.')
            sys.exit(1)
        print('nCore login OK')
    except Exception as e:
        print(f'ERROR: nCore login: {e}')
        sys.exit(1)

    print(f'\nMovies: HD_HUN + {PATTERN_1080!r}, target {TARGET_MOVIES} unique titles...')
    movie_metas = build_movie_metas(client, TARGET_MOVIES)
    print(f'  -> {len(movie_metas)} movies')

    print(f'\nSeries: HDSER_HUN + {PATTERN_1080!r}, target {TARGET_SERIES} unique shows...')
    series_metas = build_series_metas(client, TARGET_SERIES)
    print(f'  -> {len(series_metas)} series')

    try:
        client.logout()
    except Exception:
        pass

    with open(out_movies, 'w', encoding='utf-8') as f:
        json.dump(movie_metas, f, ensure_ascii=False, indent=0)
    print(f'\nSaved: {out_movies}')

    with open(out_series, 'w', encoding='utf-8') as f:
        json.dump(series_metas, f, ensure_ascii=False, indent=0)
    print(f'Saved: {out_series}')

    write_state()
    print(f'State updated: {state_file}')
    print('Done.')


if __name__ == '__main__':
    main()
