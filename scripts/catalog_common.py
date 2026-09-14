"""
Helpers shared by the catalog build scripts (title parsing, episode detection,
seed counts, TMDB movie matching). Previously each build script carried its own
copy of these; keep behaviour changes here and cover them in scripts/tests.
"""
import re
import time
from datetime import date, datetime
from difflib import SequenceMatcher

import requests

TMDB_SEARCH_URL = 'https://api.themoviedb.org/3/search/movie'
TMDB_MOVIE_URL = 'https://api.themoviedb.org/3/movie/{tmdb_id}'
DEFAULT_TMDB_DELAY = 0.4  # seconds between TMDB calls (rate-limit friendliness)

# Markers after which the release name no longer belongs to the title.
_SERIES_CUT_PATTERN = re.compile(
    r'[\s.](S\d+|E\d+|\d{3,4}[pi]|WEB-?DL|HDTV|BluRay|BRRip|DVDRip|PROPER|REPACK|AAC|DD\+?|DV|HDR|H\.26[45])',
    re.IGNORECASE,
)
_YEAR_PATTERN = re.compile(r'\.(\d{4})\.')
_EPISODE_PATTERN = re.compile(r'S(\d{1,2})E(\d{1,2})', re.IGNORECASE)
_SEASON_MARKER_PATTERN = re.compile(r's\d{1,2}(?:e\d{1,2})?', re.IGNORECASE)

# Sports keywords (English and Hungarian) used to skip live-event uploads in series lists.
SPORTS_KEYWORDS = [
    'football', 'soccer', 'nfl', 'nba', 'nhl', 'mlb', 'ufc', 'wwe', 'f1', 'formula',
    'cycling', 'tour de france', 'giro', 'vuelta', 'motogp', 'motorsport',
    'tennis', 'wimbledon', 'us open', 'australian open', 'french open',
    'olympics', 'olimpia', 'world cup', 'euro ', 'uefa', 'champions league',
    'boxing', 'wrestling', 'hockey', 'basketball', 'baseball', 'rugby',
    'golf', 'racing', 'rally', 'superbike', 'moto2', 'moto3',
    'liverpool', 'manchester', 'barcelona', 'real madrid', 'bayern', 'juventus',
    'futball', 'labdarúgás', 'kerékpár', 'boksz', 'forma-1', 'forma1',
]


def fmt_rating(x):
    """Format a rating for log lines ('?' when unknown)."""
    return '?' if x is None else f'{x:.1f}'


def _clean_words(text):
    return ' '.join(text.replace('.', ' ').split()).strip()


def parse_movie_title(title):
    """
    nCore movie release name -> (clean title, year or None).
    Everything after the first ".YYYY." is dropped: 'Dune.Part.Two.2024.1080p.x264' -> ('Dune Part Two', '2024').
    """
    title = title or ''
    year_match = _YEAR_PATTERN.search(title)
    year = year_match.group(1) if year_match else None
    clean = title[:year_match.start()] if year_match else title
    return _clean_words(clean), year


def parse_series_title(title):
    """
    nCore series release name -> (clean show name, year or None).
    Cuts at the year, else at the first season/episode/quality/release-type marker,
    so TVDB gets 'Fallout' and not 'Fallout S02 AMZN WEB DL'.
    """
    title = (title or '').strip()
    year_match = _YEAR_PATTERN.search(title)
    year = year_match.group(1) if year_match else None
    if year_match:
        clean = title[:year_match.start()]
    else:
        cut = _SERIES_CUT_PATTERN.search(title)
        clean = title[:cut.start()] if cut else title
    clean = _clean_words(clean)
    return clean or title, year


def extract_episode_info(title):
    """'Show.S02E03.720p' -> (2, 3, 'S02E03'); (None, None, None) when absent."""
    ep = _EPISODE_PATTERN.search(title or '')
    if ep:
        s, e = int(ep.group(1)), int(ep.group(2))
        return s, e, f'S{s:02d}E{e:02d}'
    return None, None, None


def is_newer_episode(new_season, new_episode, old_season, old_episode):
    """True when (new_season, new_episode) is strictly later than the old pair."""
    if new_season is None or new_episode is None:
        return False
    if old_season is None or old_episode is None:
        return True
    if new_season > old_season:
        return True
    return new_season == old_season and new_episode > old_episode


def is_likely_series(title):
    """True when a release name carries an S01/S01E02 marker (used to skip series in movie lists)."""
    if not title:
        return False
    return bool(_SEASON_MARKER_PATTERN.search(title))


def is_sports_content(title):
    """True when the release name looks like a sports broadcast."""
    lower = (title or '').lower()
    return any(k in lower for k in SPORTS_KEYWORDS)


