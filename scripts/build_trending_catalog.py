"""
Build the Felkapott (trending) catalogs: HD 1080p titles that are hot on nCore right now.

Pool
  Every HD_HUN (movies) / HDSER_HUN (series) 1080p torrent uploaded in the last
  NCORE_TRENDING_POOL_DAYS (30) days, capped at NCORE_TRENDING_POOL_MAX (600) torrents.
  Pages are fetched newest first and reading stops at the first upload older than the window.

Ranking (scripts/trending_rank.py)
  Releases are grouped per title (IMDb id after TMDB / TVDB matching; for series per
  IMDb id + episode), seeds and leechers are summed and the age is that of the earliest
  upload. Score = (seeds + 2 * leechers) / (age_days + 2) ** 0.7. Series take the best
  scoring episode of each show (no summing across episodes, which would favour daily shows).
  Floors after grouping: movies NCORE_TRENDING_MIN_SEEDERS (40), series
  NCORE_TRENDING_MIN_SEEDERS_SERIES (30); when fewer than NCORE_TRENDING_COUNT (30) titles
  reach the floor, the best of the rest fill the list so it is never short. Movies keep the release-year window
  (NCORE_TRENDING_MIN_YEAR..MAX_YEAR), series the recently-aired filter.

Momentum (opt in: NCORE_TRENDING_MOMENTUM=1)
  data/trending_state.json keeps peer samples per title from previous runs (always written).
  When enabled, titles are ranked by peers gained over the last 48 h; titles without usable
  history use the score above. Turn it on once a few days of samples exist.

Output: data/trending_movies.json, data/trending_series.json, data/trending_state.json.
Usage:  python scripts/build_trending_catalog.py
"""
import sys
import time
import os
import json
from datetime import datetime, timedelta
from pathlib import Path
from dotenv import load_dotenv

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
from catalog_common import (
    add_images,
    parse_movie_title,
    parse_series_title,
    extract_episode_info,
    is_newer_episode,
    is_likely_series,
    is_sports_content,
    search_movie_on_tmdb,
    series_release_info,
    is_recently_aired,
)
from trending_rank import (
    TrendingState,
    days_since,
    group_releases,
    momentum_scorer,
    peers_from_torrent,
    rank_groups,
    select_with_floor,
    upload_datetime,
)

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
state_file = data_dir / 'trending_state.json'

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

# Pool: uploads from the last POOL_DAYS days, at most POOL_MAX torrents per category
POOL_DAYS = float(os.getenv('NCORE_TRENDING_POOL_DAYS', '30'))
POOL_MAX = int(os.getenv('NCORE_TRENDING_POOL_MAX', '600'))
TRENDING_COUNT = int(os.getenv('NCORE_TRENDING_COUNT', '30'))
# Seed floors per title, after grouping releases (nCore median for popular HU 1080p is ~50)
TRENDING_MIN_SEEDERS = int(os.getenv('NCORE_TRENDING_MIN_SEEDERS', '40'))
TRENDING_MIN_SEEDERS_SERIES = int(os.getenv('NCORE_TRENDING_MIN_SEEDERS_SERIES', '30'))
# Only include movies with release year in [TRENDING_MIN_YEAR, TRENDING_MAX_YEAR]
TRENDING_MIN_YEAR = int(os.getenv('NCORE_TRENDING_MIN_YEAR', '2025'))
TRENDING_MAX_YEAR = int(os.getenv('NCORE_TRENDING_MAX_YEAR', '2026'))
# Series: only shows that aired an episode within this many days (drops re-uploads of long-ended shows)
TRENDING_SERIES_MAX_AGE_DAYS = int(os.getenv('NCORE_TRENDING_SERIES_MAX_AGE_DAYS', '365'))
# Rank by peers gained since the previous runs instead of the plain score (needs history in the state file)
TRENDING_MOMENTUM = os.getenv('NCORE_TRENDING_MOMENTUM', '0').strip().lower() in ('1', 'true', 'yes')
NCORE_PAGE_DELAY = float(os.getenv('NCORE_PAGE_DELAY', '2.0'))
NCORE_PAGE_RETRIES = int(os.getenv('NCORE_PAGE_RETRIES', '3'))
NCORE_RETRY_WAIT = float(os.getenv('NCORE_RETRY_WAIT', '10.0'))
PAGE_SIZE = 25

