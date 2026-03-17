"""
Build data/most_seeded_series.json for the Stremio catalog (top seeded series).
Fetches Sorozat HD/HU 1080p (HDSER_HUN, search "1080p" in title) from nCore, sorted by seeders,
matches to TVDB (same parse_series_title as build_latest_catalog so TVDB gets clean show names), writes one JSON.
- If the file already exists: fetches only NCORE_PAGES_PER_RUN pages, merges by series id,
  sorts by seed rank, trims to TARGET_COUNT (incremental, faster runs).
- If no file: full fetch until TARGET_COUNT or no more pages.

Usage: python scripts/build_most_seeded_series_catalog.py
Output: data/most_seeded_series.json
"""
import re
import sys
import time
import os
import json
from pathlib import Path
from dotenv import load_dotenv
import requests
from omdb_client import OMDbClient

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
out_file = data_dir / 'most_seeded_series.json'

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

TARGET_COUNT = int(os.getenv('NCORE_CATALOG_TARGET_SERIES', '1000'))
NCORE_PAGES_PER_RUN = int(os.getenv('NCORE_PAGES_PER_RUN', '15'))

# 1080p in title (Címben) – matches site: Sorozat + HD/HU + search "1080p", sort by seeders
PATTERN_1080 = '.1080'

NCORE_PAGE_DELAY = float(os.getenv('NCORE_PAGE_DELAY', '3.0'))
NCORE_PAGE_RETRIES = int(os.getenv('NCORE_PAGE_RETRIES', '4'))
NCORE_RETRY_WAIT = float(os.getenv('NCORE_RETRY_WAIT', '35.0'))


def parse_series_title(title):
    """
    Same as build_latest_catalog: extract clean show name and year by cutting at
    first year, or first S01/E01/1080p/WEB-DL/etc. So TVDB gets "Fallout" not "Fallout S02 AMZN WEB DL".
    """
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
    """Extract S##E## from title; return (season, episode, 'S01E02' string) or (None, None, None)."""
    ep = re.search(r'S(\d{1,2})E(\d{1,2})', (title or ''), re.IGNORECASE)
    if ep:
        s, e = int(ep.group(1)), int(ep.group(2))
        return s, e, f"S{s:02d}E{e:02d}"
    return None, None, None


def is_newer_episode(new_s, new_e, old_s, old_e):
    """True if (new_s, new_e) is strictly newer than (old_s, old_e)."""
    if new_s is None or new_e is None:
        return False
    if old_s is None or old_e is None:
        return True
    if new_s > old_s:
        return True
    if new_s == old_s and new_e > old_e:
        return True
    return False




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
    """Fetch Sorozat HD/HU 1080p (HDSER_HUN, pattern 1080p) from nCore, sorted by seeders."""
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
                    pattern=PATTERN_1080,
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
    if not TVDB_API_KEY:
        print('\n✗ TVDB_API_KEY hiányzik (TVDB a sorozatokhoz).')
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

    print('Sorozat HD/HU 1080p lekérése (seed szerint)...')
    if incremental:
        print(f'  Növekményes frissítés: max {NCORE_PAGES_PER_RUN} oldal, majd egyesítés a meglévő {len(existing_list)} elemmel.')
    else:
        print(f'  Cél: {TARGET_COUNT} torrent (1080p címben), oldalak között {NCORE_PAGE_DELAY}s várakozás.')
    torrents = fetch_all_hd_hun_series(client, max_pages=max_pages)
    client.logout()
    print(f'  {len(torrents)} torrent')

    def _seeders_from_torrent(t):
        try:
            if isinstance(t, dict):
                return int(t.get('seeders') or t.get('seed_count') or t.get('seed') or 0)
            return int(
                getattr(t, 'seeders', None)
                or getattr(t, 'seed_count', None)
                or getattr(t, 'seed', None)
                or 0
            )
        except (TypeError, ValueError):
            return 0

    new_by_id = {}  # id -> meta; keep newest episode per series
    # Cache TVDB lookups by (clean_title, year) – many torrents are same show, different episodes
    tvdb_cache = {}
    total = len(torrents)
    for i, t in enumerate(torrents):
        # Progress every 25 torrents so user sees we're not stuck
        if (i + 1) % 25 == 0 or i == 0:
            print(f'  Torrent {i + 1}/{total} … ({len(new_by_id)} sorozat eddig)')
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
        # Keep only newest episode per series
        seeders_new = _seeders_from_torrent(t)
        if seeders_new == 0:
            seeders_new = 1_000_000 - len(new_by_id)
        if imdb in new_by_id:
            old = new_by_id[imdb]
            if not is_newer_episode(new_season, new_episode, old.get('latest_season'), old.get('latest_episode')):
                continue
        
        # Get data from TVDB metadata (same shape as build_latest_catalog)
        name = metadata.get('title') or clean
        if episode_string:
            name = f"{name} ({episode_string})"
        poster_path = metadata.get('poster_path')
        if poster_path and poster_path.startswith('http'):
            poster = poster_path
        else:
            poster = f'https://image.tmdb.org/t/p/w500{poster_path}' if poster_path else f'https://images.metahub.space/poster/small/{imdb}/img'
        genres = metadata.get('genres') or []
        description = metadata.get('description') or 'Magyar HD sorozat – nCore legnagyobb seed.'
        if episode_string:
            description = f"🆕 Legújabb epizód: {episode_string}\n\n{description}"
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
            'seeders': seeders_new,
            'latest_season': new_season,
            'latest_episode': new_episode,
        }
        new_by_id[imdb] = meta
        if len(new_by_id) % 50 == 0:
            print(f'  Feldolgozva: {len(new_by_id)} sorozat')

    new_metas = list(new_by_id.values())

    def _episode_key(m):
        return (m.get('latest_season') or 0, m.get('latest_episode') or 0)

    existing_by_id = {}  # id -> meta; keep newest episode when merging
    for m in existing_list:
        m.setdefault('seeders', 0)
        m.setdefault('latest_season', None)
        m.setdefault('latest_episode', None)
        eid = m.get('id')
        if not eid:
            continue
        if eid not in existing_by_id or _episode_key(m) > _episode_key(existing_by_id[eid]):
            existing_by_id[eid] = m
    for m in new_metas:
        eid = m.get('id')
        if eid not in existing_by_id or is_newer_episode(
            m.get('latest_season'), m.get('latest_episode'),
            existing_by_id[eid].get('latest_season'), existing_by_id[eid].get('latest_episode')
        ):
            existing_by_id[eid] = m

    merged = sorted(existing_by_id.values(), key=lambda m: m.get('seeders', 0), reverse=True)
    merged = merged[:TARGET_COUNT]

    out_file.parent.mkdir(parents=True, exist_ok=True)
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False, indent=0)
    print(f'\n✓ {len(merged)} sorozat mentve: {out_file}' + (f' (+{len(new_metas)} új/frissített)' if incremental else ''))
    print('Kész.')


if __name__ == '__main__':
    main()
