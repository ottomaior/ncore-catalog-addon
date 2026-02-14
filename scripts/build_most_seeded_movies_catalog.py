"""
Build data/most_seeded_movies.json for the Stremio catalog (top seeded by genre).
Fetches HD-HUN movies from nCore, matches to Trakt + TMDB, gets genres, writes one JSON.
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

TRAKT_CLIENT_ID = os.getenv('TRAKT_CLIENT_ID')
TRAKT_ACCESS_TOKEN = os.getenv('TRAKT_ACCESS_TOKEN')
TRAKT_CLIENT_SECRET = os.getenv('TRAKT_CLIENT_SECRET')
TRAKT_REFRESH_TOKEN = os.getenv('TRAKT_REFRESH_TOKEN')
TMDB_API_KEY = os.getenv('TMDB_API_KEY')
NCORE_USER = os.getenv('NCORE_USER', '').strip()
NCORE_PASS = os.getenv('NCORE_PASS', '').strip()

# Aim for this many torrents total; script paginates until TARGET_COUNT or no more pages.
TARGET_COUNT = int(os.getenv('NCORE_CATALOG_TARGET_MOVIES', '4000'))
# When extending existing file: fetch only this many nCore pages per run (faster incremental updates).
NCORE_PAGES_PER_RUN = int(os.getenv('NCORE_PAGES_PER_RUN', '15'))


def _trakt_headers():
    return {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID,
        'Authorization': f'Bearer {os.getenv("TRAKT_ACCESS_TOKEN", TRAKT_ACCESS_TOKEN)}',
    }


headers = _trakt_headers()


def _refresh_trakt():
    try:
        from trakt_auth import refresh_trakt_tokens, update_config_tokens
        pair = refresh_trakt_tokens(
            os.getenv('TRAKT_CLIENT_ID'),
            os.getenv('TRAKT_CLIENT_SECRET'),
            os.getenv('TRAKT_REFRESH_TOKEN'),
        )
        if not pair:
            return False
        access_token, new_refresh_token = pair
        if update_config_tokens(config_file, access_token, new_refresh_token):
            load_dotenv(config_file)
            os.environ['TRAKT_ACCESS_TOKEN'] = access_token
            os.environ['TRAKT_REFRESH_TOKEN'] = new_refresh_token
            global headers
            headers = _trakt_headers()
            return True
    except Exception:
        pass
    return False


def search_movie_on_trakt(clean_title, year):
    variations = [clean_title, clean_title.replace(' and ', ' & '), clean_title.replace(' & ', ' and ')]
    variations = list(dict.fromkeys(variations))
    for variation in variations:
        try:
            time.sleep(0.5)
            url = f'https://api.trakt.tv/search/movie?query={variation}&extended=full'
            if year:
                url += f'&years={year}'
            r = requests.get(url, headers=headers)
            if r.status_code == 401 and _refresh_trakt():
                r = requests.get(url, headers=headers)
            if r.status_code != 200 or not isinstance(r.json(), list):
                continue
            for result in r.json():
                movie = result.get('movie')
                if not movie or not movie.get('ids', {}).get('trakt'):
                    continue
                movie_year = str(movie.get('year', ''))
                variation_lower = variation.lower()
                title_lower = (movie.get('title') or '').lower()
                match = (title_lower in variation_lower or variation_lower in title_lower or
                        variation_lower.replace(' ', '') in title_lower.replace(' ', ''))
                if year and movie_year != str(year):
                    continue
                if match or result == r.json()[0]:
                    return movie
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


def get_tmdb_metadata(imdb_id, tmdb_key):
    if not tmdb_key or not imdb_id:
        return None, None
    imdb_id = imdb_id.replace('tt', '')
    try:
        r = requests.get(
            'https://api.themoviedb.org/3/find/tt' + imdb_id,
            params={'api_key': tmdb_key, 'external_source': 'imdb_id', 'language': 'hu-HU'},
            timeout=10,
        )
        if r.status_code != 200:
            return None, None
        data = r.json()
        results = data.get('movie_results') or []
        if not results:
            return None, None
        item = results[0]
        title = item.get('title') or item.get('original_title') or ''
        poster = item.get('poster_path')
        poster_url = f'https://image.tmdb.org/t/p/w500{poster}' if poster else None
        return title, poster_url
    except Exception:
        return None, None


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
    if not all([TRAKT_CLIENT_ID, TRAKT_ACCESS_TOKEN]):
        print('\n✗ Trakt hitelesítés hiányzik.')
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
        movie = search_movie_on_trakt(clean, year)
        if not movie:
            continue
        imdb = (movie.get('ids') or {}).get('imdb')
        if not imdb:
            continue
        imdb = imdb if str(imdb).startswith('tt') else 'tt' + str(imdb)
        if imdb in seen_imdb:
            continue
        seen_imdb.add(imdb)
        genres = movie.get('genres') or []
        if isinstance(genres, list) and genres and isinstance(genres[0], dict):
            genres = [g.get('name') or g.get('slug', '') for g in genres]
        if not genres and movie.get('ids', {}).get('trakt'):
            try:
                time.sleep(0.4)
                tr = requests.get(
                    f"https://api.trakt.tv/movies/{movie['ids']['trakt']}",
                    headers=headers,
                    params={'extended': 'full'},
                    timeout=10,
                )
                if tr.status_code == 200:
                    j = tr.json()
                    genres = j.get('genres') or []
                    if genres and isinstance(genres[0], dict):
                        genres = [g.get('name') or g.get('slug', '') for g in genres]
            except Exception:
                pass
        genres = [str(g).strip() for g in genres if g]

        tmdb_title, tmdb_poster = get_tmdb_metadata(imdb, TMDB_API_KEY)
        name = tmdb_title or movie.get('title') or ''
        poster = tmdb_poster or f'https://images.metahub.space/poster/small/{imdb}/img'
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
            'year': movie.get('year'),
            'description': movie.get('overview') or 'Magyar HD – nCore legnagyobb seed.',
            'imdbRating': str(round(movie['rating'], 1)) if isinstance(movie.get('rating'), (int, float)) else None,
            'releaseInfo': str(movie.get('year')) if movie.get('year') else None,
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