# 1080p pattern (same as build_latest)
PATTERN_1080 = '.1080'


def _load_previous(path):
    """Previously written list (image cache source); [] when missing/invalid."""
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _title_of(t):
    try:
        return (t['title'] or '').strip()
    except Exception:
        return ''


def fetch_pool(client, search_type, label):
    """
    Torrents of `search_type` (1080p) uploaded in the last POOL_DAYS days, newest first,
    at most POOL_MAX. Stops at the first page whose last item is older than the window.
    """
    cutoff = datetime.now() - timedelta(days=POOL_DAYS)
    pool = []
    page = 1
    print(f"  {label}: 1080p feltöltések az elmúlt {POOL_DAYS:g} napból (max {POOL_MAX})...")
    while len(pool) < POOL_MAX:
        torrents = None
        for attempt in range(1, NCORE_PAGE_RETRIES + 1):
            try:
                result = client.search(
                    pattern=PATTERN_1080,
                    type=search_type,
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
                    print(f"  nCore {label} oldal {page} hiba: {e}")
                    return pool
        if not torrents:
            break
        reached_cutoff = False
        for t in torrents:
            uploaded = upload_datetime(t)
            if uploaded is not None and uploaded < cutoff:
                reached_cutoff = True
                break
            pool.append(t)
            if len(pool) >= POOL_MAX:
                break
        if reached_cutoff or len(pool) >= POOL_MAX or len(torrents) < PAGE_SIZE:
            break
        page += 1
        time.sleep(NCORE_PAGE_DELAY)
    return pool


def _scorer(state):
    if TRENDING_MOMENTUM:
        return momentum_scorer(state)
    return None


def _poster(metadata, imdb_id):
    poster_path = metadata.get('poster_path')
    if poster_path and str(poster_path).startswith('http'):
        return poster_path
    if poster_path:
        return f'https://image.tmdb.org/t/p/w500{poster_path}'
    return f'https://images.metahub.space/poster/small/{imdb_id}/img'


def _uploaded_at(group):
    """ISO date of the earliest upload in the group (oldest release is last in items)."""
    dates = [r.get('uploaded') for r in group['items'] if r.get('uploaded') is not None]
    return min(dates).strftime('%Y-%m-%d') if dates else None


def build_movies(client, state):
    print(f"🎬 Felkapott filmek (HD_HUN 1080p, év: {TRENDING_MIN_YEAR}–{TRENDING_MAX_YEAR}, min. {TRENDING_MIN_SEEDERS} seed/cím)")
    pool = fetch_pool(client, SearchParamType.HD_HUN, 'Filmek')
    print(f"  Összesen {len(pool)} torrent a poolban")

    releases = []
    match_cache = {}  # (clean title, year) -> metadata or None; releases of one film share the lookup
    unmatched = set()
    for t in pool:
        seeds, leech = peers_from_torrent(t)
        if seeds + leech <= 0:
            continue
        title = _title_of(t)
        if not title or is_likely_series(title):
            continue
        clean, year = parse_movie_title(title)
        cache_key = (clean.lower(), year)
        if cache_key not in match_cache:
            match_cache[cache_key] = search_movie_on_tmdb(clean, year, TMDB_API_KEY)
        metadata = match_cache[cache_key]
        if not metadata or not metadata.get('imdb_id'):
            if cache_key not in unmatched:
                unmatched.add(cache_key)
                print(f"  ✗ nincs találat: {clean} ({year}, {seeds} seed)")
            continue
        # TMDB may have no release date yet (upcoming Hungarian films): trust the release name's year then.
        meta_year = metadata.get('year') or (int(year) if year else None)
        if meta_year is None or not (TRENDING_MIN_YEAR <= meta_year <= TRENDING_MAX_YEAR):
            continue
        imdb_id = str(metadata['imdb_id'])
        imdb_id = imdb_id if imdb_id.startswith('tt') else 'tt' + imdb_id
        uploaded = upload_datetime(t)
        releases.append({
            'key': imdb_id, 'seeds': seeds, 'leech': leech,
            'age_days': days_since(uploaded), 'uploaded': uploaded,
            'metadata': metadata, 'clean': clean, 'year': meta_year,
        })
    print(f"  {len(releases)} release, {len(match_cache)} TMDB keresés")

    groups = group_releases(releases)
    for g in groups.values():
        state.record(g['key'], g['seeds'], g['leech'])
    ranked = rank_groups(groups, scorer=_scorer(state))
    selected, backfilled = select_with_floor(ranked, TRENDING_MIN_SEEDERS, TRENDING_COUNT)
    print(f"  {len(groups)} film, {len(selected) - backfilled} a seed-küszöb felett, {backfilled} feltöltve alulról")

    metas = []
    for g in selected:
        best = g['items'][0]
        metadata = best['metadata']
        imdb_id = g['key']
        meta_year = best.get('year')
        tmdb_rating = round(metadata['rating'], 1) if metadata.get('rating') else None
        imdb_rating = omdb.get_imdb_rating(imdb_id)
        metas.append({
            'id': imdb_id,
            'type': 'movie',
            'name': metadata.get('title') or best['clean'],
            'poster': _poster(metadata, imdb_id),
            'posterShape': 'poster',
            'year': meta_year,
            'description': metadata.get('description') or 'Felkapott magyar HD 1080p – nCore.',
            'imdbRating': imdb_rating if imdb_rating is not None else tmdb_rating,
            'releaseInfo': str(meta_year) if meta_year else None,
            'genres': metadata.get('genres') or [],
            'seeders': g['seeds'],
            'leechers': g['leech'],
            'releases': g['releases'],
            'score': g['score'],
            'uploaded_at': _uploaded_at(g),
        })
        if len(metas) % 10 == 0:
            print(f"  Film: {len(metas)}/{TRENDING_COUNT}")

    add_images(metas, 'movie', TMDB_API_KEY, previous=_load_previous(out_file_movies))
    with open(out_file_movies, 'w', encoding='utf-8') as f:
        json.dump(metas, f, ensure_ascii=False, indent=2)
    print(f"✓ {len(metas)} felkapott film → {out_file_movies.name}\n")
    return metas


def build_series(client, state):
    print(f"📺 Felkapott sorozatok (HDSER_HUN 1080p, az elmúlt {TRENDING_SERIES_MAX_AGE_DAYS} napban futó sorozatok, min. {TRENDING_MIN_SEEDERS_SERIES} seed/epizód)")
    pool = fetch_pool(client, SearchParamType.HDSER_HUN, 'Sorozatok')
    print(f"  Összesen {len(pool)} torrent a poolban")

    releases = []
    match_cache = {}  # (clean title, year) -> metadata / None
    skipped_stale = set()
    unmatched = set()
    for t in pool:
        seeds, leech = peers_from_torrent(t)
        if seeds + leech <= 0:
            continue
        title = _title_of(t)
        if not title or is_sports_content(title):
            continue
        clean, year = parse_series_title(title)
        season, episode, episode_string = extract_episode_info(title)
        cache_key = (clean.lower(), year)
        if cache_key not in match_cache:
            match_cache[cache_key] = search_show_on_tvdb(clean, year, TVDB_API_KEY, TVDB_PIN, TMDB_API_KEY)
        metadata = match_cache[cache_key]
        if not metadata or not metadata.get('imdb_id'):
            if cache_key not in unmatched:
                unmatched.add(cache_key)
                print(f"  ✗ nincs találat: {clean} ({seeds} seed)")
            continue
        imdb_id = metadata['imdb_id']
        if not is_recently_aired(metadata, TRENDING_SERIES_MAX_AGE_DAYS):
            if imdb_id not in skipped_stale:
                skipped_stale.add(imdb_id)
                print(f"  ⏭ nem aktuális sorozat (utolsó epizód: {metadata.get('last_air_date')}): {metadata.get('title') or clean}")
            continue
        uploaded = upload_datetime(t)
        # Releases of the same episode (WEB-DL, x265, ...) merge; different episodes stay apart.
        ep_key = f"{imdb_id}:S{season}E{episode}" if season is not None else f"{imdb_id}:{title.lower()}"
        releases.append({
            'key': ep_key, 'show': imdb_id, 'seeds': seeds, 'leech': leech,
            'age_days': days_since(uploaded), 'uploaded': uploaded,
            'metadata': metadata, 'clean': clean,
            'season': season, 'episode': episode, 'episode_string': episode_string,
        })
    print(f"  {len(releases)} release, {len(match_cache)} TVDB/TMDB keresés")

    groups = group_releases(releases)
    for g in groups.values():
        state.record(g['key'], g['seeds'], g['leech'])
    ranked = rank_groups(groups, scorer=_scorer(state))

    # One entry per show: the best scoring episode ranks it, the newest episode is displayed.
    shows = {}
    for g in ranked:
        show_id = g['items'][0]['show']
        entry = shows.get(show_id)
        if entry is None:
            shows[show_id] = {'best': g, 'newest': g['items'][0]}
            continue
        cur = entry['newest']
        cand = g['items'][0]
        if is_newer_episode(cand.get('season'), cand.get('episode'), cur.get('season'), cur.get('episode')):
            entry['newest'] = cand
    # Rank shows by their best episode; shows under the seed floor only fill leftover slots.
    show_rows = [dict(entry['best'], show=show_id, newest=entry['newest']) for show_id, entry in shows.items()]
    selected, backfilled = select_with_floor(show_rows, TRENDING_MIN_SEEDERS_SERIES, TRENDING_COUNT)
    print(f"  {len(groups)} epizód, {len(shows)} sorozat, {len(selected) - backfilled} a seed-küszöb felett, {backfilled} feltöltve alulról")

    metas = []
    for g in selected:
        show_id = g['show']
        newest = g['newest']
        metadata = newest['metadata']
        display_title = metadata.get('title') or newest['clean']
        description = metadata.get('description') or 'Felkapott magyar HD 1080p sorozat – nCore.'
        if newest.get('episode_string'):
            display_title = f"{display_title} ({newest['episode_string']})"
            description = f"🆕 Legújabb epizód: {newest['episode_string']}\n\n{description}"
        tmdb_rating = round(metadata['rating'], 1) if metadata.get('rating') else None
        imdb_rating = omdb.get_imdb_rating(show_id)
        metas.append({
            'id': show_id,
            'type': 'series',
            'name': display_title,
            'poster': _poster(metadata, show_id),
            'posterShape': 'poster',
            'year': metadata.get('year'),
            'description': description,
            'imdbRating': imdb_rating if imdb_rating is not None else tmdb_rating,
            'releaseInfo': series_release_info(metadata),
            'genres': metadata.get('genres') or [],
            'latest_season': newest.get('season'),
            'latest_episode': newest.get('episode'),
            'seeders': g['seeds'],
            'leechers': g['leech'],
            'releases': g['releases'],
            'score': g['score'],
            'uploaded_at': _uploaded_at(g),
        })
        if len(metas) % 10 == 0:
            print(f"  Sorozat: {len(metas)}/{TRENDING_COUNT}")

    add_images(metas, 'tv', TMDB_API_KEY, previous=_load_previous(out_file_series))
    with open(out_file_series, 'w', encoding='utf-8') as f:
        json.dump(metas, f, ensure_ascii=False, indent=2)
    print(f"✓ {len(metas)} felkapott sorozat → {out_file_series.name}")
    return metas


def main():
    if not Client or not SearchParamType:
        print("ERROR: ncoreparser missing. Install: pip install ncoreparser")
        return 1
    if not NCORE_USER or not NCORE_PASS:
        print("ERROR: NCORE_USER / NCORE_PASS missing.")
        return 1
    if not TMDB_API_KEY:
        print("ERROR: TMDB_API_KEY missing.")
        return 1
    if not hasattr(SearchParamType, 'HD_HUN') or not hasattr(SearchParamType, 'HDSER_HUN'):
        print("ERROR: ncoreparser has no HD_HUN / HDSER_HUN category.")
        return 1

    data_dir.mkdir(parents=True, exist_ok=True)

    print("nCore login...")
    client = Client()
    try:
        cookies = client.login(NCORE_USER, NCORE_PASS)
        if not cookies:
            print("ERROR: nCore login failed.")
            return 1
        print("Login OK\n")
    except Exception as e:
        print(f"❌ nCore login: {e}")
        return 1

    state = TrendingState.load(state_file)
    print(f"Rangsor: {'momentum (peer-növekedés 48 h)' if TRENDING_MOMENTUM else 'pontszám (seed + 2·leech) / (kor + 2)^0.7'}\n")

    build_movies(client, state)
    build_series(client, state)

    state.prune()
    state.save(state_file)
    print(f"✓ {len(state.samples)} cím mintája → {state_file.name}")

    client.logout()
    print("\n✅ Felkapott katalógusok kész.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