def seeders_from_torrent(t):
    """Seed count of an ncoreparser torrent (list items expose it as t['seed'], a string)."""
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
                except (KeyError, TypeError, IndexError):
                    v = 0
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# TMDB movie matching
# ---------------------------------------------------------------------------
def _norm_title(s):
    s = (s or '').lower()
    s = re.sub(r'[^0-9a-záéíóöőúüű]+', ' ', s)
    return ' '.join(s.split())


def _title_similarity(a, b):
    a, b = _norm_title(a), _norm_title(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def score_tmdb_candidate(candidate, clean_title, year):
    """
    Score a TMDB /search/movie result against the parsed nCore title.
    Title similarity (best of localized and original title) dominates; the release year
    adds a bonus for an exact/±1 match and a penalty for a clear mismatch.
    """
    sim = max(
        _title_similarity(candidate.get('title'), clean_title),
        _title_similarity(candidate.get('original_title'), clean_title),
    )
    score = sim
    release = candidate.get('release_date') or ''
    cand_year = int(release[:4]) if release[:4].isdigit() else None
    if year and cand_year:
        diff = abs(int(year) - cand_year)
        if diff == 0:
            score += 0.30
        elif diff == 1:
            score += 0.15
        else:
            score -= 0.20
    # Tiny tiebreak so equally good matches prefer the better-known film.
    score += min(float(candidate.get('popularity') or 0.0), 100.0) / 10000.0
    return score


def pick_best_tmdb_result(results, clean_title, year):
    """Best-scoring candidate among the first 10 results (falls back to results[0])."""
    if not results:
        return None
    scored = [(score_tmdb_candidate(c, clean_title, year), i, c) for i, c in enumerate(results[:10])]
    scored.sort(key=lambda x: (-x[0], x[1]))
    return scored[0][2]


def search_movie_on_tmdb(clean_title, year, tmdb_key, delay=DEFAULT_TMDB_DELAY, timeout=15, session=None):
    """
    Find a movie on TMDB and return {imdb_id, title, poster_path, genres, description, year, rating}
    or None. Tries the title with 'and'/'&' swapped, scores every candidate by title/year
    instead of blindly taking the first result, then fetches hu-HU details for the IMDb id.
    """
    if not tmdb_key or not clean_title:
        return None
    http = session or requests
    variations = [clean_title, clean_title.replace(' and ', ' & '), clean_title.replace(' & ', ' and ')]
    seen = set()
    for variation in variations:
        if variation in seen:
            continue
        seen.add(variation)
        try:
            time.sleep(delay)
            params = {'api_key': tmdb_key, 'query': variation, 'language': 'hu-HU'}
            if year:
                params['year'] = year
            r = http.get(TMDB_SEARCH_URL, params=params, timeout=timeout)
            if r.status_code != 200:
                continue
            results = r.json().get('results', [])
            best = pick_best_tmdb_result(results, variation, year)
            if not best:
                continue
            time.sleep(delay)
            r2 = http.get(
                TMDB_MOVIE_URL.format(tmdb_id=best['id']),
                params={'api_key': tmdb_key, 'language': 'hu-HU'},
                timeout=timeout,
            )
            if r2.status_code != 200:
                continue
            movie = r2.json()
            imdb_id = movie.get('imdb_id')
            if not imdb_id:
                continue
            release = movie.get('release_date') or ''
            return {
                'imdb_id': imdb_id,
                'title': movie.get('title'),
                'poster_path': movie.get('poster_path'),
                'genres': [g['name'] for g in movie.get('genres', [])],
                'description': movie.get('overview', ''),
                'year': int(release[:4]) if release[:4].isdigit() else None,
                'rating': movie.get('vote_average'),
            }
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# Series air-date helpers (metadata dicts from search_show_on_tvdb carry
# first_air_date / last_air_date / status when TMDB enrichment succeeded)
# ---------------------------------------------------------------------------
def _year_of(iso_date):
    s = str(iso_date or '')[:4]
    return int(s) if s.isdigit() else None


def series_release_info(metadata):
    """
    Stremio-style releaseInfo for a series: '2019-' while running, '2019-2023' when ended,
    plain '2019' when only the start year is known.
    """
    first = _year_of(metadata.get('first_air_date')) or metadata.get('year')
    if not first:
        return None
    status = str(metadata.get('status') or '').lower()
    ended = any(k in status for k in ('ended', 'cancel'))
    last = _year_of(metadata.get('last_air_date'))
    if ended and last:
        return str(first) if last == first else f'{first}-{last}'
    if metadata.get('last_air_date') or status:
        return f'{first}-'
    return str(first)


def is_recently_aired(metadata, max_age_days=365, today=None):
    """
    True when the show aired an episode within max_age_days (i.e. it is a current show).
    Unknown air date -> True (do not drop shows TMDB has no data for).
    """
    last = str(metadata.get('last_air_date') or '')[:10]
    try:
        last_date = datetime.strptime(last, '%Y-%m-%d').date()
    except ValueError:
        return True
    today = today or date.today()
    return (today - last_date).days <= max_age_days
